import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  applySchema,
  closeDb,
  getChanges,
  getHistory,
  isPersistable,
  openDb,
  persistSnapshot,
  pruneOld,
  reconcile
} from "../src/lib/persist.js";

function freshDb() {
  return applySchema(new DatabaseSync(":memory:"));
}

const rows = (db, sql = "SELECT * FROM entity_events ORDER BY entity_id") =>
  db.prepare(sql).all();

test("isPersistable honors the default allowlist", () => {
  assert.equal(isPersistable("seismic"), true);
  assert.equal(isPersistable("telegram"), true);
  assert.equal(isPersistable("aviation"), false); // kinematic, excluded
  assert.equal(isPersistable("ports"), false); // static, excluded
});

test("isPersistable honors an OSIRIS_PERSIST_LAYERS override", () => {
  const prev = process.env.OSIRIS_PERSIST_LAYERS;
  process.env.OSIRIS_PERSIST_LAYERS = "seismic, cyber";
  try {
    assert.equal(isPersistable("seismic"), true);
    assert.equal(isPersistable("cyber"), true);
    assert.equal(isPersistable("telegram"), false); // not in the override
  } finally {
    if (prev === undefined) delete process.env.OSIRIS_PERSIST_LAYERS;
    else process.env.OSIRIS_PERSIST_LAYERS = prev;
  }
});

test("reconcile inserts new events with first_seen = last_seen = now", () => {
  const db = freshDb();
  reconcile(db, "seismic", [
    { id: "q1", severity: 3, lat: 10.5, lon: -20.1, name: "M3 near A", source: "USGS" },
    { id: "q2", severity: 5, lat: 1, lon: 2, name: "M5 near B", source: "USGS" }
  ], "2026-07-19T00:00:00.000Z");

  const all = rows(db);
  assert.equal(all.length, 2);
  const q1 = all.find((r) => r.entity_id === "q1");
  assert.equal(q1.first_seen, "2026-07-19T00:00:00.000Z");
  assert.equal(q1.last_seen, "2026-07-19T00:00:00.000Z");
  assert.equal(q1.status, "active");
  assert.equal(q1.closed_at, null);
  assert.equal(q1.severity, 3);
  assert.equal(q1.lat, 10.5);
  assert.equal(q1.lon, -20.1);
  assert.equal(q1.name, "M3 near A");
  assert.equal(JSON.parse(q1.payload).id, "q1"); // full entity kept for detail rebuild
});

test("reconcile advances last_seen but preserves first_seen for a returning event", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1", severity: 3 }], "2026-07-19T00:00:00.000Z");
  reconcile(db, "seismic", [{ id: "q1", severity: 4 }], "2026-07-19T01:00:00.000Z");

  const [q1] = rows(db);
  assert.equal(q1.first_seen, "2026-07-19T00:00:00.000Z"); // unchanged
  assert.equal(q1.last_seen, "2026-07-19T01:00:00.000Z"); // advanced
  assert.equal(q1.severity, 4); // mutable field refreshed
  assert.equal(q1.status, "active");
});

test("reconcile closes absentees not present in the batch", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], "2026-07-19T00:00:00.000Z");
  // q2 drops out of the feed
  reconcile(db, "seismic", [{ id: "q1" }], "2026-07-19T01:00:00.000Z");

  const q2 = rows(db).find((r) => r.entity_id === "q2");
  assert.equal(q2.status, "closed");
  assert.equal(q2.closed_at, "2026-07-19T01:00:00.000Z");
  assert.equal(q2.last_seen, "2026-07-19T00:00:00.000Z"); // frozen at last observation
});

test("reconcile reopens a previously closed event that returns to the feed", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], "2026-07-19T00:00:00.000Z");
  reconcile(db, "seismic", [{ id: "q1" }], "2026-07-19T01:00:00.000Z"); // q2 closes
  reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], "2026-07-19T02:00:00.000Z"); // q2 back

  const q2 = rows(db).find((r) => r.entity_id === "q2");
  assert.equal(q2.status, "active");
  assert.equal(q2.closed_at, null);
  assert.equal(q2.first_seen, "2026-07-19T00:00:00.000Z"); // identity preserved across the gap
  assert.equal(q2.last_seen, "2026-07-19T02:00:00.000Z");
});

test("reconcile isolates layers — an absent event in one layer never closes another's", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "x" }], "2026-07-19T00:00:00.000Z");
  reconcile(db, "cyber", [{ id: "cve-1" }], "2026-07-19T01:00:00.000Z");
  // a later seismic batch must not touch the cyber row
  reconcile(db, "seismic", [{ id: "x" }], "2026-07-19T02:00:00.000Z");

  const cyber = rows(db).find((r) => r.entity_id === "cve-1");
  assert.equal(cyber.status, "active");
});

test("reconcile skips entities with no id and tolerates an empty batch", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1" }, { severity: 2 }, null], "2026-07-19T00:00:00.000Z");
  assert.equal(rows(db).length, 1);
  // empty batch closes the survivor rather than throwing
  reconcile(db, "seismic", [], "2026-07-19T01:00:00.000Z");
  assert.equal(rows(db)[0].status, "closed");
});

test("pruneOld deletes only closed rows older than the retention window", () => {
  const db = freshDb();
  const now = Date.parse("2026-07-19T00:00:00.000Z");
  const daysAgo = (d) => new Date(now - d * 86_400_000).toISOString();

  // an active-but-ancient row (never pruned) and two closed rows of different ages
  reconcile(db, "seismic", [{ id: "active-old" }], daysAgo(200));
  db.prepare(
    `INSERT INTO entity_events (layer, entity_id, first_seen, last_seen, status, closed_at)
     VALUES ('seismic','closed-old', ?, ?, 'closed', ?)`
  ).run(daysAgo(200), daysAgo(120), daysAgo(120));
  db.prepare(
    `INSERT INTO entity_events (layer, entity_id, first_seen, last_seen, status, closed_at)
     VALUES ('seismic','closed-recent', ?, ?, 'closed', ?)`
  ).run(daysAgo(30), daysAgo(10), daysAgo(10));

  const removed = pruneOld(db, 90, now);
  assert.equal(removed, 1); // only closed-old
  const ids = rows(db).map((r) => r.entity_id);
  assert.deepEqual(ids, ["active-old", "closed-recent"]);
});

// ---- Read API (Phase 2) ----------------------------------------------------
// These exercise the module singleton, so each opens an in-memory DB and closes
// it in a finally to leave persistence disabled for the next test.

test("getChanges/getHistory return the disabled shape when no DB is open", () => {
  closeDb(); // ensure disabled
  assert.deepEqual(getChanges("2026-07-19T00:00:00.000Z"), { enabled: false });
  assert.deepEqual(getHistory("seismic", {}), { enabled: false });
});

test("getChanges partitions added (first_seen>since) from closed (closed_at>since)", () => {
  const db = openDb(":memory:");
  try {
    // t0: q1, q2 appear
    reconcile(db, "seismic", [{ id: "q1", name: "A" }, { id: "q2", name: "B" }], "2026-07-19T00:00:00.000Z");
    // t1: q3 appears, q2 drops (closes)
    reconcile(db, "seismic", [{ id: "q1" }, { id: "q3", name: "C" }], "2026-07-19T02:00:00.000Z");

    const changes = getChanges("2026-07-19T01:00:00.000Z");
    assert.equal(changes.enabled, true);
    assert.equal(changes.since, "2026-07-19T01:00:00.000Z");
    // only q3 first appeared after the cutoff (q1/q2 first_seen at t0)
    assert.deepEqual(changes.added.map((c) => c.id), ["q3"]);
    // only q2 closed after the cutoff
    assert.deepEqual(changes.closed.map((c) => c.id), ["q2"]);
    assert.equal(changes.closed[0].status, "closed");
    assert.equal(changes.added[0].entity.name, "C"); // full entity rebuilt from payload
  } finally {
    closeDb();
  }
});

test("getHistory returns events whose lifespan overlaps the window", () => {
  const db = openDb(":memory:");
  try {
    reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], "2026-07-19T00:00:00.000Z");
    reconcile(db, "seismic", [{ id: "q1" }], "2026-07-19T02:00:00.000Z"); // q2 closes at t2

    // window entirely before q2 closed → both active in it
    const early = getHistory("seismic", { since: "2026-07-19T00:00:00.000Z", until: "2026-07-19T01:00:00.000Z" });
    assert.deepEqual(early.events.map((e) => e.id).sort(), ["q1", "q2"]);

    // window entirely after q2 closed → only q1 (still open) overlaps
    const late = getHistory("seismic", { since: "2026-07-19T03:00:00.000Z", until: "2026-07-19T04:00:00.000Z" });
    assert.deepEqual(late.events.map((e) => e.id), ["q1"]);

    // a different layer has no events in the window
    assert.deepEqual(getHistory("cyber", {}).events, []);
  } finally {
    closeDb();
  }
});

test("switching off a keyed source does not close its recorded history", () => {
  // An optional-keyed layer with no key returns an empty snapshot. Reconciling
  // that would close every stored record and report the whole layer as
  // "Dropped" in the what-changed panel — the source going dark is not the same
  // as its disasters having ended.
  const db = openDb(":memory:");
  try {
    persistSnapshot("reliefweb", [{ id: "d1", name: "Sudan Floods" }], { configured: true });
    persistSnapshot("reliefweb", [], { configured: false });

    const stored = rows(db, "SELECT status FROM entity_events WHERE layer = 'reliefweb'");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "active", "history must survive the source being switched off");
  } finally {
    closeDb();
  }
});

test("the off-source guard does not block a source that is switched on", () => {
  // The guard keys on configured === false only; a configured source (or one
  // whose adapter reports no meta at all) must still be recorded, or enabling a
  // key would silently stop writing history.
  const db = openDb(":memory:");
  try {
    persistSnapshot("reliefweb", [{ id: "d1", name: "Sudan Floods" }], { configured: true });
    persistSnapshot("cyber", [{ id: "cve-1" }], undefined);

    const stored = rows(db, "SELECT layer FROM entity_events ORDER BY layer");
    assert.deepEqual(stored.map((r) => r.layer), ["cyber", "reliefweb"]);
  } finally {
    closeDb();
  }
});
