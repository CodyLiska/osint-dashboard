import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry, fetchTextRetry, withRetry } from "../lib/http.js";
import { sanctionsSearch } from "./recon.js";
import { COUNTRY_CENTROIDS } from "../lib/centroids.js";

// --- IPv4 helpers (Tor / Spamhaus membership checks) ---
function ipToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function ipInCidr(ipInt, cidr) {
  const [base, bitsStr] = String(cidr).split("/");
  const bits = Number(bitsStr);
  const baseInt = ipToInt(base);
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

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
  const result = await cachedResilient(`abuseipdb:${ip}`, 30 * 60_000, () =>
    fetchJsonRetry(`https://api.abuseipdb.com/api/v2/check?${params}`, {
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

// One GreyNoise community lookup. 404 ("IP not observed") is a valid result, not
// an error; any other non-2xx throws with its status so withRetry can decide
// whether to retry (5xx / network / timeout) or give up (4xx).
async function greyNoiseOnce(ip, key) {
  const response = await fetch(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
    headers: key ? { key } : {},
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok || response.status === 404) return body;
  const error = new Error(`${response.status} ${response.statusText}`);
  error.status = response.status;
  throw error;
}

export async function greyNoiseLookup(ip) {
  const key = process.env.GREYNOISE_API_KEY;
  const result = await cachedResilient(`greynoise:${ip}`, 30 * 60_000, () => withRetry(() => greyNoiseOnce(ip, key)));
  return {
    source: "GreyNoise Community",
    ip,
    cached: result.cached,
    data: result.value
  };
}

// Shodan InternetDB: keyless per-IP exposure — open ports, known CVEs, tags,
// hostnames, CPEs. A 404 ("No information available") is a valid empty result,
// not an error; other non-2xx throw with status so withRetry decides whether to
// retry (5xx / network / timeout) or give up (4xx).
async function internetDbOnce(ip) {
  const response = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status === 404) {
    return { ip, ports: [], vulns: [], tags: [], hostnames: [], cpes: [], found: false };
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return { ...body, found: true };
  const error = new Error(`${response.status} ${response.statusText}`);
  error.status = response.status;
  throw error;
}

export async function shodanInternetDb(ip) {
  const result = await cachedResilient(`internetdb:${ip}`, 30 * 60_000, () => withRetry(() => internetDbOnce(ip)));
  return {
    source: "Shodan InternetDB",
    ip,
    cached: result.cached,
    data: result.value
  };
}

// Feodo Tracker: keyless botnet C2 IP blocklist (Emotet/Dridex/etc.). The list is
// small and refreshed upstream a few times a day, so we cache the whole thing and
// check membership — an IP present is a known malware command-and-control host.
async function feodoBlocklist() {
  const result = await cachedResilient("feodo:ipblocklist", 60 * 60_000, () =>
    fetchJsonRetry("https://feodotracker.abuse.ch/downloads/ipblocklist.json"));
  return Array.isArray(result.value) ? result.value : [];
}

export async function feodoLookup(ip) {
  const hit = (await feodoBlocklist()).find((row) => row.ip_address === ip);
  return {
    source: "Feodo Tracker",
    ip,
    data: hit
      ? {
        c2: true,
        malware: hit.malware,
        port: hit.port,
        status: hit.status,
        firstSeen: hit.first_seen,
        lastOnline: hit.last_online,
        asName: hit.as_name,
        country: hit.country
      }
      : { c2: false }
  };
}

// ThreatFox IOC search. abuse.ch added a mandatory free Auth-Key (register at
// auth.abuse.ch); without ABUSE_CH_AUTH_KEY this reports "not configured" like the
// other keyed sources. A clean IOC returns query_status "no_result" (not an error).
export async function threatFoxLookup(indicator) {
  const key = requireKey("ABUSE_CH_AUTH_KEY");
  const result = await cachedResilient(`threatfox:${indicator}`, 30 * 60_000, () =>
    fetchJsonRetry("https://threatfox-api.abuse.ch/api/v1/", {
      method: "POST",
      headers: { "Auth-Key": key, "content-type": "application/json" },
      body: JSON.stringify({ query: "search_ioc", search_term: indicator })
    }));
  const body = result.value || {};
  const matches = Array.isArray(body.data) ? body.data : [];
  return {
    source: "ThreatFox",
    ip: indicator,
    cached: result.cached,
    data: {
      status: body.query_status,
      matchCount: matches.length,
      matches: matches.slice(0, 10).map((m) => ({
        malware: m.malware_printable || m.malware,
        threatType: m.threat_type,
        confidence: m.confidence_level,
        firstSeen: m.first_seen,
        tags: m.tags,
        reference: m.reference
      }))
    }
  };
}

// URLhaus host lookup (malicious URLs hosted on an IP/domain). Same abuse.ch
// Auth-Key. query_status "no_results" for a clean host is a valid empty result.
export async function urlhausHostLookup(host) {
  const key = requireKey("ABUSE_CH_AUTH_KEY");
  const result = await cachedResilient(`urlhaus:${host}`, 30 * 60_000, () =>
    fetchJsonRetry("https://urlhaus-api.abuse.ch/v1/host/", {
      method: "POST",
      headers: { "Auth-Key": key, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ host }).toString()
    }));
  const body = result.value || {};
  const urls = Array.isArray(body.urls) ? body.urls : [];
  return {
    source: "URLhaus",
    ip: host,
    cached: result.cached,
    data: {
      status: body.query_status,
      urlCount: Number(body.url_count) || urls.length,
      firstSeen: body.firstseen,
      urls: urls.slice(0, 10).map((u) => ({
        url: u.url,
        status: u.url_status,
        threat: u.threat,
        dateAdded: u.date_added,
        tags: u.tags
      }))
    }
  };
}

// Tor exit nodes: keyless bulk list of exit-relay IPs. Cache the set and check
// membership — a queried IP that is a Tor exit is worth flagging.
export async function torExitLookup(ip) {
  const result = await cachedResilient("tor:exitlist", 60 * 60_000, async () => {
    const text = await fetchTextRetry("https://check.torproject.org/torbulkexitlist");
    return new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  });
  return { source: "Tor Exit Nodes", ip, cached: result.cached, data: { torExit: result.value.has(ip) } };
}

// Spamhaus DROP/EDROP: keyless list of hijacked / do-not-route netblocks (CIDR).
// Flag a queried IP that falls inside any listed range.
export async function spamhausDropLookup(ip) {
  const result = await cachedResilient("spamhaus:drop", 6 * 60 * 60_000, async () => {
    const text = await fetchTextRetry("https://www.spamhaus.org/drop/drop_v4.json");
    // NDJSON: one {cidr, sblid, rir} object per line (plus a metadata footer line).
    return String(text).split(/\r?\n/)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row) => row && row.cidr);
  });
  const ipInt = ipToInt(ip);
  const hit = ipInt === null ? null : result.value.find((row) => ipInCidr(ipInt, row.cidr));
  return {
    source: "Spamhaus DROP",
    ip,
    cached: result.cached,
    data: hit ? { listed: true, cidr: hit.cidr, sblid: hit.sblid } : { listed: false }
  };
}

// MalwareBazaar (abuse.ch) file-hash lookup — malware sample metadata (family,
// tags, file type, first/last seen). Same abuse.ch Auth-Key as ThreatFox/URLhaus.
// query_status "hash_not_found" for an unknown hash is a valid empty result.
export async function malwareBazaarLookup(hash) {
  const key = requireKey("ABUSE_CH_AUTH_KEY");
  const result = await cachedResilient(`malwarebazaar:${hash}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry("https://mb-api.abuse.ch/api/v1/", {
      method: "POST",
      headers: { "Auth-Key": key, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: "get_info", hash }).toString()
    }));
  const body = result.value || {};
  const sample = Array.isArray(body.data) ? body.data[0] : null;
  return {
    source: "MalwareBazaar",
    hash,
    cached: result.cached,
    data: sample
      ? {
        found: true,
        sha256: sample.sha256_hash,
        fileName: sample.file_name,
        fileType: sample.file_type,
        fileSize: sample.file_size,
        signature: sample.signature,
        tags: sample.tags,
        firstSeen: sample.first_seen,
        lastSeen: sample.last_seen,
        reporter: sample.reporter,
        deliveryMethod: sample.delivery_method
      }
      : { found: false, status: body.query_status }
  };
}

// crt.sh Certificate Transparency search — keyless subdomain enumeration for a
// domain (every cert ever issued names its hosts). crt.sh is notoriously flaky
// (502s), so it rides cachedResilient + the domain fan-out's allSettled: when it
// is down the domain lookup still returns the other sources.
export async function crtShLookup(domain) {
  const result = await cachedResilient(`crtsh:${domain}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, {}, { timeoutMs: 20_000 }));
  const rows = Array.isArray(result.value) ? result.value : [];
  const lower = domain.toLowerCase();
  const names = new Set();
  for (const row of rows) {
    for (const raw of String(row.name_value || "").split(/\n/)) {
      const name = raw.trim().toLowerCase();
      if (name && !name.startsWith("*") && (name === lower || name.endsWith(`.${lower}`))) names.add(name);
    }
  }
  const subdomains = [...names].sort();
  return {
    source: "crt.sh",
    domain,
    cached: result.cached,
    data: { count: subdomains.length, subdomains: subdomains.slice(0, 100) }
  };
}

// URLScan.io search. Works keyless (the default, low anonymous quota); supplying
// an optional URLSCAN_API_KEY sends the `API-Key` header, which raises the rate
// limit and enlarges result windows — the authenticated higher-quota tier. This
// is the phase-7 pattern: a currently-anonymous source made key-aware without
// changing behavior when no key is set (graceful-off), never made key-required.
export async function urlScanLookup(domain) {
  const key = process.env.URLSCAN_API_KEY;
  const size = key ? 100 : 20; // authenticated requests may pull a larger window
  const headers = key ? { "API-Key": key } : {};
  const result = await cachedResilient(`urlscan:${key ? "auth:" : ""}${domain}`, 60 * 60_000, () =>
    fetchJsonRetry(`https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(domain)}&size=${size}`, { headers }));
  const results = result.value?.results || [];
  return {
    source: "URLScan.io",
    domain,
    cached: result.cached,
    authenticated: Boolean(key),
    data: {
      total: result.value?.total ?? results.length,
      recent: results.slice(0, 10).map((r) => ({
        url: r.page?.url,
        ip: r.page?.ip,
        country: r.page?.country,
        server: r.page?.server,
        title: r.page?.title,
        time: r.task?.time
      }))
    }
  };
}

// Domain intel fan-out (mirrors ipIntel): VirusTotal reputation (keyed), URLhaus
// malicious-URL hosting (keyed), crt.sh subdomains (keyless), URLScan.io (keyless).
// OpenPhish community feed: keyless list of ~300 currently-active phishing URLs.
// feed.txt 302-redirects to the GitHub-hosted raw feed (fetch follows it); we check
// whether the queried host is the hostname of any active phishing URL.
export async function openPhishHostLookup(host) {
  const result = await cachedResilient("openphish:feed", 30 * 60_000, () =>
    fetchTextRetry("https://openphish.com/feed.txt"));
  const target = String(host).trim().toLowerCase().replace(/^www\./, "");
  const matches = [];
  for (const line of String(result.value).split(/\r?\n/)) {
    const url = line.trim();
    if (!url) continue;
    let hostname;
    try { hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { continue; }
    if (target && (hostname === target || hostname.endsWith(`.${target}`))) matches.push(url);
    if (matches.length >= 10) break;
  }
  return {
    source: "OpenPhish",
    ip: host,
    cached: result.cached,
    data: { listed: matches.length > 0, matchCount: matches.length, urls: matches }
  };
}

export async function domainIntel(domain) {
  const lookups = await Promise.allSettled([
    virusTotalDomainLookup(domain).catch((error) => Promise.reject({ source: "VirusTotal", error })),
    urlhausHostLookup(domain).catch((error) => Promise.reject({ source: "URLhaus", error })),
    crtShLookup(domain).catch((error) => Promise.reject({ source: "crt.sh", error })),
    urlScanLookup(domain).catch((error) => Promise.reject({ source: "URLScan.io", error })),
    openPhishHostLookup(domain).catch((error) => Promise.reject({ source: "OpenPhish", error }))
  ]);
  return {
    indicator: domain,
    type: "domain",
    results: lookups.map((result) => result.status === "fulfilled"
      ? result.value
      : { source: result.reason?.source || "unavailable", error: result.reason?.error?.message || result.reason?.message || "Lookup failed" })
  };
}

// RIPEstat: keyless RIPE NCC network/routing data. For an IP it returns the
// announcing AS (number + holder) and the covering prefix — the "what network is
// this on" pivot for the Intel tab. Two small data calls, cached together.
export async function ripeStatLookup(ip) {
  const result = await cachedResilient(`ripestat:${ip}`, 6 * 60 * 60_000, async () => {
    const net = await fetchJsonRetry(`https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}&sourceapp=osiris`);
    const asns = net.data?.asns || [];
    const prefix = net.data?.prefix || null;
    let holder = null;
    if (asns[0]) {
      const overview = await fetchJsonRetry(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asns[0]}&sourceapp=osiris`).catch(() => null);
      holder = overview?.data?.holder || null;
    }
    return { asns, prefix, holder };
  });
  return { source: "RIPEstat", ip, cached: result.cached, data: result.value };
}

function vtHeaders() {
  return { "x-apikey": requireKey("VIRUSTOTAL_API_KEY") };
}

function vtUrlId(url) {
  return Buffer.from(url).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function virusTotalIpLookup(ip) {
  const result = await cachedResilient(`virustotal:ip:${ip}`, 30 * 60_000, () =>
    fetchJsonRetry(`https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(ip)}`, {
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
  const result = await cachedResilient(`virustotal:domain:${domain}`, 30 * 60_000, () =>
    fetchJsonRetry(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, {
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
  const result = await cachedResilient(`virustotal:url:${id}`, 30 * 60_000, () =>
    fetchJsonRetry(`https://www.virustotal.com/api/v3/urls/${id}`, {
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
    virusTotalIpLookup(ip).catch((error) => Promise.reject({ source: "VirusTotal", error })),
    shodanInternetDb(ip).catch((error) => Promise.reject({ source: "Shodan InternetDB", error })),
    feodoLookup(ip).catch((error) => Promise.reject({ source: "Feodo Tracker", error })),
    threatFoxLookup(ip).catch((error) => Promise.reject({ source: "ThreatFox", error })),
    urlhausHostLookup(ip).catch((error) => Promise.reject({ source: "URLhaus", error })),
    torExitLookup(ip).catch((error) => Promise.reject({ source: "Tor Exit Nodes", error })),
    spamhausDropLookup(ip).catch((error) => Promise.reject({ source: "Spamhaus DROP", error })),
    ripeStatLookup(ip).catch((error) => Promise.reject({ source: "RIPEstat", error }))
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

// Cross-source correlation for one IP: joins the reputation fan-out (ipIntel) with
// RDAP + sanctions (whoisLookup) and resolves the announcing network and a country
// geolocation, so one lookup answers "is this bad, whose network is it on, where is
// it, and does it touch a sanctioned party" instead of the analyst reading ten
// cards and a separate WHOIS. The per-source results are passed through unchanged
// so the existing cards still render beneath the correlation summary; the threat
// verdict count is derived on the frontend (one place owns per-source classification).
export async function correlate(ip) {
  const [intel, whois] = await Promise.all([
    ipIntel(ip),
    whoisLookup(ip).catch((error) => ({ error: error.message }))
  ]);

  const bySource = new Map((intel.results || []).map((r) => [r.source, r.data || {}]));
  const vt = bySource.get("VirusTotal") || {};
  const abuse = bySource.get("AbuseIPDB") || {};
  const ripe = bySource.get("RIPEstat") || {};

  // Country is ISO alpha-2 from every carrier (RDAP, VT, AbuseIPDB), so it maps
  // straight onto the bundled centroid table — no geocoding round-trip.
  const country = whois?.summary?.country || vt.country || abuse.countryCode || null;
  const centroid = country ? COUNTRY_CENTROIDS[String(country).toUpperCase()] || null : null;

  const asn = Array.isArray(ripe.asns) ? ripe.asns[0] ?? null : ripe.asns ?? null;
  const network = {
    asn: asn ?? null,
    holder: ripe.holder || vt.as_owner || abuse.isp || null,
    prefix: ripe.prefix || null
  };

  return {
    indicator: ip,
    type: "ip",
    results: intel.results || [],
    sanctions: whois?.sanctions || null,
    network,
    geo: {
      country,
      lat: centroid ? centroid[1] : null,
      lon: centroid ? centroid[0] : null
    }
  };
}

const IP_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$|:/;

// Pull a value out of an RDAP jCard (vcardArray = ["vcard", [ [prop, {}, type, value], ... ]]).
function vcardValue(vcardArray, prop) {
  const rows = Array.isArray(vcardArray) ? vcardArray[1] : null;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => Array.isArray(entry) && entry[0] === prop);
  const value = row?.[3];
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || null;
  return null;
}

// The country sits in the 7th component of a structured jCard "adr" value.
function vcardCountry(vcardArray) {
  const rows = Array.isArray(vcardArray) ? vcardArray[1] : null;
  if (!Array.isArray(rows)) return null;
  const adr = rows.find((entry) => Array.isArray(entry) && entry[0] === "adr");
  const components = adr?.[3];
  return Array.isArray(components) ? components[6] || null : null;
}

// RDAP entities nest (a registrar can hold its own abuse/technical contacts).
function flattenEntities(entities = []) {
  const out = [];
  for (const entity of entities) {
    out.push(entity);
    if (Array.isArray(entity.entities)) out.push(...flattenEntities(entity.entities));
  }
  return out;
}

// Generic contact/role/privacy placeholders that are not real entity names and
// would only produce noise if cross-checked.
const NAME_STOPWORDS = new Set([
  "abuse", "admin", "administrator", "registrant", "registration", "registrar",
  "domain", "domains", "hostmaster", "technical", "tech", "noc", "dns", "network",
  "operations", "support", "billing", "owner", "contact", "n/a", "na", "none"
]);
const REDACTION_PATTERN = /redact|privacy|whois|protect|proxy|masking|not disclosed|data protected|statutory masking|reserved/i;

// A name is worth cross-checking only if it looks like a real org/person name:
// not a role placeholder, not a privacy-redaction string, and carrying at least
// one substantive token (so "LLC"/"Inc"-only strings are dropped).
function isCheckableName(name) {
  const lower = name.toLowerCase().trim();
  if (lower.length < 4 || NAME_STOPWORDS.has(lower) || REDACTION_PATTERN.test(lower)) return false;
  return (lower.match(/[\p{L}\p{N}]{4,}/gu) || []).length >= 1;
}

// Confirm a sanctions hit is a real name-level match (candidate name contains, or
// is contained by, the entity caption or an alias) rather than scattered tokens
// that happen to co-occur in the entity's remarks/programs.
function nameLevelMatch(name, row) {
  const needle = name.toLowerCase().trim();
  const candidates = [row.caption, ...(row.properties?.alias || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().trim());
  return candidates.some((candidate) => candidate && (candidate.includes(needle) || needle.includes(candidate)));
}

// Cross-check contact names/orgs against the sanctions feeds. Names are filtered
// to plausible entity names and each hit is verified at the name level, so common
// orgs and role placeholders do not false-flag.
export async function sanctionsCrossCheck(names) {
  const unique = [...new Set(names.map((name) => String(name || "").trim()))]
    .filter(isCheckableName)
    .slice(0, 8);
  const results = await Promise.all(unique.map(async (name) => {
    try {
      const res = await sanctionsSearch(name);
      const matches = (res.results || [])
        .filter((row) => nameLevelMatch(name, row))
        .slice(0, 3)
        .map((row) => ({ caption: row.caption, schema: row.schema, datasets: row.datasets }));
      return { name, matchCount: matches.length, matches };
    } catch (error) {
      return { name, error: error.message };
    }
  }));
  const flagged = results.filter((row) => row.matchCount > 0);
  return { checked: unique, results, flagged, sanctioned: flagged.length > 0 };
}

// WHOIS via RDAP (rdap.org bootstrap → authoritative RIR/registry), keyless and
// JSON. Handles both domains and IPs, and cross-checks contact names/orgs against
// the sanctions feeds.
export async function whoisLookup(query) {
  const raw = String(query || "").trim();
  if (!raw) {
    const error = new Error("query required");
    error.status = 400;
    throw error;
  }
  const isIp = IP_PATTERN.test(raw);
  const type = isIp ? "ip" : "domain";
  const target = isIp ? raw : raw.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  const rdapUrl = `https://rdap.org/${type}/${encodeURIComponent(target)}`;

  const result = await cachedResilient(`rdap:${type}:${target}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(rdapUrl, { headers: { accept: "application/rdap+json, application/json" } })
  );
  const rdap = result.value;

  const contacts = flattenEntities(rdap.entities || []).map((entity) => ({
    roles: entity.roles || [],
    handle: entity.handle || null,
    name: vcardValue(entity.vcardArray, "fn"),
    org: vcardValue(entity.vcardArray, "org"),
    country: vcardCountry(entity.vcardArray)
  }));
  const events = Object.fromEntries((rdap.events || []).map((event) => [event.eventAction, event.eventDate]));
  const registrar = contacts.find((contact) => contact.roles.includes("registrar"));

  const summary = isIp
    ? {
      handle: rdap.handle || null,
      network: rdap.name || null,
      range: rdap.startAddress && rdap.endAddress ? `${rdap.startAddress} - ${rdap.endAddress}` : null,
      ipVersion: rdap.ipVersion || null,
      country: rdap.country || contacts.find((contact) => contact.country)?.country || null,
      registration: events.registration || events["last changed"] || null,
      status: rdap.status || []
    }
    : {
      domain: rdap.ldhName || rdap.unicodeName || target,
      registrar: registrar?.org || registrar?.name || null,
      registrationDate: events.registration || null,
      expirationDate: events.expiration || null,
      lastChanged: events["last changed"] || null,
      nameservers: (rdap.nameservers || []).map((ns) => ns.ldhName).filter(Boolean),
      status: rdap.status || []
    };

  // Cross-check every contact name/org except the registrar's own identity
  // (plus the network name for IPs), which is who we actually care about.
  const names = [
    ...(isIp ? [rdap.name] : []),
    ...contacts.filter((contact) => !contact.roles.includes("registrar")).flatMap((contact) => [contact.org, contact.name])
  ];
  const sanctions = await sanctionsCrossCheck(names);

  return {
    source: "RDAP (rdap.org)",
    type,
    query: raw,
    cached: result.cached,
    summary,
    sanctions,
    contacts,
    rdap
  };
}
