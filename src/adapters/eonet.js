import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

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
      severity: layer === "weather" ? 3 : 4,
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
