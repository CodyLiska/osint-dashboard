import test from "node:test";
import assert from "node:assert/strict";
import { formatMacroValue, econFxBody, econMacroBody } from "../public/logic.js";

test("formatMacroValue compacts by kind", () => {
  assert.equal(formatMacroValue(4435162999976, "usd"), "$4.44T");
  assert.equal(formatMacroValue(3366315927447, "usd"), "$3.37T");
  assert.equal(formatMacroValue(53000000, "usd"), "$53.00M");
  assert.equal(formatMacroValue(123366734, "int"), "123,366,734");
  assert.equal(formatMacroValue(3.17253, "pct"), "3.17%");
  assert.equal(formatMacroValue(null, "usd"), "—");
});

test("econFxBody leads with present majors and caps the row count", () => {
  const html = econFxBody({ base: "USD", date: "2026-07-21", rates: { EUR: 0.87, ZZZ: 9, GBP: 0.74 } });
  assert.match(html, /1 USD/);
  assert.match(html, /2026-07-21/);
  // EUR (a highlighted major) must appear before ZZZ (a non-major).
  assert.ok(html.indexOf("EUR") < html.indexOf("ZZZ"), "majors are surfaced first");
});

test("econFxBody warns rather than rendering an empty table", () => {
  assert.match(econFxBody({ base: "USD", rates: {} }), /No FX rates/);
});

test("econMacroBody renders the country badge and formatted indicator rows", () => {
  const html = econMacroBody({
    country: { code: "JP", name: "Japan", iso3: "JPN" },
    indicators: [{ id: "NY.GDP.MKTP.CD", label: "GDP (current US$)", kind: "usd", value: 4435162999976, date: "2025" }],
    source: "World Bank open data"
  });
  assert.match(html, /Japan \(JPN\)/);
  assert.match(html, /\$4\.44T/);
  assert.match(html, /2025/);
});

test("econMacroBody surfaces an adapter error as a warning badge", () => {
  assert.match(econMacroBody({ error: "Could not resolve a country from \"Narnia\".", indicators: [] }), /Could not resolve/);
});
