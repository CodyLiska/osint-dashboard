import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { ucdpLayer } from "../src/adapters/ucdp.js";

test("ucdpLayer is empty and flagged not-configured without a token", async () => {
  const prev = process.env.UCDP_ACCESS_TOKEN;
  delete process.env.UCDP_ACCESS_TOKEN;
  const restore = installJsonFetch({});
  try {
    const { entities, meta } = await ucdpLayer();
    assert.deepEqual(entities, []);
    assert.equal(meta.configured, false);
    assert.match(meta.message, /UCDP_ACCESS_TOKEN/);
  } finally {
    restore();
    if (prev !== undefined) process.env.UCDP_ACCESS_TOKEN = prev;
  }
});

test("ucdpLayer maps GED events with actors and deaths-based severity when keyed", async () => {
  const prev = process.env.UCDP_ACCESS_TOKEN;
  process.env.UCDP_ACCESS_TOKEN = "test-token";
  const restore = installJsonFetch({
    Result: [
      { id: 111, type_of_violence: 1, side_a: "Government of X", side_b: "Rebel Group Y", country: "X", latitude: 12.3, longitude: 45.6, best: 130, date_start: "2026-06-01T00:00:00" },
      { id: 222, type_of_violence: 3, side_a: "Militia Z", side_b: "Civilians", country: "Q", latitude: -1.0, longitude: 2.0, best: 3, date_start: "2026-06-15T00:00:00" },
      { id: 333, type_of_violence: 2, side_a: "A", side_b: "B", country: "R", latitude: "not-a-number", longitude: 5, best: 0 } // no coords → dropped
    ]
  });
  try {
    const { entities, meta } = await ucdpLayer();
    assert.equal(meta.configured, true);
    assert.equal(entities.length, 2);

    const big = entities.find((e) => e.id === "ucdp-111");
    assert.equal(big.type, "State-based conflict");
    assert.equal(big.name, "Government of X vs Rebel Group Y");
    assert.equal(big.severity, 5); // 130 deaths
    assert.equal(big.lat, 12.3);

    const small = entities.find((e) => e.id === "ucdp-222");
    assert.equal(small.type, "One-sided violence");
    assert.equal(small.severity, 2); // 3 deaths
  } finally {
    restore();
    if (prev === undefined) delete process.env.UCDP_ACCESS_TOKEN; else process.env.UCDP_ACCESS_TOKEN = prev;
  }
});
