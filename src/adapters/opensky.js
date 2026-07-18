import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

const tokenState = {
  accessToken: null,
  expiresAt: 0
};

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (tokenState.accessToken && Date.now() < tokenState.expiresAt - 30_000) {
    return tokenState.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "OSIRIS-Situational-Dashboard/0.2"
    },
    body
  });
  if (!response.ok) throw new Error(`OpenSky auth ${response.status} ${response.statusText}`);
  const payload = await response.json();
  tokenState.accessToken = payload.access_token;
  tokenState.expiresAt = Date.now() + Number(payload.expires_in || 1800) * 1000;
  return tokenState.accessToken;
}

// Fetch the OpenSky state vectors for the bounds. Keyed by bounds so the aviation
// and military-aircraft layers share one upstream call (and its 30s cache) when
// both are active over the same viewport.
async function openSkyStates(bounds) {
  const lamin = bounds.lamin ?? "-60";
  const lomin = bounds.lomin ?? "-180";
  const lamax = bounds.lamax ?? "75";
  const lomax = bounds.lomax ?? "180";
  const authenticated = Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
  const key = `opensky:${lamin}:${lomin}:${lamax}:${lomax}`;
  const result = await cachedResilient(key, 30_000, async () => {
    const token = await getOpenSkyToken();
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return fetchJsonRetry(`https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}&extended=1`, { headers });
  });
  return { states: result.value.states || [], cached: result.cached, stale: Boolean(result.stale), authenticated };
}

// Map an OpenSky positional state array to a normalized entity. `layer` selects
// aviation vs military-air (distinct id prefixes so the same aircraft can appear
// in both layers without id collisions).
function stateEntity(row, layer, authenticated) {
  const military = layer === "military-air";
  const emergency = row[14] === "7500" || row[14] === "7600" || row[14] === "7700";
  return entity({
    id: `${military ? "mil" : "air"}-${row[0]}`,
    layer,
    type: military ? "Military aircraft" : "Aircraft",
    name: (row[1] || row[0] || "Unknown aircraft").trim(),
    lon: row[5],
    lat: row[6],
    altitude: row[7],
    velocity: row[9],
    track: row[10],
    squawk: row[14],
    category: row[17],
    originCountry: row[2],
    severity: emergency ? 5 : military ? 4 : row[17] ? 3 : 1,
    source: authenticated ? "OpenSky authenticated" : "OpenSky anonymous",
    time: row[4] ? new Date(row[4] * 1000).toISOString() : null,
    raw: row
  });
}

export async function aviationLayer(bounds) {
  const { states, cached: isCached, stale, authenticated } = await openSkyStates(bounds);
  const entities = states
    .map((row) => stateEntity(row, "aviation", authenticated))
    .filter(finiteCoordinate)
    .slice(0, 1200);

  return {
    entities,
    meta: {
      cached: isCached,
      stale: Boolean(stale),
      authenticated,
      source: "OpenSky Network"
    }
  };
}

// Military ICAO24 hex address ranges (inclusive), sourced from the community-
// maintained tar1090-db `ranges.json` `.military` list — the same heuristic
// adsbexchange/tar1090 use to flag military aircraft. Coverage is not exhaustive:
// aircraft squawking civilian addresses or with ADS-B off will not appear.
const MILITARY_HEX_RANGES = [
  [0xadf7c8, 0xafffff], [0x010070, 0x01008f], [0x0a4000, 0x0a4fff], [0x33ff00, 0x33ffff],
  [0x350000, 0x37ffff], [0x3aa000, 0x3affff], [0x3b7000, 0x3bffff], [0x3ea000, 0x3ebfff],
  [0x3f4000, 0x3fbfff], [0x400000, 0x40003f], [0x43c000, 0x43cfff], [0x444000, 0x446fff],
  [0x44f000, 0x44ffff], [0x457000, 0x457fff], [0x45f400, 0x45f4ff], [0x468000, 0x4683ff],
  [0x473c00, 0x473c0f], [0x478100, 0x4781ff], [0x480000, 0x480fff], [0x48d800, 0x48d87f],
  [0x497c00, 0x497cff], [0x498420, 0x49842f], [0x4b7000, 0x4b7fff], [0x4b8200, 0x4b82ff],
  [0x70c070, 0x70c07f], [0x710258, 0x71028f], [0x710380, 0x71039f], [0x738a00, 0x738aff],
  [0x7cf800, 0x7cfaff], [0x800200, 0x8002ff], [0xc20000, 0xc3ffff], [0xe40000, 0xe41fff]
];

export function isMilitaryHex(icao24) {
  const value = parseInt(icao24, 16);
  if (!Number.isFinite(value)) return false;
  return MILITARY_HEX_RANGES.some(([start, end]) => value >= start && value <= end);
}

export async function militaryAircraftLayer(bounds) {
  const { states, cached: isCached, stale, authenticated } = await openSkyStates(bounds);
  const entities = states
    .filter((row) => row[0] && isMilitaryHex(row[0]))
    .map((row) => stateEntity(row, "military-air", authenticated))
    .filter(finiteCoordinate)
    .slice(0, 400);

  return {
    entities,
    meta: {
      cached: isCached,
      stale: Boolean(stale),
      authenticated,
      source: authenticated ? "OpenSky (military-filtered)" : "OpenSky anonymous (military-filtered)",
      matched: entities.length
    }
  };
}
