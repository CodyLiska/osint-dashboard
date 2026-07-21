import { DatabaseSync } from "node:sqlite";
import { persistableIds } from "../adapters/layers.js";

// Optional historical persistence for OSIRIS. Fully off unless OSIRIS_DB_PATH is
// set — with it unset, every export here is a no-op and the app behaves exactly
// as it did before. The set of persisted layers is declared once, on the layer
// registry (src/adapters/layers.js `persist` flag): only live, event-shaped,
// stable-id, low-volume layers; kinematic (aviation/maritime) and static
// (ports/cctv) layers are deliberately excluded. See docs/PLAN-persistence.md.

const DEFAULT_LAYERS = persistableIds().join(",");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entity_events (
  layer      TEXT    NOT NULL,
  entity_id  TEXT    NOT NULL,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'active',
  closed_at  TEXT,
  severity   INTEGER,
  lat        REAL,
  lon        REAL,
  name       TEXT,
  source     TEXT,
  payload    TEXT,
  PRIMARY KEY (layer, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_events_last_seen    ON entity_events(last_seen);
CREATE INDEX IF NOT EXISTS idx_events_first_seen   ON entity_events(first_seen);
CREATE INDEX IF NOT EXISTS idx_events_layer_status ON entity_events(layer, status);

-- One row per (rule, entity, reason) that has ever fired. This is what makes an
-- entity alert exactly once per rule, permanently, across restarts — the whole
-- reason the alert engine is coupled to the store. Doubles as the audit trail
-- behind the Alerts panel ("why was I paged at 3am").
CREATE TABLE IF NOT EXISTS alert_log (
  rule_id    TEXT    NOT NULL,
  layer      TEXT    NOT NULL,
  entity_id  TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  fired_at   TEXT    NOT NULL,
  severity   INTEGER,
  name       TEXT,
  payload    TEXT,
  PRIMARY KEY (rule_id, layer, entity_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_alert_log_fired ON alert_log(fired_at);
`;

// The server's singleton handle. Stays null when persistence is disabled so the
// fire-and-forget hook is a cheap no-op. Tests operate on their own handles via
// the exported reconcile()/pruneOld() (which take an explicit db).
let db = null;

export function isPersistable(layer) {
  const list = (process.env.OSIRIS_PERSIST_LAYERS || DEFAULT_LAYERS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(layer);
}

// Create the schema on a fresh or existing handle. Idempotent (all IF NOT EXISTS).
export function applySchema(handle) {
  handle.exec(SCHEMA);
  return handle;
}

// Open (or reuse) the singleton store. Returns null when OSIRIS_DB_PATH is unset
// — the caller treats null as "persistence disabled". Safe to call on every start.
export function openDb(dbPath = process.env.OSIRIS_DB_PATH) {
  if (!dbPath) {
    db = null;
    return null;
  }
  db = applySchema(new DatabaseSync(dbPath));
  return db;
}

// The singleton handle, for callers that need to pass it to a handle-taking
// function (the alert engine). Null when persistence is disabled.
export function getDb() {
  return db;
}

const toInt = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const toNum = (v) => (Number.isFinite(v) ? v : null);

// The reconcile transaction: upsert every entity in the snapshot (new rows get
// first_seen=now; existing rows advance last_seen and refresh mutable fields),
// then close any row for this layer not touched this batch. Runs against an
// explicit handle so it is directly unit-testable on an in-memory db.
// Rebuild stored entities from their payload. Used for closed events, which are
// no longer in the incoming batch but still need a real entity (name, position)
// rather than a bare id.
function storedEntities(handle, layer, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return handle
    .prepare(`SELECT entity_id, payload FROM entity_events WHERE layer = ? AND entity_id IN (${placeholders})`)
    .all(layer, ...ids)
    .map((row) => {
      try {
        return JSON.parse(row.payload);
      } catch {
        // A row written before payload existed, or corrupted JSON: fall back to
        // the id so the caller still learns the event closed.
        return { id: row.entity_id, layer };
      }
    });
}

// Returns what changed, so the alert engine can act on it without re-deriving
// state: { changes: [{ reason, entity, previousSeverity? }], seeded }.
//
// One element type for every reason, because the consumer loops over changes and
// records (rule, entity, reason) — which is exactly alert_log's primary key.
// Classification is computed from the pre-transaction state and returned only
// after the COMMIT, so a rolled-back write never reports changes that were not
// stored.
export function reconcile(handle, layer, entities, now = new Date().toISOString()) {
  // Prior ACTIVE state for this layer, used to tell new from returning from
  // escalating. Indexed by idx_events_layer_status.
  const priorRows = handle
    .prepare(`SELECT entity_id, severity FROM entity_events WHERE layer = ? AND status = 'active'`)
    .all(layer);
  const prior = new Map(priorRows.map((row) => [row.entity_id, row.severity]));

  // "Cold" means this layer has never been reconciled — not merely that nothing
  // is active. On a first run every entity looks new, so alerting on that batch
  // would page the operator with the entire feed the moment the store is
  // enabled. The batch is stored, then reported as a seed with nothing to alert.
  const cold = !handle.prepare(`SELECT 1 FROM entity_events WHERE layer = ? LIMIT 1`).get(layer);

  const changes = [];
  const present = new Set();
  for (const e of entities || []) {
    if (!e || e.id == null) continue;
    const id = String(e.id);
    present.add(id);
    if (!prior.has(id)) {
      // New, or returning after having been closed. Both are "it is here now
      // and it was not before", which is the signal a rule wants; the alert_log
      // keeps a returning entity from alerting twice for the same rule.
      changes.push({ reason: "appeared", entity: e });
      continue;
    }
    const previousSeverity = prior.get(id);
    const severity = toInt(e.severity);
    if (Number.isFinite(severity) && Number.isFinite(previousSeverity) && severity > previousSeverity) {
      changes.push({ reason: "escalated", entity: e, previousSeverity });
    }
  }
  const closedIds = priorRows
    .filter((row) => !present.has(row.entity_id))
    .map((row) => row.entity_id);

  const upsert = handle.prepare(`
    INSERT INTO entity_events
      (layer, entity_id, first_seen, last_seen, status, closed_at, severity, lat, lon, name, source, payload)
    VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(layer, entity_id) DO UPDATE SET
      last_seen = excluded.last_seen,
      status    = 'active',
      closed_at = NULL,
      severity  = excluded.severity,
      lat       = excluded.lat,
      lon       = excluded.lon,
      name      = excluded.name,
      source    = excluded.source,
      payload   = excluded.payload
  `);
  const close = handle.prepare(`
    UPDATE entity_events SET status = 'closed', closed_at = ?
    WHERE layer = ? AND status = 'active' AND last_seen <> ?
  `);

  handle.exec("BEGIN");
  try {
    for (const e of entities || []) {
      if (!e || e.id == null) continue;
      upsert.run(
        layer,
        String(e.id),
        now,
        now,
        toInt(e.severity),
        toNum(e.lat),
        toNum(e.lon),
        e.name ?? null,
        e.source ?? null,
        JSON.stringify(e)
      );
    }
    close.run(now, layer, now);
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }

  // A cold layer has no prior rows, so nothing can have closed either.
  if (cold) return { changes: [], seeded: true };

  for (const entity of storedEntities(handle, layer, closedIds)) {
    changes.push({ reason: "closed", entity });
  }
  return { changes, seeded: false };
}

// Delete closed events whose closed_at is older than the retention window. Active
// rows are never pruned. Returns the number of rows removed.
export function pruneOld(handle, retentionDays = 90, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  const removed = handle
    .prepare(`DELETE FROM entity_events WHERE status = 'closed' AND closed_at < ?`)
    .run(cutoff).changes;
  // Alert history ages out on the same window. Dropping a row re-arms that
  // (rule, entity, reason), which is intended: after the retention period the
  // event is no longer part of the recent picture.
  handle.prepare(`DELETE FROM alert_log WHERE fired_at < ?`).run(cutoff);
  return removed;
}

// Server-facing fire-and-forget write. No-op when persistence is disabled or the
// layer is not in the allowlist. Synchronous (node:sqlite is sync) — callers wrap
// it in try/catch AFTER sending the response so it can never delay or break one.
// Returns the reconcile classification so the caller can feed the alert engine,
// or null when nothing was written (persistence off, layer not persistable, or
// the source is switched off).
export function persistSnapshot(layer, entities, meta) {
  if (!db || !isPersistable(layer)) return null;
  // An optional-keyed source with no key returns an empty snapshot. Reconciling
  // that would close-absentee the layer's entire history and report every record
  // as "Dropped" — the source being switched off is not the same as its events
  // having ended. Skip the write and leave the existing history intact.
  if (meta?.configured === false) return null;
  return reconcile(db, layer, entities);
}

// ---- Alert dedupe log ------------------------------------------------------

// Record that a rule fired for an entity. Returns true only if this is the
// first time for that (rule, entity, reason) — the insert itself is the dedupe,
// so there is no check-then-write gap. Callers notify only on true.
export function recordFired(handle, { ruleId, layer, entityId, reason, firedAt = new Date().toISOString(), severity = null, name = null, payload = null }) {
  const result = handle.prepare(`
    INSERT OR IGNORE INTO alert_log
      (rule_id, layer, entity_id, reason, fired_at, severity, name, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ruleId, layer, String(entityId), reason, firedAt, toInt(severity), name, payload);
  return result.changes > 0;
}

// How many times a rule has fired since a timestamp. Backs the per-rule flood
// guard, so one pathologically broad rule degrades to a summary line instead of
// emptying itself into the channel.
export function firedSince(handle, ruleId, sinceIso) {
  return handle
    .prepare(`SELECT COUNT(*) AS n FROM alert_log WHERE rule_id = ? AND fired_at >= ?`)
    .get(ruleId, sinceIso).n;
}

// Has this rule already fired for this entity and reason? Mostly for queries and
// tests — the write path should use recordFired's return value instead, so the
// check and the record cannot disagree.
export function hasFired(handle, ruleId, layer, entityId, reason) {
  return Boolean(handle
    .prepare(`SELECT 1 FROM alert_log WHERE rule_id = ? AND layer = ? AND entity_id = ? AND reason = ?`)
    .get(ruleId, layer, String(entityId), reason));
}

// ---- Read API (Phase 2) ----------------------------------------------------
// All reads go through the module singleton and return { enabled: false } when
// persistence is disabled, so the routes degrade gracefully without a DB.

const EPOCH = "1970-01-01T00:00:00.000Z";

function rowToChange(r) {
  return {
    layer: r.layer,
    id: r.entity_id,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    closedAt: r.closed_at,
    status: r.status,
    entity: r.payload ? JSON.parse(r.payload) : null
  };
}

// What changed since `since`: events that first appeared after it (added) and
// events that dropped out of the feed after it (closed). `since` is a valid ISO
// string supplied by the caller (the route validates + defaults user input).
export function getChanges(since) {
  if (!db) return { enabled: false };
  const from = since || EPOCH;
  const added = db
    .prepare(`SELECT * FROM entity_events WHERE first_seen > ? ORDER BY first_seen DESC`)
    .all(from)
    .map(rowToChange);
  const closed = db
    .prepare(
      `SELECT * FROM entity_events WHERE status = 'closed' AND closed_at > ? ORDER BY closed_at DESC`
    )
    .all(from)
    .map(rowToChange);
  return { enabled: true, since: from, added, closed };
}

// Events for a layer whose lifespan overlaps the [since, until] window: started
// at/before `until` and either still open or closed at/after `since`.
export function getHistory(layer, { since, until } = {}) {
  if (!db) return { enabled: false };
  const from = since || EPOCH;
  const to = until || new Date().toISOString();
  const events = db
    .prepare(
      `SELECT * FROM entity_events
       WHERE layer = ? AND first_seen <= ? AND (closed_at IS NULL OR closed_at >= ?)
       ORDER BY first_seen DESC`
    )
    .all(layer, to, from)
    .map(rowToChange);
  return { enabled: true, layer, since: from, until: to, events };
}

// Close the singleton handle and disable persistence (used at shutdown and to
// reset state between tests).
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Prune on startup and once daily. Unref'd so it never keeps the process alive.
// No-op (returns a no-op stopper) when persistence is disabled.
export function startRetention() {
  if (!db) return () => {};
  const days = Number(process.env.OSIRIS_RETENTION_DAYS || 90);
  const run = () => {
    try {
      pruneOld(db, days);
    } catch (error) {
      console.error("[persist] prune:", error.message);
    }
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
