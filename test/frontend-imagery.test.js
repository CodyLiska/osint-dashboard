import test from "node:test";
import assert from "node:assert/strict";
import { gibsTileUrl, yesterdayUTC, todayUTC } from "../public/logic.js";
import { layerDefinitions, LAYER_GROUPS } from "../public/data.js";

test("gibsTileUrl builds a WMTS REST template with MapLibre placeholders", () => {
  const gibs = { layer: "MODIS_Terra_CorrectedReflectance_TrueColor", matrix: "GoogleMapsCompatible_Level9", ext: "jpg" };
  const url = gibsTileUrl(gibs, "2026-07-20");
  assert.match(url, /gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/MODIS_Terra_CorrectedReflectance_TrueColor\/default\/2026-07-20\/GoogleMapsCompatible_Level9\/\{z\}\/\{y\}\/\{x\}\.jpg/);
});

test("a fixed-date product (gibs.date) ignores the supplied daily date", () => {
  const bm = { layer: "VIIRS_Black_Marble", matrix: "GoogleMapsCompatible_Level8", ext: "png", date: "2016-01-01" };
  assert.match(gibsTileUrl(bm, "2026-07-20"), /\/default\/2016-01-01\//);
});

test("yesterdayUTC returns the day before, formatted YYYY-MM-DD", () => {
  const fixed = Date.UTC(2026, 6, 21, 3, 0, 0); // 2026-07-21T03:00Z
  assert.equal(yesterdayUTC(fixed), "2026-07-20");
});

test("todayUTC returns the current UTC day (for near-real-time layers like GOES)", () => {
  const fixed = Date.UTC(2026, 6, 21, 3, 0, 0);
  assert.equal(todayUTC(fixed), "2026-07-21");
});

test("every raster layer carries a complete gibs config and lives in the imagery group", () => {
  const groups = new Set(LAYER_GROUPS.map((g) => g.id));
  assert.ok(groups.has("imagery"), "an imagery group exists");
  const rasters = layerDefinitions.filter((l) => l.raster);
  assert.ok(rasters.length >= 1, "there is at least one raster layer");
  for (const l of rasters) {
    assert.equal(l.group, "imagery", `${l.id} is in the imagery group`);
    assert.ok(l.gibs?.layer && l.gibs.matrix && l.gibs.ext, `${l.id} has a full gibs config`);
    assert.ok(!l.live && !l.staticKey, `${l.id} is neither live nor static`);
  }
});
