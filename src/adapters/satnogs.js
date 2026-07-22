import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// SatNOGS — keyless open network of community satellite ground stations. Each
// station reports fixed coordinates (lat/lng) plus its status and antennas, so
// this is a reference layer of the global amateur SDR receiving network; it pairs
// with the space/satellite layer ("where can this satellite be received").
const SATNOGS_URL = "https://network.satnogs.org/api/stations/?format=json";
const MAX_STATIONS = 2000;

export async function satnogsLayer() {
  const result = await cachedResilient("satnogs:stations", 6 * 60 * 60_000, () =>
    fetchJsonRetry(SATNOGS_URL));
  const stations = Array.isArray(result.value) ? result.value : [];

  const entities = stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .slice(0, MAX_STATIONS)
    .map((s) => entity({
      id: `satnogs-${s.id}`,
      layer: "satnogs",
      type: "Satellite ground station",
      name: s.name || `Station ${s.id}`,
      lat: s.lat,
      lon: s.lng,
      // Online stations are the operationally relevant ones; rank them above the rest.
      severity: s.status === "Online" ? 3 : 2,
      time: s.last_seen || null,
      source: "SatNOGS Network",
      summary: `${s.status || "Unknown"} ground station${Array.isArray(s.antenna) && s.antenna.length ? `; ${s.antenna.length} antenna(s)` : ""}${s.qthlocator ? ` (${s.qthlocator})` : ""}.`,
      status: s.status,
      grid: s.qthlocator
    }))
    .filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      count: entities.length,
      source: "SatNOGS ground station network"
    }
  };
}
