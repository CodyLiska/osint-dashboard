import test from "node:test";
import assert from "node:assert/strict";
import { geoparse, places } from "../src/lib/gazetteer.js";

// Pick a real gazetteer place that is a single Latin token of decent length, so
// tests stay deterministic against the versioned dataset without hard-coding a
// specific city that could be removed later.
const isLatinToken = (name) => /^[A-Za-zÀ-ɏ]{5,}$/.test(name);
const sample = places.find(([name]) => isLatinToken(name));

test("geoparse returns null for empty or missing text", () => {
  assert.equal(geoparse(null), null);
  assert.equal(geoparse(""), null);
  assert.equal(geoparse("no place names here at all 123"), null);
});

test("dataset exposes at least one usable Latin place name", () => {
  assert.ok(sample, "expected a single-token Latin place in gazetteer.json");
});

test("geoparse matches a clean canonical mention with High confidence", { skip: !sample }, () => {
  const [name, lat, lon] = sample;
  const result = geoparse(`Reports of an incident near ${name} earlier today.`);
  assert.ok(result, "expected a match");
  assert.equal(result.name, name);
  assert.equal(result.lat, lat);
  assert.equal(result.lon, lon);
  assert.equal(result.confidence, "High");
  assert.equal(result.matchedOn, name.toLocaleLowerCase());
});

test("geoparse enforces word boundaries for Latin names", { skip: !sample }, () => {
  const [name] = sample;
  // Name glued inside a longer word must not match on that alone.
  const result = geoparse(`zzzq${name}qzzz`);
  assert.ok(result === null || result.name !== name, "Latin name should not match without word boundaries");
});

test("geoparse reports a score between 0 and 1 and a candidate count", { skip: !sample }, () => {
  const [name] = sample;
  const result = geoparse(`${name} ${name}`); // repeated mention
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(Number.isInteger(result.candidates) && result.candidates >= 1);
});
