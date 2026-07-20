import test from "node:test";
import assert from "node:assert/strict";
import { layerEntities, persistableIds, sourceName } from "../src/adapters/layers.js";

test("sourceName resolves static and config-dependent names, with an id fallback", () => {
  assert.equal(sourceName("seismic"), "USGS");
  assert.equal(sourceName("bogus-layer"), "bogus-layer"); // unknown → raw id

  const prev = process.env.NEWSAPI_KEY;
  try {
    delete process.env.NEWSAPI_KEY;
    assert.equal(sourceName("news"), "Static broadcaster directory");
    process.env.NEWSAPI_KEY = "x";
    assert.equal(sourceName("news"), "NewsAPI");
  } finally {
    if (prev === undefined) delete process.env.NEWSAPI_KEY;
    else process.env.NEWSAPI_KEY = prev;
  }
});

test("persistableIds is the event-shaped allowlist and excludes kinematic/static-adapter layers", () => {
  const ids = persistableIds();
  for (const id of ["seismic", "weather", "cyber", "news", "telegram", "conflict"]) {
    assert.ok(ids.includes(id), `${id} should be persistable`);
  }
  for (const id of ["aviation", "military-air", "maritime", "ports", "space", "crypto", "sanctions", "gdelt"]) {
    assert.ok(!ids.includes(id), `${id} must not be persistable`);
  }
});

test("layerEntities returns null for an unknown layer and for a static placeholder (no adapter)", async () => {
  assert.equal(await layerEntities("bogus-layer"), null);
  assert.equal(await layerEntities("conflict"), null); // load:null, served client-side only
});
