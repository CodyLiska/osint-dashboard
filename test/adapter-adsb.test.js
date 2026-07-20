import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { militaryAircraftLayer } from "../src/adapters/adsb.js";

test("militaryAircraftLayer normalizes adsb.lol military aircraft to the OpenSky shape", async () => {
  const restore = installJsonFetch({
    ac: [
      { hex: "ae080e", flight: "RCH434 ", r: "05-5153", t: "C17", alt_baro: 33000, gs: 450, track: 270, squawk: "1234", category: "A5", lat: 38.24, lon: -121.95 },
      { hex: "abc123", flight: "", r: "N123", t: "F16", alt_baro: "ground", gs: 0, true_heading: 90, squawk: "7700", lat: 40, lon: -100 }
    ]
  });
  try {
    const { entities, meta } = await militaryAircraftLayer({});
    assert.match(meta.source, /adsb\.lol/);
    assert.equal(entities.length, 2);

    const c17 = entities.find((e) => e.id === "mil-ae080e");
    assert.equal(c17.layer, "military-air");
    assert.equal(c17.type, "C17");
    assert.equal(c17.name, "RCH434"); // trimmed callsign
    assert.equal(c17.track, 270);
    assert.equal(c17.severity, 4);
    assert.ok(Math.abs(c17.velocity - 450 * 0.514444) < 0.01, "knots→m/s for dead-reckoning");
    assert.ok(Math.abs(c17.altitude - 33000 * 0.3048) < 0.1, "ft→m altitude");

    const f16 = entities.find((e) => e.id === "mil-abc123");
    assert.equal(f16.name, "N123"); // falls back to registration when no callsign
    assert.equal(f16.track, 90); // true_heading when track absent
    assert.equal(f16.altitude, 0); // "ground"
    assert.equal(f16.severity, 5); // squawk 7700 = emergency
  } finally {
    restore();
  }
});
