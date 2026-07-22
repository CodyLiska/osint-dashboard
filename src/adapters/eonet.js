import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// EONET publishes no intensity, so severity is a coarse per-category importance
// weight (1-5) derived from the event's OWN category rather than a single per-layer
// constant. That is what lets a severity-filtered or minSeverity alert rule
// actually discriminate on the weather layer (a volcano ranks above drifting snow),
// where before every event shared one value and no threshold could tell them apart.
// It is a ranking, not a measurement; an unknown/absent category falls back to 3.
const CATEGORY_SEVERITY = {
  volcanoes: 5,
  earthquakes: 5,
  severeStorms: 4,
  floods: 4,
  wildfires: 4,
  landslides: 4,
  drought: 3,
  tempExtremes: 3,
  manmade: 3,
  snow: 2,
  seaLakeIce: 2,
  dustHaze: 2,
  waterColor: 2
};

export function severityForCategory(categoryId) {
  return CATEGORY_SEVERITY[categoryId] || 3;
}

function bboxParam(bounds) {
  if (!bounds.lomin || !bounds.lamin || !bounds.lomax || !bounds.lamax) return "";
  const westRaw = Number(bounds.lomin);
  const southRaw = Number(bounds.lamin);
  const eastRaw = Number(bounds.lomax);
  const northRaw = Number(bounds.lamax);
  const west = Math.max(-180, Math.min(180, westRaw));
  const east = Math.max(-180, Math.min(180, eastRaw));
  const south = Math.max(-90, Math.min(90, southRaw));
  const north = Math.max(-90, Math.min(90, northRaw));
  if (east <= west || north <= south || eastRaw - westRaw >= 350) return "";
  return `&bbox=${west},${south},${east},${north}`;
}

export async function eonetLayer(layer, categories, bounds = {}) {
  const categoryParam = categories.join(",");
  const bbox = bboxParam(bounds);
  const key = `eonet:${layer}:${categoryParam}:${bbox}`;
  const result = await cachedResilient(key, 15 * 60_000, () =>
    fetchJsonRetry(`https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=100&category=${encodeURIComponent(categoryParam)}${bbox}`)
  );

  const entities = (result.value.events || [])
    .flatMap((event) => event.geometry?.slice(-1).map((geo) => entity({
      id: `${layer}-${event.id}`,
      layer,
      type: event.categories?.[0]?.title || "Natural event",
      name: event.title,
      lat: geo.coordinates?.[1],
      lon: geo.coordinates?.[0],
      severity: severityForCategory(event.categories?.[0]?.id),
      time: geo.date,
      source: event.sources?.[0]?.id || "NASA EONET",
      url: event.link,
      raw: event
    })) || [])
    .filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "NASA EONET",
      categories
    }
  };
}
