import { cached } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";

function requireKey(name) {
  const key = process.env[name];
  if (!key) {
    const error = new Error(`${name} is not configured`);
    error.status = 400;
    throw error;
  }
  return key;
}

export async function abuseIpLookup(ip) {
  const key = requireKey("ABUSEIPDB_API_KEY");
  const params = new URLSearchParams({
    ipAddress: ip,
    maxAgeInDays: String(process.env.ABUSEIPDB_MAX_AGE_DAYS || 90),
    verbose: "true"
  });
  const result = await cached(`abuseipdb:${ip}`, 30 * 60_000, () =>
    fetchJson(`https://api.abuseipdb.com/api/v2/check?${params}`, {
      headers: {
        key,
        accept: "application/json"
      }
    })
  );
  return {
    source: "AbuseIPDB",
    ip,
    cached: result.cached,
    data: result.value.data || result.value
  };
}

export async function greyNoiseLookup(ip) {
  const key = process.env.GREYNOISE_API_KEY;
  const result = await cached(`greynoise:${ip}`, 30 * 60_000, async () => {
    const response = await fetch(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
      headers: key ? { key } : {}
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 404) throw new Error(`${response.status} ${response.statusText}`);
    return body;
  });
  return {
    source: "GreyNoise Community",
    ip,
    cached: result.cached,
    data: result.value
  };
}

function vtHeaders() {
  return { "x-apikey": requireKey("VIRUSTOTAL_API_KEY") };
}

function vtUrlId(url) {
  return Buffer.from(url).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function virusTotalIpLookup(ip) {
  const result = await cached(`virustotal:ip:${ip}`, 30 * 60_000, () =>
    fetchJson(`https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(ip)}`, {
      headers: vtHeaders()
    })
  );
  return {
    source: "VirusTotal",
    type: "ip",
    indicator: ip,
    cached: result.cached,
    data: result.value.data || result.value
  };
}

export async function virusTotalDomainLookup(domain) {
  const result = await cached(`virustotal:domain:${domain}`, 30 * 60_000, () =>
    fetchJson(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, {
      headers: vtHeaders()
    })
  );
  return {
    source: "VirusTotal",
    type: "domain",
    indicator: domain,
    cached: result.cached,
    data: result.value.data || result.value
  };
}

export async function virusTotalUrlLookup(url) {
  const id = vtUrlId(url);
  const result = await cached(`virustotal:url:${id}`, 30 * 60_000, () =>
    fetchJson(`https://www.virustotal.com/api/v3/urls/${id}`, {
      headers: vtHeaders()
    })
  );
  return {
    source: "VirusTotal",
    type: "url",
    indicator: url,
    cached: result.cached,
    data: result.value.data || result.value
  };
}

export async function ipIntel(ip) {
  const lookups = await Promise.allSettled([
    abuseIpLookup(ip).catch((error) => Promise.reject({ source: "AbuseIPDB", error })),
    greyNoiseLookup(ip).catch((error) => Promise.reject({ source: "GreyNoise Community", error })),
    virusTotalIpLookup(ip).catch((error) => Promise.reject({ source: "VirusTotal", error }))
  ]);
  return {
    indicator: ip,
    type: "ip",
    results: lookups.map((result) => result.status === "fulfilled"
      ? result.value
      : {
        source: result.reason?.source || "unavailable",
        error: result.reason?.error?.message || result.reason?.message || "Lookup failed"
      })
  };
}
