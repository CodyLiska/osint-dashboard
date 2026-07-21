import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { infrastructureLayer, parseOverpass } from "../src/adapters/overpass.js";

const BERLIN = { lamin: "52.3", lomin: "13.2", lamax: "52.7", lomax: "13.6" };

test("a request with no viewport never reaches Overpass", async () => {
  // Missing bounds arrive as null, and Number(null) is 0 — so a plain cast turns
  // "no viewport" into a zero-area bbox at null island and queries the shared,
  // rate-limited endpoint for nothing.
  let called = false;
  const restore = installJsonFetch(() => { called = true; return { elements: [] }; });
  try {
    const nulls = await infrastructureLayer({ lamin: null, lomin: null, lamax: null, lomax: null });
    assert.equal(nulls.meta.configured, false);
    const empty = await infrastructureLayer({});
    assert.equal(empty.meta.configured, false);
    assert.equal(called, false, "no upstream request may be made without a viewport");
  } finally {
    restore();
  }
});

test("a viewport larger than the cap is refused rather than queried", async () => {
  let called = false;
  const restore = installJsonFetch(() => { called = true; return { elements: [] }; });
  try {
    const { entities, meta } = await infrastructureLayer({
      lamin: "35", lomin: "-10", lamax: "60", lomax: "30"
    });
    assert.equal(entities.length, 0);
    assert.equal(meta.configured, false);
    assert.match(meta.message, /Zoom in/);
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test("each feature type gets its own result budget", async () => {
  // Overpass emits in query order, so one shared limit lets dense substation
  // coverage crowd out every tower. Each set must emit under its own cap.
  let query = "";
  const restore = installJsonFetch((_url, opts) => {
    query = String(opts?.body || "");
    return { elements: [] };
  });
  try {
    await infrastructureLayer(BERLIN);
    const outs = query.match(/out center \d+/g) || [];
    assert.equal(outs.length, 2, "one out statement per feature set");
    assert.match(query, /->\.sub;/);
    assert.match(query, /->\.tower;/);
  } finally {
    restore();
  }
});

test("ways are placed by their computed center, not dropped for lacking lat/lon", () => {
  const rows = parseOverpass({
    elements: [
      { type: "node", id: 1, lat: 52.5, lon: 13.4, tags: { power: "substation" } },
      { type: "way", id: 2, center: { lat: 52.6, lon: 13.5 }, tags: { man_made: "communications_tower" } },
      { type: "node", id: 3, lat: 52.4, lon: 13.3, tags: { amenity: "cafe" } } // untagged for us
    ]
  });
  assert.equal(rows.length, 2);
  const way = rows.find((r) => r.id === "osm-way-2");
  assert.equal(way.lat, 52.6);
  assert.equal(way.type, "Communications tower");
});

test("a timed-out Overpass query is not published as an empty area", async () => {
  // Overpass reports a server-side timeout as HTTP 200 with a "remark". Caching
  // that would tell an analyst the region has no substations when in fact the
  // query never ran.
  const restore = installJsonFetch({ remark: "runtime error: Query timed out in 'query' at line 1", elements: [] });
  try {
    await assert.rejects(
      () => infrastructureLayer(BERLIN),
      /Overpass/,
      "a remark must surface as a failure, not a successful empty result"
    );
  } finally {
    restore();
  }
});
