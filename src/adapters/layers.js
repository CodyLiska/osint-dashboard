import { aviationLayer } from "./opensky.js";
import { militaryAircraftLayer } from "./adsb.js";
import { firesLayer } from "./firms.js";
import { eonetLayer } from "./eonet.js";
import { seismicLayer } from "./usgs.js";
import { telegramLayer } from "./telegram.js";
import { spaceWeatherLayer } from "./space.js";
import { cyberLayer } from "./cyber.js";
import { cryptoLayer, sanctionsLayer } from "./recon.js";
import { maritimeLayer } from "./maritime.js";
import { newsLayer } from "./news.js";
import { portsLayer } from "./ports.js";
import { gdeltLayer } from "./gdelt.js";
import { gdacsLayer } from "./gdacs.js";
import { ucdpLayer } from "./ucdp.js";
import { nwsAlertsLayer } from "./nws.js";
import { iodaLayer } from "./ioda.js";
import { cloudflareRadarLayer } from "./cloudflare.js";

// Single backend source-of-truth for every server-side layer. Adding a source
// means adding ONE row here — its adapter dispatch (`load`), its health-panel
// name (`sourceName`), and whether it feeds historical persistence (`persist`)
// all live together, instead of drifting across three separate maps.
//
// Fields:
//   id         - the /api/layers/:id key
//   sourceName - health-panel label; a function when it depends on config (a key
//                present vs. the keyless fallback)
//   load       - (bounds) => { entities, meta }; null for a known-but-static layer
//                that has no backend adapter yet (still 404s on /api/layers)
//   persist    - true only for live, event-shaped, stable-id, low-volume layers
//                (see the checklist in docs/PLAN-persistence.md before flipping it)
const LAYERS = [
  { id: "aviation", sourceName: "OpenSky Network", load: (b) => aviationLayer(b), persist: false },
  { id: "military-air", sourceName: "adsb.lol / OpenSky (military)", load: (b) => militaryAircraftLayer(b), persist: false },
  { id: "fires", sourceName: "NASA FIRMS", load: (b) => firesLayer(b), persist: false },
  { id: "weather", sourceName: "NASA EONET", load: (b) => eonetLayer("weather", ["severeStorms", "floods", "volcanoes"], b), persist: true },
  { id: "ports", sourceName: "NGA World Port Index", load: (b) => portsLayer(b), persist: false },
  { id: "seismic", sourceName: "USGS", load: () => seismicLayer(), persist: true },
  { id: "telegram", sourceName: "Telegram public preview", load: () => telegramLayer(), persist: true },
  { id: "cyber", sourceName: "NVD", load: () => cyberLayer(), persist: true },
  { id: "news", sourceName: () => (process.env.NEWSAPI_KEY ? "NewsAPI" : "Static broadcaster directory"), load: () => newsLayer(), persist: true },
  // persist:false — event-shaped with a stable GlobalEventID, but far too
  // high-volume (~hundreds every 15 min) for the reconcile model (see the
  // checklist in docs/PLAN-persistence.md).
  { id: "gdelt", sourceName: "GDELT Project", load: () => gdeltLayer(), persist: false },
  // Event-shaped (disasters appear/end), stable GDACS eventid, low volume (~100)
  // → a good persistence candidate per the checklist.
  { id: "gdacs", sourceName: "GDACS", load: () => gdacsLayer(), persist: true },
  // Optional-keyed (UCDP_ACCESS_TOKEN); curated conflict events. persist:false —
  // it's a lagged accumulating historical record, not an appear/disappear feed.
  { id: "ucdp", sourceName: "UCDP GED", load: () => ucdpLayer(), persist: false },
  // Keyless US severe-weather WARNING POLYGONS (rendered as areas, not points).
  // persist:false — the polygon payloads are heavy and alerts are short-lived US-only.
  { id: "nws", sourceName: "NOAA/NWS", load: () => nwsAlertsLayer(), persist: false },
  // Country-level internet outages. Event-shaped (outages start/end), stable
  // country id, sparse/high-signal → persist:true (feeds the what-changed panel).
  { id: "ioda", sourceName: "IODA", load: () => iodaLayer(), persist: true },
  // Optional-keyed (CLOUDFLARE_API_TOKEN); Cloudflare's outage annotations with cause.
  { id: "cloudflare", sourceName: "Cloudflare Radar", load: () => cloudflareRadarLayer(), persist: false },
  { id: "space", sourceName: () => (process.env.N2YO_API_KEY ? "NOAA SWPC, N2YO" : "NOAA SWPC, CelesTrak"), load: () => spaceWeatherLayer(), persist: false },
  { id: "maritime", sourceName: () => (process.env.AISSTREAM_API_KEY ? "AISStream" : "Static port directory"), load: (b) => maritimeLayer(b), persist: false },
  { id: "crypto", sourceName: "OFAC SDN", load: () => cryptoLayer(), persist: false },
  { id: "sanctions", sourceName: "Official sanctions feeds", load: () => sanctionsLayer(), persist: false },
  // Static today (public/data/conflict.json, rendered client-side, no /api/layers
  // adapter). Kept here so it is already persistable the moment it goes live via
  // ACLED/GDELT — see docs/FUTURE-DATA-SOURCES.md §1.
  { id: "conflict", sourceName: "Conflict events (static)", load: null, persist: true }
];

const byId = new Map(LAYERS.map((layer) => [layer.id, layer]));

export async function layerEntities(layer, bounds = {}) {
  const entry = byId.get(layer);
  if (!entry || !entry.load) return null;
  return entry.load(bounds);
}

// Health-panel display name for a layer (resolving the config-dependent ones).
// Falls back to the raw id for unknown layers.
export function sourceName(layer) {
  const entry = byId.get(layer);
  if (!entry) return layer;
  return typeof entry.sourceName === "function" ? entry.sourceName() : entry.sourceName;
}

// Ids of layers that feed historical persistence — the default OSIRIS_PERSIST_LAYERS.
export function persistableIds() {
  return LAYERS.filter((layer) => layer.persist).map((layer) => layer.id);
}
