// Regenerates public/data/country-centroids.json from the upstream
// Natural-Earth-derived centroid set, adding the name lookup that country-coded
// feeds (travel advisories, ReliefWeb) need to resolve a country NAME to a code.
//
// Run: node scripts/build-country-centroids.mjs
//
// The upstream omits four territories that matter for situational awareness
// (Taiwan, Kosovo, Hong Kong, Macau) — they are added by hand below. Without
// them the outage layers silently drop those countries.

import { writeFileSync, readFileSync } from "node:fs";

const UPSTREAM = "https://raw.githubusercontent.com/gavinr/world-countries-centroids/master/dist/countries.geojson";
const OUT = new URL("../public/data/country-centroids.json", import.meta.url);

// Territories absent from the upstream dataset. Coordinates are approximate
// land centroids, precise enough for a country-level map marker.
const MANUAL = {
  TW: { lon: 120.96, lat: 23.7, name: "Taiwan" },
  XK: { lon: 20.9, lat: 42.6, name: "Kosovo" },
  HK: { lon: 114.17, lat: 22.32, name: "Hong Kong" },
  MO: { lon: 113.55, lat: 22.2, name: "Macau" }
};

// Upstream carries three ISO codes twice (an outlying island plus the
// mainland). Left to source order the island wins, which put Spain in the
// Canary Islands ~1800km from Madrid. Pin each to its principal landmass.
const DUPLICATE_PREFERENCE = {
  ES: "Spain",
  TF: "French Southern Territories",
  BQ: "Bonaire"
};

// Name variants upstream does not carry. Keyed by normalized form. Sourced from
// the actual titles the US State Dept advisory feed emits plus common UN/ISO
// long forms, so the lookup survives either spelling.
const ALIASES = {
  burma: "MM",
  russia: "RU",
  czechia: "CZ",
  brunei: "BN",
  "cape verde": "CV",
  "east timor": "TL",
  "timor leste": "TL",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  "congo kinshasa": "CD",
  "republic of the congo": "CG",
  "congo brazzaville": "CG",
  "kingdom of denmark": "DK",
  "kyrgyz republic": "KG",
  "federated states of micronesia": "FM",
  "syrian arab republic": "SY",
  "russian federation": "RU",
  "republic of korea": "KR",
  "south korea": "KR",
  "north korea": "KP",
  "democratic peoples republic of korea": "KP",
  "united republic of tanzania": "TZ",
  "viet nam": "VN",
  "lao peoples democratic republic": "LA",
  laos: "LA",
  "iran islamic republic of": "IR",
  "venezuela bolivarian republic of": "VE",
  "bolivia plurinational state of": "BO",
  "united states of america": "US",
  "united kingdom of great britain and northern ireland": "GB",
  "cote d ivoire": "CI",
  "ivory coast": "CI",
  "cabo verde": "CV",
  eswatini: "SZ",
  swaziland: "SZ",
  "sint eustatius": "BQ",
  "bonaire sint eustatius and saba": "BQ",
  "caribbean netherlands": "BQ",
  "state of palestine": "PS",
  "palestinian territories": "PS",
  "west bank": "PS",
  "holy see": "VA",
  "vatican city": "VA"
};

// Lowercase, strip accents and punctuation, and drop the leading article /
// trailing feed boilerplate the advisory titles carry ("The Gambia",
// "Mexico Travel Advisory"). Kept in sync with normalizeCountryName() in
// src/lib/centroids.js — both sides must agree or the lookup misses.
function normalize(value) {
  let name = String(value)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&amp;/g, "and")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  name = name.replace(/\s+travel advisory$/, "");
  name = name.replace(/^the\s+/, "");
  return name.trim();
}

const response = await fetch(UPSTREAM);
if (!response.ok) throw new Error(`upstream ${response.status}`);
const geo = await response.json();

const centroids = {};
const names = {};

for (const feature of geo.features) {
  const { ISO: code, COUNTRY: country } = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  if (!code || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
  const preferred = DUPLICATE_PREFERENCE[code];
  if (!(code in centroids) || preferred === country) {
    centroids[code] = [round(lon), round(lat)];
  }
  names[normalize(country)] = code;
}

for (const [code, { lon, lat, name }] of Object.entries(MANUAL)) {
  centroids[code] = [round(lon), round(lat)];
  names[normalize(name)] = code;
}

for (const [alias, code] of Object.entries(ALIASES)) {
  if (!centroids[code]) throw new Error(`alias ${alias} -> unknown code ${code}`);
  names[normalize(alias)] = code;
}

// Guard the regeneration: every centroid the previous version published must
// still resolve to the same point, or a downstream layer silently moves.
try {
  const previous = JSON.parse(readFileSync(OUT)).centroids || {};
  for (const [code, point] of Object.entries(previous)) {
    const next = centroids[code];
    if (!next) throw new Error(`regression: ${code} disappeared`);
    if (next[0] !== point[0] || next[1] !== point[1]) {
      // A deliberate duplicate-resolution fix is allowed to move a point;
      // anything else moving means the upstream shifted under us.
      if (!DUPLICATE_PREFERENCE[code]) {
        throw new Error(`regression: ${code} moved ${point} -> ${next}`);
      }
      console.log(`  fixed ${code}: ${point} -> ${next} (${DUPLICATE_PREFERENCE[code]})`);
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

const doc = {
  dataset: "country-centroids",
  version: 2,
  updated: new Date().toISOString().slice(0, 10),
  source: "gavinr/world-countries-centroids (Natural Earth derived, public domain); TW/XK/HK/MO added manually",
  license: "public domain",
  count: Object.keys(centroids).length,
  nameCount: Object.keys(names).length,
  centroids,
  names
};

writeFileSync(OUT, `${JSON.stringify(doc)}\n`);
console.log(`wrote ${doc.count} centroids, ${doc.nameCount} name keys`);
