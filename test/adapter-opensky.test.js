import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { aviationLayer } from "../src/adapters/opensky.js";

// OpenSky state vectors are positional arrays. Build one with the indices the
// adapter reads: 0 icao, 1 callsign, 2 country, 5 lon, 6 lat, 9 velocity,
// 10 track, 14 squawk, 17 category.
function row({ id = "abc123", call = "TEST123", country = "Testland", lon = 5, lat = 10, squawk = null, cat = 0 } = {}) {
  const r = new Array(18).fill(null);
  r[0] = id; r[1] = call; r[2] = country; r[4] = 1_700_000_000;
  r[5] = lon; r[6] = lat; r[9] = 200; r[10] = 90; r[14] = squawk; r[17] = cat;
  return r;
}
const states = (rows) => ({ time: 1_700_000_000, states: rows });
const bounds = { lamin: "0", lomin: "0", lamax: "20", lomax: "20" };

test("aviationLayer maps a state vector into an aircraft entity", async () => {
  const restore = installJsonFetch(states([row({ id: "a1", call: "SWA1 ", lon: 5, lat: 10 })]));
  try {
    const { entities, meta } = await aviationLayer(bounds);
    assert.equal(entities.length, 1);
    const e = entities[0];
    assert.equal(e.id, "air-a1");
    assert.equal(e.name, "SWA1"); // trimmed
    assert.equal(e.lon, 5);
    assert.equal(e.lat, 10);
    assert.equal(meta.authenticated, false);
    assert.equal(meta.source, "OpenSky Network");
  } finally {
    restore();
  }
});

test("aviationLayer flags emergency squawks (7500/7600/7700) as max severity", async () => {
  const restore = installJsonFetch(states([
    row({ id: "hij", squawk: "7700", lon: 1, lat: 1 }),
    row({ id: "cat", squawk: null, cat: 4, lon: 2, lat: 2 }),
    row({ id: "plain", squawk: null, cat: 0, lon: 3, lat: 3 })
  ]));
  try {
    const byId = Object.fromEntries((await aviationLayer(bounds)).entities.map((e) => [e.id, e]));
    assert.equal(byId["air-hij"].severity, 5); // emergency squawk
    assert.equal(byId["air-cat"].severity, 3); // has a category
    assert.equal(byId["air-plain"].severity, 1);
  } finally {
    restore();
  }
});

test("aviationLayer drops states with non-finite coordinates", async () => {
  // Non-numeric position coerces to NaN and is filtered out. (Passing undefined
  // would just hit the helper's default; use a corrupt string to force NaN.)
  const restore = installJsonFetch(states([
    row({ id: "good", lon: 4, lat: 4 }),
    row({ id: "bad", lon: "?", lat: "?" })
  ]));
  try {
    const ids = (await aviationLayer(bounds)).entities.map((e) => e.id);
    assert.deepEqual(ids, ["air-good"]);
  } finally {
    restore();
  }
});

test("aviationLayer caps the result at 1200 aircraft", async () => {
  const many = Array.from({ length: 1300 }, (_, i) => row({ id: `n${i}`, lon: (i % 100) / 10, lat: (i % 90) / 10 }));
  const restore = installJsonFetch(states(many));
  try {
    const { entities } = await aviationLayer(bounds);
    assert.equal(entities.length, 1200);
  } finally {
    restore();
  }
});
