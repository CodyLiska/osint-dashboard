import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { sanctionsCrossCheck, whoisLookup } from "../src/adapters/intel.js";

const SDN_URL = "treasury.gov/ofac/downloads/sdn.xml";
const evilCorpSdn = `<sdnList><sdnEntry><uid>500</uid><lastName>EVIL CORP</lastName><sdnType>Entity</sdnType><programList><program>CYBER2</program></programList></sdnEntry></sdnList>`;

// vcardArray builder: [prop, value] pairs -> RDAP jCard structure.
const vcard = (pairs) => ["vcard", pairs.map(([prop, value]) => [prop, {}, "text", value])];

// Route RDAP + SDN; other sanctions feeds resolve empty.
function routes({ rdap = {}, sdn = "" } = {}) {
  return (url) => {
    if (url.includes("rdap.org")) return rdap;
    if (url.includes(SDN_URL)) return sdn;
    return "";
  };
}

test("whoisLookup parses a domain RDAP record into a summary", async () => {
  const rdap = {
    ldhName: "EXAMPLE.COM",
    events: [
      { eventAction: "registration", eventDate: "1995-08-14" },
      { eventAction: "expiration", eventDate: "2030-08-13" }
    ],
    nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }, { ldhName: "B.IANA-SERVERS.NET" }],
    status: ["client delete prohibited"],
    entities: [{
      roles: ["registrar"],
      vcardArray: vcard([["fn", "RESERVED-IANA"], ["org", "Internet Assigned Numbers Authority"]])
    }]
  };
  const restore = installFetch(routes({ rdap }));
  try {
    const res = await whoisLookup("example.com");
    assert.equal(res.type, "domain");
    assert.equal(res.summary.domain, "EXAMPLE.COM");
    assert.equal(res.summary.registrar, "Internet Assigned Numbers Authority");
    assert.equal(res.summary.registrationDate, "1995-08-14");
    assert.equal(res.summary.expirationDate, "2030-08-13");
    assert.deepEqual(res.summary.nameservers, ["A.IANA-SERVERS.NET", "B.IANA-SERVERS.NET"]);
    assert.equal(res.sanctions.sanctioned, false); // only the registrar, which is excluded
  } finally {
    restore();
  }
});

test("whoisLookup parses an IP RDAP record and detects the IP branch", async () => {
  const rdap = {
    handle: "NET-8-8-8-0-1",
    name: "GOGL",
    startAddress: "8.8.8.0",
    endAddress: "8.8.8.255",
    ipVersion: "v4",
    country: "US",
    events: [{ eventAction: "registration", eventDate: "2014-03-14" }],
    status: ["active"],
    entities: []
  };
  const restore = installFetch(routes({ rdap }));
  try {
    const res = await whoisLookup("8.8.8.8");
    assert.equal(res.type, "ip");
    assert.equal(res.summary.network, "GOGL");
    assert.equal(res.summary.range, "8.8.8.0 - 8.8.8.255");
    assert.equal(res.summary.country, "US");
  } finally {
    restore();
  }
});

test("whoisLookup flags a sanctioned registrant org", async () => {
  const rdap = {
    ldhName: "SHADY.COM",
    events: [],
    entities: [
      { roles: ["registrar"], vcardArray: vcard([["org", "Some Registrar Inc"]]) },
      { roles: ["registrant"], vcardArray: vcard([["fn", "EVIL CORP"], ["org", "EVIL CORP"]]) }
    ]
  };
  const restore = installFetch(routes({ rdap, sdn: evilCorpSdn }));
  try {
    const res = await whoisLookup("shady.com");
    assert.equal(res.sanctions.sanctioned, true);
    assert.ok(res.sanctions.flagged.some((row) => row.name === "EVIL CORP"));
  } finally {
    restore();
  }
});

test("whoisLookup rejects an empty query with a 400", async () => {
  const restore = installFetch(routes({}));
  try {
    await assert.rejects(whoisLookup("  "), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /query required/);
      return true;
    });
  } finally {
    restore();
  }
});

test("sanctionsCrossCheck filters role/privacy placeholder names before checking", async () => {
  const restore = installFetch(routes({ sdn: "" }));
  try {
    const res = await sanctionsCrossCheck(["abuse", "ab", "REDACTED FOR PRIVACY", "Real Company Ltd"]);
    assert.deepEqual(res.checked, ["Real Company Ltd"]); // the rest are dropped
    assert.equal(res.sanctioned, false);
  } finally {
    restore();
  }
});

test("sanctionsCrossCheck flags a name that matches the sanctions feed", async () => {
  const restore = installFetch(routes({ sdn: evilCorpSdn }));
  try {
    const res = await sanctionsCrossCheck(["EVIL CORP", "Friendly Bakery LLC"]);
    assert.equal(res.sanctioned, true);
    const evil = res.results.find((r) => r.name === "EVIL CORP");
    assert.equal(evil.matchCount, 1);
    assert.equal(evil.matches[0].caption, "EVIL CORP");
  } finally {
    restore();
  }
});
