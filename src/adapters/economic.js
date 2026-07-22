import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { countryCodeForName } from "../lib/centroids.js";

// Economic / financial context, both keyless. Recon-tab only (no map presence):
//   - Frankfurter: ECB daily reference FX rates.
//   - World Bank: per-country macro indicators (open data, CC-BY).
// Neither is per-indicator enrichment, so they answer "what's the economic
// backdrop of this country / currency", not "is this IP malicious".

// Frankfurter moved from api.frankfurter.app (301) to api.frankfurter.dev/v1.
const FX_URL = "https://api.frankfurter.dev/v1/latest";

export async function fxRates(base = "USD") {
  const code = String(base).toUpperCase();
  // Rates publish once per business day, so an hour of caching is plenty.
  const result = await cachedResilient(`econ:fx:${code}`, 60 * 60_000, () =>
    fetchJsonRetry(`${FX_URL}?base=${encodeURIComponent(code)}`));
  const value = result.value || {};
  return {
    base: value.base || code,
    date: value.date || null,
    rates: value.rates || {},
    cached: result.cached,
    stale: Boolean(result.stale),
    source: "Frankfurter (ECB reference rates)"
  };
}

// A small, widely-populated indicator set. `kind` drives frontend formatting.
const INDICATORS = [
  { id: "NY.GDP.MKTP.CD", label: "GDP (current US$)", kind: "usd" },
  { id: "NY.GDP.PCAP.CD", label: "GDP per capita (US$)", kind: "usd" },
  { id: "SP.POP.TOTL", label: "Population", kind: "int" },
  { id: "FP.CPI.TOTL.ZG", label: "Inflation, CPI (annual %)", kind: "pct" },
  { id: "SL.UEM.TOTL.ZS", label: "Unemployment (% labor force)", kind: "pct" },
  { id: "NE.EXP.GNFS.ZS", label: "Exports (% of GDP)", kind: "pct" }
];

// World Bank accepts ISO2 or ISO3. A 2-3 letter input is treated as a code as-is;
// anything else is resolved from a country name via the shared centroid table.
export function resolveCountryCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2,3}$/.test(raw)) return raw.toUpperCase();
  return countryCodeForName(raw);
}

// World Bank returns [meta, [rows]] — or [meta, null] / a message array for an
// unknown code. Pull the single most-recent row (mrv=1) or null.
function macroRow(payload) {
  return Array.isArray(payload) && Array.isArray(payload[1]) ? payload[1][0] : null;
}

export async function countryMacro(query) {
  const code = resolveCountryCode(query);
  if (!code) return { error: `Could not resolve a country from "${query}".`, indicators: [] };

  // Each indicator is a separate request (the multi-indicator semicolon syntax
  // hangs upstream). allSettled so one slow/missing indicator can't blank the card.
  const settled = await Promise.allSettled(INDICATORS.map((ind) =>
    cachedResilient(`econ:wb:${code}:${ind.id}`, 24 * 60 * 60_000, () =>
      fetchJsonRetry(`https://api.worldbank.org/v2/country/${encodeURIComponent(code)}/indicator/${ind.id}?format=json&mrv=1`))
      .then((result) => ({ ind, row: macroRow(result.value) }))));

  let country = null;
  const indicators = [];
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled" || !outcome.value.row) continue;
    const { ind, row } = outcome.value;
    if (row.value == null) continue;
    if (!country && row.country) {
      country = { code: row.country.id, name: row.country.value, iso3: row.countryiso3code };
    }
    indicators.push({ id: ind.id, label: ind.label, kind: ind.kind, value: row.value, date: row.date });
  }

  if (!indicators.length) return { error: `No World Bank data for "${query}".`, indicators: [] };
  return { configured: true, country, indicators, source: "World Bank open data" };
}
