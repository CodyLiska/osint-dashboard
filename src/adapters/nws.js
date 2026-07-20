import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// NOAA / NWS active severe-weather alerts (US), keyless. Unlike every other layer
// these are AREAS, not points — each alert carries a warning polygon. The adapter
// keeps only alerts with real Polygon geometry (most zone-referenced alerts have
// null geometry and would need a separate zone-shape lookup), attaches the polygon
// for the map to draw, and derives a centroid for clustering/feed/flyTo/detail.
const NWS_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";

const SEVERITY = { Extreme: 5, Severe: 4, Moderate: 3, Minor: 2, Unknown: 2 };

// Mean of the outer ring's vertices — good enough to anchor the alert.
function centroid(ring) {
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return { lon: x / ring.length, lat: y / ring.length };
}

export async function nwsAlertsLayer(max = Number(process.env.NWS_MAX_ITEMS) || 200) {
  const result = await cachedResilient("nws:alerts", 5 * 60_000, () =>
    fetchJsonRetry(NWS_URL, { headers: { accept: "application/geo+json" } }));

  const entities = (result.value?.features || [])
    .filter((feature) => feature.geometry?.type === "Polygon" && feature.geometry.coordinates?.length)
    .slice(0, max)
    .map((feature) => {
      const p = feature.properties || {};
      const rings = feature.geometry.coordinates; // [[ [lon,lat], ... ]]
      const { lat, lon } = centroid(rings[0]);
      return entity({
        id: `nws-${p.id || p["@id"]}`,
        layer: "nws",
        type: p.event || "Weather Alert",
        name: p.event || "Weather Alert",
        lat,
        lon,
        severity: SEVERITY[p.severity] || 2,
        time: p.effective || p.sent || null,
        source: "NOAA/NWS",
        url: p["@id"] || null,
        summary: [p.headline, p.areaDesc].filter(Boolean).join(" · "),
        polygon: rings, // GeoJSON Polygon rings, for the map's PolygonLayer
        severityLabel: p.severity,
        urgency: p.urgency,
        areaDesc: p.areaDesc
      });
    })
    .filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "NOAA/NWS active alerts (US)"
    }
  };
}
