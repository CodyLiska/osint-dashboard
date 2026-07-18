import { readFileSync } from "node:fs";

// Gazetteer for geoparsing free-text OSINT feeds (Telegram today, reusable by any
// text layer). The place data lives in the versioned dataset
// public/data/gazetteer.json (with provenance); this module loads it once at
// startup and compiles matchers.
//
// geoparse() scores every mention rather than taking the first hit, and matches
// Latin names on word boundaries so short names ("Lima", "London") do not fire
// inside longer words. Non-Latin aliases (Cyrillic/Arabic/CJK) match as
// substrings, where word boundaries and spacing do not apply the same way.
const dataset = JSON.parse(readFileSync(new URL("../../public/data/gazetteer.json", import.meta.url), "utf8"));

// [name, lat, lon, aliases] tuples consumed by the compiled matcher below.
export const places = dataset.records.map((row) => [row.name, row.lat, row.lon, row.aliases || []]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A candidate is "Latin" if every character is within the Latin blocks (ASCII +
// Latin-1 + Latin Extended-A/B, so "São Paulo"/"Bogotá" still qualify). Latin
// candidates match only on word boundaries; anything with other scripts falls
// back to a plain substring test.
function buildTester(candidate) {
  const needle = candidate.toLocaleLowerCase();
  if (/[^ -ɏ]/.test(candidate)) {
    return (haystack) => haystack.includes(needle);
  }
  const re = new RegExp(`(?:^|[^\\p{L}])${escapeRegex(needle)}(?:[^\\p{L}]|$)`, "u");
  return (haystack) => re.test(haystack);
}

// Precompile one tester per candidate at module load so geoparse stays cheap when
// scanning hundreds of feed posts per refresh.
const compiled = places.map(([name, lat, lon, aliases = []]) => ({
  name,
  lat,
  lon,
  candidates: [{ raw: name, canonical: true }, ...aliases.map((raw) => ({ raw, canonical: false }))]
    .map(({ raw, canonical }) => ({ raw: raw.toLocaleLowerCase(), canonical, test: buildTester(raw) }))
}));

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

// Scan text for gazetteer places and return the best-supported location with a
// confidence label, or null if nothing matched. A canonical whole-word hit scores
// higher than an alias; repeated mentions raise confidence; several competing
// places (ambiguity) lower it.
export function geoparse(text) {
  if (!text) return null;
  const haystack = text.toLocaleLowerCase();
  const matches = [];

  for (const place of compiled) {
    let strength = 0;
    let matchedOn = null;
    for (const candidate of place.candidates) {
      if (candidate.test(haystack)) {
        strength = candidate.canonical ? 1 : 0.85;
        matchedOn = candidate.raw;
        break;
      }
    }
    if (strength > 0) {
      matches.push({ name: place.name, lat: place.lat, lon: place.lon, strength, matchedOn });
    }
  }

  if (matches.length === 0) return null;

  for (const match of matches) {
    match.count = countOccurrences(haystack, match.matchedOn);
  }
  matches.sort((a, b) => b.strength - a.strength || b.count - a.count);
  const best = matches[0];

  let score = best.strength;
  if (best.count > 1) score = Math.min(1, score + Math.min(0.1, 0.05 * (best.count - 1)));
  if (matches.length > 1) score -= Math.min(0.3, 0.1 * (matches.length - 1));
  score = Math.max(0, Math.min(1, score));

  const confidence = score >= 0.85 ? "High" : score >= 0.6 ? "Medium" : "Low";
  return {
    name: best.name,
    lat: best.lat,
    lon: best.lon,
    confidence,
    score: Number(score.toFixed(2)),
    matchedOn: best.matchedOn,
    candidates: matches.length
  };
}
