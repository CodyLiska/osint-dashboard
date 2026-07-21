import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRules, matchBatch, matchGeofence, matchKeyword, matchRule, parseRules, resetLoadedRules
} from "../src/lib/alert-rules.js";
import { geoProvenance, knownLayerIds } from "../src/adapters/layers.js";

// Only the loadRules tests touch disk; everything else runs against parseRules.
const tmp = mkdtempSync(join(tmpdir(), "osiris-alert-rules-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const write = (name, contents) => {
  const path = join(tmp, name);
  writeFileSync(path, contents);
  return path;
};

// Every validation case below runs against parseRules(object) — no filesystem.
const ok = (raw) => {
  const { rules, errors } = parseRules([raw]);
  assert.deepEqual(errors, [], "expected no validation errors");
  return rules[0];
};
const rejected = (raw) => {
  const { rules, errors } = parseRules([raw]);
  assert.equal(rules.length, 0, "expected the rule to be rejected");
  assert.ok(errors.length, "expected an error explaining why");
  return errors.join(" ");
};

const entity = (over = {}) => ({
  id: "e1", layer: "seismic", name: "M5.2 near Hualien", severity: 4, lat: 23.9, lon: 121.5, ...over
});

// ---- registry gate ---------------------------------------------------------

test("every layer in the registry declares its coordinate provenance", () => {
  // A new source must state whether its coordinates are real, or a geofence
  // rule could silently match fabricated positions.
  const valid = new Set(["real", "inferred", "country", "synthetic", "none"]);
  for (const id of knownLayerIds()) {
    assert.ok(valid.has(geoProvenance(id)), `${id} has no valid geo provenance`);
  }
});

test("an unknown layer is never treated as geofenceable", () => {
  assert.equal(geoProvenance("does-not-exist"), "none");
});

// ---- validation ------------------------------------------------------------

test("a rule with no conditions is rejected, not loaded with a warning", () => {
  // It would match every entity on every layer. That is a typo, not an intent.
  assert.match(rejected({ id: "everything" }), /no conditions/);
});

test("one invalid rule does not prevent the valid ones from loading", () => {
  // A single typo must not disable an operator's whole alert configuration.
  const { rules, errors } = parseRules([
    { id: "good", minSeverity: 4 },
    { id: "bad", layers: ["not-a-layer"] },
    { id: "also-good", keywords: ["reactor"] }
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["good", "also-good"]);
  assert.equal(errors.length, 1);
});

test("an unknown layer id is named in the error rather than silently ignored", () => {
  // Identifier drift between the registry and a config file has bitten this
  // codebase before; the id has to appear in the message.
  assert.match(rejected({ id: "typo", layers: ["seismicc"] }), /seismicc/);
});

test("a geofence over synthetic-coordinate layers is rejected", () => {
  // cyber/news scatter entities around a fixed anchor by array index, so a
  // geofence would match fabricated positions that move between fetches.
  const message = rejected({
    id: "cve-box",
    layers: ["cyber"],
    geofence: { type: "bbox", west: -80, south: 35, east: -70, north: 42 }
  });
  assert.match(message, /cyber \(synthetic\)/);
  assert.match(message, /not real positions/);
});

test("a geofence over country-centroid layers is rejected in favour of countries", () => {
  const message = rejected({
    id: "outage-box",
    layers: ["ioda"],
    geofence: { type: "circle", lat: 50, lon: 30, radiusKm: 300 }
  });
  assert.match(message, /ioda \(country\)/);
  assert.match(message, /countries/);
});

test("a geofence over real-coordinate layers is accepted", () => {
  const rule = ok({
    id: "taiwan",
    layers: ["seismic", "gdacs"],
    geofence: { type: "bbox", west: 118, south: 21.5, east: 123, north: 26.5 }
  });
  assert.equal(rule.layers.length, 2);
});

test("geoparsed layers may be geofenced, since the coordinates are real places", () => {
  const rule = ok({
    id: "tg", layers: ["telegram"],
    geofence: { type: "bbox", west: 22, south: 44, east: 40, north: 52 }
  });
  assert.ok(rule.geofence);
});

test("a duplicate rule id is rejected because ids key the alert dedupe", () => {
  const { rules, errors } = parseRules([
    { id: "dupe", minSeverity: 3 },
    { id: "dupe", minSeverity: 5 }
  ]);
  assert.equal(rules.length, 1);
  assert.match(errors.join(" "), /more than once/);
});

test("a transposed bbox is reported instead of silently matching nothing", () => {
  assert.match(
    rejected({ id: "flipped", layers: ["seismic"], geofence: { type: "bbox", west: 30, south: 40, east: 20, north: 50 } }),
    /transposed/
  );
});

test("severity outside the 1-5 scale is rejected", () => {
  assert.match(rejected({ id: "s", minSeverity: 9 }), /1 to 5/);
});

test("a non-array rules document is rejected as a whole", () => {
  const { rules, errors } = parseRules({ id: "not-an-array" });
  assert.equal(rules.length, 0);
  assert.match(errors.join(" "), /JSON array/);
});

// ---- geofence matching -----------------------------------------------------

test("bbox matching includes the boundary and excludes the outside", () => {
  const box = { type: "bbox", west: 118, south: 21.5, east: 123, north: 26.5 };
  assert.equal(matchGeofence(box, { lat: 23.9, lon: 121.5 }), true);
  assert.equal(matchGeofence(box, { lat: 21.5, lon: 118 }), true, "corner is inside");
  assert.equal(matchGeofence(box, { lat: 35.0, lon: 121.5 }), false);
  assert.equal(matchGeofence(box, { lat: 23.9, lon: 100.0 }), false);
});

test("a bbox crossing the antimeridian matches both sides of 180", () => {
  // west > east is the wrap case; treating it as a normal range matches nothing.
  const box = { type: "bbox", west: 170, south: -20, east: -170, north: 20 };
  assert.equal(matchGeofence(box, { lat: 0, lon: 175 }), true);
  assert.equal(matchGeofence(box, { lat: 0, lon: -175 }), true);
  assert.equal(matchGeofence(box, { lat: 0, lon: 0 }), false);
});

test("circle matching respects the radius boundary", () => {
  // Distances from Phoenix, verified by haversine: Scottsdale 13.7km,
  // Tucson 171.1km, New York 3443km.
  const circle = { type: "circle", lat: 33.45, lon: -112.07, radiusKm: 150 };
  assert.equal(matchGeofence(circle, { lat: 33.45, lon: -112.07 }), true, "centre");
  assert.equal(matchGeofence(circle, { lat: 33.49, lon: -111.93 }), true, "Scottsdale, 13.7km, inside");
  assert.equal(matchGeofence(circle, { lat: 32.22, lon: -110.97 }), false, "Tucson, 171.1km, outside a 150km radius");
  assert.equal(matchGeofence(circle, { lat: 40.71, lon: -74.01 }), false, "New York, far outside");

  // The same Tucson point falls inside once the radius covers it, so the test
  // is exercising the radius and not just a coordinate typo.
  assert.equal(matchGeofence({ ...circle, radiusKm: 200 }, { lat: 32.22, lon: -110.97 }), true);
});

test("an entity with no usable coordinates never matches a geofence", () => {
  const box = { type: "bbox", west: -10, south: -10, east: 10, north: 10 };
  assert.equal(matchGeofence(box, { lat: NaN, lon: 0 }), false);
  assert.equal(matchGeofence(box, {}), false);
});

// ---- keyword matching ------------------------------------------------------

test("keywords match whole words, not substrings", () => {
  // The gazetteer's "London" inside "Londonderry" bug, in a new place.
  assert.equal(matchKeyword("london", "Explosion in Londonderry"), false);
  assert.equal(matchKeyword("london", "Explosion in London today"), true);
  assert.equal(matchKeyword("london", "London"), true);
});

test("keyword matching is case-insensitive and survives punctuation", () => {
  assert.equal(matchKeyword("iaea", "The IAEA, meeting today"), true);
  assert.equal(matchKeyword("reactor", "reactor-4 shutdown"), true);
});

test("a keyword containing regex characters is matched literally", () => {
  assert.equal(matchKeyword("c++", "written in c++ today"), true);
  assert.equal(matchKeyword("a.b", "value axb"), false);
});

// ---- rule matching ---------------------------------------------------------

test("all present conditions must hold for a rule to match", () => {
  const rule = ok({
    id: "taiwan-major", layers: ["seismic"], minSeverity: 4,
    geofence: { type: "bbox", west: 118, south: 21.5, east: 123, north: 26.5 }
  });
  assert.equal(matchRule(rule, entity()), true);
  assert.equal(matchRule(rule, entity({ severity: 2 })), false, "below severity");
  assert.equal(matchRule(rule, entity({ lat: 51.5, lon: -0.1 })), false, "outside the box");
  assert.equal(matchRule(rule, entity({ layer: "gdacs" })), false, "wrong layer");
});

test("a disabled rule never matches", () => {
  const rule = ok({ id: "off", enabled: false, minSeverity: 1 });
  assert.equal(matchRule(rule, entity()), false);
});

test("countries match either the name or the ISO code", () => {
  const rule = ok({ id: "ru-ua", layers: ["ioda"], countries: ["RU", "Ukraine"] });
  assert.equal(matchRule(rule, entity({ layer: "ioda", country: "Ukraine" })), true);
  assert.equal(matchRule(rule, entity({ layer: "ioda", countryCode: "RU" })), true);
  assert.equal(matchRule(rule, entity({ layer: "ioda", country: "France" })), false);
});

test("keywords are searched across name, summary and text", () => {
  const rule = ok({ id: "nuke", keywords: ["reactor"] });
  assert.equal(matchRule(rule, entity({ name: "Quake", summary: "near a reactor site" })), true);
  assert.equal(matchRule(rule, entity({ name: "Quake", text: "reactor offline" })), true);
  assert.equal(matchRule(rule, entity({ name: "Quake", summary: "nothing relevant" })), false);
});

// ---- batching --------------------------------------------------------------

test("matches are grouped by rule, which is what delivery sends", () => {
  // One notification per rule listing its matches — not one per entity.
  const { rules } = parseRules([
    { id: "major", minSeverity: 5 },
    { id: "taiwan", layers: ["seismic"], geofence: { type: "bbox", west: 118, south: 21.5, east: 123, north: 26.5 } }
  ]);
  const grouped = matchBatch(rules, [
    entity({ id: "a", severity: 5 }),
    entity({ id: "b", severity: 4 }),
    entity({ id: "c", severity: 5, lat: 0, lon: 0 })
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ["major", "taiwan"]);
  assert.deepEqual(grouped.get("major").map((e) => e.id), ["a", "c"]);
  assert.deepEqual(grouped.get("taiwan").map((e) => e.id), ["a", "b"]);
});

test("rules with no matches are omitted rather than returned empty", () => {
  const { rules } = parseRules([{ id: "quiet", minSeverity: 5 }]);
  const grouped = matchBatch(rules, [entity({ severity: 1 })]);
  assert.equal(grouped.size, 0);
});

test("an empty batch is handled without throwing", () => {
  const { rules } = parseRules([{ id: "any", minSeverity: 1 }]);
  assert.equal(matchBatch(rules, []).size, 0);
  assert.equal(matchBatch(rules, undefined).size, 0);
});

// ---- loading (the one impure seam, so it needs real files) -----------------

test("a missing rules file means alerting is off, not broken", () => {
  // No rules file is a valid configuration. It must not throw or look like an
  // error, or a fresh install would appear misconfigured.
  resetLoadedRules();
  const result = loadRules(join(tmp, "does-not-exist.json"));
  assert.equal(result.present, false);
  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.errors, []);
});

test("a valid file loads its rules", () => {
  resetLoadedRules();
  const path = write("good.json", JSON.stringify([
    { id: "a", minSeverity: 4 },
    { id: "b", keywords: ["reactor"] }
  ]));
  const result = loadRules(path);
  assert.equal(result.present, true);
  assert.deepEqual(result.rules.map((r) => r.id), ["a", "b"]);
});

test("malformed JSON keeps the last good rules instead of dropping to none", () => {
  // A bad edit must degrade to the previously working configuration, not
  // silently disable every alert the operator depends on.
  resetLoadedRules();
  loadRules(write("first.json", JSON.stringify([{ id: "keeper", minSeverity: 3 }])));
  const result = loadRules(write("broken.json", "[{ id: "));
  assert.deepEqual(result.rules.map((r) => r.id), ["keeper"]);
  assert.ok(result.errors.length, "the parse failure is still reported");
});

test("a file with one bad rule still loads the good ones", () => {
  resetLoadedRules();
  const path = write("mixed.json", JSON.stringify([
    { id: "fine", minSeverity: 2 },
    { id: "broken", layers: ["no-such-layer"] }
  ]));
  const result = loadRules(path);
  assert.deepEqual(result.rules.map((r) => r.id), ["fine"]);
  assert.equal(result.errors.length, 1);
});

test("the shipped example file is valid", () => {
  // The example is the only documentation of the rule shape, so it breaking
  // silently would mislead every operator who copies it.
  resetLoadedRules();
  // fileURLToPath, not URL.pathname — the latter yields "/C:/..." on Windows.
  const result = loadRules(fileURLToPath(new URL("../config/alert-rules.example.json", import.meta.url)));
  assert.equal(result.present, true);
  assert.deepEqual(result.errors, [], "the example must not contain a rejected rule");
  assert.ok(result.rules.length >= 3);
});

test("a malformed geofence is rejected with a message naming the problem", () => {
  // These are the fail-loud guarantees: rejecting rather than warning is only
  // useful if each malformed shape actually produces its own error.
  const cases = [
    [{ type: "bbox", west: 1, south: 2, east: 3 }, /north must be a number/],
    [{ type: "bbox", west: "x", south: 2, east: 3, north: 4 }, /west must be a number/],
    [{ type: "bbox", west: 1, south: 50, east: 3, north: 40 }, /south is north of/],
    [{ type: "circle", lon: 5, radiusKm: 10 }, /lat and geofence.lon must be numbers/],
    [{ type: "circle", lat: 1, lon: 5, radiusKm: 0 }, /radiusKm must be a positive number/],
    [{ type: "circle", lat: 1, lon: 5 }, /radiusKm must be a positive number/],
    [{ type: "polygon", points: [] }, /must be "bbox" or "circle"/],
    ["not-an-object", /geofence must be an object/]
  ];
  for (const [geofence, expected] of cases) {
    const { rules, errors } = parseRules([{ id: "g", layers: ["seismic"], geofence }]);
    assert.equal(rules.length, 0, `expected rejection for ${JSON.stringify(geofence)}`);
    assert.match(errors.join(" "), expected);
  }
});

test("an unreadable rules path is reported without dropping the last good rules", () => {
  // A permissions or path-type problem is not the same as "no rules file", and
  // must not silently disable alerting.
  resetLoadedRules();
  loadRules(write("prior.json", JSON.stringify([{ id: "kept", minSeverity: 3 }])));
  const result = loadRules(tmp); // a directory, not a file
  assert.equal(result.present, true);
  assert.deepEqual(result.rules.map((r) => r.id), ["kept"]);
  assert.ok(result.errors.length);
});

test("an empty or malformed condition list is rejected rather than ignored", () => {
  // `"keywords": []` is the shape a half-finished edit leaves behind. Ignoring
  // it would silently drop the condition and widen the rule to everything else.
  assert.match(rejected({ id: "a", layers: [] }), /layers must be a non-empty array/);
  assert.match(rejected({ id: "b", layers: "seismic" }), /layers must be a non-empty array/);
  assert.match(rejected({ id: "c", keywords: [] }), /keywords must be a non-empty array/);
  assert.match(rejected({ id: "d", keywords: ["ok", "  "] }), /keywords must be a non-empty array/);
  assert.match(rejected({ id: "e", countries: [] }), /countries must be a non-empty array/);
  assert.match(rejected({ id: "f", countries: [42] }), /countries must be a non-empty array/);
});
