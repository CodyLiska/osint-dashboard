import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { gdacsLayer } from "../src/adapters/gdacs.js";

const feed = {
  type: "FeatureCollection",
  features: [
    {
      geometry: { type: "Point", coordinates: [126.97, 37.56] },
      properties: {
        eventtype: "FL", eventid: 1104032, name: "Flood in South Korea", alertlevel: "Orange",
        fromdate: "2026-07-18T01:00:00", url: { report: "https://gdacs.org/report?id=1104032" },
        severitydata: { severitytext: "Magnitude 2.5" }, country: "South Korea"
      }
    },
    {
      geometry: { type: "Point", coordinates: [130.0, -5.0] },
      properties: {
        eventtype: "EQ", eventid: 1552918, name: "Earthquake in Indonesia", alertlevel: "Green",
        fromdate: "2026-07-20T00:27:46", url: { report: "https://gdacs.org/report?id=1552918" },
        severitydata: { severitytext: "Magnitude 4.7M" }
      }
    },
    // A red cyclone with no coordinates → filtered out.
    { geometry: { type: "Point", coordinates: [] }, properties: { eventtype: "TC", eventid: 9, alertlevel: "Red" } }
  ]
};

test("gdacsLayer normalizes disasters with type labels and alert-level severity", async () => {
  const restore = installJsonFetch(feed);
  try {
    const { entities, meta } = await gdacsLayer();
    assert.equal(entities.length, 2); // the coordinate-less cyclone is dropped
    assert.match(meta.source, /GDACS/);

    const flood = entities.find((e) => e.id === "gdacs-FL-1104032");
    assert.equal(flood.type, "Flood");
    assert.equal(flood.severity, 4); // Orange
    assert.equal(flood.lat, 37.56);
    assert.equal(flood.lon, 126.97);
    assert.equal(flood.time, "2026-07-18T01:00:00Z"); // forced UTC
    assert.match(flood.summary, /Orange alert/);
    assert.equal(flood.url, "https://gdacs.org/report?id=1104032");

    const quake = entities.find((e) => e.id === "gdacs-EQ-1552918");
    assert.equal(quake.type, "Earthquake");
    assert.equal(quake.severity, 2); // Green
  } finally {
    restore();
  }
});
