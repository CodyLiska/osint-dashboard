import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// UCDP GED (Uppsala Conflict Data Program, Georeferenced Event Dataset) — curated,
// death-counted, actor-attributed armed-conflict events. The public API added a
// mandatory access token (register at ucdp.uu.se), so this is optional-keyed:
// without UCDP_ACCESS_TOKEN the layer is empty (configured:false), like FIRMS
// without a map key. GDELT already provides keyless conflict coverage.
const VIOLENCE_LABEL = { 1: "State-based conflict", 2: "Non-state conflict", 3: "One-sided violence" };

// Best-estimate fatalities → OSIRIS 1-5 severity.
function severityFromDeaths(best) {
  const n = Number(best) || 0;
  if (n >= 100) return 5;
  if (n >= 25) return 4;
  if (n >= 5) return 3;
  if (n >= 1) return 2;
  return 1;
}

export async function ucdpLayer() {
  const token = process.env.UCDP_ACCESS_TOKEN;
  if (!token) {
    return { entities: [], meta: { configured: false, message: "UCDP_ACCESS_TOKEN not set — conflict events (UCDP) unavailable; GDELT provides keyless conflict coverage." } };
  }

  const version = process.env.UCDP_VERSION || "25.1";
  const max = Number(process.env.UCDP_MAX_ITEMS) || 500;
  const result = await cachedResilient(`ucdp:${version}:${max}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(`https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${max}&page=0`, {
      headers: { "x-ucdp-access-token": token }
    })
  );

  const events = result.value?.Result || [];
  const entities = events.map((ev) => {
    const sides = [ev.side_a, ev.side_b].filter(Boolean).join(" vs ");
    return entity({
      id: `ucdp-${ev.id}`,
      layer: "ucdp",
      type: VIOLENCE_LABEL[ev.type_of_violence] || "Conflict event",
      name: sides || `Conflict in ${ev.country || "unknown"}`,
      lat: Number(ev.latitude),
      lon: Number(ev.longitude),
      severity: severityFromDeaths(ev.best),
      time: ev.date_start || null,
      source: "UCDP GED",
      summary: `${ev.best ?? 0} deaths (best est.) · ${ev.country || ""}`,
      deaths: Number(ev.best) || 0,
      country: ev.country
    });
  }).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      configured: true,
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "UCDP GED",
      count: entities.length
    }
  };
}
