// Static reference datasets now live as versioned JSON with provenance under
// public/data/. loadStaticLayers() fetches the ones the app renders client-side
// (chokepoints, cctv, conflict) and returns them keyed by layer id. Each fetch is
// best-effort: a missing dataset yields an empty layer rather than a hard failure.
const STATIC_DATASETS = ["chokepoints", "cctv", "conflict", "military", "power-plants"];

export async function loadStaticLayers() {
  const entries = await Promise.all(STATIC_DATASETS.map(async (name) => {
    try {
      const response = await fetch(`/data/${name}.json`);
      if (!response.ok) throw new Error(`${response.status}`);
      const doc = await response.json();
      return [name, doc.records || []];
    } catch {
      return [name, []];
    }
  }));
  return Object.fromEntries(entries);
}

// Layer groups, in display order. The sidebar renders one collapsible section
// per group; a layer must declare one (asserted by a test) so the list stays
// navigable as the source catalogue grows.
export const LAYER_GROUPS = [
  { id: "air", label: "Air & Space" },
  { id: "signals", label: "Signals & Radio" },
  { id: "maritime", label: "Maritime" },
  { id: "hazards", label: "Hazards" },
  { id: "conflict", label: "Conflict & Political" },
  { id: "feeds", label: "Open-Source Feeds" },
  { id: "cyber", label: "Cyber & Internet" },
  { id: "infra", label: "Infrastructure" },
  { id: "imagery", label: "Imagery" }
];

export const layerDefinitions = [
  { id: "aviation", label: "Aviation", color: [92, 200, 255], live: true, group: "air" },
  { id: "ports", label: "NGA World Port Index", color: [20, 184, 166], live: true, group: "maritime" },
  { id: "chokepoints", label: "10 Chokepoints", color: [251, 146, 60], staticKey: "chokepoints", group: "maritime" },
  { id: "cctv", label: "CCTV Cameras", color: [168, 85, 247], staticKey: "cctv", group: "infra" },
  { id: "seismic", label: "USGS M2.5+ Earthquakes", color: [248, 113, 113], live: true, group: "hazards" },
  { id: "fires", label: "NASA FIRMS Fires", color: [239, 68, 68], live: true, group: "hazards" },
  { id: "weather", label: "Severe Weather", color: [59, 130, 246], live: true, group: "hazards" },
  { id: "news", label: "Live News", color: [250, 204, 21], live: true, group: "feeds" },
  { id: "gdelt", label: "GDELT Events", color: [232, 121, 249], live: true, group: "feeds" },
  { id: "gdacs", label: "GDACS Disasters", color: [249, 115, 22], live: true, group: "hazards" },
  { id: "ucdp", label: "Conflict (UCDP)", color: [190, 18, 60], live: true, group: "conflict" },
  { id: "nws", label: "NWS Alerts (US)", color: [124, 58, 237], live: true, group: "hazards" },
  { id: "tsunami", label: "Tsunami Warnings", color: [14, 165, 233], live: true, group: "hazards" },
  { id: "volcanoes", label: "Volcanic Activity", color: [234, 88, 12], live: true, group: "hazards" },
  { id: "ioda", label: "Internet Outages", color: [219, 39, 119], live: true, group: "cyber" },
  { id: "advisories", label: "Travel Advisories", color: [217, 119, 6], live: true, group: "conflict" },
  { id: "reliefweb", label: "Humanitarian (ReliefWeb)", color: [56, 189, 248], live: true, group: "conflict" },
  { id: "infrastructure", label: "Infrastructure (OSM)", color: [163, 230, 53], live: true, group: "infra" },
  { id: "submarine-cables", label: "Submarine Cables", color: [56, 189, 248], live: true, group: "infra" },
  { id: "power-plants", label: "Power Plants", color: [250, 204, 21], staticKey: "power-plants", group: "infra" },
  { id: "cloudflare", label: "Cloudflare Radar", color: [251, 146, 60], live: true, group: "cyber" },
  { id: "space", label: "NOAA Space Weather", color: [129, 140, 248], live: true, group: "air" },
  { id: "cyber", label: "Cyber CVE", color: [34, 197, 94], live: true, group: "cyber" },
  { id: "ransomware", label: "Ransomware Victims", color: [190, 24, 93], live: true, group: "cyber" },
  { id: "gpsjam", label: "GPS Interference", color: [250, 204, 21], live: true, group: "air" },
  { id: "pskreporter", label: "HF Activity (PSKReporter)", color: [96, 165, 250], live: true, group: "signals" },
  { id: "satnogs", label: "Ground Stations (SatNOGS)", color: [45, 212, 191], live: true, group: "signals" },
  { id: "conflict", label: "Conflict Zones", color: [244, 63, 94], staticKey: "conflict", group: "conflict" },
  { id: "telegram", label: "Telegram OSINT", color: [34, 211, 238], live: true, group: "feeds" },
  { id: "crypto", label: "Crypto Intel", color: [234, 179, 8], live: true, group: "cyber" },
  { id: "sanctions", label: "Sanctions Intel", color: [220, 38, 38], live: true, group: "cyber" },
  { id: "maritime", label: "Maritime Intel", color: [45, 212, 191], live: true, group: "maritime" },
  { id: "military", label: "Military Bases", color: [148, 163, 184], staticKey: "military", group: "infra" },
  { id: "military-air", label: "Military Aircraft", color: [245, 158, 11], live: true, group: "air" },
  // NASA GIBS raster imagery. Not entity layers — `raster` routes the toggle to a
  // MapLibre raster source (see setImageryLayer in app.js) instead of an adapter
  // fetch. `gibs` carries the WMTS layer id, tile-matrix set, extension, max zoom,
  // and an optional fixed `date` (daily layers default to yesterday UTC).
  { id: "gibs-modis-truecolor", label: "MODIS True Color", color: [96, 165, 250], raster: true, group: "imagery",
    gibs: { layer: "MODIS_Terra_CorrectedReflectance_TrueColor", matrix: "GoogleMapsCompatible_Level9", ext: "jpg", maxZoom: 9 } },
  { id: "gibs-viirs-truecolor", label: "VIIRS True Color", color: [125, 211, 252], raster: true, group: "imagery",
    gibs: { layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor", matrix: "GoogleMapsCompatible_Level9", ext: "jpg", maxZoom: 9 } },
  { id: "gibs-black-marble", label: "Night Lights (Black Marble)", color: [250, 204, 21], raster: true, group: "imagery",
    gibs: { layer: "VIIRS_Black_Marble", matrix: "GoogleMapsCompatible_Level8", ext: "png", maxZoom: 8, date: "2016-01-01" } },
  // GOES geostationary near-real-time (GeoColor = true-color day / IR-blend night).
  // `today: true` → today-UTC, not the daily-layer yesterday default. GOES-East
  // covers the Americas + Atlantic; GOES-West the Pacific. Disk edges are nodata
  // (404 tiles, which MapLibre skips) — normal for a single geostationary sensor.
  { id: "gibs-goes-east", label: "GOES-East (live)", color: [125, 211, 252], raster: true, group: "imagery",
    gibs: { layer: "GOES-East_ABI_GeoColor", matrix: "GoogleMapsCompatible_Level7", ext: "png", maxZoom: 7, today: true } },
  { id: "gibs-goes-west", label: "GOES-West (live)", color: [96, 165, 250], raster: true, group: "imagery",
    gibs: { layer: "GOES-West_ABI_GeoColor", matrix: "GoogleMapsCompatible_Level7", ext: "png", maxZoom: 7, today: true } }
];
