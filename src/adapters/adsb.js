import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { militaryAircraftLayer as openSkyMilitaryLayer } from "./opensky.js";

// adsb.lol curated global military ADS-B feed (/v2/mil). Much better military
// coverage than the current OpenSky hex-range heuristic, which misses ADS-B-off
// and civilian-squawking military aircraft. Entities match the OpenSky military
// shape so the frontend (icon angle, dead-reckoning, detail card) is unchanged.
// Falls back to the OpenSky heuristic if adsb.lol is unavailable.
const FT_TO_M = 0.3048;
const KTS_TO_MS = 0.514444; // ground speed knots -> m/s (frontend dead-reckons in m/s)
const EMERGENCY = new Set(["7500", "7600", "7700"]);

export async function militaryAircraftLayer(bounds) {
  try {
    const result = await cachedResilient("adsblol:mil", 30_000, () =>
      fetchJsonRetry("https://api.adsb.lol/v2/mil",
        { headers: { "user-agent": "OSIRIS-Situational-Dashboard/0.2" } },
        { timeoutMs: 12_000 }));
    const entities = (result.value?.ac || []).map((a) => entity({
      id: `mil-${a.hex}`,
      layer: "military-air",
      type: a.t || "Military aircraft",
      name: (a.flight || "").trim() || a.r || a.hex,
      lon: a.lon,
      lat: a.lat,
      altitude: typeof a.alt_baro === "number" ? a.alt_baro * FT_TO_M : 0,
      velocity: Number.isFinite(a.gs) ? a.gs * KTS_TO_MS : null,
      track: Number.isFinite(a.track) ? a.track : (Number.isFinite(a.true_heading) ? a.true_heading : null),
      squawk: a.squawk,
      category: a.category,
      registration: a.r,
      severity: EMERGENCY.has(a.squawk) ? 5 : 4,
      source: "adsb.lol",
      raw: a
    })).filter(finiteCoordinate).slice(0, 400);

    if (entities.length) {
      return { entities, meta: { cached: result.cached, stale: Boolean(result.stale), source: "adsb.lol (military)", matched: entities.length } };
    }
    // empty response → fall through to the OpenSky heuristic
  } catch {
    // adsb.lol unavailable → OpenSky fallback below
  }
  return openSkyMilitaryLayer(bounds);
}
