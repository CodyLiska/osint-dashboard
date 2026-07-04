import { cached } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
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

export async function aviationLayer(bounds) {
  const lamin = bounds.lamin ?? "-60";
  const lomin = bounds.lomin ?? "-180";
  const lamax = bounds.lamax ?? "75";
  const lomax = bounds.lomax ?? "180";
  const authenticated = Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
  const key = `opensky:${lamin}:${lomin}:${lamax}:${lomax}`;
  const result = await cached(key, 30_000, async () => {
    const token = await getOpenSkyToken();
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    return fetchJson(`https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}&extended=1`, { headers });
  });

  const entities = (result.value.states || [])
    .map((row) => entity({
      id: `air-${row[0]}`,
      layer: "aviation",
      type: "Aircraft",
      name: (row[1] || row[0] || "Unknown aircraft").trim(),
      lon: row[5],
      lat: row[6],
      altitude: row[7],
      velocity: row[9],
      track: row[10],
      squawk: row[14],
      category: row[17],
      originCountry: row[2],
      severity: row[14] === "7500" || row[14] === "7600" || row[14] === "7700" ? 5 : row[17] ? 3 : 1,
      source: authenticated ? "OpenSky authenticated" : "OpenSky anonymous",
      time: row[4] ? new Date(row[4] * 1000).toISOString() : null,
      raw: row
    }))
    .filter(finiteCoordinate)
    .slice(0, 1200);

  return {
    entities,
    meta: {
      cached: result.cached,
      authenticated,
      source: "OpenSky Network"
    }
  };
}
