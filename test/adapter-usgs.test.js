import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { seismicLayer } from "../src/adapters/usgs.js";

const feed = (features) => ({ type: "FeatureCollection", features });
const quake = (id, mag, lon, lat, extra = {}) => ({
  id,
  properties: { mag, place: `place-${id}`, time: 1_700_000_000_000, url: `http://u/${id}`, ...extra },
  geometry: { coordinates: [lon, lat, 10] }
});

test("seismicLayer normalizes GeoJSON features into entities", async () => {
  const restore = installJsonFetch(feed([quake("aa", 4.2, -120, 35)]));
  try {
    const { entities, meta } = await seismicLayer();
    assert.equal(entities.length, 1);
    const e = entities[0];
    assert.equal(e.id, "quake-aa");
    assert.equal(e.layer, "seismic");
    assert.equal(e.lon, -120);
    assert.equal(e.lat, 35);
    assert.equal(e.magnitude, 4.2);
    assert.equal(e.time, new Date(1_700_000_000_000).toISOString());
    assert.equal(meta.source, "USGS Earthquake Hazards Program");
  } finally {
    restore();
  }
});

test("seismicLayer clamps severity from magnitude into 1..5", async () => {
  const restore = installJsonFetch(feed([
    quake("small", 0.5, 10, 10),
    quake("big", 8.9, 20, 20)
  ]));
  try {
    const byId = Object.fromEntries((await seismicLayer()).entities.map((e) => [e.id, e]));
    assert.equal(byId["quake-small"].severity, 1); // 0.5 -> min 1
    assert.equal(byId["quake-big"].severity, 5);   // 8.9 -> max 5
  } finally {
    restore();
  }
});

test("seismicLayer drops features with non-finite coordinates", async () => {
  // A too-short / non-numeric coordinate array yields NaN and is filtered out.
  // (A null coordinate would coerce to 0 and survive — that's finite.)
  const restore = installJsonFetch(feed([
    quake("good", 3, 30, 30),
    { id: "bad", properties: { mag: 3, place: "x", time: null }, geometry: { coordinates: [30] } }
  ]));
  try {
    const ids = (await seismicLayer()).entities.map((e) => e.id);
    assert.deepEqual(ids, ["quake-good"]);
  } finally {
    restore();
  }
});

test("seismicLayer tolerates an empty feed", async () => {
  const restore = installJsonFetch(feed([]));
  try {
    const { entities } = await seismicLayer();
    assert.deepEqual(entities, []);
  } finally {
    restore();
  }
});
