import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { cyberLayer } from "../src/adapters/cyber.js";

const cve = (id, score) => ({
  cve: {
    id,
    published: "2026-06-01T00:00:00.000",
    descriptions: [{ lang: "en", value: `${id} description` }],
    metrics: { cvssMetricV31: [{ cvssData: { baseScore: score, baseSeverity: score >= 9 ? "CRITICAL" : "HIGH" } }] }
  }
});

// Route the four cyber upstreams by URL. The three NVD queries share one base URL
// and are disambiguated by their query params (hasKev / CRITICAL / HIGH).
function routes({ nvdKev = [], critical = [], high = [], kevCatalog = [], epss = [] } = {}) {
  return (url) => {
    if (url.includes("services.nvd.nist.gov")) {
      if (url.includes("hasKev")) return { vulnerabilities: nvdKev };
      if (url.includes("CRITICAL")) return { vulnerabilities: critical };
      if (url.includes("HIGH")) return { vulnerabilities: high };
      return { vulnerabilities: [] };
    }
    if (url.includes("known_exploited_vulnerabilities")) return { catalogVersion: "2026.06.01", vulnerabilities: kevCatalog };
    if (url.includes("api.first.org")) return { data: epss };
    return {};
  };
}

test("cyberLayer merges NVD buckets, dedupes by CVE, and flags/ranks KEV entries", async () => {
  const saved = process.env.NVD_API_KEY;
  delete process.env.NVD_API_KEY;
  const restore = installJsonFetch(routes({
    critical: [cve("CVE-2026-1111", 9.8)],
    high: [cve("CVE-2026-2222", 7.5), cve("CVE-2026-1111", 9.8)], // 1111 duplicated across buckets
    kevCatalog: [{ cveID: "CVE-2026-1111", vendorProject: "Acme", product: "Widget", dueDate: "2026-07-01" }],
    epss: [{ cve: "CVE-2026-1111", epss: "0.9", percentile: "0.99", date: "2026-06-15" }]
  }));
  try {
    const { entities, meta } = await cyberLayer();
    const byId = Object.fromEntries(entities.map((e) => [e.name, e]));
    assert.equal(entities.length, 2, "duplicate CVE collapsed to one entity");
    assert.equal(entities[0].name, "CVE-2026-1111", "KEV entry ranks first");
    assert.equal(byId["CVE-2026-1111"].kev, true);
    assert.equal(byId["CVE-2026-1111"].type, "Known exploited CVE");
    assert.equal(byId["CVE-2026-1111"].severity, 5); // exploited + score>=9 + epss>=0.7
    assert.equal(byId["CVE-2026-1111"].epss, 0.9);
    assert.equal(byId["CVE-2026-1111"].vendorProject, "Acme");
    assert.equal(byId["CVE-2026-2222"].kev, false);
    assert.equal(meta.cisaKevCatalogDate, "2026.06.01");
    assert.equal(meta.sourceCounts.epssEnriched, 1);
  } finally {
    restore();
    if (saved === undefined) delete process.env.NVD_API_KEY; else process.env.NVD_API_KEY = saved;
  }
});

test("cyberLayer scores severity from CVSS when not exploited", async () => {
  const restore = installJsonFetch(routes({
    critical: [cve("CVE-A", 9.5)],
    high: [cve("CVE-B", 7.2), cve("CVE-C", 5.0)]
  }));
  try {
    const { entities } = await cyberLayer();
    const byId = Object.fromEntries(entities.map((e) => [e.name, e]));
    assert.equal(byId["CVE-A"].severity, 5); // >=9
    assert.equal(byId["CVE-B"].severity, 4); // >=7
    assert.equal(byId["CVE-C"].severity, 3); // >=4
    assert.ok(entities.every((e) => e.kev === false && e.layer === "cyber"));
  } finally {
    restore();
  }
});
