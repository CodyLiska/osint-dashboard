import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layerEntities } from "./src/adapters/layers.js";
import {
  abuseIpLookup,
  greyNoiseLookup,
  ipIntel,
  virusTotalDomainLookup,
  virusTotalIpLookup,
  virusTotalUrlLookup,
  whoisLookup
} from "./src/adapters/intel.js";
import { btcLookup, cveSearch, ethLookup, sanctionsSearch } from "./src/adapters/recon.js";
import { geocode } from "./src/adapters/geo.js";
import { getHealth, markSource, withHealth } from "./src/lib/health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

async function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  try {
    const text = await fs.readFile(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await loadEnvFile();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=30"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload, headers = jsonHeaders) {
  send(res, status, JSON.stringify(payload), headers);
}

function boundsFromSearchParams(params) {
  return {
    lamin: params.get("lamin"),
    lomin: params.get("lomin"),
    lamax: params.get("lamax"),
    lomax: params.get("lomax")
  };
}

function sourceNameForLayer(layer) {
  return {
    aviation: "OpenSky Network",
    "military-air": "OpenSky (military)",
    fires: "NASA FIRMS",
    ports: "NGA World Port Index",
    weather: "NASA EONET",
    seismic: "USGS",
    telegram: "Telegram public preview",
    cyber: "NVD",
    space: process.env.N2YO_API_KEY ? "NOAA SWPC, N2YO" : "NOAA SWPC",
    maritime: process.env.AISSTREAM_API_KEY ? "AISStream" : "Static port directory",
    news: process.env.NEWSAPI_KEY ? "NewsAPI" : "Static broadcaster directory",
    crypto: "OFAC SDN",
    sanctions: "Official sanctions feeds"
  }[layer] || layer;
}

function legacyPayload(layer, payload) {
  if (layer === "seismic") {
    return {
      type: "FeatureCollection",
      features: payload.entities.map((row) => ({
        type: "Feature",
        id: row.id.replace(/^quake-/, ""),
        properties: {
          mag: row.magnitude,
          place: row.name,
          time: row.time ? Date.parse(row.time) : null,
          url: row.url
        },
        geometry: { type: "Point", coordinates: [row.lon, row.lat, row.depthKm] }
      }))
    };
  }

  if (layer === "aviation") {
    return {
      time: Math.floor(Date.now() / 1000),
      states: payload.entities.map((row) => row.raw).filter(Boolean)
    };
  }

  if (layer === "telegram") {
    return { posts: payload.entities };
  }

  return payload;
}

async function handleLayer(req, res, url, layer) {
  const payload = await withHealth(layer, sourceNameForLayer(layer), async () => {
    const result = await layerEntities(layer, boundsFromSearchParams(url.searchParams));
    if (!result) {
      const error = new Error(`Unknown layer: ${layer}`);
      error.status = 404;
      throw error;
    }
    return result;
  });

  sendJson(res, 200, {
    layer,
    entities: payload.entities,
    meta: {
      ...payload.meta,
      count: payload.entities.length,
      generatedAt: new Date().toISOString()
    }
  });
}

async function handleApi(req, res, url) {
  try {
    const layerMatch = url.pathname.match(/^\/api\/layers\/([a-z0-9-]+)$/);
    if (layerMatch) return await handleLayer(req, res, url, layerMatch[1]);

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { sources: getHealth() }, {
        ...jsonHeaders,
        "cache-control": "no-store"
      });
    }

    if (url.pathname === "/api/crypto/btc") {
      const address = url.searchParams.get("address");
      if (!address) return sendJson(res, 400, { error: "address required" });
      const data = await withHealth("crypto-btc", "Blockstream Esplora", () => btcLookup(address));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/crypto/eth") {
      const address = url.searchParams.get("address");
      if (!address) return sendJson(res, 400, { error: "address required" });
      const data = await withHealth("crypto-eth", "Ethereum public RPC", () => ethLookup(address));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/geocode") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("geocode", "Nominatim", () => geocode(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/sanctions") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("sanctions", "OpenSanctions", () => sanctionsSearch(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/cves") {
      const keyword = url.searchParams.get("q") || "kev";
      const data = await withHealth("cyber-search", "NVD", () => cveSearch(keyword));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/ip") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("ip-intel", "AbuseIPDB, GreyNoise, VirusTotal", () => ipIntel(ip));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/whois") {
      const query = url.searchParams.get("query") || url.searchParams.get("domain") || url.searchParams.get("ip");
      if (!query) return sendJson(res, 400, { error: "query required" });
      const data = await withHealth("whois", "RDAP + OpenSanctions", () => whoisLookup(query));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/abuseipdb") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("abuseipdb", "AbuseIPDB", () => abuseIpLookup(ip));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/greynoise") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("greynoise", "GreyNoise Community", () => greyNoiseLookup(ip));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/virustotal/ip") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("virustotal-ip", "VirusTotal", () => virusTotalIpLookup(ip));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/virustotal/domain") {
      const domain = url.searchParams.get("domain");
      if (!domain) return sendJson(res, 400, { error: "domain required" });
      const data = await withHealth("virustotal-domain", "VirusTotal", () => virusTotalDomainLookup(domain));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/virustotal/url") {
      const indicator = url.searchParams.get("url");
      if (!indicator) return sendJson(res, 400, { error: "url required" });
      const data = await withHealth("virustotal-url", "VirusTotal", () => virusTotalUrlLookup(indicator));
      return sendJson(res, 200, data);
    }

    const legacy = {
      "/api/usgs": "seismic",
      "/api/eonet": "weather",
      "/api/opensky": "aviation",
      "/api/telegram": "telegram",
      "/api/news": "news",
      "/api/maritime": "maritime"
    }[url.pathname];
    if (legacy) {
      const payload = await withHealth(legacy, sourceNameForLayer(legacy), () =>
        layerEntities(legacy, boundsFromSearchParams(url.searchParams))
      );
      return sendJson(res, 200, legacyPayload(legacy, payload));
    }

    return sendJson(res, 404, { error: "Unknown API route" });
  } catch (error) {
    markSource("last-error", { source: "OSIRIS API", status: "error", error: error.message });
    sendJson(res, error.status || 502, { error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return send(res, 403, "Forbidden");

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";
    send(res, 200, body, { "content-type": type });
  } catch {
    send(res, 404, "Not found");
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  });
}

// Listen only when run directly (`node server.js`); stay silent when imported by
// tests so routing can be exercised on an ephemeral port without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  createServer().listen(port, host, () => {
    console.log(`OSINT dashboard running at http://${host}:${port}`);
  });
}
