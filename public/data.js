// Static reference datasets now live as versioned JSON with provenance under
// public/data/. loadStaticLayers() fetches the ones the app renders client-side
// (chokepoints, cctv, conflict) and returns them keyed by layer id. Each fetch is
// best-effort: a missing dataset yields an empty layer rather than a hard failure.
const STATIC_DATASETS = ["chokepoints", "cctv", "conflict", "military"];

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

export const layerDefinitions = [
  { id: "aviation", label: "Aviation", color: [92, 200, 255], live: true },
  { id: "ports", label: "NGA World Port Index", color: [20, 184, 166], live: true },
  { id: "chokepoints", label: "10 Chokepoints", color: [251, 146, 60], staticKey: "chokepoints" },
  { id: "cctv", label: "CCTV Cameras", color: [168, 85, 247], staticKey: "cctv" },
  { id: "seismic", label: "USGS M2.5+ Earthquakes", color: [248, 113, 113], live: true },
  { id: "fires", label: "NASA FIRMS Fires", color: [239, 68, 68], live: true },
  { id: "weather", label: "Severe Weather", color: [59, 130, 246], live: true },
  { id: "news", label: "Live News", color: [250, 204, 21], live: true },
  { id: "gdelt", label: "GDELT Events", color: [232, 121, 249], live: true },
  { id: "gdacs", label: "GDACS Disasters", color: [249, 115, 22], live: true },
  { id: "ucdp", label: "Conflict (UCDP)", color: [190, 18, 60], live: true },
  { id: "nws", label: "NWS Alerts (US)", color: [124, 58, 237], live: true },
  { id: "ioda", label: "Internet Outages", color: [219, 39, 119], live: true },
  { id: "cloudflare", label: "Cloudflare Radar", color: [251, 146, 60], live: true },
  { id: "space", label: "NOAA Space Weather", color: [129, 140, 248], live: true },
  { id: "cyber", label: "Cyber CVE", color: [34, 197, 94], live: true },
  { id: "conflict", label: "Conflict Zones", color: [244, 63, 94], staticKey: "conflict" },
  { id: "telegram", label: "Telegram OSINT", color: [34, 211, 238], live: true },
  { id: "crypto", label: "Crypto Intel", color: [234, 179, 8], live: true },
  { id: "sanctions", label: "Sanctions Intel", color: [220, 38, 38], live: true },
  { id: "maritime", label: "Maritime Intel", color: [45, 212, 191], live: true },
  { id: "military", label: "Military Bases", color: [148, 163, 184], staticKey: "military" },
  { id: "military-air", label: "Military Aircraft", color: [245, 158, 11], live: true }
];
