import { entity, finiteCoordinate } from "../lib/normalize.js";

const portFallback = [
  ["Shanghai", 31.2304, 121.4737], ["Singapore", 1.2644, 103.8200], ["Ningbo-Zhoushan", 29.8683, 121.5440],
  ["Shenzhen", 22.5431, 114.0579], ["Guangzhou", 23.1291, 113.2644], ["Busan", 35.1796, 129.0756],
  ["Qingdao", 36.0671, 120.3826], ["Hong Kong", 22.3193, 114.1694], ["Tianjin", 39.3434, 117.3616],
  ["Rotterdam", 51.9244, 4.4777], ["Antwerp", 51.2194, 4.4025], ["Hamburg", 53.5511, 9.9937],
  ["Los Angeles", 33.7405, -118.2775], ["Long Beach", 33.7701, -118.1937], ["New York/New Jersey", 40.6681, -74.0451],
  ["Santos", -23.9608, -46.3336], ["Jebel Ali", 25.0118, 55.0616], ["Felixstowe", 51.9542, 1.3511],
  ["Valencia", 39.4699, -0.3763], ["Piraeus", 37.9429, 23.6469], ["Colombo", 6.9271, 79.8612],
  ["Tanjung Pelepas", 1.3626, 103.5480], ["Port Klang", 3.0016, 101.3928], ["Laem Chabang", 13.0827, 100.8836],
  ["Kaohsiung", 22.6273, 120.3014], ["Manila", 14.5995, 120.9842], ["Jakarta", -6.2088, 106.8456],
  ["Melbourne", -37.8136, 144.9631], ["Sydney", -33.8688, 151.2093], ["Vancouver", 49.2827, -123.1207],
  ["Seattle/Tacoma", 47.6062, -122.3321], ["Oakland", 37.8044, -122.2712], ["Houston", 29.7604, -95.3698],
  ["Savannah", 32.0809, -81.0912], ["Norfolk", 36.8508, -76.2859], ["Durban", -29.8587, 31.0218],
  ["Mombasa", -4.0435, 39.6682], ["Lagos", 6.5244, 3.3792], ["Istanbul", 41.0082, 28.9784]
];

function fallbackLayer() {
  return {
    entities: portFallback.map(([name, lat, lon]) => entity({
      id: `maritime-port-${name}`,
      layer: "maritime",
      type: "Port",
      name,
      lat,
      lon,
      severity: 2,
      source: "Static port directory",
      summary: "AISStream key not configured; showing static global ports."
    })),
    meta: {
      source: "Static port directory",
      configured: false,
      count: portFallback.length
    }
  };
}

function worldOrBounds(bounds) {
  const lamin = Number(bounds.lamin);
  const lomin = Number(bounds.lomin);
  const lamax = Number(bounds.lamax);
  const lomax = Number(bounds.lomax);
  if ([lamin, lomin, lamax, lomax].every(Number.isFinite) && Math.abs(lomax - lomin) < 355) {
    return [[Math.max(-90, lamin), Math.max(-180, lomin)], [Math.min(90, lamax), Math.min(180, lomax)]];
  }
  return [[-90, -180], [90, 180]];
}

function collectAisMessages(apiKey, bounds) {
  const timeoutMs = Number(process.env.AISSTREAM_COLLECT_MS || 6500);
  const max = Number(process.env.AISSTREAM_MAX_ITEMS || 120);
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("WebSocket runtime unavailable in this Node version"));
      return;
    }

    const rows = [];
    const socket = new WebSocket("wss://stream.aisstream.io/v0/stream");
    const done = (error) => {
      clearTimeout(timer);
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      } catch {}
      error ? reject(error) : resolve(rows);
    };
    const timer = setTimeout(() => done(), timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [worldOrBounds(bounds)],
        FilterMessageTypes: ["PositionReport"]
      }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const report = payload.Message?.PositionReport;
        if (!report || !Number.isFinite(report.Latitude) || !Number.isFinite(report.Longitude)) return;
        rows.push({ payload, report });
        if (rows.length >= max) done();
      } catch {}
    });

    socket.addEventListener("error", () => done(new Error("AISStream connection failed")));
  });
}

export async function maritimeLayer(bounds = {}) {
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) return fallbackLayer();

  const rows = await collectAisMessages(apiKey, bounds);
  const entities = rows.map(({ payload, report }, index) => entity({
    id: `ais-${payload.MetaData?.MMSI || report.UserID || index}`,
    layer: "maritime",
    type: "AIS vessel",
    name: payload.MetaData?.ShipName?.trim() || `MMSI ${payload.MetaData?.MMSI || report.UserID}`,
    lat: report.Latitude,
    lon: report.Longitude,
    severity: report.Sog > 20 ? 3 : 2,
    time: payload.MetaData?.time_utc,
    source: "AISStream",
    summary: `MMSI ${payload.MetaData?.MMSI || report.UserID}; speed ${report.Sog ?? "?"} kn; course ${report.Cog ?? "?"}.`,
    mmsi: payload.MetaData?.MMSI || report.UserID,
    speedKnots: report.Sog,
    course: report.Cog,
    heading: report.TrueHeading,
    raw: payload
  })).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      source: "AISStream",
      configured: true,
      count: entities.length,
      collectMs: Number(process.env.AISSTREAM_COLLECT_MS || 6500)
    }
  };
}
