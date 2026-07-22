import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { cablesLayer } from "../src/adapters/cables.js";

const geo = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "i-2sea", name: "I-2SEA", color: "#939597", coordinates: [93.15, 9.29] },
      geometry: { type: "MultiLineString", coordinates: [[[80.2, 13.0], [83.7, 11.7]], [[89.2, 10.2], [93.1, 9.3]]] }
    },
    // No anchor in properties → falls back to the first path's first point.
    {
      type: "Feature",
      properties: { id: "no-anchor", name: "No Anchor" },
      geometry: { type: "MultiLineString", coordinates: [[[10, 20], [11, 21]]] }
    },
    // A point geometry (not a cable route) → dropped (no paths).
    {
      type: "Feature",
      properties: { id: "landing", name: "Landing" },
      geometry: { type: "Point", coordinates: [0, 0] }
    }
  ]
};

test("cablesLayer keeps each cable's segments and anchors it for the map/feed", async () => {
  const restore = installJsonFetch(geo);
  try {
    const { entities, meta } = await cablesLayer();
    assert.equal(entities.length, 2, "the Point feature (no line segments) is dropped");
    const cable = entities.find((e) => e.name === "I-2SEA");
    assert.equal(cable.layer, "submarine-cables");
    assert.equal(cable.segmentCount, 2);
    assert.deepEqual([cable.lon, cable.lat], [93.15, 9.29], "uses the provided label anchor");
    assert.equal(cable.color, "#939597");
    assert.match(meta.source, /Submarine Cable Map/);
  } finally {
    restore();
  }
});

test("a cable with no properties.coordinates falls back to its first path point", async () => {
  const restore = installJsonFetch(geo);
  try {
    const { entities } = await cablesLayer();
    const fallback = entities.find((e) => e.name === "No Anchor");
    assert.deepEqual([fallback.lon, fallback.lat], [10, 20]);
  } finally {
    restore();
  }
});
