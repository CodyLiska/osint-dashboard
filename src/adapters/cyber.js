import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

const nvdBase = "https://services.nvd.nist.gov/rest/json/cves/2.0";

function isoNoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000");
}

function dateWindow(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60_000);
  return { start: isoNoZ(start), end: isoNoZ(end) };
}

function cvssMetric(cve) {
  return cve.metrics?.cvssMetricV40?.[0]
    || cve.metrics?.cvssMetricV31?.[0]
    || cve.metrics?.cvssMetricV30?.[0]
    || cve.metrics?.cvssMetricV2?.[0]
    || null;
}

function cvssScore(cve) {
  return Number(cvssMetric(cve)?.cvssData?.baseScore || 0);
}

function severityFromScore(score, exploited, epss) {
  if (exploited || score >= 9 || epss >= 0.7) return 5;
  if (score >= 7 || epss >= 0.3) return 4;
  if (score >= 4 || epss >= 0.1) return 3;
  return 2;
}

async function nvdQuery(key, params, ttlMs = 30 * 60_000) {
  const headers = process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : {};
  const result = await cachedResilient(`nvd:${key}`, ttlMs, () =>
    fetchJsonRetry(`${nvdBase}?${params.toString()}`, { headers })
  );
  return { ...result.value, cached: result.cached, stale: result.stale };
}

async function cisaKevCatalog() {
  const result = await cachedResilient("cisa:kev", 60 * 60_000, () =>
    fetchJsonRetry("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json")
  );
  return { ...result.value, cached: result.cached, stale: result.stale };
}

async function epssFor(cves) {
  const unique = [...new Set(cves)].filter(Boolean).slice(0, 120);
  if (!unique.length) return new Map();

  const chunks = [];
  for (let i = 0; i < unique.length; i += 80) chunks.push(unique.slice(i, i + 80));

  const rows = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({ cve: chunk.join(",") });
    const result = await cachedResilient(`epss:${chunk.join(",")}`, 6 * 60 * 60_000, () =>
      fetchJsonRetry(`https://api.first.org/data/v1/epss?${params}`)
    );
    rows.push(...(result.value.data || []));
  }

  return new Map(rows.map((row) => [row.cve, {
    epss: Number(row.epss),
    percentile: Number(row.percentile),
    date: row.date
  }]));
}

function sourcePoint(source, index) {
  const anchors = {
    "CISA KEV": [-77.0369, 38.9072],
    "NVD Critical": [-77.0369, 38.9072],
    "NVD High": [-77.0369, 38.9072],
    "FIRST EPSS": [-74.0060, 40.7128]
  };
  const [lon, lat] = anchors[source] || [-95, 39];
  return {
    lon: lon + Math.cos(index * 0.85) * 3.5,
    lat: lat + Math.sin(index * 0.85) * 2.4
  };
}

function cveSummary(cve) {
  return cve.descriptions?.find((row) => row.lang === "en")?.value
    || cve.descriptions?.[0]?.value
    || "No description available.";
}

function toEntity(item, index) {
  const cve = item.cve;
  const score = cvssScore(cve);
  const epss = item.epss?.epss || 0;
  const exploited = Boolean(item.kev);
  const point = sourcePoint(item.sourceBucket, index);
  const source = exploited ? "CISA KEV / NVD" : item.sourceBucket;
  return entity({
    id: `cve-${cve.id}`,
    layer: "cyber",
    type: exploited ? "Known exploited CVE" : "CVE",
    name: cve.id,
    lat: point.lat,
    lon: point.lon,
    severity: severityFromScore(score, exploited, epss),
    time: cve.published || item.kev?.dateAdded || null,
    source,
    summary: cveSummary(cve),
    url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
    cvss: score || null,
    epss: item.epss?.epss || null,
    epssPercentile: item.epss?.percentile || null,
    kev: exploited,
    vendorProject: item.kev?.vendorProject || null,
    product: item.kev?.product || null,
    dueDate: item.kev?.dueDate || null,
    sourceBucket: item.sourceBucket,
    raw: item
  });
}

export async function cyberLayer() {
  const { start, end } = dateWindow(Number(process.env.CYBER_NVD_WINDOW_DAYS || 30));

  const kevParams = new URLSearchParams({
    hasKev: "",
    resultsPerPage: "40"
  });
  const criticalParams = new URLSearchParams({
    cvssV3Severity: "CRITICAL",
    pubStartDate: start,
    pubEndDate: end,
    resultsPerPage: "40"
  });
  const highParams = new URLSearchParams({
    cvssV3Severity: "HIGH",
    pubStartDate: start,
    pubEndDate: end,
    resultsPerPage: "30"
  });

  const [kevCatalog, nvdKev, critical, high] = await Promise.all([
    cisaKevCatalog().catch(() => ({ vulnerabilities: [] })),
    nvdQuery("kev", kevParams),
    nvdQuery(`critical:${start}:${end}`, criticalParams),
    nvdQuery(`high:${start}:${end}`, highParams)
  ]);

  const kevByCve = new Map((kevCatalog.vulnerabilities || []).map((row) => [row.cveID, row]));
  const merged = new Map();

  function addRows(rows, sourceBucket) {
    for (const entry of rows || []) {
      const id = entry.cve?.id;
      if (!id) continue;
      const previous = merged.get(id);
      const next = {
        cve: entry.cve,
        sourceBucket,
        kev: kevByCve.get(id) || previous?.kev || null
      };
      if (!previous || (next.kev && !previous.kev) || cvssScore(next.cve) > cvssScore(previous.cve)) {
        merged.set(id, { ...previous, ...next });
      }
    }
  }

  addRows(nvdKev.vulnerabilities, "CISA KEV");
  addRows(critical.vulnerabilities, "NVD Critical");
  addRows(high.vulnerabilities, "NVD High");

  const epss = await epssFor([...merged.keys()]).catch(() => new Map());
  const entities = [...merged.values()]
    .map((item) => ({ ...item, epss: epss.get(item.cve.id) || null }))
    .sort((a, b) => {
      const aRisk = (a.kev ? 100 : 0) + cvssScore(a.cve) + ((a.epss?.epss || 0) * 10);
      const bRisk = (b.kev ? 100 : 0) + cvssScore(b.cve) + ((b.epss?.epss || 0) * 10);
      return bRisk - aRisk;
    })
    .slice(0, Number(process.env.CYBER_MAX_ITEMS || 80))
    .map(toEntity)
    .filter(finiteCoordinate);

  return {
    entities,
    meta: {
      source: "CISA KEV, NVD, FIRST EPSS",
      count: entities.length,
      nvdWindowDays: Number(process.env.CYBER_NVD_WINDOW_DAYS || 30),
      cisaKevCatalogDate: kevCatalog.catalogVersion || null,
      sourceCounts: {
        nvdKev: nvdKev.vulnerabilities?.length || 0,
        critical: critical.vulnerabilities?.length || 0,
        high: high.vulnerabilities?.length || 0,
        epssEnriched: [...epss.keys()].length
      },
      nvdApiKeyConfigured: Boolean(process.env.NVD_API_KEY),
      cached: Boolean(nvdKev.cached && critical.cached && high.cached),
      stale: Boolean(nvdKev.stale || critical.stale || high.stale || kevCatalog.stale)
    }
  };
}
