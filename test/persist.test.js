import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  applySchema,
  closeDb,
  getChanges,
  getHistory,
  getSnapshotAt,
  hasFired,
  isPersistable,
  openDb,
  persistSnapshot,
  pruneOld,
  recordFired,
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

// ---- classification (Phase 2) ----------------------------------------------

const T0 = "2026-07-20T00:00:00.000Z";
const T1 = "2026-07-20T01:00:00.000Z";
const T2 = "2026-07-20T02:00:00.000Z";

// reconcile returns one flat change list; these pull out a single reason.
const of = (result, reason) => result.changes.filter((c) => c.reason === reason);
const idsOf = (result, reason) => of(result, reason).map((c) => c.entity.id);

// A layer that has already been seeded, so classification is live rather than
// suppressed. Returns the db.
function seeded(db, layer, entities, at = T0) {
  const first = reconcile(db, layer, entities, at);
  assert.equal(first.seeded, true, "the first reconcile of a layer is a seed");
  return db;
}

test("the first reconcile of a layer seeds without reporting anything to alert on", () => {
  // Enabling the store must not page the operator with the entire current feed.
  const db = freshDb();
  const result = reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], T0);
  assert.equal(result.seeded, true);
  assert.deepEqual(result.changes, []);
  // The entities are still stored — seeding suppresses alerting, not persistence.
  assert.equal(rows(db).length, 2);
});

test("a genuinely new entity is reported as appeared once the layer is seeded", () => {
  const db = seeded(freshDb(), "seismic", [{ id: "q1" }]);
  const result = reconcile(db, "seismic", [{ id: "q1" }, { id: "q2", name: "M5 near B" }], T1);
  assert.equal(result.seeded, false);
  assert.deepEqual(idsOf(result, "appeared"), ["q2"]);
});

test("an entity returning after it closed counts as appeared again", () => {
  // It is here now and it was not before, which is the signal a rule wants; the
  // alert_log is what stops it notifying twice.
  const db = seeded(freshDb(), "seismic", [{ id: "q1" }, { id: "q2" }]);
  reconcile(db, "seismic", [{ id: "q1" }], T1); // q2 closes
  const result = reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], T2);
  assert.deepEqual(idsOf(result, "appeared"), ["q2"]);
});

test("escalation is reported only when severity actually rises", () => {
  const db = seeded(freshDb(), "seismic", [
    { id: "up", severity: 2 }, { id: "down", severity: 4 }, { id: "same", severity: 3 }
  ]);
  const result = reconcile(db, "seismic", [
    { id: "up", severity: 5 }, { id: "down", severity: 1 }, { id: "same", severity: 3 }
  ], T1);
  assert.deepEqual(idsOf(result, "escalated"), ["up"]);
});

test("an escalation carries the previous severity so a rule can test the crossing", () => {
  // A rule fires when previous < minSeverity <= current, so the old value has to
  // survive the reconcile that overwrote it.
  const db = seeded(freshDb(), "seismic", [{ id: "q1", severity: 2 }]);
  const result = reconcile(db, "seismic", [{ id: "q1", severity: 5 }], T1);
  const escalated = of(result, "escalated");
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].previousSeverity, 2);
  assert.equal(escalated[0].entity.severity, 5);
});

test("entities dropping out of the feed are reported as closed", () => {
  const db = seeded(freshDb(), "seismic", [{ id: "q1" }, { id: "q2" }]);
  const result = reconcile(db, "seismic", [{ id: "q1" }], T1);
  assert.deepEqual(idsOf(result, "closed"), ["q2"]);
});

test("a layer is seeded independently of other layers", () => {
  // Seeding is per layer, so enabling a new source later does not flood, and an
  // established layer is not re-suppressed by a newcomer.
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1" }], T0);
  const cyberFirst = reconcile(db, "cyber", [{ id: "cve-1" }], T1);
  assert.equal(cyberFirst.seeded, true);
  const seismicNext = reconcile(db, "seismic", [{ id: "q1" }, { id: "q2" }], T2);
  assert.equal(seismicNext.seeded, false);
  assert.deepEqual(idsOf(seismicNext, "appeared"), ["q2"]);
});

// ---- alert dedupe log ------------------------------------------------------

const fired = (db, over = {}) => recordFired(db, {
  ruleId: "taiwan", layer: "seismic", entityId: "q1", reason: "appeared", firedAt: T0, ...over
});

test("a rule fires once per entity and reason, permanently", () => {
  // This is what the DB coupling buys: dedupe that survives restarts, so a
  // long-running event does not re-alert after every deploy.
  const db = freshDb();
  assert.equal(fired(db), true, "first time fires");
  assert.equal(fired(db, { firedAt: T1 }), false, "second time is suppressed");
  assert.equal(hasFired(db, "taiwan", "seismic", "q1", "appeared"), true);
});

test("the same entity can fire for a different rule or a different reason", () => {
  const db = freshDb();
  assert.equal(fired(db), true);
  assert.equal(fired(db, { ruleId: "other-rule" }), true, "a different rule is its own decision");
  assert.equal(fired(db, { reason: "escalated" }), true, "escalation is a distinct event");
});

test("an unfired rule reports as not fired", () => {
  assert.equal(hasFired(freshDb(), "nope", "seismic", "q1", "appeared"), false);
});

test("pruning ages out alert history, re-arming the rule", () => {
  // After the retention window the event is no longer part of the recent
  // picture, so it is allowed to alert again if it recurs.
  const db = freshDb();
  const now = Date.parse(T2);
  const old = new Date(now - 120 * 86_400_000).toISOString();
  assert.equal(fired(db, { firedAt: old }), true);
  pruneOld(db, 90, now);
  assert.equal(hasFired(db, "taiwan", "seismic", "q1", "appeared"), false);
  assert.equal(fired(db, { firedAt: T2 }), true, "re-armed after the retention window");
});

test("a failed reconcile reports nothing and stores nothing", () => {
  // Classification is returned only after the COMMIT, so a rolled-back batch
  // must not tell the alert engine about changes that were never stored.
  const db = seeded(freshDb(), "seismic", [{ id: "q1", severity: 2 }]);
  const circular = { id: "bad", severity: 5 };
  circular.self = circular; // JSON.stringify throws inside the transaction

  assert.throws(() => reconcile(db, "seismic", [{ id: "q2" }, circular], T1));

  // The partial batch was rolled back: q2 was never added, q1 untouched.
  const stored = rows(db, "SELECT entity_id, status FROM entity_events WHERE layer = 'seismic'");
  assert.deepEqual(stored.map((r) => r.entity_id), ["q1"]);
  assert.equal(stored[0].status, "active");
});

test("a closed change carries the rebuilt entity, not a bare id", () => {
  // The entity is gone from the incoming batch, so it has to come back out of
  // the stored payload — otherwise a consumer can only report "something ended".
  const db = seeded(freshDb(), "seismic", [
    { id: "q1" },
    { id: "q2", name: "M5.2 near Hualien", severity: 4, lat: 23.9, lon: 121.5 }
  ]);
  const result = reconcile(db, "seismic", [{ id: "q1" }], T1);
  const [closed] = of(result, "closed");
  assert.equal(closed.entity.id, "q2");
  assert.equal(closed.entity.name, "M5.2 near Hualien");
  assert.equal(closed.entity.severity, 4);
  assert.equal(closed.entity.lat, 23.9);
});

test("every change carries a reason, so the alert log can key on it", () => {
  // reason maps onto alert_log's primary key; a change without one could not be
  // deduplicated.
  const db = seeded(freshDb(), "seismic", [{ id: "a", severity: 2 }, { id: "b" }]);
  const result = reconcile(db, "seismic", [{ id: "a", severity: 5 }, { id: "c" }], T1);
  const reasons = result.changes.map((c) => c.reason).sort();
  assert.deepEqual(reasons, ["appeared", "closed", "escalated"]);
  assert.ok(result.changes.every((c) => c.entity && c.entity.id), "each change carries an entity");
});

// ---- Phase 5: observations + point-in-time replay --------------------------

const observations = (db) =>
  db.prepare("SELECT * FROM entity_observations ORDER BY observed_at").all();

test("reconcile appends an observation only when state is new or changed", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1", severity: 3, lat: 1, lon: 2 }], "2026-07-19T00:00:00.000Z");
  assert.equal(observations(db).length, 1, "baseline observation on first appearance");

  reconcile(db, "seismic", [{ id: "q1", severity: 3, lat: 1, lon: 2 }], "2026-07-19T01:00:00.000Z");
  assert.equal(observations(db).length, 1, "unchanged state adds nothing");

  reconcile(db, "seismic", [{ id: "q1", severity: 5, lat: 1, lon: 2 }], "2026-07-19T02:00:00.000Z");
  assert.equal(observations(db).length, 2, "severity change appends an observation");

  reconcile(db, "seismic", [{ id: "q1", severity: 5, lat: 9, lon: 2 }], "2026-07-19T03:00:00.000Z");
  assert.equal(observations(db).length, 3, "position change appends an observation");
});

test("getSnapshotAt reconstructs a layer as of a past instant", () => {
  const db = openDb(":memory:");
  try {
    reconcile(db, "seismic", [{ id: "q1", severity: 3, lat: 1, lon: 2, name: "M3" }], "2026-07-19T00:00:00.000Z");
    reconcile(db, "seismic", [
      { id: "q1", severity: 6, lat: 1, lon: 2, name: "M6" },
      { id: "q2", severity: 4, lat: 3, lon: 4, name: "M4" }
    ], "2026-07-19T02:00:00.000Z");

    // At 01:00 only q1 existed, and it was still M3 (pre-escalation).
    const early = getSnapshotAt("seismic", "2026-07-19T01:00:00.000Z");
    assert.equal(early.enabled, true);
    assert.deepEqual(early.entities.map((e) => e.id), ["q1"]);
    assert.equal(early.entities[0].severity, 3);
    assert.equal(early.entities[0].name, "M3");

    // At 02:30 q1 has escalated to M6 and q2 has appeared.
    const late = getSnapshotAt("seismic", "2026-07-19T02:30:00.000Z");
    assert.equal(late.entities.length, 2);
    assert.equal(late.entities.find((e) => e.id === "q1").severity, 6);
  } finally {
    closeDb();
  }
});

test("getSnapshotAt excludes events that had already closed at the instant", () => {
  const db = openDb(":memory:");
  try {
    reconcile(db, "seismic", [
      { id: "q1", severity: 3, lat: 1, lon: 2 },
      { id: "q2", severity: 3, lat: 3, lon: 4 }
    ], "2026-07-19T00:00:00.000Z");
    reconcile(db, "seismic", [{ id: "q1", severity: 3, lat: 1, lon: 2 }], "2026-07-19T02:00:00.000Z"); // q2 closes

    // At 01:00 both were present; at 03:00 only q1 remains.
    assert.deepEqual(getSnapshotAt("seismic", "2026-07-19T01:00:00.000Z").entities.map((e) => e.id).sort(), ["q1", "q2"]);
    assert.deepEqual(getSnapshotAt("seismic", "2026-07-19T03:00:00.000Z").entities.map((e) => e.id), ["q1"]);
  } finally {
    closeDb();
  }
});

test("getSnapshotAt returns the disabled shape when persistence is off", () => {
  closeDb();
  assert.deepEqual(getSnapshotAt("seismic", "2026-07-19T00:00:00.000Z"), { enabled: false });
});

test("pruneOld drops observations older than the retention window", () => {
  const db = freshDb();
  reconcile(db, "seismic", [{ id: "q1", severity: 3 }], "2020-01-01T00:00:00.000Z"); // ancient baseline
  reconcile(db, "seismic", [{ id: "q1", severity: 9 }], new Date().toISOString());    // recent change
  assert.equal(observations(db).length, 2);
  pruneOld(db, 90);
  assert.equal(observations(db).length, 1, "only the in-window observation survives");
});
