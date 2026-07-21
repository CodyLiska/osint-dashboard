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

const toInt = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const toNum = (v) => (Number.isFinite(v) ? v : null);

// The reconcile transaction: upsert every entity in the snapshot (new rows get
// first_seen=now; existing rows advance last_seen and refresh mutable fields),
// then close any row for this layer not touched this batch. Runs against an
// explicit handle so it is directly unit-testable on an in-memory db.
export function reconcile(handle, layer, entities, now = new Date().toISOString()) {
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
}

// Delete closed events whose closed_at is older than the retention window. Active
// rows are never pruned. Returns the number of rows removed.
export function pruneOld(handle, retentionDays = 90, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  return handle
    .prepare(`DELETE FROM entity_events WHERE status = 'closed' AND closed_at < ?`)
    .run(cutoff).changes;
}

// Server-facing fire-and-forget write. No-op when persistence is disabled or the
// layer is not in the allowlist. Synchronous (node:sqlite is sync) — callers wrap
// it in try/catch AFTER sending the response so it can never delay or break one.
export function persistSnapshot(layer, entities, meta) {
  if (!db || !isPersistable(layer)) return;
  // An optional-keyed source with no key returns an empty snapshot. Reconciling
  // that would close-absentee the layer's entire history and report every record
  // as "Dropped" — the source being switched off is not the same as its events
  // having ended. Skip the write and leave the existing history intact.
  if (meta?.configured === false) return;
  reconcile(db, layer, entities);
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
