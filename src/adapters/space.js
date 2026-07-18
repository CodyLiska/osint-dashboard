import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

function latest(rows) {
  return rows?.length ? rows[rows.length - 1] : null;
}

function alertSeverity(message = "") {
  if (/\b(G4|G5|S4|S5|R4|R5|WARNING|ALERT)\b/i.test(message)) return 5;
  if (/\b(G3|S3|R3|WATCH)\b/i.test(message)) return 4;
  if (/\b(G2|S2|R2)\b/i.test(message)) return 3;
  return 2;
}

const defaultSatelliteIds = [
  25544, // ISS
  48274, // Tianhe
  43013, // NOAA 20
  37849, // Suomi NPP
  28654, // NOAA 18
  33591, // NOAA 19
  41866, // GOES 16
  43226 // GOES 17
];

async function n2yoSatellites() {
  const apiKey = process.env.N2YO_API_KEY;
  if (!apiKey) return { entities: [], meta: { configured: false, count: 0 } };

  const ids = (process.env.N2YO_SATELLITE_IDS || defaultSatelliteIds.join(","))
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite)
    .slice(0, Number(process.env.N2YO_MAX_SATELLITES || 12));

  const observerLat = Number(process.env.N2YO_OBSERVER_LAT || 0);
  const observerLon = Number(process.env.N2YO_OBSERVER_LON || 0);
  const observerAlt = Number(process.env.N2YO_OBSERVER_ALT_M || 0);

  const rows = [];
  for (const id of ids) {
    const result = await cachedResilient(`n2yo:position:${id}:${observerLat}:${observerLon}:${observerAlt}`, 5 * 60_000, () =>
      fetchJsonRetry(`https://api.n2yo.com/rest/v1/satellite/positions/${id}/${observerLat}/${observerLon}/${observerAlt}/1/&apiKey=${encodeURIComponent(apiKey)}`)
    ).catch(() => null);
    const position = result?.value?.positions?.[0];
    if (!position) continue;
    rows.push({ info: result.value.info, position, cached: result.cached });
  }

  const entities = rows.map((row) => entity({
    id: `satellite-${row.info.satid}`,
    layer: "space",
    type: "Satellite position",
    name: row.info.satname || `Satellite ${row.info.satid}`,
    lat: row.position.satlatitude,
    lon: row.position.satlongitude,
    severity: 2,
    time: row.position.timestamp ? new Date(row.position.timestamp * 1000).toISOString() : null,
    source: "N2YO",
    summary: `Altitude ${Number(row.position.sataltitude).toFixed(1)} km; velocity data from N2YO position API.`,
    altitudeKm: row.position.sataltitude,
    satId: row.info.satid,
    raw: row
  })).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      configured: true,
      count: entities.length,
      requested: ids.length
    }
  };
}

export async function spaceWeatherLayer() {
  const result = await cachedResilient("swpc:space-weather", 10 * 60_000, async () => {
    const [alerts, kp] = await Promise.all([
      fetchJsonRetry("https://services.swpc.noaa.gov/products/alerts.json"),
      fetchJsonRetry("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json")
    ]);
    return { alerts, kp };
  });

  const recentAlerts = (result.value.alerts || []).slice(0, 8);
  const kp = latest(result.value.kp || []);
  const satellites = await n2yoSatellites();
  const entities = [
    kp && entity({
      id: `space-kp-${kp.time_tag}`,
      layer: "space",
      type: "Planetary K-index",
      name: `NOAA SWPC Kp ${Number(kp.Kp).toFixed(2)}`,
      lat: 40.015,
      lon: -105.2705,
      severity: Math.min(5, Math.max(1, Math.ceil(Number(kp.Kp) / 2))),
      time: kp.time_tag,
      source: "NOAA SWPC",
      summary: `Planetary K-index ${kp.Kp}; station count ${kp.station_count}.`,
      raw: kp
    }),
    ...recentAlerts.map((alert, index) => entity({
      id: `space-alert-${alert.product_id}-${alert.issue_datetime}-${index}`,
      layer: "space",
      type: "SWPC alert",
      name: alert.product_id || "SWPC alert",
      lat: 40.015 + index * 0.18,
      lon: -105.2705 + index * 0.18,
      severity: alertSeverity(alert.message),
      time: alert.issue_datetime,
      source: "NOAA SWPC",
      summary: alert.message,
      raw: alert
    })),
    ...satellites.entities
  ].filter(Boolean).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: satellites.meta.configured ? "NOAA SWPC, N2YO" : "NOAA SWPC",
      alertCount: recentAlerts.length,
      kp: kp?.Kp,
      n2yo: satellites.meta
    }
  };
}
