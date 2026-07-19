import test from "node:test";
import assert from "node:assert/strict";
import { maritimeLayer } from "../src/adapters/maritime.js";

// The live path is a WebSocket to AISStream (not HTTP, deliberately un-mocked).
// The keyless fallback — the common case in this LAN homelab deploy — is testable.
test("maritimeLayer serves the static port fallback without an AISStream key", async () => {
  const saved = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  try {
    const { entities, meta } = await maritimeLayer();
    assert.equal(meta.configured, false);
    assert.equal(meta.source, "Static port directory");
    assert.equal(meta.count, entities.length);
    assert.ok(entities.length >= 30, "a useful set of global ports is returned");
    assert.ok(entities.every((e) => e.layer === "maritime" && Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    assert.ok(entities.some((e) => e.name === "Singapore"));
  } finally {
    if (saved === undefined) delete process.env.AISSTREAM_API_KEY; else process.env.AISSTREAM_API_KEY = saved;
  }
});
