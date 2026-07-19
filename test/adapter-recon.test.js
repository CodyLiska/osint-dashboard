import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { clearCache } from "../src/lib/cache.js";
import { sanctionedCrypto, btcLookup, ethLookup, cryptoLayer, sanctionsLayer, sanctionsSearch, cveSearch } from "../src/adapters/recon.js";

const SDN_URL = "treasury.gov/ofac/downloads/sdn.xml";

// Minimal OFAC SDN XML with two digital-currency addresses on one entry.
const cryptoSdnXml = `<sdnList>
  <sdnEntry>
    <uid>4001</uid>
    <lastName>EVIL CORP</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>CYBER2</program></programList>
    <idList>
      <id><idType>Digital Currency Address - XBT</idType><idNumber>1EvilBtcAddr</idNumber></id>
      <id><idType>Digital Currency Address - ETH</idType><idNumber>0xEvilEthAddr</idNumber></id>
      <id><idType>Passport</idType><idNumber>P-999</idNumber></id>
    </idList>
  </sdnEntry>
  <sdnEntry>
    <uid>4002</uid>
    <lastName>CLEAN CO</lastName>
    <sdnType>Entity</sdnType>
  </sdnEntry>
</sdnList>`;

// Minimal OFAC SDN XML with one individual (for sanctions layer / search / cross-check).
const entitySdnXml = `<sdnList>
  <sdnEntry>
    <uid>111</uid>
    <firstName>Vladimir</firstName>
    <lastName>TESTOV</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>UKRAINE-EO13661</program></programList>
    <countryList><country>Russia</country></countryList>
    <akaList><aka><lastName>TESTOV ALIAS</lastName></aka></akaList>
    <idList><id><idType>Passport</idType><idNumber>P1</idNumber></id></idList>
  </sdnEntry>
</sdnList>`;

// A valid eth_getBalance RPC reply (0x1bc16d674ec80000 wei = 2 ETH) unless overridden.
const ethRpc = (result = "0x1bc16d674ec80000") => ({ jsonrpc: "2.0", id: 1, result });

// A valid Ethplorer getAddressInfo reply: ETH balance + N ERC-20 tokens.
const ethplorerInfo = (balance = 2, tokenCount = 1) => ({
  ETH: { balance },
  tokens: Array.from({ length: tokenCount }, (_, i) => ({
    tokenInfo: { symbol: `TK${i}`, name: `Token ${i}`, decimals: "18", address: `0xtok${i}` },
    rawBalance: "1000000000000000000"
  }))
});

// Resolver: SDN url -> given xml; other sanctions feeds -> empty; chain APIs / NVD -> JSON.
function routes({ sdn = "", btc = {}, eth = ethRpc(), ethplorer = ethplorerInfo(), nvd = {} } = {}) {
  return (url) => {
    if (url.includes(SDN_URL)) return sdn;
    if (url.includes("blockstream.info")) return btc;
    if (url.includes("api.ethplorer.io")) return ethplorer;
    if (url.includes("ethereum.publicnode.com")) return eth;
    if (url.includes("services.nvd.nist.gov")) return nvd;
    return ""; // consolidated / UN / UK feeds: empty
  };
}

test("sanctionedCrypto parses digital-currency addresses from OFAC SDN XML", async () => {
  const restore = installFetch(routes({ sdn: cryptoSdnXml }));
  try {
    const rows = await sanctionedCrypto();
    assert.equal(rows.length, 2); // XBT + ETH, the Passport id is ignored
    const byChain = Object.fromEntries(rows.map((r) => [r.chain, r]));
    assert.equal(byChain.XBT.address, "1EvilBtcAddr");
    assert.equal(byChain.ETH.address, "0xEvilEthAddr");
    assert.equal(byChain.XBT.name, "EVIL CORP");
    assert.deepEqual(byChain.XBT.programs, ["CYBER2"]);
  } finally {
    restore();
  }
});

test("btcLookup flags an address present in the OFAC list (case-insensitive)", async () => {
  const restore = installFetch(routes({ sdn: cryptoSdnXml, btc: { address: "x", chain_stats: {} } }));
  try {
    const hit = await btcLookup("1evilbtcaddr"); // lowercase input still matches
    assert.equal(hit.sanctioned, true);
    assert.equal(hit.chain, "BTC");
    const miss = await btcLookup("1SomeCleanAddress");
    assert.equal(miss.sanctioned, false);
  } finally {
    restore();
  }
});

test("ethLookup flags a sanctioned ETH address and returns Ethplorer balance + tokens", async () => {
  const restore = installFetch(routes({ sdn: cryptoSdnXml, ethplorer: ethplorerInfo(2, 3) }));
  try {
    const hit = await ethLookup("0xEvilEthAddr");
    assert.equal(hit.sanctioned, true);
    assert.equal(hit.chain, "ETH");
    assert.equal(hit.data.balanceEth, 2);
    assert.equal(hit.data.tokenCount, 3);
    assert.equal(hit.data.tokens[0].balance, 1); // rawBalance 1e18 / 1e18 decimals
    assert.match(hit.data.source, /ethplorer/);
  } finally {
    restore();
  }
});

test("ethLookup falls back to the RPC balance when Ethplorer is down", async () => {
  clearCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.ethplorer.io")) return new Response("down", { status: 503, statusText: "Service Unavailable" });
    if (u.includes("ethereum.publicnode.com")) {
      return new Response(JSON.stringify(ethRpc()), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(cryptoSdnXml, { status: 200 });
  };
  try {
    const hit = await ethLookup("0xEvilEthAddr");
    assert.equal(hit.data.balanceEth, 2);           // from the RPC fallback (2 ETH)
    assert.equal(hit.data.balanceWei, "2000000000000000000");
    assert.match(hit.data.source, /publicnode/);
    assert.ok(hit.data.note, "notes that token data is unavailable");
  } finally {
    globalThis.fetch = original;
    clearCache();
  }
});

test("ethLookup keeps the OFAC result when BOTH chain sources fail", async () => {
  // Both Ethplorer and the RPC fallback throw; OFAC data still available — the
  // sanctions verdict must survive and the chain error is surfaced in data.
  clearCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.ethplorer.io") || u.includes("ethereum.publicnode.com")) {
      return new Response("boom", { status: 503, statusText: "Service Unavailable" });
    }
    return new Response(cryptoSdnXml, { status: 200 });
  };
  try {
    const hit = await ethLookup("0xEvilEthAddr");
    assert.equal(hit.sanctioned, true); // OFAC check unaffected by the chain outage
    assert.ok(hit.data.error, "chain error is surfaced in data");
    assert.equal(hit.data.balanceEth, undefined);
  } finally {
    globalThis.fetch = original;
    clearCache();
  }
});

test("cryptoLayer builds entities with chain counts", async () => {
  const restore = installFetch(routes({ sdn: cryptoSdnXml }));
  try {
    const { entities, meta } = await cryptoLayer();
    assert.equal(entities.length, 2);
    assert.equal(meta.totalAddresses, 2);
    assert.deepEqual(meta.chainCounts, { XBT: 1, ETH: 1 });
    assert.ok(entities.every((e) => e.severity === 5 && e.layer === "crypto"));
  } finally {
    restore();
  }
});

test("sanctionsLayer groups official entries by default", async () => {
  const restore = installFetch(routes({ sdn: entitySdnXml }));
  try {
    const { entities, meta } = await sanctionsLayer();
    assert.equal(meta.displayMode, "grouped");
    assert.equal(meta.totalEntries, 1);
    assert.deepEqual(meta.sourceCounts, { "OFAC SDN": 1 });
    assert.equal(entities.length, 1);
    assert.equal(entities[0].groupCount, 1);
    assert.match(entities[0].name, /Russia/);
  } finally {
    restore();
  }
});

test("sanctionsLayer supports individual display mode", async () => {
  const restore = installFetch(routes({ sdn: entitySdnXml }));
  const saved = process.env.SANCTIONS_DISPLAY_MODE;
  process.env.SANCTIONS_DISPLAY_MODE = "individual";
  try {
    const { entities, meta } = await sanctionsLayer();
    assert.equal(meta.displayMode, "individual");
    assert.equal(entities.length, 1);
    assert.equal(entities[0].sdnName, "Vladimir TESTOV");
    assert.equal(entities[0].country, "Russia");
  } finally {
    if (saved === undefined) delete process.env.SANCTIONS_DISPLAY_MODE; else process.env.SANCTIONS_DISPLAY_MODE = saved;
    restore();
  }
});

test("sanctionsSearch matches names in the local fallback and reports misses", async () => {
  const restore = installFetch(routes({ sdn: entitySdnXml }));
  try {
    const hit = await sanctionsSearch("testov");
    assert.equal(hit.fallback, "local-official-sanctions");
    assert.equal(hit.total.value, 1);
    assert.equal(hit.results[0].caption, "Vladimir TESTOV");

    const miss = await sanctionsSearch("nonexistent-name");
    assert.equal(miss.total.value, 0);

    const empty = await sanctionsSearch("   ");
    assert.deepEqual(empty.results, []);
  } finally {
    restore();
  }
});

test("cveSearch passes NVD results through and tags the source", async () => {
  const nvd = { totalResults: 1, vulnerabilities: [{ cve: { id: "CVE-2026-0001" } }] };
  const restore = installFetch(routes({ nvd }));
  try {
    const res = await cveSearch("log4j");
    assert.equal(res.totalResults, 1);
    assert.equal(res.vulnerabilities[0].cve.id, "CVE-2026-0001");
    assert.equal(res.meta.source, "NVD");
  } finally {
    restore();
  }
});
