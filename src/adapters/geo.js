import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";

// Forward geocoding via Nominatim (OpenStreetMap), keyless. Used as the last
// resort for the top-bar place search so arbitrary street addresses resolve, not
// just gazetteer cities. Results are cached 24h to respect Nominatim's usage
// policy (it asks for caching + a low request rate + an identifying User-Agent,
// which src/lib/http.js already sets).
export async function geocode(query) {
  const q = String(query || "").trim();
  if (!q) {
    const error = new Error("q required");
    error.status = 400;
    throw error;
  }

  const result = await cachedResilient(`geocode:${q.toLowerCase()}`, 24 * 60 * 60_000, () =>
    fetchJsonRetry(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { "accept-language": "en" }
    })
  );

  const top = Array.isArray(result.value) ? result.value[0] : null;
  if (!top) return { found: false, query: q, source: "Nominatim / OpenStreetMap" };

  return {
    found: true,
    query: q,
    name: top.display_name,
    lat: Number(top.lat),
    lon: Number(top.lon),
    category: top.class,
    type: top.type,
    source: "Nominatim / OpenStreetMap",
    cached: result.cached
  };
}
