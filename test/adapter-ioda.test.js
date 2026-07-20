import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { iodaLayer } from "../src/adapters/ioda.js";

const country = (cc, name, time, level) => ({
  entity: { type: "country", name, attrs: { country_code: cc } }, time, level, datasource: "bgp"
});

test("iodaLayer maps country-level critical outages to centroids", async () => {
  const restore = installJsonFetch({
    data: [
      country("UA", "Ukraine", 1000, "critical"),   // in outage → mapped
      country("US", "United States", 2000, "normal"), // recovered → excluded
      { entity: { type: "asn", name: "AS123" }, time: 3000, level: "critical" } // not a country → excluded
    ]
  });
  try {
    const { entities, meta } = await iodaLayer();
    assert.match(meta.source, /IODA/);
    assert.equal(entities.length, 1);
    const ua = entities[0];
    assert.equal(ua.id, "ioda-UA");
    assert.equal(ua.type, "Internet outage");
    assert.equal(ua.severity, 5);
    assert.ok(Number.isFinite(ua.lat) && Number.isFinite(ua.lon), "geolocated to the UA centroid");
    assert.match(ua.name, /Ukraine/);
  } finally {
    restore();
  }
});

test("iodaLayer uses the latest alert per country (a later 'normal' clears an outage)", async () => {
  const restore = installJsonFetch({
    data: [
      country("UA", "Ukraine", 1000, "critical"),
      country("UA", "Ukraine", 5000, "normal") // more recent → Ukraine has recovered
    ]
  });
  try {
    const { entities } = await iodaLayer();
    assert.equal(entities.length, 0);
  } finally {
    restore();
  }
});
