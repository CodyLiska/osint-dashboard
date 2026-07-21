import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { cellToLonLat } from "../lib/h3.js";

// GPSJam — daily GPS interference derived from ADS-B navigation-accuracy reports.
// Aircraft whose reported accuracy collapses are counted as "bad" per H3 cell;
// a high bad ratio marks jamming or spoofing.
//
// The data is gzipped CSV keyed by H3 resolution-4 cell with NO coordinates —
// see src/lib/h3.js for why placement is a bundled lookup table rather than a
// hand-ported projection. Keyless; no Referer header is required despite the
// site's own client sending one.
const MANIFEST_URL = "https://gpsjam.org/data/manifest.csv";
const dayUrl = (date) => `https://gpsjam.org/data/${date}-h3_4.csv`;

// A cell needs enough traffic for the ratio to mean anything: a single aircraft
// reporting badly is 100% interference by arithmetic and noise in fact. A real
// day has 47 such single-aircraft cells.
const MIN_AIRCRAFT = 5;
const MIN_RATIO = 0.02;

// Bad-aircraft ratio -> 1-5. Unlike most feeds this layer has genuine severity
// variation, so it can alert on an upward crossing, not just on appearance.
export function severityForRatio(ratio) {
  if (ratio >= 0.5) return 5;
  if (ratio >= 0.25) return 4;
  if (ratio >= 0.1) return 3;
  return 2;
}

function csvRows(text) {
  return String(text).trim().split(/\r?\n/).slice(1).filter(Boolean);
}

// The manifest lists every published day oldest-first, with a flag marking days
// whose collection looked anomalous. Returns the newest entry.
export function latestManifestEntry(csv) {
  let latest = null;
  for (const line of csvRows(csv)) {
    const [date, suspect] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) continue;
    if (!latest || date > latest.date) latest = { date, suspect: suspect === "true" };
  }
  return latest;
}

export function parseCells(csv) {
  const rows = [];
  for (const line of csvRows(csv)) {
    const [hex, good, bad] = line.split(",");
    const goodCount = Number(good);
    const badCount = Number(bad);
    if (!hex || !Number.isFinite(goodCount) || !Number.isFinite(badCount)) continue;
    const total = goodCount + badCount;
    if (total < MIN_AIRCRAFT) continue;
    const ratio = badCount / total;
    if (ratio < MIN_RATIO) continue;
    rows.push({ hex, good: goodCount, bad: badCount, total, ratio });
  }
  return rows;
}

export async function gpsJamLayer() {
  const result = await cachedResilient("gpsjam:daily", 6 * 60 * 60_000, async () => {
    const manifest = await fetchTextRetry(MANIFEST_URL, { headers: { Accept: "text/csv" } });
    const latest = latestManifestEntry(manifest);
    if (!latest) throw new Error("gpsjam manifest listed no usable dates");
    const csv = await fetchTextRetry(dayUrl(latest.date), { headers: { Accept: "text/csv" } });
    return { date: latest.date, suspect: latest.suspect, csv };
  });

  const { date, suspect, csv } = result.value;
  // A cell absent from the lookup table would be silently dropped, so it is
  // counted and surfaced in meta rather than disappearing.
  let unmapped = 0;
  const entities = parseCells(csv).map((row) => {
    const point = cellToLonLat(row.hex);
    if (!point) {
      unmapped += 1;
      return null;
    }
    const percent = Math.round(row.ratio * 100);
    return entity({
      id: `gpsjam-${row.hex}`,
      layer: "gpsjam",
      type: "GPS interference",
      name: `GPS interference ${percent}%`,
      lon: point[0],
      lat: point[1],
      severity: severityForRatio(row.ratio),
      time: `${date}T00:00:00.000Z`,
      source: "GPSJam",
      url: `https://gpsjam.org/?lat=${point[1].toFixed(2)}&lon=${point[0].toFixed(2)}&z=7&date=${date}`,
      summary: `${row.bad} of ${row.total} aircraft reported degraded navigation accuracy (${percent}%).`,
      ratio: row.ratio,
      badAircraft: row.bad,
      totalAircraft: row.total,
      observedOn: date,
      cell: row.hex
    });
  }).filter(Boolean);

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "GPSJam daily GPS interference (ADS-B derived)",
      observedOn: date,
      // The upstream's own flag for a day whose collection looked anomalous.
      suspectDay: suspect,
      unmappedCells: unmapped
    }
  };
}
