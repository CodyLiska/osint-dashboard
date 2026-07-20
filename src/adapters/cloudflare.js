import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { COUNTRY_CENTROIDS as CENTROIDS } from "../lib/centroids.js";

// Cloudflare Radar internet-outage annotations — optional-keyed (Cloudflare API
// token, Bearer). Complements IODA with Cloudflare's own network view, including
// the outage CAUSE (government-directed, power, cable cut, ...). Outages are
// country-coded, so geolocate to a centroid. Graceful-off without the token.
const RADAR_URL = "https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=50";

export async function cloudflareRadarLayer() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    return { entities: [], meta: { configured: false, message: "CLOUDFLARE_API_TOKEN not set — Cloudflare Radar outages unavailable (IODA covers outages keyless)." } };
  }

  const result = await cachedResilient("cloudflare:outages", 30 * 60_000, () =>
    fetchJsonRetry(RADAR_URL, { headers: { authorization: `Bearer ${token}` } }));
  const annotations = result.value?.result?.annotations || [];

  const entities = annotations.map((a) => {
    const cc = (a.locations || [])[0];
    const centroid = cc && CENTROIDS[cc];
    if (!centroid) return null;
    const cause = a.outage?.outageCause;
    return entity({
      id: `cf-outage-${a.id}`,
      layer: "cloudflare",
      type: "Internet outage",
      name: `Internet outage: ${(a.locationsDetails?.[0]?.name) || cc}`,
      lon: centroid[0],
      lat: centroid[1],
      severity: cause === "GOVERNMENT_DIRECTED" ? 5 : 4,
      time: a.startDate || null,
      source: "Cloudflare Radar",
      summary: [a.description, cause && `cause: ${cause}`].filter(Boolean).join(" · "),
      cause,
      asns: a.asns
    });
  }).filter(Boolean).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      configured: true,
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "Cloudflare Radar outages"
    }
  };
}
