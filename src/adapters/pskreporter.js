import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { gridToLatLon } from "../lib/maidenhead.js";

// PSKReporter — keyless live picture of active HF radio receivers worldwide. The
// query with no callsign returns every receiver that reported in the window; each
// carries a Maidenhead grid locator (not coordinates), converted via src/lib/maidenhead.
// PSKReporter asks for >=5 min between identical queries, so the cache is generous.
const PSK_URL = "https://retrieve.pskreporter.info/query?flowStartSeconds=-900";
const MAX_RECEIVERS = 1500;

// Region/DXCC/antenna text arrives as numeric XML character references
// (e.g. "&#321;&#243;d&#378;" = "Łódź"), which the named-entity decoder misses.
function decodeEntities(value = "") {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

// The <activeReceiver> elements are attribute-based and self-closing, so the
// shared tag() helper (which reads element bodies) does not apply — parse attrs.
function parseAttrs(fragment) {
  const out = {};
  for (const match of fragment.matchAll(/([\w-]+)="([^"]*)"/g)) out[match[1]] = decodeEntities(match[2]);
  return out;
}

export function parseActiveReceivers(xml) {
  return [...String(xml).matchAll(/<activeReceiver\b([^>]*?)\/>/g)].map((m) => parseAttrs(m[1]));
}

export async function pskReporterLayer() {
  const result = await cachedResilient("pskreporter:active", 10 * 60_000, () =>
    fetchTextRetry(PSK_URL, { headers: { Accept: "application/xml" } }));

  const seen = new Set();
  const entities = [];
  for (const r of parseActiveReceivers(result.value)) {
    if (!r.callsign || seen.has(r.callsign)) continue;
    const point = gridToLatLon(r.locator);
    if (!point) continue;
    seen.add(r.callsign);
    entities.push(entity({
      id: `psk-${r.callsign}`,
      layer: "pskreporter",
      type: "HF receiver",
      name: r.callsign,
      lat: point.lat,
      lon: point.lon,
      severity: 2, // every receiver is the same kind of station — constant, like ransomware
      time: null,
      source: "PSKReporter",
      summary: `${r.mode || "?"} receiver in ${r.region || r.DXCC || r.locator}; monitoring ${r.bands || "?"}.`,
      grid: r.locator,
      mode: r.mode,
      bands: r.bands,
      region: r.region,
      dxcc: r.DXCC,
      antenna: r.antennaInformation
    }));
    if (entities.length >= MAX_RECEIVERS) break;
  }

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      count: entities.length,
      source: "PSKReporter (active HF receivers)"
    }
  };
}
