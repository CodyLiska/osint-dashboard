import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// TeleGeography Submarine Cable Map — keyless GeoJSON of the world's ~717 subsea
// internet cables (critical infrastructure; pairs with the chokepoints/outage
// layers). Each cable is a MultiLineString route; we keep its segments on the
// entity and render them as a deck.gl PathLayer (the app's first LINE layer,
// after the NWS polygon layer). Changes slowly, so cache for a day.
const CABLE_URL = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json";

export async function cablesLayer() {
  const result = await cachedResilient("cables:geo", 24 * 60 * 60_000, () => fetchJsonRetry(CABLE_URL));
  const features = result.value?.features || [];

  const entities = features.map((feature) => {
    const p = feature.properties || {};
    const paths = feature.geometry?.type === "MultiLineString" ? (feature.geometry.coordinates || []) : [];
    // Label anchor: the feed provides one; fall back to the first path's first point.
    const anchor = Array.isArray(p.coordinates) ? p.coordinates : paths[0]?.[0];
    const [lon, lat] = anchor || [];
    return entity({
      id: `cable-${p.id || p.feature_id || p.name}`,
      layer: "submarine-cables",
      type: "Submarine cable",
      name: p.name || "Submarine cable",
      lon,
      lat,
      severity: 2, // infrastructure, not an event — constant
      time: null,
      source: "TeleGeography Submarine Cable Map",
      color: p.color || "#38bdf8",
      paths,
      segmentCount: paths.length
    });
  }).filter((c) => Array.isArray(c.paths) && c.paths.length).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      count: entities.length,
      source: "TeleGeography Submarine Cable Map"
    }
  };
}
