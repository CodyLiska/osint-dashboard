import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(",").map((item) => item.trim()) || [];
  if (!headers.includes("latitude") || !headers.includes("longitude")) {
    throw new Error(`Unexpected FIRMS response: ${text.slice(0, 120)}`);
  }
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function viewportArea(bounds) {
  const westRaw = Number(bounds.lomin ?? -180);
  const southRaw = Number(bounds.lamin ?? -90);
  const eastRaw = Number(bounds.lomax ?? 180);
  const northRaw = Number(bounds.lamax ?? 90);
  const west = Math.max(-180, Math.min(180, westRaw));
  const east = Math.max(-180, Math.min(180, eastRaw));
  const south = Math.max(-90, Math.min(90, southRaw));
  const north = Math.max(-90, Math.min(90, northRaw));
  if (east <= west || north <= south || eastRaw - westRaw >= 350) return "world";
  return `${west},${south},${east},${north}`;
}

export async function firesLayer(bounds) {
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) {
    return {
      entities: [],
      meta: {
        cached: false,
        configured: false,
        source: "NASA FIRMS",
        message: "Set FIRMS_MAP_KEY to enable active fire detections."
      }
    };
  }

  const area = viewportArea(bounds);
  const sources = (process.env.FIRMS_SOURCES || process.env.FIRMS_SOURCE || "VIIRS_NOAA20_NRT,VIIRS_SNPP_NRT,MODIS_NRT")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  const dayRange = process.env.FIRMS_DAY_RANGE || "1";
  const key = `firms:${sources.join("+")}:${area}:${dayRange}`;
  const result = await cachedResilient(key, 10 * 60_000, async () => {
    const texts = await Promise.all(sources.map(async (source) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/${area}/${dayRange}`;
      return { source, text: await fetchTextRetry(url) };
    }));
    return texts.flatMap(({ source, text }) => parseCsv(text).map((row) => ({ ...row, sourceProduct: source })));
  });

  const entities = result.value.map((row, index) => {
    const confidence = Number(row.confidence || row.confidence_text || 0);
    const bright = Number(row.bright_ti4 || row.brightness || 0);
    return entity({
      id: `fire-${row.latitude}-${row.longitude}-${row.acq_date}-${row.acq_time}-${index}`,
      layer: "fires",
      type: "Active fire",
      name: `${row.satellite || row.sourceProduct || "FIRMS"} thermal detection`,
      lat: row.latitude,
      lon: row.longitude,
      severity: confidence >= 80 || bright >= 340 ? 5 : confidence >= 50 ? 4 : 3,
      time: row.acq_date && row.acq_time ? `${row.acq_date}T${String(row.acq_time).padStart(4, "0").slice(0, 2)}:${String(row.acq_time).padStart(4, "0").slice(2)}:00Z` : null,
      source: "NASA FIRMS",
      confidence: row.confidence,
      frp: row.frp,
      satellite: row.satellite,
      sourceProduct: row.sourceProduct,
      raw: row
    });
  }).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      configured: true,
      source: "NASA FIRMS",
      sourceProducts: sources,
      area
    }
  };
}
