import test from "node:test";
import assert from "node:assert/strict";
import { subSatellitePoint, elementsFromGp } from "../src/lib/orbit.js";

// Real GOES-18 elements (validated live: it sits at ~137.0degW). A geostationary
// sat is the ideal fixture — its sub-longitude is time-stable and independently
// known, so this pins the whole pipeline (Kepler solve, PQW->ECI, GMST).
const goes18 = {
  epoch: "2026-07-19T17:39:30.046752",
  meanMotion: 1.00272002,
  eccentricity: 0.0000616,
  inclination: 0.0158,
  raan: 91.176,
  argPerigee: 60.7789,
  meanAnomaly: 273.4501
};

test("subSatellitePoint places GOES-18 at its known geostationary slot (~137W)", () => {
  const p = subSatellitePoint(goes18, Date.parse("2026-07-20T02:00:00Z"));
  assert.ok(Math.abs(p.lon - -136.998) < 0.5, `lon ${p.lon}`); // GOES-West operational slot
  assert.ok(Math.abs(p.lat) < 0.1, `lat ${p.lat}`); // geostationary → ~equatorial
  assert.ok(Math.abs(p.altKm - 35786) < 20, `alt ${p.altKm}`); // GEO altitude
});

test("a geostationary longitude is stable over time (mean motion ~ Earth rotation)", () => {
  const t0 = Date.parse("2026-07-20T02:00:00Z");
  const a = subSatellitePoint(goes18, t0);
  const b = subSatellitePoint(goes18, t0 + 12 * 3600_000);
  assert.ok(Math.abs(a.lon - b.lon) < 0.5, `drift ${Math.abs(a.lon - b.lon)}`);
});

test("epoch without a timezone is treated as UTC (a local offset would corrupt the position)", () => {
  const withZ = subSatellitePoint({ ...goes18, epoch: "2026-07-19T17:39:30.046752Z" }, Date.parse("2026-07-20T02:00:00Z"));
  const without = subSatellitePoint(goes18, Date.parse("2026-07-20T02:00:00Z"));
  assert.ok(Math.abs(withZ.lon - without.lon) < 1e-6);
  assert.ok(Math.abs(withZ.lat - without.lat) < 1e-6);
});

test("sub-satellite latitude never exceeds the orbital inclination (a LEO sweep)", () => {
  // ISS-like: ~51.6deg inclination, ~92 min period.
  const iss = { epoch: "2026-07-20T00:00:00Z", meanMotion: 15.49, eccentricity: 0.0006, inclination: 51.63, raan: 100, argPerigee: 60, meanAnomaly: 0 };
  const t0 = Date.parse(iss.epoch);
  let maxAbsLat = 0;
  let alt = 0;
  for (let m = 0; m <= 100; m += 2) {
    const p = subSatellitePoint(iss, t0 + m * 60_000);
    maxAbsLat = Math.max(maxAbsLat, Math.abs(p.lat));
    alt = p.altKm;
    assert.ok(p.lon >= -180 && p.lon <= 180, `lon in range: ${p.lon}`);
  }
  assert.ok(maxAbsLat <= 51.63 + 0.5, `max |lat| ${maxAbsLat} within inclination`);
  assert.ok(maxAbsLat > 45, `orbit actually reaches high latitude: ${maxAbsLat}`);
  assert.ok(alt > 350 && alt < 450, `LEO altitude band: ${alt}`);
});

test("elementsFromGp maps CelesTrak GP field names to the element shape", () => {
  const gp = {
    EPOCH: "2026-07-19T17:39:30Z", MEAN_MOTION: 1.0027, ECCENTRICITY: 0.0001,
    INCLINATION: 0.02, RA_OF_ASC_NODE: 91.1, ARG_OF_PERICENTER: 60.7, MEAN_ANOMALY: 273.4
  };
  const el = elementsFromGp(gp);
  assert.equal(el.meanMotion, 1.0027);
  assert.equal(el.raan, 91.1);
  assert.equal(el.meanAnomaly, 273.4);
  assert.equal(el.epoch, "2026-07-19T17:39:30Z");
});
