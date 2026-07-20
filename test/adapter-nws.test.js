import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { nwsAlertsLayer } from "../src/adapters/nws.js";

const feed = {
  type: "FeatureCollection",
  features: [
    {
      geometry: { type: "Polygon", coordinates: [[[-100, 40], [-100, 42], [-98, 42], [-98, 40], [-100, 40]]] },
      properties: {
        id: "urn:oid:alert-1", event: "Tornado Warning", severity: "Extreme", urgency: "Immediate",
        headline: "Tornado Warning issued", areaDesc: "Some County, KS", effective: "2026-07-20T00:00:00-05:00",
        "@id": "https://api.weather.gov/alerts/alert-1"
      }
    },
    // zone-referenced alert with null geometry → skipped (no polygon to draw)
    { geometry: null, properties: { id: "alert-2", event: "Heat Advisory", severity: "Minor" } }
  ]
};

test("nwsAlertsLayer keeps polygon alerts, attaches the polygon, and centroids them", async () => {
  const restore = installJsonFetch(feed);
  try {
    const { entities, meta } = await nwsAlertsLayer();
    assert.equal(entities.length, 1); // the null-geometry alert is dropped
    assert.match(meta.source, /NWS/);

    const alert = entities[0];
    assert.equal(alert.layer, "nws");
    assert.equal(alert.type, "Tornado Warning");
    assert.equal(alert.severity, 5); // Extreme
    assert.ok(Array.isArray(alert.polygon), "the warning polygon is attached for the map");
    assert.equal(alert.polygon[0].length, 5); // ring vertices
    // centroid of the ring
    assert.ok(Math.abs(alert.lat - 40.8) < 0.5 && Math.abs(alert.lon - -99.2) < 0.5, `centroid ${alert.lat},${alert.lon}`);
    assert.match(alert.summary, /Some County/);
    assert.equal(alert.url, "https://api.weather.gov/alerts/alert-1");
  } finally {
    restore();
  }
});

test("nwsAlertsLayer honors the max cap", async () => {
  const many = { features: Array.from({ length: 10 }, (_, i) => ({
    geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    properties: { id: `a${i}`, event: "Flood Warning", severity: "Severe" }
  })) };
  const restore = installJsonFetch(many);
  try {
    const { entities } = await nwsAlertsLayer(3);
    assert.equal(entities.length, 3);
  } finally {
    restore();
  }
});
