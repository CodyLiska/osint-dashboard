import test from "node:test";
import assert from "node:assert/strict";
import { cached, cachedResilient, cacheSize, clearCache } from "../src/lib/cache.js";

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

test("cachedResilient serves a stale value when the loader fails after expiry", async () => {
  clearCache();
  const r1 = await cachedResilient("r:a", 5, async () => "good");
  assert.equal(r1.value, "good");
  assert.equal(r1.stale, undefined);
  await wait(20); // let it expire
  const r2 = await cachedResilient("r:a", 5, async () => { throw new Error("503"); });
  assert.equal(r2.value, "good"); // stale value served instead of throwing
  assert.equal(r2.stale, true);
});

test("cachedResilient throws when the loader fails and nothing is cached", async () => {
  clearCache();
  await assert.rejects(cachedResilient("r:cold", 5, async () => { throw new Error("503"); }), /503/);
});

test("cachedResilient de-duplicates concurrent loads for the same key", async () => {
  clearCache();
  let calls = 0;
  const load = async () => { calls++; await wait(10); return calls; };
  const [a, b, c] = await Promise.all([
    cachedResilient("r:dup", 60_000, load),
    cachedResilient("r:dup", 60_000, load),
    cachedResilient("r:dup", 60_000, load)
  ]);
  assert.equal(calls, 1); // one shared upstream call
  assert.equal(a.value, 1);
  assert.equal(b.value, 1);
  assert.equal(c.value, 1);
});

test("the cache is bounded — least-recently-used entries are evicted past the cap", async () => {
  clearCache();
  const prev = process.env.OSIRIS_CACHE_MAX_ENTRIES;
  process.env.OSIRIS_CACHE_MAX_ENTRIES = "3";
  try {
    for (const k of ["a", "b", "c"]) await cached(`lru:${k}`, 60_000, async () => k);
    assert.equal(cacheSize(), 3);
    // Touch "a" so it is most-recently-used, then insert "d" — the oldest
    // untouched entry ("b") is evicted, not "a".
    await cached("lru:a", 60_000, async () => "a"); // hit → marks a as MRU
    let reloads = 0;
    await cached("lru:d", 60_000, async () => { reloads++; return "d"; });
    assert.equal(cacheSize(), 3); // still capped
    // "a" survived (served from cache), "b" was evicted (reloads on next call)
    let aReloaded = 0;
    await cached("lru:a", 60_000, async () => { aReloaded++; return "a"; });
    assert.equal(aReloaded, 0, "recently-used entry must survive eviction");
    let bReloaded = 0;
    await cached("lru:b", 60_000, async () => { bReloaded++; return "b"; });
    assert.equal(bReloaded, 1, "least-recently-used entry must have been evicted");
  } finally {
    if (prev === undefined) delete process.env.OSIRIS_CACHE_MAX_ENTRIES;
    else process.env.OSIRIS_CACHE_MAX_ENTRIES = prev;
    clearCache();
  }
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
