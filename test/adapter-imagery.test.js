import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { sceneSearch } from "../src/adapters/imagery.js";
import { sceneResults } from "../public/logic.js";

const stac = {
  numberMatched: 385,
  features: [
    { id: "S2C_54SUE_20260720_0_L2A", bbox: [139, 35, 140, 36],
      properties: { datetime: "2026-07-20T01:37:23Z", "eo:cloud_cover": 9.53, platform: "sentinel-2c" },
      assets: { thumbnail: { href: "https://sentinel-cogs.s3.amazonaws.com/x/preview.jpg" } } },
    { id: "no-thumb", properties: { datetime: "2026-07-10T00:00:00Z", "eo:cloud_cover": 5 }, assets: {} }
  ]
};

test("sceneSearch normalizes scenes, rounds cloud cover, and drops thumbnail-less features", async () => {
  const restore = installJsonFetch(stac);
  try {
    const out = await sceneSearch([139.6, 35.6, 139.8, 35.8]);
    assert.equal(out.matched, 385);
    assert.equal(out.scenes.length, 1, "the feature without a thumbnail is dropped");
    assert.equal(out.scenes[0].id, "S2C_54SUE_20260720_0_L2A");
    assert.equal(out.scenes[0].cloud, 9.5);
    assert.match(out.scenes[0].thumbnail, /preview\.jpg$/);
  } finally {
    restore();
  }
});

test("sceneSearch rejects a malformed bbox before calling the network", async () => {
  const out = await sceneSearch([1, 2, 3]);
  assert.match(out.error, /valid bbox/);
  assert.deepEqual(out.scenes, []);
});

test("sceneResults renders a thumbnail grid with date and cloud cover", () => {
  const html = sceneResults(
    { scenes: [{ id: "s1", datetime: "2026-07-20T01:37:23Z", cloud: 9.5, thumbnail: "https://x/preview.jpg", platform: "sentinel-2c" }], matched: 385, source: "Earth Search" },
    { name: "Tokyo, Japan" }
  );
  assert.match(html, /Tokyo, Japan/);
  assert.match(html, /2026-07-20/);
  assert.match(html, /9\.5% cloud/);
  assert.match(html, /preview\.jpg/);
  assert.match(html, /newest 1 of 385/);
});

test("sceneResults reports an empty result and an error distinctly", () => {
  assert.match(sceneResults({ scenes: [], matched: 0 }, { name: "Nowhere" }), /No recent low-cloud/);
  assert.match(sceneResults({ error: "A valid bbox [minLon,minLat,maxLon,maxLat] is required.", scenes: [] }), /valid bbox/);
});
