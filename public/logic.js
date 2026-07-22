// Pure, side-effect-free logic extracted from app.js so it can be unit-tested in
// Node (app.js itself touches browser globals — maplibregl, deck, document,
// localStorage — and runs side effects on import, so it can't be imported here).
// Everything in this module is deterministic and free of DOM/CDN dependencies;
// app.js imports these back. Rendering/DOM code stays in app.js (Playwright-verified).

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

// Identity of a viewport-scoped request: the bbox at exactly the precision
// fetchLayer puts on the wire. Two viewports with the same key produce a
// byte-identical request, so a viewport-triggered refresh between them has
// nothing to fetch. Rounding here (rather than comparing raw floats against an
// epsilon) means the skip is provable rather than a guess at "close enough".
export const BOUNDS_PRECISION = 2;

export function boundsKey(south, west, north, east) {
  return [south, west, north, east].map((n) => Number(n).toFixed(BOUNDS_PRECISION)).join(",");
}

// Dense layers that collapse into count badges when zoomed out. A layer only
// clusters once it has at least CLUSTER_MIN_POINTS visible entities and the map
// is below CLUSTER_MAX_ZOOM; past that zoom every point renders individually.
export const CLUSTER_LAYERS = new Set(["aviation", "military-air", "fires", "seismic", "news", "telegram", "maritime", "ports", "gdelt", "gdacs", "ucdp", "power-plants", "infrastructure", "pskreporter", "satnogs"]);
export const CLUSTER_MIN_POINTS = 15;
export const CLUSTER_MAX_ZOOM = 5;

export function shouldCluster(id, rows, zoom) {
  return CLUSTER_LAYERS.has(id) && rows.length >= CLUSTER_MIN_POINTS && zoom < CLUSTER_MAX_ZOOM;
}

// Grid-bin points into clusters. Cells shrink as you zoom in, so clusters split
// apart. A cell with one point is returned as a single (rendered as its normal
// icon); multi-point cells collapse into one count badge at the cell centroid.
export function clusterPoints(rows, zoom) {
  const cellDeg = 90 / 2 ** zoom;
  const bins = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
    const key = `${Math.floor(row.lon / cellDeg)}:${Math.floor(row.lat / cellDeg)}`;
    let bin = bins.get(key);
    if (!bin) {
      bin = { sumLon: 0, sumLat: 0, items: [] };
      bins.set(key, bin);
    }
    bin.sumLon += row.lon;
    bin.sumLat += row.lat;
    bin.items.push(row);
  }
  const singles = [];
  const clusters = [];
  for (const bin of bins.values()) {
    if (bin.items.length === 1) {
      singles.push(bin.items[0]);
    } else {
      clusters.push({
        lon: bin.sumLon / bin.items.length,
        lat: bin.sumLat / bin.items.length,
        count: bin.items.length
      });
    }
  }
  return { singles, clusters };
}

// Drop rows below the minimum severity (minSeverity=1 keeps everything).
export function filterBySeverity(rows, minSeverity) {
  if (minSeverity <= 1) return rows;
  return rows.filter((row) => (Number(row.severity) || 1) >= minSeverity);
}

// Advance one aircraft from its last known ground speed + heading over dtSeconds.
// Returns the unchanged position when speed/track/position aren't usable, so a
// caller can detect "no movement" by identity of the returned lat/lon.
export function advancePosition({ lat, lon, velocity, track }, dtSeconds) {
  const speed = Number(velocity); // metres/second
  const heading = Number(track);  // degrees clockwise from north
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(heading)) return { lat, lon };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat, lon };
  const dist = speed * dtSeconds; // metres travelled
  const rad = (heading * Math.PI) / 180;
  const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
  return {
    lat: lat + (dist * Math.cos(rad)) / 111_320,
    lon: lon + (dist * Math.sin(rad)) / (111_320 * cosLat)
  };
}

// Highest-severity, then most-recent first.
export function byPriority(a, b) {
  return (Number(b.severity) || 1) - (Number(a.severity) || 1)
    || String(b.time || "").localeCompare(String(a.time || ""));
}

// Aggregate the most notable located items across the enabled layers for the Live
// Desk. getVisible(id) returns that layer's severity-filtered entities. Each
// layer's contribution is capped first (perLayer) so one noisy layer can't crowd
// out everything else, then the merged list is sorted by priority and capped.
export function buildFeed(enabledIds, getVisible, { limit, perLayer }) {
  return [...enabledIds]
    .flatMap((id) => getVisible(id)
      .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon))
      .sort(byPriority)
      .slice(0, perLayer))
    .sort(byPriority)
    .slice(0, limit);
}

// Collect the present detail fields as [label, value] pairs. Labels and values
// are rendered distinctly (muted uppercase label beside a bright value) so the
// card reads as structured data rather than a wall of identical sentences.
export function detailRows(item) {
  const rows = [];
  const add = (label, value) => {
    if (value !== null && value !== undefined && value !== "") rows.push([label, String(value)]);
  };
  add("Magnitude", item.magnitude);
  add("CVSS", item.cvss);
  if (item.epss) add("EPSS", `${(Number(item.epss) * 100).toFixed(1)}%`);
  if (item.kev) add("Exploited", "Known exploited vulnerability");
  add("Due", item.dueDate);
  if (item.cwes?.length) add("Weakness", item.cwes.join(", "));
  add("Chain", item.chain);
  add("Address", item.address);
  if (item.groupCount) add("Entries", Number(item.groupCount).toLocaleString());
  add("Group", item.groupLabel);
  add("MMSI", item.mmsi);
  if (Number.isFinite(item.speedKnots)) add("Speed", `${Number(item.speedKnots).toFixed(1)} kn`);
  if (Number.isFinite(item.course)) add("Course", `${Number(item.course).toFixed(1)}°`);
  if (Number.isFinite(item.altitudeKm)) add("Altitude", `${Number(item.altitudeKm).toFixed(1)} km`);
  add("SDN", item.sdnName);
  add("SDN type", item.sdnType);
  add("Country", item.country);
  add("Region", item.region);
  add("WPI", item.portNumber);
  add("Harbor size", item.harborSize);
  add("Harbor type", item.harborType);
  add("NAVAREA", item.navArea);
  add("UN/LOCODE", item.unloCode);
  add("Chart", item.chartNumber);
  if (item.facilities?.length) add("Facilities", item.facilities.join(", "));
  if (item.programs?.length) add("Programs", item.programs.slice(0, 6).join(", "));
  if (item.topPrograms?.length) add("Top programs", item.topPrograms.map((row) => `${row.name} (${row.count})`).join(", "));
  if (item.topCountries?.length) add("Top countries", item.topCountries.map((row) => `${row.name} (${row.count})`).join(", "));
  if (item.sampleEntries?.length) add("Sample", item.sampleEntries.map((row) => row.name).join("; "));
  add("OFAC UID", item.uid);
  if (Number.isFinite(item.akaCount)) add("Aliases", item.akaCount);
  if (Number.isFinite(item.idCount)) add("IDs", item.idCount);
  if (item.altitude) add("Altitude", `${Math.round(item.altitude).toLocaleString()} m`);
  add("Event class", item.eventClass);
  if (Number.isFinite(item.articles) && item.articles) {
    add("Coverage", `${item.articles} article${item.articles === 1 ? "" : "s"}`);
  }
  if (Number.isFinite(item.tone) && item.eventClass) add("Tone", Number(item.tone).toFixed(1));
  add("Confidence", item.confidence);
  add("Source", item.source);
  return rows;
}

// ATT&CK technique tags for a cyber entity, each a deep-link to its MITRE page.
// Returns "" when the entity carries no techniques (non-cyber entities, or a CVE
// whose CWE has no curated mapping), so callers can drop it into a card blindly.
// The tags are weakness-derived (CVE→CWE→technique), labelled as such in the UI.
export function attackTags(item) {
  const techniques = item?.techniques || [];
  if (!techniques.length) return "";
  const links = techniques
    .map((t) => extLink(t.url, `${t.id} · ${t.name}`))
    .join("");
  return `<div class="attack-tags">
    <span class="attack-label">ATT&CK <span class="attack-note">(from CWE)</span></span>
    <div class="result-refs">${links}</div>
  </div>`;
}

export function kvRow(label, value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
  return text ? `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(text))}</span></div>` : "";
}

export function extLink(url, label) {
  return `<a class="result-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)} ↗</a>`;
}

// --- NASA GIBS imagery tiles (raster layers) -------------------------------

// WMTS REST tile template for a MapLibre raster source. MapLibre fills {z}/{y}/{x};
// GIBS orders the path row-before-col (z/y/x). A `gibs.date` pins a fixed-date
// product (e.g. Black Marble); otherwise the supplied daily `date` is used.
export function gibsTileUrl(gibs, date) {
  const day = gibs.date || date;
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${gibs.layer}/default/${day}/${gibs.matrix}/{z}/{y}/{x}.${gibs.ext}`;
}

// Daily GIBS imagery lags by processing latency and the UTC day boundary, so
// default to yesterday (UTC) rather than today to avoid a not-yet-published day.
export function yesterdayUTC(now = Date.now()) {
  return new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Sentinel-2 scene-search results as a thumbnail grid (Scenes recon tab).
export function sceneResults(payload, place) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  const scenes = payload?.scenes || [];
  if (!scenes.length) return `<div class="badge warn">No recent low-cloud Sentinel-2 scenes for ${escapeHtml(place?.name || "this location")}.</div>`;
  const head = `<div class="badge ok">${escapeHtml(place?.name || "Location")} — newest ${scenes.length} of ${escapeHtml(String(payload.matched ?? scenes.length))}</div>`;
  const cards = scenes.map((s) => `
    <a class="scene-card" href="${escapeHtml(s.thumbnail)}" target="_blank" rel="noreferrer">
      <img loading="lazy" src="${escapeHtml(s.thumbnail)}" alt="${escapeHtml(s.id)}">
      <span class="scene-meta"><strong>${escapeHtml(s.datetime ? s.datetime.slice(0, 10) : "—")}</strong><span>${s.cloud == null ? "" : `${escapeHtml(String(s.cloud))}% cloud · `}${escapeHtml(s.platform)}</span></span>
    </a>`).join("");
  return `<div class="econ-body">${head}<div class="scene-grid">${cards}</div><p class="result-note">Source: ${escapeHtml(payload.source || "Earth Search")}</p></div>`;
}

// World Bank indicator value → a compact, human-readable string. `kind` comes
// from the adapter (usd / int / pct) so formatting never has to guess.
export function formatMacroValue(value, kind) {
  if (value == null || value === "") return "—"; // Number(null)/Number("") are 0, not NaN
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (kind === "pct") return `${n.toFixed(2)}%`;
  if (kind === "int") return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (kind === "usd") {
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return String(value);
}

// Major currencies to surface first in an FX result (only those actually present
// are shown); the rest follow, capped, so the box isn't a wall of 30 rows.
export const FX_HIGHLIGHT = ["EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD", "INR", "RUB", "BRL", "ZAR", "MXN"];

export function econFxBody(payload) {
  const rates = payload?.rates || {};
  const base = payload?.base || "USD";
  const codes = Object.keys(rates);
  if (!codes.length) return `<div class="badge warn">No FX rates available.</div>`;
  const ordered = [...FX_HIGHLIGHT.filter((c) => c in rates), ...codes.filter((c) => !FX_HIGHLIGHT.includes(c))];
  const head = `<div class="badge ok">1 ${escapeHtml(base)}${payload?.date ? ` · ${escapeHtml(payload.date)}` : ""}</div>`;
  const rows = ordered.slice(0, 16).map((code) => kvRow(code, String(rates[code]))).join("");
  const note = `<p class="result-note">Source: ${escapeHtml(payload?.source || "Frankfurter")}</p>`;
  return `<div class="econ-body">${head}${rows}${note}</div>`;
}

export function econMacroBody(payload) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  const country = payload?.country;
  const head = country
    ? `<div class="badge ok">${escapeHtml(country.name)} (${escapeHtml(country.iso3 || country.code)})</div>`
    : "";
  const rows = (payload?.indicators || [])
    .map((i) => kvRow(`${i.label}${i.date ? ` · ${i.date}` : ""}`, formatMacroValue(i.value, i.kind)))
    .join("");
  if (!rows) return `<div class="badge warn">No indicators returned.</div>`;
  const note = `<p class="result-note">Source: ${escapeHtml(payload?.source || "World Bank")}</p>`;
  return `<div class="econ-body">${head}${rows}${note}</div>`;
}

// Build the collapsible detail body for a sanctions search hit from its
// OpenSanctions/OFAC properties (country, programs, aliases, UID, notes).
export function sanctionDetail(row) {
  const props = row.properties || {};
  const parts = [];
  const add = (label, value) => {
    const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
    if (text) parts.push(`<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(text))}</span></div>`);
  };
  add("Country", props.country);
  add("Programs", props.program);
  add("Aliases", props.alias);
  add("OFAC UID", props.uid);
  add("Notes", props.notes);
  add("Source", row.datasets);
  return parts.join("") || `<div class="kv"><span>Detail</span><span>No further detail available.</span></div>`;
}

// --- Person / entity OSINT render bodies (Entity tab) ----------------------

export function entityCompanyBody(payload) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  const c = payload?.company || {};
  const head = `<div class="badge ok">${escapeHtml(c.name || "Company")}${c.ticker ? ` · ${escapeHtml(c.ticker)}` : ""}</div>`;
  const meta = [
    kvRow("CIK", c.cik),
    kvRow("Industry (SIC)", c.sic),
    kvRow("Location", c.location),
    kvRow("Exchanges", c.exchanges)
  ].join("");
  const filings = (payload?.filings || []).length
    ? `<p class="result-note">Recent filings</p>` + payload.filings.map((f) =>
      `<div class="kv"><span>${escapeHtml(f.form || "—")} · ${escapeHtml(f.date || "")}</span><span>${extLink(f.url, "Open on EDGAR")}</span></div>`).join("")
    : "";
  return `<div class="econ-body">${head}${meta}${filings}<p class="result-note">Source: ${escapeHtml(payload?.source || "SEC EDGAR")}</p></div>`;
}

export function entityWikidataBody(payload) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  const rows = (payload?.matches || []).map((m) =>
    `<div class="kv"><span>${extLink(m.url, m.label)} <em>(${escapeHtml(m.id)})</em></span><span>${escapeHtml(m.description || "")}</span></div>`).join("");
  if (!rows) return `<div class="badge warn">No matches.</div>`;
  return `<div class="econ-body"><div class="badge ok">${payload.matches.length} entity match${payload.matches.length === 1 ? "" : "es"}</div>${rows}<p class="result-note">Source: Wikidata</p></div>`;
}

export function entityGravatarBody(payload) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  if (!payload?.found) return `<div class="badge warn">${escapeHtml(payload?.message || "No public Gravatar profile.")}</div>`;
  const p = payload.profile || {};
  const head = `<div class="badge ok">${escapeHtml(p.displayName || "Profile")}${p.pronouns ? ` · ${escapeHtml(p.pronouns)}` : ""}</div>`;
  const meta = [
    kvRow("Location", p.location),
    kvRow("Role", [p.jobTitle, p.company].filter(Boolean).join(" @ ")),
    kvRow("About", p.aboutMe)
  ].join("");
  const links = [
    p.profileUrl ? `<div class="kv"><span>Gravatar</span><span>${extLink(p.profileUrl, "View profile")}</span></div>` : "",
    ...(p.accounts || []).map((a) => `<div class="kv"><span>${escapeHtml(a.label || "Account")}</span><span>${extLink(a.url, "Open")}</span></div>`)
  ].join("");
  return `<div class="econ-body">${head}${meta}${links}<p class="result-note">Source: Gravatar</p></div>`;
}

export function entityGithubBody(payload) {
  if (payload?.error) return `<div class="badge warn">${escapeHtml(payload.error)}</div>`;
  if (!payload?.found) return `<div class="badge warn">${escapeHtml(payload?.message || "No public GitHub user.")}</div>`;
  const p = payload.profile || {};
  const head = `<div class="badge ok">${extLink(p.htmlUrl, p.name ? `${p.name} (@${p.login})` : `@${p.login}`)}</div>`;
  const meta = [
    kvRow("Bio", p.bio),
    kvRow("Company", p.company),
    kvRow("Location", p.location),
    kvRow("Public email", p.email),
    kvRow("Blog", p.blog),
    kvRow("Repos / Followers", `${p.publicRepos ?? "—"} / ${p.followers ?? "—"}`),
    kvRow("Joined", p.created ? String(p.created).slice(0, 10) : null)
  ].join("");
  const repos = (payload.repos || []).length
    ? `<p class="result-note">Recently pushed repos</p>` + payload.repos.map((r) =>
      `<div class="kv"><span>${extLink(r.url, r.name)}${r.language ? ` <em>${escapeHtml(r.language)}</em>` : ""}</span><span>★ ${escapeHtml(String(r.stars ?? 0))}</span></div>`).join("")
    : "";
  return `<div class="econ-body">${head}${meta}${repos}<p class="result-note">Source: GitHub</p></div>`;
}

// External reputation portals to pivot an IOC into, keyed by indicator kind.
export function intelLinks(kind, q) {
  const e = encodeURIComponent(q);
  const links = {
    ip: [[`https://www.virustotal.com/gui/ip-address/${e}`, "VirusTotal"], [`https://www.abuseipdb.com/check/${e}`, "AbuseIPDB"], [`https://viz.greynoise.io/ip/${e}`, "GreyNoise"], [`https://www.shodan.io/host/${e}`, "Shodan"]],
    domain: [[`https://www.virustotal.com/gui/domain/${e}`, "VirusTotal"], [`https://otx.alienvault.com/indicator/domain/${e}`, "AlienVault OTX"]],
    url: [[`https://www.virustotal.com/gui/search/${e}`, "VirusTotal"]],
    hash: [[`https://bazaar.abuse.ch/sample/${e}/`, "MalwareBazaar"], [`https://www.virustotal.com/gui/file/${e}`, "VirusTotal"]]
  }[kind] || [];
  return links.map(([url, label]) => extLink(url, label)).join("");
}

// Collapsible detail for one NVD CVE: CVSS score, publish date, full description,
// a link to the NVD record, and the first few reference links.
export function cveDetail(row) {
  const cve = row.cve || {};
  const desc = (cve.descriptions || []).find((d) => d.lang === "en")?.value
    || cve.descriptions?.[0]?.value || "No description available.";
  const metric = cve.metrics?.cvssMetricV31?.[0] || cve.metrics?.cvssMetricV30?.[0] || cve.metrics?.cvssMetricV2?.[0];
  const cvss = metric?.cvssData
    ? `${metric.cvssData.baseScore} (${metric.cvssData.baseSeverity || metric.baseSeverity || "?"})`
    : null;
  const refs = (cve.references || []).slice(0, 4).map((ref) => extLink(ref.url, ref.url.replace(/^https?:\/\//, "").slice(0, 48)));
  return `
    ${kvRow("CVSS", cvss)}
    ${kvRow("Published", cve.published ? cve.published.slice(0, 10) : "")}
    <p class="result-desc">${escapeHtml(desc)}</p>
    ${/^CVE-/i.test(cve.id) ? extLink(`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve.id)}`, "Open on NVD") : ""}
    ${refs.length ? `<div class="result-refs">${refs.join("")}</div>` : ""}
  `;
}

// Coarse "3m ago" / "5h ago" / "2d ago" label for a timestamp, used by the
// What-Changed panel. `now` is injectable so it is deterministically testable.
export function relativeTime(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Trim an entity to the fields worth putting in an exported analyst snapshot.
export function snapshotEntity(item) {
  return {
    id: item.id,
    layer: item.layer,
    type: item.type,
    name: item.name,
    lat: item.lat,
    lon: item.lon,
    severity: item.severity,
    ...(item.magnitude != null ? { magnitude: item.magnitude } : {}),
    ...(item.confidence ? { confidence: item.confidence } : {}),
    ...(item.time ? { time: item.time } : {}),
    ...(item.source ? { source: item.source } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.summary || item.text ? { note: String(item.summary || item.text).slice(0, 300) } : {})
  };
}

// ---- IP / domain intelligence cards ---------------------------------------
// The /api/intel/ip fan-out returns { indicator, type, results: [{source, data,
// error}] } across ten sources with ten different payload shapes. Rendering the
// raw JSON made the analyst read a wall of text to answer one question: did
// anything flag this indicator? Each source gets a renderer that pulls out its
// verdict and the few facts that justify it.

// A source is in one of four states, and they must not look alike: "flagged"
// (a positive threat hit), "clean" (checked, nothing found), "off" (no API key
// configured), and "failed" (the lookup errored).
const INTEL_STATE = {
  flagged: { label: "FLAGGED", className: "flagged" },
  clean: { label: "CLEAN", className: "clean" },
  off: { label: "NOT CONFIGURED", className: "off" },
  failed: { label: "UNAVAILABLE", className: "failed" }
};

function intelState(key) {
  return INTEL_STATE[key] || INTEL_STATE.failed;
}

// Per-source renderers. Each returns { state, facts: [[label, value], ...] }.
// A source with no renderer falls back to a generic key/value dump, so adding a
// source to the fan-out degrades gracefully instead of disappearing.
const INTEL_RENDERERS = {
  "AbuseIPDB"(d) {
    const score = Number(d.abuseConfidenceScore) || 0;
    return {
      state: score >= 25 ? "flagged" : "clean",
      facts: [
        ["Abuse score", `${score}/100`],
        ["Reports", d.totalReports],
        ["Country", d.countryCode],
        ["ISP", d.isp],
        ["Usage", d.usageType]
      ]
    };
  },
  "GreyNoise Community"(d) {
    // "noise" means mass-scanning infrastructure; "riot" means a known-benign
    // common service, which is a reassurance rather than a hit.
    return {
      state: d.noise ? "flagged" : "clean",
      facts: [
        ["Classification", d.classification],
        ["Internet noise", d.noise ? "yes — mass scanner" : "no"],
        ["Known-good service", d.riot ? `yes${d.name ? ` (${d.name})` : ""}` : "no"],
        ["Last seen", d.last_seen],
        ["Note", d.noise || d.riot ? null : d.message]
      ]
    };
  },
  "VirusTotal"(d) {
    const stats = d.last_analysis_stats || {};
    const malicious = Number(stats.malicious) || 0;
    const suspicious = Number(stats.suspicious) || 0;
    return {
      state: malicious + suspicious > 0 ? "flagged" : "clean",
      facts: [
        ["Detections", `${malicious} malicious · ${suspicious} suspicious · ${Number(stats.harmless) || 0} clean`],
        ["Reputation", d.reputation],
        ["Owner", d.as_owner],
        ["Country", d.country]
      ]
    };
  },
  "Shodan InternetDB"(d) {
    const vulns = d.vulns || [];
    const ports = d.ports || [];
    return {
      // Exposed ports alone are not a threat verdict; known CVEs are.
      state: vulns.length ? "flagged" : "clean",
      facts: [
        ["Open ports", ports.length ? ports.join(", ") : "none found"],
        ["Known CVEs", vulns.length ? vulns.join(", ") : null],
        ["Hostnames", d.hostnames],
        ["Tags", d.tags]
      ]
    };
  },
  "Feodo Tracker"(d) {
    return {
      state: d.c2 ? "flagged" : "clean",
      facts: d.c2
        ? [["Verdict", "Known botnet C2 server"], ["Malware", d.malware], ["Port", d.port], ["Status", d.status], ["First seen", d.first_seen]]
        : [["Verdict", "Not a known botnet C2"]]
    };
  },
  "ThreatFox"(d) {
    const rows = Array.isArray(d.data) ? d.data : [];
    return {
      state: rows.length ? "flagged" : "clean",
      facts: rows.length
        ? [["Verdict", "Listed as an indicator of compromise"], ["Malware", rows[0].malware_printable], ["Threat type", rows[0].threat_type], ["Confidence", rows[0].confidence_level]]
        : [["Verdict", "No IOC match"]]
    };
  },
  "URLhaus"(d) {
    const urls = d.urls || [];
    return {
      state: urls.length ? "flagged" : "clean",
      facts: urls.length
        ? [["Verdict", `${urls.length} malicious URL(s) hosted`], ["Most recent", urls[0].url], ["Status", urls[0].url_status]]
        : [["Verdict", "No malware-hosting URLs known"]]
    };
  },
  "Tor Exit Nodes"(d) {
    return {
      state: d.torExit ? "flagged" : "clean",
      facts: [["Verdict", d.torExit ? "Tor exit node — traffic origin is anonymized" : "Not a Tor exit node"]]
    };
  },
  "OpenPhish"(d) {
    return {
      state: d.listed ? "flagged" : "clean",
      facts: d.listed
        ? [["Verdict", `Host of ${d.matchCount} active phishing URL(s)`], ["Most recent", (d.urls || [])[0]]]
        : [["Verdict", "Not in the active OpenPhish feed"]]
    };
  },
  "Spamhaus DROP"(d) {
    return {
      state: d.listed ? "flagged" : "clean",
      facts: d.listed
        ? [["Verdict", "In a hijacked / criminal-controlled netblock"], ["Netblock", d.cidr], ["SBL ref", d.sbl]]
        : [["Verdict", "Not in a DROP-listed netblock"]]
    };
  },
  "RIPEstat"(d) {
    // Pure enrichment — network context, never a threat verdict.
    return {
      state: "clean",
      facts: [
        ["ASN", Array.isArray(d.asns) ? d.asns.join(", ") : d.asns],
        ["Prefix", d.prefix],
        ["Holder", d.holder]
      ]
    };
  }
};

function genericFacts(data) {
  return Object.entries(data)
    .filter(([, value]) => value != null && value !== "" && !(Array.isArray(value) && !value.length))
    .slice(0, 6)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]);
}

// Classify one fan-out result into its verdict state without rendering. Owned
// here so the per-source cards and the correlation summary count identically.
// "not configured" is an operator action, not a source failure — an analyst must
// be able to tell "we did not check" from "we checked and found nothing".
export function intelResultState(result) {
  if (result.error) return /not configured|api[_ ]key|appname/i.test(result.error) ? "off" : "failed";
  if (result.data) {
    const renderer = INTEL_RENDERERS[result.source];
    return renderer ? renderer(result.data).state : "clean";
  }
  return "failed";
}

// Turns one fan-out result into a card. Exported for tests; app.js renders the
// full set through intelCards().
export function intelCard(result) {
  const source = result.source || "Unknown source";
  const state = intelResultState(result);
  let facts = [];

  if (result.error) {
    facts = [["Reason", result.error]];
  } else if (result.data) {
    const renderer = INTEL_RENDERERS[source];
    facts = renderer ? renderer(result.data).facts : genericFacts(result.data);
  }

  const { label, className } = intelState(state);
  const rows = facts.map(([key, value]) => kvRow(key, value)).join("");
  return `<div class="intel-card ${className}">
    <div class="intel-card-head"><strong>${escapeHtml(source)}</strong><span class="intel-verdict ${className}">${label}</span></div>
    ${rows || kvRow("Result", "No details returned")}
  </div>`;
}

// Renders the whole fan-out, flagged sources first so a hit is never buried
// below nine clean cards, with a one-line summary at the top.
export function intelCards(payload) {
  const results = payload?.results || [];
  if (!results.length) return "";

  const cards = results.map((result) => ({ result, html: intelCard(result) }));
  const rank = (html) => (html.includes("intel-card flagged") ? 0 : html.includes("intel-card clean") ? 1 : 2);
  cards.sort((a, b) => rank(a.html) - rank(b.html));

  const flagged = cards.filter((c) => rank(c.html) === 0).length;
  const checked = cards.filter((c) => rank(c.html) < 2).length;
  const summary = flagged
    ? `<div class="badge danger">${flagged} of ${checked} source(s) flagged this indicator</div>`
    : `<div class="badge ok">No hits across ${checked} checked source(s)</div>`;

  return `${summary}<div class="intel-cards">${cards.map((c) => c.html).join("")}</div>`;
}

// ---- Cross-source correlation ---------------------------------------------
// The /api/intel/correlate payload is the IP fan-out results plus resolved
// network, geo, and sanctions. This collapses the ten cards into one verdict:
// threat (how many reputation sources flagged it), network (announcing AS),
// geo (country), and sanctions (RDAP contact hit). Threat is counted here rather
// than trusting a server field so the count and the per-source cards can't drift.
export function correlationSummary(payload) {
  const results = payload?.results || [];
  const states = results.map(intelResultState);
  const flaggedSources = results.filter((_, i) => states[i] === "flagged").map((r) => r.source);
  const checkedCount = states.filter((s) => s === "flagged" || s === "clean").length;
  return {
    flaggedCount: flaggedSources.length,
    flaggedSources,
    checkedCount,
    network: payload?.network || {},
    geo: payload?.geo || {},
    sanctions: payload?.sanctions || null
  };
}

export function correlationBanner(payload) {
  const s = correlationSummary(payload);
  const sanctioned = Boolean(s.sanctions?.sanctioned);
  const cls = s.flaggedCount > 0 || sanctioned ? "danger" : "ok";

  const threat = s.checkedCount
    ? `flagged by ${s.flaggedCount} of ${s.checkedCount} source${s.checkedCount === 1 ? "" : "s"}${s.flaggedCount ? ` — ${s.flaggedSources.join(", ")}` : ""}`
    : "no source returned a verdict";
  const network = [s.network.asn ? `AS${s.network.asn}` : null, s.network.holder].filter(Boolean).join(" · ") || "unknown";
  const sanctionText = sanctioned
    ? `${s.sanctions.flagged.length} name match — ${s.sanctions.flagged.map((r) => r.name).join(", ")}`
    : (s.sanctions ? "no OpenSanctions name match" : "not checked");

  const canLocate = Number.isFinite(s.geo.lat) && Number.isFinite(s.geo.lon);
  const geoValue = escapeHtml(s.geo.country || "unknown")
    + (canLocate
      ? ` <button type="button" class="correlate-locate" data-lat="${s.geo.lat}" data-lon="${s.geo.lon}" data-label="${escapeHtml(payload?.indicator || "")}">Locate on map ↗</button>`
      : "");

  const row = (label, value) => `<div class="correlate-row"><span>${label}</span><strong>${value}</strong></div>`;
  return `<div class="correlate-banner ${cls}">
    <div class="correlate-title">Correlation — ${escapeHtml(payload?.indicator || "")}</div>
    ${row("Threat", escapeHtml(threat))}
    ${row("Network", escapeHtml(network))}
    ${row("Geo", geoValue)}
    ${row("Sanctions", escapeHtml(sanctionText))}
  </div>`;
}

// ---- Timeline scrubber (Phase 5 replay) ------------------------------------
// The scrubber slider spans a fixed window [startMs, endMs]. At the far right it
// means "live" (no replay); anywhere left of that maps linearly to a past instant.
// Pure so the mapping is unit-tested; the DOM layer formats the label and fetches.
export function scrubberTime(value, max, startMs, endMs) {
  const v = Math.max(0, Math.min(Number(value) || 0, max));
  if (v >= max) return { live: true, ms: endMs, iso: new Date(endMs).toISOString() };
  const ms = Math.round(startMs + ((endMs - startMs) * v) / max);
  return { live: false, ms, iso: new Date(ms).toISOString() };
}

// Merge per-layer snapshot payloads (each { enabled, entities }) into one flat
// list for the replay overlay, keeping only enabled snapshots and placeable
// entities. Non-persistable layers come back enabled with an empty list, so
// fanning out over every enabled layer is safe — they simply contribute nothing.
export function replayEntities(payloads) {
  const out = [];
  for (const payload of payloads || []) {
    if (!payload?.enabled) continue;
    for (const entity of payload.entities || []) {
      if (Number.isFinite(entity?.lat) && Number.isFinite(entity?.lon)) out.push(entity);
    }
  }
  return out;
}

// ---- Alert rule health -----------------------------------------------------
// A rule can validate and load cleanly and still never match anything — a
// minSeverity above a layer's constant severity is the common case. Silence from
// an alert rule is otherwise indistinguishable from "nothing has happened yet",
// so the panel states which of the two it is.
const QUIET_AFTER_MS = 7 * 86_400_000;

export function ruleHealth(rule, nowMs = Date.now()) {
  if (rule.enabled === false) {
    return { state: "disabled", label: "disabled" };
  }
  if (!rule.fires) {
    return { state: "never", label: "never matched" };
  }
  const last = Date.parse(rule.lastFiredAt);
  const fires = `${rule.fires} fire${rule.fires === 1 ? "" : "s"}`;
  if (Number.isFinite(last) && nowMs - last > QUIET_AFTER_MS) {
    return { state: "quiet", label: `${fires}, none recently` };
  }
  return { state: "active", label: fires };
}
