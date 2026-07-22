import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layerEntities, sourceName as sourceNameForLayer } from "./src/adapters/layers.js";
import {
  abuseIpLookup,
  greyNoiseLookup,
  correlate,
  domainIntel,
  ipIntel,
  malwareBazaarLookup,
  virusTotalDomainLookup,
  virusTotalIpLookup,
  virusTotalUrlLookup,
  whoisLookup
} from "./src/adapters/intel.js";
import { btcLookup, cveSearch, ethLookup, icsAdvisories, sanctionsSearch, vulnCheckKev } from "./src/adapters/recon.js";
import { geocode } from "./src/adapters/geo.js";
import { fxRates, countryMacro } from "./src/adapters/economic.js";
import { secCompany, wikidataEntity, gravatarProfile, githubUser } from "./src/adapters/entity.js";
import { sceneSearch } from "./src/adapters/imagery.js";
import { getHealth, markSource, withHealth } from "./src/lib/health.js";
import { getAlerts, getChanges, getDb, getHistory, getSnapshotAt, openDb, persistSnapshot, ruleStats, startRetention } from "./src/lib/persist.js";
import { currentRules, loadRules } from "./src/lib/alert-rules.js";
import { evaluateAlerts } from "./src/lib/alerts.js";

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

  // Fire-and-forget history write, after the response is sent. No-op unless
  // OSIRIS_DB_PATH is set and the layer is persistable; a failure here must never
  // delay or break the layer response, so it is caught and logged.
  let classification = null;
  try {
    classification = persistSnapshot(layer, payload.entities, payload.meta);
  } catch (error) {
    console.error(`[persist] ${layer}:`, error.message);
  }

  // Alert evaluation rides the same fire-and-forget slot. It needs the store, so
  // it is a no-op when persistence is disabled. Awaited inside its own catch so
  // a Slack outage or a bad rule can never surface to the client.
  if (classification) {
    try {
      const rules = currentRules();
      if (rules.length) await evaluateAlerts(getDb(), layer, classification, rules);
    } catch (error) {
      console.error(`[alerts] ${layer}:`, error.message);
    }
  }
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

    if (url.pathname === "/api/changes") {
      const raw = url.searchParams.get("since");
      if (raw && Number.isNaN(Date.parse(raw))) {
        return sendJson(res, 400, { error: "since must be an ISO 8601 timestamp" });
      }
      const since = raw || new Date(Date.now() - 86_400_000).toISOString();
      return sendJson(res, 200, getChanges(since), { ...jsonHeaders, "cache-control": "no-store" });
    }

    if (url.pathname === "/api/alerts") {
      const raw = url.searchParams.get("since");
      if (raw && Number.isNaN(Date.parse(raw))) {
        return sendJson(res, 400, { error: "since must be an ISO 8601 timestamp" });
      }
      const since = raw || new Date(Date.now() - 7 * 86_400_000).toISOString();
      const payload = getAlerts(since);
      if (payload.enabled) {
        // Join the configured rules against their fire counts so a rule that has
        // never matched is visible as such, rather than just absent.
        const stats = ruleStats();
        payload.rules = currentRules().map((rule) => ({
          id: rule.id,
          enabled: rule.enabled,
          layers: rule.layers,
          fires: stats.get(rule.id)?.fires || 0,
          lastFiredAt: stats.get(rule.id)?.lastFiredAt || null
        }));
      }
      return sendJson(res, 200, payload, { ...jsonHeaders, "cache-control": "no-store" });
    }

    const snapshotMatch = url.pathname.match(/^\/api\/snapshot\/([a-z0-9-]+)$/);
    if (snapshotMatch) {
      const raw = url.searchParams.get("at");
      if (raw && Number.isNaN(Date.parse(raw))) {
        return sendJson(res, 400, { error: "at must be an ISO 8601 timestamp" });
      }
      const at = raw || new Date().toISOString();
      return sendJson(res, 200, getSnapshotAt(snapshotMatch[1], at), {
        ...jsonHeaders,
        "cache-control": "no-store"
      });
    }

    const historyMatch = url.pathname.match(/^\/api\/history\/([a-z0-9-]+)$/);
    if (historyMatch) {
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      for (const [name, value] of [["since", since], ["until", until]]) {
        if (value && Number.isNaN(Date.parse(value))) {
          return sendJson(res, 400, { error: `${name} must be an ISO 8601 timestamp` });
        }
      }
      return sendJson(res, 200, getHistory(historyMatch[1], { since, until }), {
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

    if (url.pathname === "/api/econ/fx") {
      const base = url.searchParams.get("base") || "USD";
      const data = await withHealth("econ-fx", "Frankfurter (ECB)", () => fxRates(base));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/econ/country") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("econ-country", "World Bank", () => countryMacro(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/entity/company") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("entity-company", "SEC EDGAR", () => secCompany(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/entity/wikidata") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("entity-wikidata", "Wikidata", () => wikidataEntity(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/entity/gravatar") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("entity-gravatar", "Gravatar", () => gravatarProfile(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/entity/github") {
      const q = url.searchParams.get("q");
      if (!q) return sendJson(res, 400, { error: "q required" });
      const data = await withHealth("entity-github", "GitHub", () => githubUser(q));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/imagery/scenes") {
      const bboxParam = url.searchParams.get("bbox");
      // Read raw first: Number(null) is 0, so coercing an absent lat/lon would
      // silently search at [0,0] instead of erroring.
      const latRaw = url.searchParams.get("lat");
      const lonRaw = url.searchParams.get("lon");
      let bbox;
      if (bboxParam) {
        bbox = bboxParam.split(",").map(Number);
        if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
          return sendJson(res, 400, { error: "bbox must be minLon,minLat,maxLon,maxLat" });
        }
      } else if (latRaw !== null && lonRaw !== null && Number.isFinite(Number(latRaw)) && Number.isFinite(Number(lonRaw))) {
        const lat = Number(latRaw);
        const lon = Number(lonRaw);
        const pad = 0.08; // ~9km box around the point
        bbox = [lon - pad, lat - pad, lon + pad, lat + pad];
      } else {
        return sendJson(res, 400, { error: "bbox or lat/lon required" });
      }
      const data = await withHealth("imagery-scenes", "Earth Search STAC", () => sceneSearch(bbox));
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
      // Special keywords reuse the CVE result shape: "ics" = CISA OT/ICS advisories
      // (keyless), "vulncheck" = VulnCheck exploited-CVE intel (optional-keyed).
      const kw = keyword.toLowerCase();
      const data = kw === "ics"
        ? await withHealth("ics-advisories", "CISA ICS", () => icsAdvisories())
        : kw === "vulncheck"
          ? await withHealth("vulncheck", "VulnCheck", () => vulnCheckKev())
          : await withHealth("cyber-search", "NVD", () => cveSearch(keyword));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/ip") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("ip-intel", "AbuseIPDB, GreyNoise, VirusTotal", () => ipIntel(ip));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/correlate") {
      const ip = url.searchParams.get("ip");
      if (!ip) return sendJson(res, 400, { error: "ip required" });
      const data = await withHealth("correlate", "IP intel + RDAP + OpenSanctions", () => correlate(ip));
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

    if (url.pathname === "/api/intel/domain") {
      const domain = url.searchParams.get("domain");
      if (!domain) return sendJson(res, 400, { error: "domain required" });
      const data = await withHealth("domain-intel", "VirusTotal, URLhaus, crt.sh", () => domainIntel(domain));
      return sendJson(res, 200, data);
    }

    if (url.pathname === "/api/intel/malwarebazaar") {
      const hash = url.searchParams.get("hash");
      if (!hash) return sendJson(res, 400, { error: "hash required" });
      const data = await withHealth("malwarebazaar", "MalwareBazaar", () => malwareBazaarLookup(hash));
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
// State the alerting posture once at boot, in every case. Rules are otherwise
// loaded lazily on the first persistable layer fetch, and a missing rules file
// logs nothing at all — so without this an operator cannot tell "configured and
// waiting" from "silently disabled", which is the worst failure this feature
// has. Says why it is off, not just that it is.
function reportAlertStatus() {
  if (!process.env.OSIRIS_DB_PATH) {
    console.log("[alerts] disabled: OSIRIS_DB_PATH is not set (alert dedupe lives in the history store)");
    return;
  }
  const rulesPath = process.env.OSIRIS_ALERT_RULES_PATH || "./config/alert-rules.json";
  const { rules, errors, present } = loadRules(rulesPath);
  if (!present) {
    console.log(`[alerts] idle: no rules file at ${rulesPath} — create one to enable alerting`);
    return;
  }
  const dryRun = process.env.OSIRIS_ALERT_DRY_RUN === "1" ? " (DRY RUN: logging only, nothing sent or recorded)" : "";
  const rejected = errors.length ? `, ${errors.length} rejected` : "";
  const sink = process.env.SLACK_WEBHOOK_URL ? "Slack" : "log only (no SLACK_WEBHOOK_URL)";
  console.log(`[alerts] active: ${rules.length} rule(s) from ${rulesPath}${rejected} → ${sink}${dryRun}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  openDb(); // no-op unless OSIRIS_DB_PATH is set
  startRetention();
  reportAlertStatus();
  createServer().listen(port, host, () => {
    console.log(`OSINT dashboard running at http://${host}:${port}`);
  });
}
