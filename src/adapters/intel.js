import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry, withRetry } from "../lib/http.js";
import { sanctionsSearch } from "./recon.js";

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
