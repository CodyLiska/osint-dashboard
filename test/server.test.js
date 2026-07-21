import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { installFetch } from "./helpers/mock-fetch.js";
import { createServer } from "../server.js";
import { closeDb, openDb, reconcile, recordFired
} from "../src/lib/persist.js";

// Upstreams the routing tests may reach are mocked so the recon/layer routes run
// end-to-end without the network. One SDN fixture serves both crypto and entity
// lookups; other feeds resolve empty.
const usgsFeed = {
  features: [{
    id: "q1",
    properties: { mag: 5, place: "Test Ridge", time: 1_700_000_000_000, url: "http://u/q1" },
    geometry: { coordinates: [-100, 40, 5] }
  }]
};

const sdnXml = `<sdnList>
  <sdnEntry>
    <uid>4001</uid><lastName>EVIL CORP</lastName><sdnType>Entity</sdnType>
    <programList><program>CYBER2</program></programList>
    <idList><id><idType>Digital Currency Address - XBT</idType><idNumber>1EvilBtcAddr</idNumber></id></idList>
  </sdnEntry>
  <sdnEntry>
    <uid>111</uid><firstName>Vladimir</firstName><lastName>TESTOV</lastName><sdnType>Individual</sdnType>
    <programList><program>UKRAINE-EO13661</program></programList>
    <countryList><country>Russia</country></countryList>
  </sdnEntry>
</sdnList>`;

const rdapDomain = {
  ldhName: "EXAMPLE.COM",
  events: [{ eventAction: "registration", eventDate: "1995-08-14" }],
  nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }],
  status: [],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["org", {}, "text", "IANA"]]] }]
};

function upstream(url) {
  if (url.includes("earthquake.usgs.gov")) return usgsFeed;
  if (url.includes("treasury.gov/ofac/downloads/sdn.xml")) return sdnXml;
  if (url.includes("blockstream.info")) return { address: "x", chain_stats: {} };
  if (url.includes("api.ethplorer.io")) return { ETH: { balance: 1.5 }, tokens: [] };
  if (url.includes("services.nvd.nist.gov")) return { totalResults: 1, vulnerabilities: [{ cve: { id: "CVE-2026-0001" } }] };
  if (url.includes("rdap.org")) return rdapDomain;
  return "";
}

let server;
let baseServerPort;
let restoreFetch;

// The test client uses node:http (not fetch) so it still reaches the server while
// the server's own outbound fetch is mocked.
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: baseServerPort, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({
        status: res.statusCode,
        type: res.headers["content-type"] || "",
        body,
        json: () => JSON.parse(body)
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  restoreFetch = installFetch(upstream);
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseServerPort = server.address().port;
});

after(() => {
  restoreFetch?.();
  server?.close();
});

test("serves index.html at the root", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.match(res.body, /OSIRIS/);
});

test("serves static assets with the right content type", async () => {
  const res = await get("/styles.css");
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/css/);
});

test("does not serve files outside the public directory", async () => {
  // %2e%2e is normalized away by the URL parser (404); the startsWith guard is
  // defense-in-depth behind it. Either way, server source must never be served.
  const res = await get("/%2e%2e/server.js");
  assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  assert.doesNotMatch(res.body, /createServer|handleApi/);
});

test("GET /api/health returns a sources array", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json().sources));
});

test("GET /api/layers/:layer returns normalized entities and meta", async () => {
  const res = await get("/api/layers/seismic");
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.layer, "seismic");
  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].id, "quake-q1");
  assert.equal(body.meta.count, 1);
  assert.ok(body.meta.generatedAt);
});

test("an unknown layer returns 404", async () => {
  const res = await get("/api/layers/bogus");
  assert.equal(res.status, 404);
  assert.match(res.json().error, /Unknown layer/);
});

test("a route with a missing required param returns 400", async () => {
  const res = await get("/api/crypto/btc");
  assert.equal(res.status, 400);
  assert.equal(res.json().error, "address required");
});

test("an unknown API route returns 404", async () => {
  const res = await get("/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.json().error, "Unknown API route");
});

test("GET /api/crypto/btc reports OFAC exposure for a sanctioned address", async () => {
  const res = await get("/api/crypto/btc?address=1EvilBtcAddr");
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.chain, "BTC");
  assert.equal(body.sanctioned, true);
});

test("GET /api/crypto/eth returns balance data and the OFAC verdict", async () => {
  const res = await get("/api/crypto/eth?address=0x0000000000000000000000000000000000000000");
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.chain, "ETH");
  assert.equal(body.data.balanceEth, 1.5); // from the mocked Ethplorer response
  assert.equal(body.sanctioned, false);    // address not in the SDN fixture
});

test("GET /api/crypto/eth without an address returns 400", async () => {
  const res = await get("/api/crypto/eth");
  assert.equal(res.status, 400);
  assert.equal(res.json().error, "address required");
});

test("GET /api/sanctions searches the sanctions feed", async () => {
  const res = await get("/api/sanctions?q=testov");
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.total.value, 1);
  assert.equal(body.results[0].caption, "Vladimir TESTOV");
});

test("GET /api/cves returns NVD results", async () => {
  const res = await get("/api/cves?q=log4j");
  assert.equal(res.status, 200);
  assert.equal(res.json().vulnerabilities[0].cve.id, "CVE-2026-0001");
});

test("GET /api/intel/whois returns a parsed RDAP summary", async () => {
  const res = await get("/api/intel/whois?query=example.com");
  assert.equal(res.status, 200);
  assert.equal(res.json().summary.domain, "EXAMPLE.COM");
});

// ---- Phase 2 read API ------------------------------------------------------
// With no DB open (the default in this suite) the endpoints return the graceful
// disabled shape rather than erroring.

test("GET /api/changes returns { enabled:false } when persistence is disabled", async () => {
  const res = await get("/api/changes");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { enabled: false });
});

test("GET /api/history/:layer returns { enabled:false } when persistence is disabled", async () => {
  const res = await get("/api/history/seismic");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { enabled: false });
});

test("GET /api/changes rejects a non-ISO since with 400", async () => {
  const res = await get("/api/changes?since=not-a-date");
  assert.equal(res.status, 400);
  assert.match(res.json().error, /ISO 8601/);
});

test("GET /api/changes and /api/history/:layer read from an enabled store", async () => {
  const db = openDb(":memory:"); // opens the module singleton the server reads
  try {
    reconcile(db, "seismic", [{ id: "q1", name: "A" }, { id: "q2", name: "B" }], "2026-07-19T00:00:00.000Z");
    reconcile(db, "seismic", [{ id: "q1" }, { id: "q3", name: "C" }], "2026-07-19T02:00:00.000Z"); // q2 closes, q3 added

    const changes = await get("/api/changes?since=2026-07-19T01:00:00.000Z");
    assert.equal(changes.status, 200);
    const cbody = changes.json();
    assert.equal(cbody.enabled, true);
    assert.deepEqual(cbody.added.map((c) => c.id), ["q3"]);
    assert.deepEqual(cbody.closed.map((c) => c.id), ["q2"]);

    const history = await get("/api/history/seismic?since=2026-07-19T00:00:00.000Z&until=2026-07-19T01:00:00.000Z");
    assert.equal(history.status, 200);
    const hbody = history.json();
    assert.equal(hbody.enabled, true);
    assert.deepEqual(hbody.events.map((e) => e.id).sort(), ["q1", "q2"]);
  } finally {
    closeDb(); // leave persistence disabled for any later tests
  }
});

test("GET /api/alerts degrades gracefully when persistence is disabled", async () => {
  closeDb();
  const res = await get("/api/alerts");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { enabled: false });
});

test("GET /api/alerts rejects a malformed since", async () => {
  const res = await get("/api/alerts?since=not-a-date");
  assert.equal(res.status, 400);
});

test("GET /api/alerts returns fired alerts and the health of every configured rule", async () => {
  const db = openDb(":memory:");
  const previousRules = process.env.OSIRIS_ALERT_RULES_PATH;
  // Point at the committed example so the route has real rules to report on.
  process.env.OSIRIS_ALERT_RULES_PATH = fileURLToPath(new URL("../config/alert-rules.example.json", import.meta.url));
  try {
    recordFired(db, {
      ruleId: "taiwan-strait-seismic", layer: "seismic", entityId: "q1", reason: "appeared",
      firedAt: new Date().toISOString(), severity: 4, name: "M5.2 near Hualien",
      payload: JSON.stringify({ id: "q1", name: "M5.2 near Hualien", lat: 23.9, lon: 121.5 })
    });

    const res = await get("/api/alerts");
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.enabled, true);
    assert.deepEqual(body.alerts.map((a) => a.id), ["q1"]);
    // The entity is rebuilt from the payload so the panel can fly to it.
    assert.equal(body.alerts[0].entity.lat, 23.9);

    // Every configured rule appears, including ones that have never fired —
    // otherwise an inert rule is invisible rather than flagged.
    const fired = body.rules.find((r) => r.id === "taiwan-strait-seismic");
    const neverFired = body.rules.find((r) => r.id === "nuclear-keywords");
    assert.equal(fired.fires, 1);
    assert.ok(fired.lastFiredAt);
    assert.equal(neverFired.fires, 0, "a rule that never matched is still listed");
    assert.equal(neverFired.lastFiredAt, null);
  } finally {
    if (previousRules === undefined) delete process.env.OSIRIS_ALERT_RULES_PATH;
    else process.env.OSIRIS_ALERT_RULES_PATH = previousRules;
    closeDb();
  }
});
