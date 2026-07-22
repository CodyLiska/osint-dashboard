import { createHash } from "node:crypto";
import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";

// Person / entity OSINT — all keyless, all recon-tab (no map presence). Per the
// §5 note in FUTURE-DATA-SOURCES.md this is deliberately LAN-only, query-driven
// lookups, never scattered on a public map:
//   - SEC EDGAR   : US company filings + registration (corporate OSINT)
//   - Wikidata    : entity resolution / disambiguation for people & orgs
//   - Gravatar    : email -> public profile (name, location, links, pronouns)
// GitHub is usable keyless (60 req/hr); GITHUB_TOKEN raises that to 5000/hr.
// Hudson Rock (keyless breach) is NOT here yet — the service was unreachable
// (timeout + 502) at build time, so it is left for a re-probe rather than shipped
// against an unverified response shape.

// --- SEC EDGAR -------------------------------------------------------------

async function secTickers() {
  const result = await cachedResilient("sec:tickers", 24 * 60 * 60_000, () =>
    fetchJsonRetry("https://www.sec.gov/files/company_tickers.json"));
  return Object.values(result.value || {});
}

// Prefer an exact ticker, then a name that starts with the query, then any name
// containing it — so "apple" finds Apple Inc. and "AAPL" finds it directly.
export function matchCompany(rows, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  return rows.find((r) => String(r.ticker).toLowerCase() === q)
    || rows.find((r) => String(r.title).toLowerCase().startsWith(q))
    || rows.find((r) => String(r.title).toLowerCase().includes(q))
    || null;
}

export async function secCompany(query) {
  const match = matchCompany(await secTickers(), query);
  if (!match) return { error: `No SEC-registered company matching "${query}".`, filings: [] };

  const cik = String(match.cik_str).padStart(10, "0");
  const result = await cachedResilient(`sec:sub:${cik}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(`https://data.sec.gov/submissions/CIK${cik}.json`));
  const sub = result.value || {};
  const recent = sub.filings?.recent || {};
  const accessions = recent.accessionNumber || [];

  const filings = accessions.slice(0, 8).map((accession, i) => ({
    form: recent.form?.[i] || "",
    date: recent.filingDate?.[i] || "",
    accession,
    // Direct link to the filing's primary document in the EDGAR archive.
    url: `https://www.sec.gov/Archives/edgar/data/${match.cik_str}/${accession.replace(/-/g, "")}/${recent.primaryDocument?.[i] || ""}`
  }));

  return {
    company: {
      name: sub.name || match.title,
      ticker: match.ticker,
      cik,
      sic: sub.sicDescription || null,
      location: [sub.addresses?.business?.city, sub.addresses?.business?.stateOrCountry].filter(Boolean).join(", ") || null,
      exchanges: Array.isArray(sub.exchanges) ? sub.exchanges.join(", ") : null
    },
    filings,
    source: "SEC EDGAR"
  };
}

// --- Wikidata --------------------------------------------------------------

export async function wikidataEntity(query) {
  const q = String(query || "").trim();
  if (!q) return { error: "A name is required.", matches: [] };
  const result = await cachedResilient(`wikidata:search:${q.toLowerCase()}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=6&origin=*`));

  const matches = (result.value?.search || []).map((row) => ({
    id: row.id,
    label: row.label || row.id,
    description: row.description || "",
    url: row.concepturi || (row.url ? `https:${row.url}` : `https://www.wikidata.org/wiki/${row.id}`)
  }));
  if (!matches.length) return { error: `No Wikidata entity matching "${q}".`, matches: [] };
  return { matches, source: "Wikidata" };
}

// --- GitHub ----------------------------------------------------------------

// Username → public profile + most-recently-pushed repos. Keyless at 60 req/hr;
// an optional GITHUB_TOKEN raises the limit. A 403/429 is a rate limit, NOT a
// missing user, so the two are reported distinctly.
export async function githubUser(username) {
  const login = String(username || "").trim().replace(/^@/, "");
  if (!login) return { error: "Enter a GitHub username." };

  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const user = await cachedResilient(`github:user:${login.toLowerCase()}`, 60 * 60_000, () =>
    fetchJsonRetry(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers })).catch((error) => ({ error }));
  if (user.error) {
    const status = user.error?.status;
    if (status === 404) return { found: false, message: `No public GitHub user "${login}".`, source: "GitHub" };
    if (status === 403 || status === 429) return { error: "GitHub rate limit reached — set GITHUB_TOKEN to raise the 60/hr keyless limit.", source: "GitHub" };
    return { error: user.error?.message || "GitHub lookup failed.", source: "GitHub" };
  }

  const repos = await cachedResilient(`github:repos:${login.toLowerCase()}`, 60 * 60_000, () =>
    fetchJsonRetry(`https://api.github.com/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=5`, { headers })).catch(() => ({ value: [] }));

  const u = user.value;
  return {
    found: true,
    profile: {
      login: u.login,
      name: u.name || null,
      company: u.company || null,
      location: u.location || null,
      bio: u.bio || null,
      blog: u.blog || null,
      email: u.email || null,
      publicRepos: u.public_repos,
      followers: u.followers,
      created: u.created_at || null,
      htmlUrl: u.html_url
    },
    repos: (Array.isArray(repos.value) ? repos.value : []).slice(0, 5).map((r) => ({
      name: r.name,
      stars: r.stargazers_count,
      language: r.language || null,
      pushed: r.pushed_at || null,
      url: r.html_url
    })),
    source: "GitHub"
  };
}

// --- Gravatar --------------------------------------------------------------

// Gravatar keys profiles by the md5 of the lowercased, trimmed email.
export function gravatarHash(email) {
  return createHash("md5").update(String(email || "").trim().toLowerCase()).digest("hex");
}

export async function gravatarProfile(email) {
  const q = String(email || "").trim();
  if (!q.includes("@")) return { error: "Enter an email address.", found: false };
  const hash = gravatarHash(q);
  const result = await cachedResilient(`gravatar:${hash}`, 6 * 60 * 60_000, () =>
    fetchJsonRetry(`https://gravatar.com/${hash}.json`)).catch(() => null);

  const entry = result?.value?.entry?.[0];
  if (!entry) return { found: false, hash, message: "No public Gravatar profile for that email.", source: "Gravatar" };

  return {
    found: true,
    hash,
    profile: {
      displayName: entry.displayName || entry.preferredUsername || null,
      pronouns: entry.pronouns || null,
      aboutMe: entry.aboutMe || null,
      location: entry.currentLocation || null,
      jobTitle: entry.job_title || null,
      company: entry.company || null,
      profileUrl: entry.profileUrl || null,
      thumbnailUrl: entry.thumbnailUrl || null,
      accounts: (entry.accounts || []).map((a) => ({ label: a.name || a.shortname || a.domain, url: a.url })).filter((a) => a.url)
    },
    source: "Gravatar"
  };
}
