import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { spaceWeatherLayer } from "../src/adapters/space.js";

function routes({ alerts = [], kp = [] } = {}) {
  return (url) => {
    if (url.includes("alerts.json")) return alerts;
    if (url.includes("noaa-planetary-k-index.json")) return kp;
    return {};
  };
}

test("spaceWeatherLayer emits a Kp entity plus SWPC alerts, scoring alert severity", async () => {
  const saved = process.env.N2YO_API_KEY;
  delete process.env.N2YO_API_KEY; // no satellite layer -> SWPC-only
  const restore = installJsonFetch(routes({
    kp: [
      { time_tag: "2026-06-01T09:00:00", Kp: "3.00", station_count: 8 },
      { time_tag: "2026-06-01T12:00:00", Kp: "5.00", station_count: 8 } // latest wins
    ],
    alerts: [
      { product_id: "K04A", issue_datetime: "2026-06-01T12:05:00", message: "ALERT: Geomagnetic K-index of 4 (G4) WARNING" },
      { product_id: "K02A", issue_datetime: "2026-06-01T11:00:00", message: "Minor G2 conditions observed" }
    ]
  }));
  try {
    const { entities, meta } = await spaceWeatherLayer();
    const kpEntity = entities.find((e) => e.type === "Planetary K-index");
    assert.ok(kpEntity, "a Kp entity is produced from the latest reading");
    assert.match(kpEntity.name, /5\.00/);
    assert.equal(kpEntity.severity, 3); // ceil(5/2) = 3
    const g4 = entities.find((e) => e.name === "K04A");
    const g2 = entities.find((e) => e.name === "K02A");
    assert.equal(g4.severity, 5); // G4/WARNING -> 5
    assert.equal(g2.severity, 3); // G2 -> 3
    assert.equal(meta.source, "NOAA SWPC"); // no satellites from the empty mock
    assert.equal(meta.satellites.approximate, true); // keyless → CelesTrak path
    assert.equal(meta.kp, "5.00");
  } finally {
    restore();
    if (saved === undefined) delete process.env.N2YO_API_KEY; else process.env.N2YO_API_KEY = saved;
  }
});

test("without an N2YO key, satellites come from CelesTrak elements (keyless, approximate)", async () => {
  const saved = process.env.N2YO_API_KEY;
  delete process.env.N2YO_API_KEY;
  // Real GOES-18 GP record; every CATNR request in the mock returns it.
  const goes18Gp = {
    OBJECT_NAME: "GOES 18", NORAD_CAT_ID: 51850, EPOCH: "2026-07-19T17:39:30.046752",
    MEAN_MOTION: 1.00272002, ECCENTRICITY: 0.0000616, INCLINATION: 0.0158,
    RA_OF_ASC_NODE: 91.176, ARG_OF_PERICENTER: 60.7789, MEAN_ANOMALY: 273.4501
  };
  const restore = installJsonFetch((url) => {
    if (url.includes("alerts.json")) return [];
    if (url.includes("noaa-planetary-k-index.json")) return [{ time_tag: "2026-06-01T12:00:00", Kp: "2.00", station_count: 8 }];
    if (url.includes("celestrak.org")) return [goes18Gp];
    return {};
  });
  try {
    const { entities, meta } = await spaceWeatherLayer();
    const sat = entities.find((e) => e.type === "Satellite position");
    assert.ok(sat, "a satellite entity is produced from CelesTrak elements");
    assert.equal(sat.source, "CelesTrak (approx)");
    assert.ok(Number.isFinite(sat.lat) && Number.isFinite(sat.lon), "has a computed position");
    assert.ok(Math.abs(sat.altitudeKm - 35786) < 50, `GEO altitude: ${sat.altitudeKm}`);
    assert.equal(meta.source, "NOAA SWPC, CelesTrak");
    assert.equal(meta.satellites.approximate, true);
  } finally {
    restore();
    if (saved === undefined) delete process.env.N2YO_API_KEY; else process.env.N2YO_API_KEY = saved;
  }
});
