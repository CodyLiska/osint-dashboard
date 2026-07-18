import test from "node:test";
import assert from "node:assert/strict";
import { markSource, withHealth, getHealth } from "../src/lib/health.js";

// No SLACK_WEBHOOK_URL is set here, so the alerting hooks in withHealth are
// silent no-ops and these tests exercise only the health telemetry.

test("markSource defaults status to ok and merges patches", () => {
  const s = markSource("unit-a", { source: "Test", count: 3 });
  assert.equal(s.id, "unit-a");
  assert.equal(s.status, "ok");
  assert.equal(s.source, "Test");
  assert.equal(s.count, 3);
  assert.ok(s.lastChecked);
});

test("withHealth marks a source ok and records entity count on success", async () => {
  const result = await withHealth("unit-ok", "Src", async () => ({ entities: [1, 2], meta: { cached: true } }));
  assert.deepEqual(result.entities, [1, 2]);
  const row = getHealth().find((r) => r.id === "unit-ok");
  assert.equal(row.status, "ok");
  assert.equal(row.count, 2);
  assert.equal(row.cached, true);
  assert.equal(row.error, null);
  assert.ok(row.lastSuccess);
});

test("withHealth marks a source error and rethrows on failure", async () => {
  await assert.rejects(
    withHealth("unit-bad", "Src", async () => { throw new Error("boom"); }),
    /boom/
  );
  const row = getHealth().find((r) => r.id === "unit-bad");
  assert.equal(row.status, "error");
  assert.equal(row.error, "boom");
});

test("getHealth returns entries sorted by id", () => {
  markSource("zzz-last", { source: "z" });
  markSource("aaa-first", { source: "a" });
  const ids = getHealth().map((r) => r.id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(ids, sorted);
});
