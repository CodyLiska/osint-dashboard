import test from "node:test";
import assert from "node:assert/strict";
import {
  COUNTRY_CENTROIDS, centroidForCountry, countryCodeForName, normalizeCountryName
} from "../src/lib/centroids.js";

test("Spain resolves to the mainland, not the Canary Islands", () => {
  // The upstream lists ES twice; taking the last row put Spain ~1800km away in
  // the Atlantic, so every country-coded event for Spain plotted off Morocco.
  const [lon, lat] = COUNTRY_CENTROIDS.ES;
  assert.ok(lat > 35 && lon > -10, `expected mainland Spain, got ${lon},${lat}`);
});

test("territories the upstream omits are still placeable", () => {
  // IODA and Cloudflare skip any country with no centroid, so these four were
  // silently undroppable events — a Taiwan or Hong Kong outage showed nothing.
  for (const code of ["TW", "HK", "XK", "MO"]) {
    assert.ok(Array.isArray(COUNTRY_CENTROIDS[code]), `${code} must have a centroid`);
  }
});

test("feed spellings resolve to the same country as the canonical name", () => {
  assert.equal(countryCodeForName("Burma"), countryCodeForName("Myanmar"));
  assert.equal(countryCodeForName("Czechia"), countryCodeForName("Czech Republic"));
  assert.equal(countryCodeForName("Russia"), "RU");
});

test("leading articles and feed boilerplate do not defeat the lookup", () => {
  assert.equal(countryCodeForName("The Gambia"), "GM");
  assert.equal(countryCodeForName("Mexico Travel Advisory"), "MX");
  assert.equal(normalizeCountryName("  CÔTE D'IVOIRE  "), "cote d ivoire");
});

test("an unknown country yields null so callers can skip it", () => {
  assert.equal(countryCodeForName("Atlantis"), null);
  assert.equal(centroidForCountry("Atlantis"), null);
  assert.equal(countryCodeForName(""), null);
});
