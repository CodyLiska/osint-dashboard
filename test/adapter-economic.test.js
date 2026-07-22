import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { fxRates, countryMacro, resolveCountryCode } from "../src/adapters/economic.js";

// A World Bank v2 response is [meta, [row]]; mrv=1 yields a single row.
const wbRow = (indId, indLabel, value, { code = "JP", name = "Japan", iso3 = "JPN", date = "2025" } = {}) => ([
  { page: 1, pages: 1, per_page: 50, total: 1, lastupdated: "2026-07-13" },
  [{ indicator: { id: indId, value: indLabel }, country: { id: code, value: name }, countryiso3code: iso3, date, value }]
]);

test("resolveCountryCode passes codes through and resolves names via the centroid table", () => {
  assert.equal(resolveCountryCode("JP"), "JP");
  assert.equal(resolveCountryCode("jpn"), "JPN");
  assert.equal(resolveCountryCode("Japan"), "JP");
  assert.equal(resolveCountryCode("Narnia"), null);
  assert.equal(resolveCountryCode(""), null);
});

test("fxRates normalizes the Frankfurter payload", async () => {
  const restore = installJsonFetch({ amount: 1, base: "USD", date: "2026-07-21", rates: { EUR: 0.8758, JPY: 162.74 } });
  try {
    const fx = await fxRates("USD");
    assert.equal(fx.base, "USD");
    assert.equal(fx.date, "2026-07-21");
    assert.equal(fx.rates.EUR, 0.8758);
    assert.match(fx.source, /Frankfurter/);
  } finally {
    restore();
  }
});

test("countryMacro joins per-indicator responses and carries the resolved country", async () => {
  const restore = installJsonFetch((url) => {
    if (url.includes("NY.GDP.MKTP.CD")) return wbRow("NY.GDP.MKTP.CD", "GDP", 4435162999976);
    if (url.includes("FP.CPI.TOTL.ZG")) return wbRow("FP.CPI.TOTL.ZG", "Inflation", 3.17);
    if (url.includes("SP.POP.TOTL")) return wbRow("SP.POP.TOTL", "Population", 123366734);
    // Other indicators return an empty [meta, null] — i.e. no data for this country.
    return [{ total: 0 }, null];
  });
  try {
    const macro = await countryMacro("Japan");
    assert.equal(macro.country.name, "Japan");
    assert.equal(macro.country.iso3, "JPN");
    const ids = macro.indicators.map((i) => i.id);
    assert.ok(ids.includes("NY.GDP.MKTP.CD"));
    assert.ok(ids.includes("SP.POP.TOTL"));
    assert.equal(macro.indicators.length, 3, "only the three indicators with data are kept");
  } finally {
    restore();
  }
});

test("countryMacro reports a resolution failure instead of querying a null code", async () => {
  // No fetch should be needed, but install one so a stray call is visible as data.
  const restore = installJsonFetch(wbRow("X", "X", 1));
  try {
    const macro = await countryMacro("Narnia");
    assert.match(macro.error, /Could not resolve/);
    assert.deepEqual(macro.indicators, []);
  } finally {
    restore();
  }
});

test("countryMacro returns an error when a valid code has no indicator data at all", async () => {
  const restore = installJsonFetch(() => [{ total: 0 }, null]);
  try {
    const macro = await countryMacro("JP");
    assert.match(macro.error, /No World Bank data/);
  } finally {
    restore();
  }
});
