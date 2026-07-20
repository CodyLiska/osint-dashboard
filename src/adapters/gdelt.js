import { inflateRawSync } from "node:zlib";
import { cachedResilient } from "../lib/cache.js";
import { fetchBufferRetry, fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// GDELT 2.0 georeferenced global event stream. The GEO 2.0 GeoJSON API is dead
// (404s), and the DOC API is hard rate-limited (1 req / 5s), so we read the
// authoritative source directly: the static Events file the project publishes
// every 15 minutes. lastupdate.txt names the latest .export.CSV.zip; we fetch,
// unzip (single-entry ZIP via node:zlib — no npm dep), and parse the tab-CSV.
const MANIFEST_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";

// Column indices into the 61-field GDELT 2.0 Event record (no header row).
const COL = {
  id: 0, root: 28, quad: 29, gold: 30, mentions: 31, articles: 33, tone: 34,
  name: 52, lat: 56, lon: 57, dateAdded: 59, url: 60
};

// CAMEO EventRootCode → human label (the 20 root categories).
const CAMEO_ROOT = {
  "01": "Public Statement", "02": "Appeal", "03": "Intent to Cooperate", "04": "Consult",
  "05": "Diplomatic Cooperation", "06": "Material Cooperation", "07": "Provide Aid", "08": "Yield",
  "09": "Investigate", "10": "Demand", "11": "Disapprove", "12": "Reject", "13": "Threaten",
  "14": "Protest", "15": "Force Posture", "16": "Reduce Relations", "17": "Coerce",
  "18": "Assault", "19": "Fight", "20": "Mass Violence"
};

// QuadClass drives severity so the global stream sorts on the situational axis
// that matters: material conflict is loudest, verbal cooperation quietest.
const QUAD = {
  1: { label: "Verbal cooperation", severity: 1 },
  2: { label: "Material cooperation", severity: 2 },
  3: { label: "Verbal conflict", severity: 4 },
  4: { label: "Material conflict", severity: 5 }
};

// Extract the single entry from a ZIP whose one member is stored or deflated.
// GDELT's files are pre-built (sizes present in the local header), so we read the
// compressed size straight from it rather than scanning for the central directory.
export function unzipSingleEntry(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("not a ZIP local header");
  const method = buffer.readUInt16LE(8);
  const compSize = buffer.readUInt32LE(18);
  const start = 30 + buffer.readUInt16LE(26) + buffer.readUInt16LE(28); // + name + extra
  const data = buffer.subarray(start, compSize ? start + compSize : undefined);
  return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
}

function isoFromStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

// Parse the tab-delimited Events CSV into normalized entities: keep only rows with
// a real action location, tag with the CAMEO category, derive severity from the
// conflict/cooperation class, then rank by press coverage and cap.
export function parseGdeltEvents(text, { max = 500 } = {}) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const lat = Number(c[COL.lat]);
    const lon = Number(c[COL.lon]);
    const name = c[COL.name];
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const quad = QUAD[Number(c[COL.quad])] || { label: null, severity: 2 };
    const articles = Number(c[COL.articles]) || 0;
    rows.push(entity({
      id: `gdelt-${c[COL.id]}`,
      layer: "gdelt",
      type: CAMEO_ROOT[c[COL.root]] || "Event",
      name,
      lat,
      lon,
      severity: quad.severity,
      time: isoFromStamp(c[COL.dateAdded]),
      source: "GDELT",
      url: c[COL.url] || null,
      eventClass: quad.label,
      goldstein: Number(c[COL.gold]),
      articles,
      tone: Number(c[COL.tone])
    }));
  }
  // Most-covered events first so the cap keeps the globally significant ones.
  rows.sort((a, b) => b.articles - a.articles);
  return rows.slice(0, max).filter(finiteCoordinate);
}

export async function gdeltLayer() {
  const max = Number(process.env.GDELT_MAX_ITEMS) || 500;
  // 15-min TTL matches GDELT's publish cadence; one fetch serves all viewers and a
  // failure serves the last-good slice (stale) instead of erroring.
  const result = await cachedResilient("gdelt:events", 15 * 60_000, async () => {
    const manifest = await fetchTextRetry(MANIFEST_URL, {}, { timeoutMs: 15_000 });
    const line = manifest.split("\n").find((row) => row.includes(".export.CSV.zip"));
    const url = line && line.trim().split(/\s+/)[2];
    if (!url) throw new Error("GDELT manifest missing export URL");
    const zip = await fetchBufferRetry(url, {}, { timeoutMs: 30_000 });
    return parseGdeltEvents(unzipSingleEntry(zip), { max });
  });

  return {
    entities: result.value,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "GDELT 2.0 Events (data.gdeltproject.org)"
    }
  };
}
