import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { firesLayer } from "../src/adapters/firms.js";

const csv = [
  "latitude,longitude,bright_ti4,confidence,acq_date,acq_time,satellite,frp",
  "10.5,20.5,345,85,2026-06-01,1230,N,5.1", // confidence>=80 -> sev 5
  "-5.0,30.0,300,40,2026-06-01,1200,N,2.0"  // confidence<50, bright<340 -> sev 3
].join("\n");

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return (async () => {
    try { return await fn(); }
    finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  })();
}

test("firesLayer returns configured:false and no entities without a map key", async () => {
  await withEnv({ FIRMS_MAP_KEY: undefined }, async () => {
    const { entities, meta } = await firesLayer({});
    assert.equal(entities.length, 0);
    assert.equal(meta.configured, false);
    assert.match(meta.message, /FIRMS_MAP_KEY/);
  });
});

test("firesLayer parses the FIRMS CSV and scores severity by confidence/brightness", async () => {
  await withEnv({ FIRMS_MAP_KEY: "test-key", FIRMS_SOURCES: "VIIRS_NOAA20_NRT" }, async () => {
    const restore = installFetch((url) => url.includes("firms.modaps.eosdis.nasa.gov") ? csv : "");
    try {
      const { entities, meta } = await firesLayer({});
      assert.equal(meta.configured, true);
      assert.equal(entities.length, 2);
      const sevs = entities.map((e) => e.severity).sort();
      assert.deepEqual(sevs, [3, 5]);
      assert.ok(entities.every((e) => e.layer === "fires" && Number.isFinite(e.lat)));
      assert.equal(meta.source, "NASA FIRMS");
    } finally {
      restore();
    }
  });
});

test("firesLayer collapses a full-globe viewport request to 'world'", async () => {
  await withEnv({ FIRMS_MAP_KEY: "test-key", FIRMS_SOURCES: "VIIRS_NOAA20_NRT" }, async () => {
    let requestedUrl = "";
    const restore = installFetch((url) => { if (url.includes("firms")) requestedUrl = url; return url.includes("firms") ? csv : ""; });
    try {
      await firesLayer({ lamin: -90, lomin: -180, lamax: 90, lomax: 180 });
      assert.match(requestedUrl, /\/world\//, "a global bbox uses the 'world' area, not a huge box");
    } finally {
      restore();
    }
  });
});
