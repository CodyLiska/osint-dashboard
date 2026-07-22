import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";

// Earth Search — keyless STAC index of Sentinel-2 L2A (10 m optical) on AWS Open
// Data. Given a bbox we return the most recent low-cloud scenes and each scene's
// preview.jpg thumbnail (a ready image), so this is "show me the latest clear
// high-res satellite image of here" WITHOUT running a COG tiler.
const STAC_URL = "https://earth-search.aws.element84.com/v1/search";

export async function sceneSearch(bbox, { cloudMax = 40, limit = 6 } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return { error: "A valid bbox [minLon,minLat,maxLon,maxLat] is required.", scenes: [] };
  }
  const key = `stac:s2:${bbox.map((n) => n.toFixed(2)).join(",")}:${cloudMax}:${limit}`;
  const result = await cachedResilient(key, 30 * 60_000, () =>
    fetchJsonRetry(STAC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collections: ["sentinel-2-l2a"],
        bbox,
        query: { "eo:cloud_cover": { lt: cloudMax } },
        sortby: [{ field: "properties.datetime", direction: "desc" }],
        limit
      })
    }));

  const features = result.value?.features || [];
  const scenes = features.map((f) => ({
    id: f.id,
    datetime: f.properties?.datetime || null,
    cloud: typeof f.properties?.["eo:cloud_cover"] === "number"
      ? Math.round(f.properties["eo:cloud_cover"] * 10) / 10
      : null,
    thumbnail: f.assets?.thumbnail?.href || null,
    platform: f.properties?.platform || f.properties?.constellation || "sentinel-2"
  })).filter((s) => s.thumbnail);

  return {
    scenes,
    matched: result.value?.context?.matched ?? result.value?.numberMatched ?? scenes.length,
    source: "Sentinel-2 L2A · Earth Search (AWS Open Data)",
    cached: result.cached,
    stale: Boolean(result.stale)
  };
}
