import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { gpsJamLayer, latestManifestEntry, parseCells, severityForRatio } from "../src/adapters/gpsjam.js";
import { cellToLonLat, cellKey, centroidTableSize } from "../src/lib/h3.js";

const MANIFEST = `date,suspect,num_bad_aircraft_hexes
2026-07-18,false,400
2026-07-20,false,532
2026-07-19,true,688`;

// 8400001ffffffff is a real res-4 cell; the others exercise the filters.
const DAY = `hex,count_good_aircraft,count_bad_aircraft
8400001ffffffff,10,10
8400003ffffffff,99,1
8400005ffffffff,0,1
84005c7ffffffff,3,17
notacell,10,10`;

test("the manifest yields the newest day regardless of file order", () => {
  // Rows are not guaranteed sorted, so max-by-date is the only safe read.
  assert.deepEqual(latestManifestEntry(MANIFEST), { date: "2026-07-20", suspect: false });
});

test("a manifest with no usable rows yields null rather than a bogus date", () => {
  assert.equal(latestManifestEntry("date,suspect\ngarbage,false"), null);
});

test("cells below the traffic floor or the ratio floor are excluded", () => {
  const rows = parseCells(DAY);
  const hexes = rows.map((r) => r.hex);
  assert.ok(hexes.includes("8400001ffffffff"), "10/20 = 50% over the floor");
  assert.ok(hexes.includes("84005c7ffffffff"), "17/20 = 85%");
  assert.ok(!hexes.includes("8400003ffffffff"), "1/100 = 1% is below the ratio floor");
  // A single aircraft reporting badly is 100% by arithmetic and noise in fact.
  assert.ok(!hexes.includes("8400005ffffffff"), "1 aircraft is below the traffic floor");
});

test("severity rises with the interference ratio", () => {
  // This layer is one of the few with real severity variation, so an alert rule
  // can fire on an upward crossing rather than only on appearance.
  assert.equal(severityForRatio(0.02), 2);
  assert.equal(severityForRatio(0.1), 3);
  assert.equal(severityForRatio(0.25), 4);
  assert.equal(severityForRatio(0.9), 5);
  assert.ok(severityForRatio(0.6) > severityForRatio(0.3));
});

test("the H3 lookup places a cell and rejects a malformed id", () => {
  assert.equal(centroidTableSize(), 288122);
  const point = cellToLonLat("8400001ffffffff");
  assert.ok(Array.isArray(point) && point.length === 2);
  assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]));
  assert.ok(point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90);
  // Wrong resolution prefix, wrong length, and junk all refuse rather than throw,
  // so one bad upstream row cannot empty the layer.
  assert.equal(cellToLonLat("85005c7ffffffff"), null);
  assert.equal(cellToLonLat("nonsense"), null);
  assert.equal(cellKey("nonsense"), null);
});

test("a day's cells become located entities tagged with the observation date", async () => {
  const restore = installFetch((url) => (String(url).includes("manifest") ? MANIFEST : DAY));
  try {
    const { entities, meta } = await gpsJamLayer();
    assert.equal(meta.observedOn, "2026-07-20");
    assert.equal(meta.suspectDay, false);
    assert.equal(meta.stale, false);
    // "notacell" is not a valid res-4 id, so it is counted, not silently lost.
    assert.equal(meta.unmappedCells, 1);
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    const worst = entities.find((e) => e.cell === "84005c7ffffffff");
    assert.equal(worst.severity, 5, "85% interference is top of the scale");
    assert.equal(worst.badAircraft, 17);
    assert.equal(worst.totalAircraft, 20);
    assert.equal(worst.time, "2026-07-20T00:00:00.000Z");
    assert.match(worst.summary, /17 of 20 aircraft/);
  } finally {
    restore();
  }
});

test("a day the upstream flags as suspect is surfaced, not silently served", async () => {
  const manifest = "date,suspect,num_bad_aircraft_hexes\n2026-07-21,true,900";
  const restore = installFetch((url) => (String(url).includes("manifest") ? manifest : DAY));
  try {
    const { meta } = await gpsJamLayer();
    assert.equal(meta.suspectDay, true);
  } finally {
    restore();
  }
});
