import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

export async function seismicLayer() {
  const result = await cachedResilient("usgs:2.5_day", 60_000, () =>
    fetchJsonRetry("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson")
  );

  const entities = (result.value.features || []).map((feature) => entity({
    id: `quake-${feature.id}`,
    layer: "seismic",
    type: "Earthquake",
    name: feature.properties.place,
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
    depthKm: feature.geometry.coordinates[2],
    magnitude: feature.properties.mag,
    severity: Math.min(5, Math.max(1, feature.properties.mag || 1)),
    time: feature.properties.time ? new Date(feature.properties.time).toISOString() : null,
    source: "USGS",
    url: feature.properties.url,
    raw: feature
  })).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "USGS Earthquake Hazards Program"
    }
  };
}
