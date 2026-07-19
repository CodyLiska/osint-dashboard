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
    assert.equal(meta.source, "NOAA SWPC");
    assert.equal(meta.n2yo.configured, false);
    assert.equal(meta.kp, "5.00");
  } finally {
    restore();
    if (saved === undefined) delete process.env.N2YO_API_KEY; else process.env.N2YO_API_KEY = saved;
  }
});
