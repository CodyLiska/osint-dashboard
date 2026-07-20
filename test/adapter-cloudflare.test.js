import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { cloudflareRadarLayer } from "../src/adapters/cloudflare.js";

test("cloudflareRadarLayer is empty and flagged not-configured without a token", async () => {
  const prev = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  const restore = installJsonFetch({});
  try {
    const { entities, meta } = await cloudflareRadarLayer();
    assert.deepEqual(entities, []);
    assert.equal(meta.configured, false);
    assert.match(meta.message, /CLOUDFLARE_API_TOKEN/);
  } finally {
    restore();
    if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev;
  }
});

test("cloudflareRadarLayer maps outage annotations to centroids when keyed", async () => {
  const prev = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const restore = installJsonFetch({
    result: {
      annotations: [
        { id: "a1", locations: ["UA"], locationsDetails: [{ name: "Ukraine" }], startDate: "2026-07-19T00:00:00Z", description: "Regional outage", outage: { outageCause: "GOVERNMENT_DIRECTED" }, asns: [15895] },
        { id: "a2", locations: ["ZZ"], startDate: "2026-07-18T00:00:00Z" } // unknown country → dropped
      ]
    }
  });
  try {
    const { entities, meta } = await cloudflareRadarLayer();
    assert.equal(meta.configured, true);
    assert.equal(entities.length, 1);
    const ua = entities[0];
    assert.equal(ua.id, "cf-outage-a1");
    assert.equal(ua.severity, 5); // government-directed
    assert.equal(ua.cause, "GOVERNMENT_DIRECTED");
    assert.ok(Number.isFinite(ua.lat) && Number.isFinite(ua.lon));
  } finally {
    restore();
    if (prev === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = prev;
  }
});
