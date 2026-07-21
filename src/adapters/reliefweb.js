import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { centroidForCountry } from "../lib/centroids.js";

// ReliefWeb (UN OCHA) — authoritative humanitarian disaster records. The API is
// optional-keyed: v1 was decommissioned (HTTP 410) and v2 rejects every
// unregistered caller with "not an approved appname", so RELIEFWEB_APPNAME must
// hold a name registered at apidoc.reliefweb.int. Without it the layer is empty
// (configured:false), like FIRMS without a map key.
//
// The disasters schema carries no coordinates, so each record is placed on its
// primary country's centroid — country-level precision, same as the outage layers.
const BASE_URL = "https://api.reliefweb.int/v2/disasters";

// ReliefWeb marks a disaster alert / current / past.
const STATUS_SEVERITY = { alert: 5, current: 4, past: 2 };

export function parseDisasters(payload) {
  return (payload?.data || []).map((row) => {
    const f = row.fields || {};
    const country = f.primary_country?.name || f.country?.[0]?.name || null;
    return {
      id: row.id ?? f.id,
      name: f.name || "Humanitarian emergency",
      status: String(f.status || "").toLowerCase(),
      country,
      type: f.primary_type?.name || f.type?.[0]?.name || "Disaster",
      date: f.date?.event || f.date?.created || null,
      url: f.url_alias || f.url || null,
      glide: f.glide || null
    };
  });
}

export async function reliefWebLayer() {
  const appname = process.env.RELIEFWEB_APPNAME;
  if (!appname) {
    return {
      entities: [],
      meta: {
        configured: false,
        message: "RELIEFWEB_APPNAME not set — UN OCHA humanitarian disasters unavailable; register an appname at apidoc.reliefweb.int. GDACS provides keyless disaster coverage."
      }
    };
  }

  const max = Number(process.env.RELIEFWEB_MAX_ITEMS) || 200;
  const fields = [
    "name", "status", "date", "primary_country", "primary_type", "url_alias", "glide"
  ].map((name) => `fields[include][]=${name}`).join("&");
  const url = `${BASE_URL}?appname=${encodeURIComponent(appname)}&limit=${max}&sort[]=date:desc&${fields}`;

  const result = await cachedResilient(`reliefweb:${appname}:${max}`, 60 * 60_000, () =>
    fetchJsonRetry(url));

  const entities = parseDisasters(result.value)
    // "past" disasters are closed records, not situational awareness.
    .filter((row) => row.status !== "past")
    .map((row) => {
      const centroid = row.country ? centroidForCountry(row.country) : null;
      return entity({
        id: `reliefweb-${row.id}`,
        layer: "reliefweb",
        type: row.type,
        name: row.name,
        lon: centroid?.[0],
        lat: centroid?.[1],
        severity: STATUS_SEVERITY[row.status] || 3,
        time: row.date || null,
        source: "ReliefWeb (UN OCHA)",
        url: row.url,
        summary: `${row.type}${row.country ? ` · ${row.country}` : ""}${row.status ? ` · ${row.status}` : ""}`,
        country: row.country,
        status: row.status,
        glide: row.glide
      });
    })
    .filter(finiteCoordinate);

  return {
    entities,
    meta: {
      configured: true,
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "ReliefWeb (UN OCHA)",
      count: entities.length
    }
  };
}
