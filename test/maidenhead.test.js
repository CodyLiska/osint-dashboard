import test from "node:test";
import assert from "node:assert/strict";
import { gridToLatLon } from "../src/lib/maidenhead.js";

const near = (a, b, tol = 0.06) => Math.abs(a - b) <= tol;

test("a 6-char locator resolves to the subsquare centre", () => {
  // FN21MH is the well-known grid near the NY/NJ/PA area.
  const p = gridToLatLon("FN21MH");
  assert.ok(near(p.lat, 41.3125), `lat ${p.lat}`);
  assert.ok(near(p.lon, -74.958), `lon ${p.lon}`);
});

test("locators are case-insensitive and JO43kb lands on Bremen", () => {
  const p = gridToLatLon("jo43KB");
  assert.ok(near(p.lat, 53.06), `lat ${p.lat}`);
  assert.ok(near(p.lon, 8.875), `lon ${p.lon}`);
});

test("a 4-char locator resolves to the square centre", () => {
  const p = gridToLatLon("FN21");
  // The 2°-wide square spans -76..-74, so its centre lon is -75; lat centre 41.5.
  assert.ok(near(p.lat, 41.5), `lat ${p.lat}`);
  assert.ok(near(p.lon, -75.0), `lon ${p.lon}`);
});

test("the field origin AA00 sits at the south-west corner region", () => {
  const p = gridToLatLon("AA00");
  assert.ok(near(p.lat, -89.5), `lat ${p.lat}`);
  assert.ok(near(p.lon, -179.0), `lon ${p.lon}`);
});

test("malformed locators return null rather than a bogus coordinate", () => {
  assert.equal(gridToLatLon("ZZ99"), null); // Z is out of the A-R field range
  assert.equal(gridToLatLon("FN2"), null);  // too short
  assert.equal(gridToLatLon(""), null);
  assert.equal(gridToLatLon(null), null);
});
