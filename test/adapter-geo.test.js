import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { geocode } from "../src/adapters/geo.js";

test("geocode returns the top Nominatim hit as lat/lon + display name", async () => {
  const restore = installJsonFetch([
    { display_name: "350 Fifth Avenue, New York, NY 10118, USA", lat: "40.7484", lon: "-73.9857", class: "place", type: "house" }
  ]);
  try {
    const res = await geocode("350 fifth avenue new york");
    assert.equal(res.found, true);
    assert.equal(res.lat, 40.7484);
    assert.equal(res.lon, -73.9857);
    assert.match(res.name, /New York/);
  } finally {
    restore();
  }
});

test("geocode reports found:false when Nominatim returns nothing", async () => {
  const restore = installJsonFetch([]);
  try {
    const res = await geocode("asdkjhasdkjh nowhere place");
    assert.equal(res.found, false);
  } finally {
    restore();
  }
});

test("geocode rejects an empty query with a 400", async () => {
  await assert.rejects(geocode("   "), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});
