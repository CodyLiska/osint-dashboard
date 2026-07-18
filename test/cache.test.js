import test from "node:test";
import assert from "node:assert/strict";
import { cached, clearCache } from "../src/lib/cache.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("first call misses and runs the loader", async () => {
  clearCache("t:");
  let calls = 0;
  const r = await cached("t:a", 60_000, async () => { calls++; return 42; });
  assert.equal(r.value, 42);
  assert.equal(r.cached, false);
  assert.equal(calls, 1);
});

test("second call within TTL is served from cache without re-running the loader", async () => {
  clearCache("t:");
  let calls = 0;
  const load = async () => { calls++; return { n: calls }; };
  const first = await cached("t:b", 60_000, load);
  const second = await cached("t:b", 60_000, load);
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.deepEqual(second.value, first.value);
  assert.ok(second.ageMs >= 0);
});

test("entry expires after its TTL and reloads", async () => {
  clearCache("t:");
  let calls = 0;
  const load = async () => { calls++; return calls; };
  await cached("t:c", 5, load);
  await wait(20);
  const r = await cached("t:c", 5, load);
  assert.equal(calls, 2);
  assert.equal(r.cached, false);
});

test("clearCache(prefix) removes only matching keys", async () => {
  clearCache();
  let calls = 0;
  const load = async () => { calls++; return calls; };
  await cached("keep:1", 60_000, load);
  await cached("drop:1", 60_000, load);
  clearCache("drop:");
  const keep = await cached("keep:1", 60_000, load); // still cached
  const drop = await cached("drop:1", 60_000, load); // reloaded
  assert.equal(keep.cached, true);
  assert.equal(drop.cached, false);
});
