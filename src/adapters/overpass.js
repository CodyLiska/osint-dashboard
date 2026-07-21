import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// OpenInfraMap-style critical-infrastructure overlay, read straight from
// OpenStreetMap via Overpass. Covers electrical substations and communications
// towers — deliberately NOT power plants, which the bundled WRI dataset already
// provides with capacity and fuel type.
//
// Overpass is a shared, rate-limited community endpoint, so this layer is
// viewport-scoped and refuses to run at world scale: an unbounded query would
// return hundreds of thousands of nodes and get us throttled. Below the zoom
// threshold the layer reports configured:false with a "zoom in" message, which
// surfaces as the standard amber flag instead of a silent empty layer.
const ENDPOINT = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

// Max viewport area in square degrees. Measured against the public endpoint,
// reliability is driven more by its rate limiting than by area, but a cap still
// keeps a zoomed-out map from issuing a query that can only time out. ~12 deg2
// is roughly a large metro region and returns in a few seconds.
const MAX_AREA_DEG2 = Number(process.env.OVERPASS_MAX_AREA) || 12;

// `share` is each feature's slice of the result budget. Overpass emits results
// in query order, so a single shared limit lets dense substation coverage crowd
// out every tower; giving each set its own `out` budget keeps both visible.
const FEATURES = [
  { tag: '"power"="substation"', type: "Electrical substation", severity: 4, set: "sub", share: 0.6 },
  { tag: '"man_made"="communications_tower"', type: "Communications tower", severity: 3, set: "tower", share: 0.4 }
];

function buildQuery(south, west, north, east, limit) {
  const bbox = `(${south},${west},${north},${east})`;
  // Each feature collects into its own named set, then emits under its own cap.
  // "out center" resolves each way to a single point so ways and nodes render
  // through the same scatter/icon path.
  const sets = FEATURES.map(({ tag, set }) =>
    `(node[${tag}]${bbox};way[${tag}]${bbox};)->.${set};`).join("");
  const outs = FEATURES.map(({ set, share }) =>
    `.${set} out center ${Math.max(1, Math.round(limit * share))};`).join("");
  return `[out:json][timeout:25];${sets}${outs}`;
}

export function parseOverpass(payload) {
  const typeByTag = new Map();
  for (const feature of FEATURES) {
    const [key, value] = feature.tag.replace(/"/g, "").split("=");
    typeByTag.set(`${key}=${value}`, feature);
  }

  const rows = [];
  for (const element of payload?.elements || []) {
    const tags = element.tags || {};
    const match = [...typeByTag.entries()].find(([pair]) => {
      const [key, value] = pair.split("=");
      return tags[key] === value;
    });
    if (!match) continue;
    const [, feature] = match;
    // Nodes carry lat/lon directly; ways carry a computed "center".
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    rows.push({
      id: `osm-${element.type}-${element.id}`,
      type: feature.type,
      severity: feature.severity,
      lat,
      lon,
      name: tags.name || tags.operator || feature.type,
      operator: tags.operator,
      voltage: tags.voltage,
      ref: tags.ref
    });
  }
  return rows;
}

// A missing bounds param arrives as null, and Number(null) is 0 rather than NaN
// — so a plain Number() cast turns "no viewport" into a valid zero-area bbox at
// null island and actually queries Overpass. Treat empty values as missing.
function coordinate(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

export async function infrastructureLayer(bounds = {}) {
  const south = coordinate(bounds.lamin);
  const west = coordinate(bounds.lomin);
  const north = coordinate(bounds.lamax);
  const east = coordinate(bounds.lomax);
  const bounded = [south, west, north, east].every(Number.isFinite);
  const area = bounded ? Math.abs(north - south) * Math.abs(east - west) : Infinity;

  // A zero-area box is a degenerate viewport, not a legitimate query.
  if (!bounded || area === 0 || area > MAX_AREA_DEG2) {
    return {
      entities: [],
      meta: {
        configured: false,
        message: "Zoom in to load infrastructure — OpenStreetMap/Overpass is queried per viewport and will not run at world scale."
      }
    };
  }

  const limit = Number(process.env.OVERPASS_MAX_ITEMS) || 400;
  // Round the bbox into ~0.1deg buckets so small pans reuse one cached response
  // instead of re-querying a rate-limited shared endpoint on every moveend.
  const round = (value) => Math.round(value * 10) / 10;
  const key = `overpass:${round(south)}:${round(west)}:${round(north)}:${round(east)}:${limit}`;

  const result = await cachedResilient(key, 30 * 60_000, async () => {
    const payload = await fetchJsonRetry(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: buildQuery(south, west, north, east, limit)
    }, { timeoutMs: 30_000 });
    // Overpass reports a server-side timeout or truncation as HTTP 200 with a
    // "remark" rather than an error status. Caching that would publish an empty
    // result as if the area genuinely had no infrastructure, so treat it as a
    // failure and let cachedResilient fall back to the last good response.
    if (payload?.remark) throw new Error(`Overpass: ${payload.remark}`);
    return payload;
  });

  const entities = parseOverpass(result.value).map((row) => entity({
    id: row.id,
    layer: "infrastructure",
    type: row.type,
    name: row.name,
    lat: row.lat,
    lon: row.lon,
    severity: row.severity,
    source: "OpenStreetMap",
    url: `https://www.openstreetmap.org/${row.id.replace(/^osm-/, "").replace("-", "/")}`,
    summary: [row.type, row.operator, row.voltage ? `${row.voltage} V` : null]
      .filter(Boolean).join(" · "),
    operator: row.operator,
    voltage: row.voltage,
    ref: row.ref
  })).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      configured: true,
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "OpenStreetMap via Overpass (OpenInfraMap-style)",
      count: entities.length
    }
  };
}
