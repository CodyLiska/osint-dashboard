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

// Dense layers that collapse into count badges when zoomed out. A layer only
// clusters once it has at least CLUSTER_MIN_POINTS visible entities and the map
// is below CLUSTER_MAX_ZOOM; past that zoom every point renders individually.
export const CLUSTER_LAYERS = new Set(["aviation", "military-air", "fires", "seismic", "news", "telegram", "maritime", "ports", "gdelt", "gdacs", "ucdp", "power-plants", "infrastructure"]);
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

export function kvRow(label, value) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
  return text ? `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(text))}</span></div>` : "";
}

export function extLink(url, label) {
  return `<a class="result-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)} ↗</a>`;
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

// Turns one fan-out result into a card. Exported for tests; app.js renders the
// full set through intelCards().
export function intelCard(result) {
  const source = result.source || "Unknown source";
  let state = "failed";
  let facts = [];

  if (result.error) {
    // "not configured" is an operator action, not a source failure — an analyst
    // must be able to tell "we did not check" from "we checked and found nothing".
    state = /not configured|api[_ ]key|appname/i.test(result.error) ? "off" : "failed";
    facts = [["Reason", result.error]];
  } else if (result.data) {
    const renderer = INTEL_RENDERERS[source];
    const rendered = renderer ? renderer(result.data) : { state: "clean", facts: genericFacts(result.data) };
    state = rendered.state;
    facts = rendered.facts;
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
