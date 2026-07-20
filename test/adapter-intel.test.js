import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { crtShLookup, domainIntel, feodoLookup, ipIntel, malwareBazaarLookup, ripeStatLookup, sanctionsCrossCheck, shodanInternetDb, spamhausDropLookup, threatFoxLookup, torExitLookup, urlhausHostLookup, urlScanLookup, whoisLookup } from "../src/adapters/intel.js";
import { clearCache } from "../src/lib/cache.js";

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

test("shodanInternetDb returns exposure data on a 200", async () => {
  const restore = installFetch((url) => url.includes("internetdb.shodan.io")
    ? { ip: "1.1.1.1", ports: [53, 443], vulns: ["CVE-2021-1234"], tags: ["cdn"], hostnames: ["one.one.one.one"], cpes: [] }
    : "");
  try {
    const res = await shodanInternetDb("1.1.1.1");
    assert.equal(res.source, "Shodan InternetDB");
    assert.deepEqual(res.data.ports, [53, 443]);
    assert.deepEqual(res.data.vulns, ["CVE-2021-1234"]);
    assert.equal(res.data.found, true);
  } finally {
    restore();
  }
});

test("shodanInternetDb treats a 404 as an empty result, not an error", async () => {
  const original = globalThis.fetch;
  clearCache();
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "No information available" }), {
    status: 404,
    headers: { "content-type": "application/json" }
  });
  try {
    const res = await shodanInternetDb("192.0.2.1");
    assert.equal(res.data.found, false);
    assert.deepEqual(res.data.ports, []);
  } finally {
    globalThis.fetch = original;
    clearCache();
  }
});

test("ipIntel includes the Shodan InternetDB result alongside the other sources", async () => {
  const restore = installFetch((url) => url.includes("internetdb.shodan.io")
    ? { ip: "8.8.8.8", ports: [53], vulns: [], tags: [], hostnames: ["dns.google"], cpes: [] }
    : "");
  try {
    const res = await ipIntel("8.8.8.8");
    const shodan = res.results.find((r) => r.source === "Shodan InternetDB");
    assert.ok(shodan, "ipIntel results should include a Shodan InternetDB entry");
    assert.deepEqual(shodan.data.ports, [53]);
  } finally {
    restore();
  }
});

test("feodoLookup flags an IP present in the C2 blocklist", async () => {
  const restore = installFetch((url) => url.includes("feodotracker.abuse.ch")
    ? [{ ip_address: "162.243.103.246", port: 8080, status: "offline", malware: "Emotet", as_name: "DIGITALOCEAN-ASN", country: "US", first_seen: "2022-06-04 21:24:53", last_online: "2026-03-07" }]
    : "");
  try {
    const res = await feodoLookup("162.243.103.246");
    assert.equal(res.source, "Feodo Tracker");
    assert.equal(res.data.c2, true);
    assert.equal(res.data.malware, "Emotet");
    assert.equal(res.data.port, 8080);
  } finally {
    restore();
  }
});

test("feodoLookup returns c2:false for an IP not in the blocklist", async () => {
  const restore = installFetch((url) => url.includes("feodotracker.abuse.ch")
    ? [{ ip_address: "1.2.3.4", malware: "Dridex" }]
    : "");
  try {
    const res = await feodoLookup("8.8.8.8");
    assert.equal(res.data.c2, false);
    assert.equal(res.data.malware, undefined);
  } finally {
    restore();
  }
});

test("ipIntel includes the Feodo Tracker result", async () => {
  const restore = installFetch((url) => {
    if (url.includes("feodotracker.abuse.ch")) return [{ ip_address: "5.6.7.8", malware: "QakBot", port: 443, status: "online" }];
    if (url.includes("internetdb.shodan.io")) return { ip: "5.6.7.8", ports: [], vulns: [], tags: [], hostnames: [], cpes: [] };
    return "";
  });
  try {
    const res = await ipIntel("5.6.7.8");
    const feodo = res.results.find((r) => r.source === "Feodo Tracker");
    assert.ok(feodo, "ipIntel results should include a Feodo Tracker entry");
    assert.equal(feodo.data.c2, true);
    assert.equal(feodo.data.malware, "QakBot");
  } finally {
    restore();
  }
});

test("threatFoxLookup returns matched IOCs when the abuse.ch key is set", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  process.env.ABUSE_CH_AUTH_KEY = "test-key";
  const restore = installFetch((url) => url.includes("threatfox-api.abuse.ch")
    ? { query_status: "ok", data: [{ malware_printable: "Cobalt Strike", threat_type: "botnet_cc", confidence_level: 100, first_seen: "2026-07-01", tags: ["cs"], reference: "https://threatfox.abuse.ch/ioc/1" }] }
    : "");
  try {
    const res = await threatFoxLookup("139.180.203.104");
    assert.equal(res.source, "ThreatFox");
    assert.equal(res.data.matchCount, 1);
    assert.equal(res.data.matches[0].malware, "Cobalt Strike");
    assert.equal(res.data.matches[0].threatType, "botnet_cc");
  } finally {
    restore();
    if (prev === undefined) delete process.env.ABUSE_CH_AUTH_KEY; else process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("threatFoxLookup rejects with 400 when no abuse.ch key is configured", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  delete process.env.ABUSE_CH_AUTH_KEY;
  const restore = installFetch(() => "");
  try {
    await assert.rejects(threatFoxLookup("1.2.3.4"), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /ABUSE_CH_AUTH_KEY/);
      return true;
    });
  } finally {
    restore();
    if (prev !== undefined) process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("urlhausHostLookup returns hosted malicious URLs when the key is set", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  process.env.ABUSE_CH_AUTH_KEY = "test-key";
  const restore = installFetch((url) => url.includes("urlhaus-api.abuse.ch")
    ? { query_status: "ok", url_count: "2", firstseen: "2026-06-01", urls: [{ url: "http://evil.test/x", url_status: "online", threat: "malware_download", date_added: "2026-06-01", tags: ["elf"] }] }
    : "");
  try {
    const res = await urlhausHostLookup("5.6.7.8");
    assert.equal(res.source, "URLhaus");
    assert.equal(res.data.urlCount, 2);
    assert.equal(res.data.urls[0].threat, "malware_download");
  } finally {
    restore();
    if (prev === undefined) delete process.env.ABUSE_CH_AUTH_KEY; else process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("ipIntel includes ThreatFox + URLhaus, and they degrade gracefully without a key", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  // With a key: both appear as data results.
  process.env.ABUSE_CH_AUTH_KEY = "test-key";
  let restore = installFetch((url) => {
    if (url.includes("threatfox-api.abuse.ch")) return { query_status: "no_result", data: [] };
    if (url.includes("urlhaus-api.abuse.ch")) return { query_status: "no_results", urls: [] };
    if (url.includes("feodotracker.abuse.ch")) return [];
    if (url.includes("internetdb.shodan.io")) return { ip: "9.9.9.9", ports: [], vulns: [], tags: [], hostnames: [], cpes: [] };
    return "";
  });
  try {
    const withKey = await ipIntel("9.9.9.9");
    assert.ok(withKey.results.find((r) => r.source === "ThreatFox" && r.data));
    assert.ok(withKey.results.find((r) => r.source === "URLhaus" && r.data));
  } finally {
    restore();
  }
  // Without a key: they still appear, but as error entries (not configured).
  delete process.env.ABUSE_CH_AUTH_KEY;
  restore = installFetch((url) => url.includes("internetdb.shodan.io")
    ? { ip: "9.9.9.9", ports: [], vulns: [], tags: [], hostnames: [], cpes: [] } : "");
  try {
    const noKey = await ipIntel("9.9.9.9");
    const tf = noKey.results.find((r) => r.source === "ThreatFox");
    assert.ok(tf.error && /ABUSE_CH_AUTH_KEY/.test(tf.error), "ThreatFox should report the missing key");
  } finally {
    restore();
    if (prev !== undefined) process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("torExitLookup flags an IP present in the bulk exit list", async () => {
  const restore = installFetch((url) => url.includes("torproject.org")
    ? "171.25.193.25\n80.67.167.81\n198.98.51.189" : "");
  try {
    const hit = await torExitLookup("80.67.167.81");
    assert.equal(hit.source, "Tor Exit Nodes");
    assert.equal(hit.data.torExit, true);
    const miss = await torExitLookup("8.8.8.8");
    assert.equal(miss.data.torExit, false);
  } finally {
    restore();
  }
});

test("spamhausDropLookup flags an IP inside a listed CIDR (and clears one outside)", async () => {
  const drop = [
    '{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}',
    '{"cidr":"2.56.0.0/16","sblid":"SBL400000","rir":"ripe"}',
    '{"metadata":"footer line without a cidr"}'
  ].join("\n");
  const restore = installFetch((url) => url.includes("spamhaus.org") ? drop : "");
  try {
    const inside = await spamhausDropLookup("1.10.20.5"); // within 1.10.16.0/20
    assert.equal(inside.data.listed, true);
    assert.equal(inside.data.cidr, "1.10.16.0/20");
    assert.equal(inside.data.sblid, "SBL256894");
    const outside = await spamhausDropLookup("8.8.8.8");
    assert.equal(outside.data.listed, false);
    const edge = await spamhausDropLookup("1.10.32.0"); // just past the /20 boundary
    assert.equal(edge.data.listed, false);
  } finally {
    restore();
  }
});

test("ipIntel includes Tor and Spamhaus results in the fan-out", async () => {
  const restore = installFetch((url) => {
    if (url.includes("torproject.org")) return "9.9.9.9";
    if (url.includes("spamhaus.org")) return '{"cidr":"9.9.9.0/24","sblid":"SBL1"}';
    if (url.includes("internetdb.shodan.io")) return { ip: "9.9.9.9", ports: [], vulns: [], tags: [], hostnames: [], cpes: [] };
    if (url.includes("feodotracker.abuse.ch")) return [];
    return "";
  });
  try {
    const res = await ipIntel("9.9.9.9");
    assert.ok(res.results.find((r) => r.source === "Tor Exit Nodes" && r.data.torExit === true));
    assert.ok(res.results.find((r) => r.source === "Spamhaus DROP" && r.data.listed === true));
  } finally {
    restore();
  }
});

test("malwareBazaarLookup returns sample metadata when the abuse.ch key is set", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  process.env.ABUSE_CH_AUTH_KEY = "test-key";
  const restore = installFetch((url) => url.includes("mb-api.abuse.ch")
    ? { query_status: "ok", data: [{ sha256_hash: "abc123", file_name: "evil.exe", file_type: "exe", file_size: 4096, signature: "Emotet", tags: ["exe", "Emotet"], first_seen: "2026-06-01" }] }
    : "");
  try {
    const res = await malwareBazaarLookup("abc123");
    assert.equal(res.source, "MalwareBazaar");
    assert.equal(res.data.found, true);
    assert.equal(res.data.signature, "Emotet");
    assert.equal(res.data.fileName, "evil.exe");
  } finally {
    restore();
    if (prev === undefined) delete process.env.ABUSE_CH_AUTH_KEY; else process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("malwareBazaarLookup reports found:false for an unknown hash", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  process.env.ABUSE_CH_AUTH_KEY = "test-key";
  const restore = installFetch((url) => url.includes("mb-api.abuse.ch") ? { query_status: "hash_not_found" } : "");
  try {
    const res = await malwareBazaarLookup("deadbeef");
    assert.equal(res.data.found, false);
    assert.equal(res.data.status, "hash_not_found");
  } finally {
    restore();
    if (prev === undefined) delete process.env.ABUSE_CH_AUTH_KEY; else process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("malwareBazaarLookup rejects with 400 when no abuse.ch key is configured", async () => {
  const prev = process.env.ABUSE_CH_AUTH_KEY;
  delete process.env.ABUSE_CH_AUTH_KEY;
  const restore = installFetch(() => "");
  try {
    await assert.rejects(malwareBazaarLookup("abc"), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /ABUSE_CH_AUTH_KEY/);
      return true;
    });
  } finally {
    restore();
    if (prev !== undefined) process.env.ABUSE_CH_AUTH_KEY = prev;
  }
});

test("crtShLookup extracts unique subdomains and drops wildcards/non-matches", async () => {
  const restore = installFetch((url) => url.includes("crt.sh")
    ? [
        { name_value: "github.com\nwww.github.com" },
        { name_value: "*.github.com" },        // wildcard → dropped
        { name_value: "api.github.com" },
        { name_value: "www.github.com" },      // duplicate
        { name_value: "evil.example.com" }     // different domain → dropped
      ]
    : "");
  try {
    const res = await crtShLookup("github.com");
    assert.equal(res.source, "crt.sh");
    assert.deepEqual(res.data.subdomains, ["api.github.com", "github.com", "www.github.com"]);
    assert.equal(res.data.count, 3);
  } finally {
    restore();
  }
});

test("domainIntel fans out to crt.sh (keyless) even when the keyed sources are unconfigured", async () => {
  const prevVt = process.env.VIRUSTOTAL_API_KEY;
  const prevAbuse = process.env.ABUSE_CH_AUTH_KEY;
  delete process.env.VIRUSTOTAL_API_KEY;
  delete process.env.ABUSE_CH_AUTH_KEY;
  const restore = installFetch((url) => url.includes("crt.sh") ? [{ name_value: "a.evil.test" }] : "");
  try {
    const res = await domainIntel("evil.test");
    assert.equal(res.type, "domain");
    const crt = res.results.find((r) => r.source === "crt.sh");
    assert.ok(crt && crt.data.count === 1, "crt.sh result is present with data");
    // the keyed sources surface as error entries, not failures of the whole lookup
    assert.ok(res.results.find((r) => r.source === "VirusTotal" && r.error));
    assert.ok(res.results.find((r) => r.source === "URLhaus" && r.error));
  } finally {
    restore();
    if (prevVt !== undefined) process.env.VIRUSTOTAL_API_KEY = prevVt;
    if (prevAbuse !== undefined) process.env.ABUSE_CH_AUTH_KEY = prevAbuse;
  }
});

test("ripeStatLookup returns the ASN, prefix, and AS holder for an IP", async () => {
  const restore = installFetch((url) => {
    if (url.includes("network-info")) return { data: { asns: ["15169"], prefix: "8.8.8.0/24" } };
    if (url.includes("as-overview")) return { data: { holder: "GOOGLE - Google LLC" } };
    return "";
  });
  try {
    const res = await ripeStatLookup("8.8.8.8");
    assert.equal(res.source, "RIPEstat");
    assert.deepEqual(res.data.asns, ["15169"]);
    assert.equal(res.data.prefix, "8.8.8.0/24");
    assert.equal(res.data.holder, "GOOGLE - Google LLC");
  } finally {
    restore();
  }
});

test("ipIntel includes the RIPEstat network result", async () => {
  const restore = installFetch((url) => {
    if (url.includes("network-info")) return { data: { asns: ["13335"], prefix: "1.1.1.0/24" } };
    if (url.includes("as-overview")) return { data: { holder: "CLOUDFLARENET" } };
    if (url.includes("internetdb.shodan.io")) return { ip: "1.1.1.1", ports: [], vulns: [], tags: [], hostnames: [], cpes: [] };
    if (url.includes("feodotracker.abuse.ch")) return [];
    return "";
  });
  try {
    const res = await ipIntel("1.1.1.1");
    const ripe = res.results.find((r) => r.source === "RIPEstat");
    assert.ok(ripe && ripe.data.holder === "CLOUDFLARENET");
  } finally {
    restore();
  }
});

test("urlScanLookup summarizes recent scans of a domain", async () => {
  const restore = installFetch((url) => url.includes("urlscan.io")
    ? { total: 42, results: [{ page: { url: "https://evil.test/x", ip: "1.2.3.4", country: "RU", server: "nginx", title: "Phish" }, task: { time: "2026-07-01T00:00:00Z" } }] }
    : "");
  try {
    const res = await urlScanLookup("evil.test");
    assert.equal(res.source, "URLScan.io");
    assert.equal(res.data.total, 42);
    assert.equal(res.data.recent[0].ip, "1.2.3.4");
    assert.equal(res.data.recent[0].country, "RU");
  } finally {
    restore();
  }
});
