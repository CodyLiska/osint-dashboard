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
import { advisoriesLayer } from "./advisories.js";
import { reliefWebLayer } from "./reliefweb.js";
import { ransomwareLayer } from "./ransomware.js";
import { infrastructureLayer } from "./overpass.js";

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
//   geo        - where an entity's coordinates come from. This answers one
//                question: "is a geofence over this layer meaningful?" The alert
//                engine rejects geofence rules on anything but real/inferred.
//                  real      - a genuine position from the upstream
//                  inferred  - derived from text (gazetteer geoparse); carries a
//                              confidence field and can be wrong
//                  country   - a country centroid; country-granular, NOT spatial
//                  synthetic - a decorative position scattered around a fixed
//                              anchor by ARRAY INDEX. Not a location, and it
//                              changes between fetches as the feed reorders.
const LAYERS = [
  { id: "aviation", sourceName: "OpenSky Network", load: (b) => aviationLayer(b), persist: false, geo: "real" },
  { id: "military-air", sourceName: "adsb.lol / OpenSky (military)", load: (b) => militaryAircraftLayer(b), persist: false, geo: "real" },
  { id: "fires", sourceName: "NASA FIRMS", load: (b) => firesLayer(b), persist: false, geo: "real" },
  { id: "weather", sourceName: "NASA EONET", load: (b) => eonetLayer("weather", ["severeStorms", "floods", "volcanoes"], b), persist: true, geo: "real" },
  { id: "ports", sourceName: "NGA World Port Index", load: (b) => portsLayer(b), persist: false, geo: "real" },
  { id: "seismic", sourceName: "USGS", load: () => seismicLayer(), persist: true, geo: "real" },
  { id: "telegram", sourceName: "Telegram public preview", load: () => telegramLayer(), persist: true, geo: "inferred" },
  { id: "cyber", sourceName: "NVD", load: () => cyberLayer(), persist: true, geo: "synthetic" },
  { id: "news", sourceName: () => (process.env.NEWSAPI_KEY ? "NewsAPI" : "Static broadcaster directory"), load: () => newsLayer(), persist: true, geo: "synthetic" },
  // persist:false — event-shaped with a stable GlobalEventID, but far too
  // high-volume (~hundreds every 15 min) for the reconcile model (see the
  // checklist in docs/PLAN-persistence.md).
  { id: "gdelt", sourceName: "GDELT Project", load: () => gdeltLayer(), persist: false, geo: "real" },
  // Event-shaped (disasters appear/end), stable GDACS eventid, low volume (~100)
  // → a good persistence candidate per the checklist.
  { id: "gdacs", sourceName: "GDACS", load: () => gdacsLayer(), persist: true, geo: "real" },
  // Optional-keyed (UCDP_ACCESS_TOKEN); curated conflict events. persist:false —
  // it's a lagged accumulating historical record, not an appear/disappear feed.
  { id: "ucdp", sourceName: "UCDP GED", load: () => ucdpLayer(), persist: false, geo: "real" },
  // Keyless US severe-weather WARNING POLYGONS (rendered as areas, not points).
  // persist:false — the polygon payloads are heavy and alerts are short-lived US-only.
  { id: "nws", sourceName: "NOAA/NWS", load: () => nwsAlertsLayer(), persist: false, geo: "real" },
  // Country-level internet outages. Event-shaped (outages start/end), stable
  // country id, sparse/high-signal → persist:true (feeds the what-changed panel).
  { id: "ioda", sourceName: "IODA", load: () => iodaLayer(), persist: true, geo: "country" },
  // Optional-keyed (CLOUDFLARE_API_TOKEN); Cloudflare's outage annotations with cause.
  { id: "cloudflare", sourceName: "Cloudflare Radar", load: () => cloudflareRadarLayer(), persist: false, geo: "country" },
  // Country risk levels 1-4. persist:false — every country always carries an
  // advisory, so nothing ever appears or disappears; reconcile refreshes
  // severity in place, which means a level change (the only real event here)
  // would overwrite rather than record. Tracking those needs an append model.
  { id: "advisories", sourceName: "US State Department", load: () => advisoriesLayer(), persist: false, geo: "country" },
  // Optional-keyed (RELIEFWEB_APPNAME). Disasters open and close with a stable
  // record id at bounded volume → persistable. Safe now that persistSnapshot
  // skips unconfigured snapshots instead of closing the whole history.
  { id: "reliefweb", sourceName: "ReliefWeb (UN OCHA)", load: () => reliefWebLayer(), persist: true, geo: "country" },
  // Keyless RSS. Each disclosure is a discrete event with a stable id at bounded
  // volume (last 200), so it persists cleanly — a new victim is a real "appeared"
  // in What Changed. geo:"country" because the feed reports only a country code,
  // so an entity sits on the centroid, not at the victim's actual location.
  { id: "ransomware", sourceName: "Ransomware.live", load: () => ransomwareLayer(), persist: true, geo: "country" },
  // OSM infrastructure, queried per viewport. persist:false — the entity set is
  // a function of where the user is looking, so reconcile would close every
  // record outside the current view on each pan.
  { id: "infrastructure", sourceName: "OpenStreetMap / Overpass", load: (b) => infrastructureLayer(b), persist: false, geo: "real" },
  // geo:"synthetic" is a conservative call on a MIXED layer — satellite
  // sub-points are genuinely real, but the space-weather readings (Kp) are
  // pinned to NOAA Boulder as a symbolic marker. Since a geofence cannot mean
  // one thing for one half of a layer, the whole layer is treated as unsafe.
  { id: "space", sourceName: () => (process.env.N2YO_API_KEY ? "NOAA SWPC, N2YO" : "NOAA SWPC, CelesTrak"), load: () => spaceWeatherLayer(), persist: false, geo: "synthetic" },
  { id: "maritime", sourceName: () => (process.env.AISSTREAM_API_KEY ? "AISStream" : "Static port directory"), load: (b) => maritimeLayer(b), persist: false, geo: "real" },
  { id: "crypto", sourceName: "OFAC SDN", load: () => cryptoLayer(), persist: false, geo: "synthetic" },
  { id: "sanctions", sourceName: "Official sanctions feeds", load: () => sanctionsLayer(), persist: false, geo: "synthetic" },
  // Static today (public/data/conflict.json, rendered client-side, no /api/layers
  // adapter). Kept here so it is already persistable the moment it goes live via
  // ACLED/GDELT — see docs/FUTURE-DATA-SOURCES.md §1.
  { id: "conflict", sourceName: "Conflict events (static)", load: null, persist: true, geo: "real" }
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

// Coordinate provenance for a layer (see the `geo` notes on LAYERS). Returns
// "none" for an unknown layer so a caller never treats a typo as geofenceable.
export function geoProvenance(layer) {
  return byId.get(layer)?.geo || "none";
}

// Layer ids known to the registry — used to validate alert rules against real
// layers instead of letting a typo silently match nothing.
export function knownLayerIds() {
  return LAYERS.map((layer) => layer.id);
}

// Ids of layers that feed historical persistence — the default OSIRIS_PERSIST_LAYERS.
export function persistableIds() {
  return LAYERS.filter((layer) => layer.persist).map((layer) => layer.id);
}
