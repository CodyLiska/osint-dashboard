import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { advisoriesLayer, parseAdvisories, parseAdvisoryTitle } from "../src/adapters/advisories.js";

const feed = (...titles) => `<?xml version="1.0"?><rss><channel>
  <title>travel.state.gov: Travel Advisories</title>
  ${titles.map((t) => `<item><title>${t}</title>
    <link>https://travel.state.gov/x.html</link><pubDate>Mon, 20 Jul 2026</pubDate></item>`).join("")}
</channel></rss>`;

test("an advisory title yields the country, its level, and the standing advice", () => {
  assert.deepEqual(parseAdvisoryTitle("Syria - Level 4: Do Not Travel"), {
    country: "Syria", level: 4, advice: "Do Not Travel"
  });
});

test("entries carrying no level are not placed on the map", () => {
  // The feed includes pointer rows like this that describe no single country.
  assert.equal(parseAdvisoryTitle("Mainland China, Hong Kong &amp; Macau - See Summaries"), null);
});

test("a country listed twice is reported once, at its highest level", () => {
  // The feed publishes most countries twice; a naive parse double-plots them.
  const rows = parseAdvisories(feed(
    "Mexico - Level 2: Exercise Increased Caution",
    "Mexico - Level 3: Reconsider Travel"
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 3);
});

test("countries the feed names differently from the centroid set still resolve", async () => {
  // "Burma" and "The Gambia" only match via the alias/article-stripping rules —
  // without them these countries silently vanish from the layer.
  const restore = installFetch(feed(
    "Burma - Level 4: Do Not Travel",
    "The Gambia - Level 1: Exercise Normal Precautions"
  ));
  try {
    const { entities } = await advisoriesLayer();
    const codes = entities.map((e) => e.countryCode).sort();
    assert.deepEqual(codes, ["GM", "MM"]);
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
  } finally {
    restore();
  }
});

test("Do Not Travel outranks Reconsider Travel on the severity scale", async () => {
  // The severity filter is how an analyst hides noise; L3 and L4 must not
  // collapse to the same value or the filter cannot separate them.
  const restore = installFetch(feed(
    "Syria - Level 4: Do Not Travel",
    "Nigeria - Level 3: Reconsider Travel",
    "Bhutan - Level 1: Exercise Normal Precautions"
  ));
  try {
    const { entities } = await advisoriesLayer();
    const sev = Object.fromEntries(entities.map((e) => [e.country, e.severity]));
    assert.ok(sev.Syria > sev.Nigeria, "level 4 must outrank level 3");
    assert.ok(sev.Nigeria > sev.Bhutan, "level 3 must outrank level 1");
  } finally {
    restore();
  }
});
