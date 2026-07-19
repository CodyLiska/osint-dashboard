# Implementation Plan — Historical Persistence

> Status: **PROPOSED** (not started). Draft 2026-07-19.
> Source idea: `docs/FUTURE-DATA-SOURCES.md` → "Cross-cutting enhancements" → historical persistence.
> Precedent: sibling project `public-risk-radar` (Postgres `risk_events`, EONET persistence, fire-and-forget after response). Same lineage, decided the opposite way at deploy time — see decisions-log #24 (OSIRIS chose in-memory-only as a shipping simplicity) and #26/#34 (risk-radar's persistence patterns).

## Goal

Give OSIRIS a durable, queryable history so it can answer questions the in-memory model **structurally cannot**, because it discards every prior snapshot on refresh and everything on restart:

- **"What changed since yesterday"** — events that newly appeared or dropped out (new CVEs, new conflict events, quakes, EONET events that closed).
- **Trends** — e.g. a building earthquake swarm, rising cyber activity.
- **Survival across restart** — the current picture is not lost when the container recycles.

Later phases build a timeline scrubber and durable alert state on top of the same store.

## Non-goals (explicitly out of scope)

- Persisting **kinematic** layers (aviation, military-air, maritime). Their value is *live position*; a plane's location three hours ago is noise, and 60s polling of thousands of points would balloon the store for nothing. Same call risk-radar made keeping FIRMS live-only (decisions-log #26).
- Persisting **static** layers (ports, chokepoints, cctv, military). They already live as versioned files in `public/data/`; they don't change, so there is no history to capture.
- A full mutable-field timeline (every severity/coord change over time). Phase 1 captures *appearance and disappearance* of discrete events, which is 90% of the analyst value. A full observations log is deferred to Phase 5.
- Any change to the "works with nothing configured" ethos. **Persistence must be fully optional** — unset the DB path and OSIRIS behaves exactly as it does today.

## Storage decision: `node:sqlite`

**Chosen: `node:sqlite`** (built-in `DatabaseSync`), *not* JSONL, *not* an npm dependency.

- Verified available in the deployed runtime: `node:22-alpine` → Node v22.x exposes `node:sqlite` (`DatabaseSync`, `StatementSync`). It emits an `ExperimentalWarning` (suppressed at launch — see Phase 3). **Zero npm deps preserved** — this is the whole reason SQLite wins over `better-sqlite3`.
- Rationale over JSONL: the headline features ("what changed since X", timeline, trends) are *time-range queries*. SQLite gives indexes and `WHERE last_seen > ?` for free; JSONL would mean loading and scanning in JS on every query. JSONL stays the fallback **only** if the experimental flag ever becomes a blocker.
- Risk accepted: `node:sqlite` is experimental and its API "might change." Mitigation: it is used behind one thin module (`src/lib/persist.js`); if the API shifts, the blast radius is that one file.

## What to persist and how — the reconcile model

Do **not** think of this as "snapshot the cache." Think of it as an **append-only-ish event table keyed by stable entity id**, recording when each discrete event first appeared and when it dropped out of the feed.

**Persistable layers (`OSIRIS_PERSIST_LAYERS`, default):** the live, event-shaped, stable-id, low-volume layers —
`seismic` (USGS quake ids), `weather` (EONET event ids), `cyber` (CVE/KEV ids), `news`, `conflict`, `telegram`.
Seismic + weather are the two certain wins and mirror risk-radar exactly. Volume sanity: seismic ~30–300/day, EONET ~tens open, cyber ~hundreds/day, news ~dozens — all trivial for SQLite. (`conflict` is static today but becomes event-shaped the moment it goes live via ACLED/GDELT per FUTURE-DATA-SOURCES §1.)

> **Source of truth (as built):** the allowlist is declared once, as the `persist` flag on each layer's row in the backend registry `src/adapters/layers.js`; `persist.js` derives the default `OSIRIS_PERSIST_LAYERS` from `persistableIds()`. `conflict` is a static placeholder row there (`load: null`, `persist: true`) so it is already allowlisted when it goes live. The `OSIRIS_PERSIST_LAYERS` env var still overrides the default at runtime.

### Checklist — before flipping a layer's `persist` flag to `true`

Reconcile is upsert-by-`(layer, entity_id)` + close-absentees, run on *every* successful fetch. That model only behaves for a specific shape of source. Before adding a layer to persistence, confirm **all four**:

1. **Stable entity id.** The id must come from a durable upstream identifier (a permalink, a record id, a CVE number) so the same real-world event yields the same id across fetches. An id built from array position/index churns → every fetch inserts "new" rows and closes the old ones → the table bloats and "what changed" is all noise. (This is why `telegram` was gated on `data-post` — resolved — and why any position-fallback id is a red flag.)
2. **Event-shaped, not kinematic.** The layer must be discrete events that *appear and disappear* (quakes, CVEs, conflict events), not continuously-moving points. A plane's or vessel's position is live-only value; persisting it 60s at a time balloons the store for nothing. Aviation/military-air/maritime stay `persist: false`.
3. **Not static.** Static layers (ports/cctv/chokepoints/military) are already versioned files in `public/data/`; they have no history to capture. Leave them off.
4. **Bounded volume per fetch.** Reconcile writes one row per entity every poll. Tens–hundreds per fetch is fine (SQLite laughs at it); thousands-per-fetch on a fast poll is not — reconsider or down-sample first.

If any of the four fails, keep `persist: false` (the layer still renders and serves normally; it just isn't recorded to history).

**Reconcile, per layer, per successful fetch** (one transaction):
1. For each entity in the snapshot: **upsert** by `(layer, entity_id)` — insert with `first_seen = now` if new; otherwise set `last_seen = now`, `status = 'active'`, `closed_at = NULL`, and refresh `severity`/`lat`/`lon`/`name`/`payload`.
2. **Close absentees:** any row for this layer still `status='active'` whose `last_seen < now` (i.e. not touched this batch) → `status='closed'`, `closed_at = now`.

That single table yields: current-active (`status='active'`), newly-appeared (`first_seen > since`), and gone (`closed_at > since`).

## Schema

```sql
CREATE TABLE IF NOT EXISTS entity_events (
  layer      TEXT    NOT NULL,
  entity_id  TEXT    NOT NULL,
  first_seen TEXT    NOT NULL,             -- ISO 8601, first observation
  last_seen  TEXT    NOT NULL,             -- ISO 8601, most recent observation
  status     TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'closed'
  closed_at  TEXT,                         -- ISO 8601, when it left the feed
  severity   INTEGER,
  lat        REAL,
  lon        REAL,
  name       TEXT,
  source     TEXT,
  payload    TEXT,                         -- JSON.stringify of the latest entity
  PRIMARY KEY (layer, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_events_last_seen    ON entity_events(last_seen);
CREATE INDEX IF NOT EXISTS idx_events_first_seen   ON entity_events(first_seen);
CREATE INDEX IF NOT EXISTS idx_events_layer_status ON entity_events(layer, status);
```

`payload` keeps the full latest entity so history reads can rebuild a detail card without re-fetching upstream. Schema is created idempotently on first open (no migration framework needed yet).

## Where it hooks in

`server.js` → `handleLayer` (currently `server.js:121`). After the existing `sendJson(res, 200, …)`, fire-and-forget:

```js
// after sendJson(...)
if (isPersistable(layer)) {
  persistSnapshot(layer, payload.entities).catch((err) =>
    console.error(`[persist] ${layer}:`, err.message));
}
```

**Non-negotiable resilience contract** (risk-radar #34): persistence runs **after** the response is sent and its failure is caught and logged — it can never delay or break a layer response. If the DB is unavailable or `OSIRIS_DB_PATH` is unset, `persistSnapshot` is a no-op.

## Retention

A store grows forever; a long-running homelab container needs a bound.
- `OSIRIS_RETENTION_DAYS` (default 90): `DELETE FROM entity_events WHERE status='closed' AND closed_at < ?`.
- Active rows are never pruned.
- Run on startup and once daily (a single `setInterval`, cleared on shutdown — mirror the existing polling-ticker pattern).

## Configuration (all optional — unset = today's behavior)

| Env | Default | Effect |
|---|---|---|
| `OSIRIS_DB_PATH` | *(unset)* | Unset → **persistence disabled**, app identical to today. Set (e.g. `/app/data/osiris.db`) → enabled. |
| `OSIRIS_PERSIST_LAYERS` | `seismic,weather,cyber,news,conflict,telegram` | CSV allowlist override. |
| `OSIRIS_RETENTION_DAYS` | `90` | Prune closed events older than this. |

Document all three in `.env.example` and `docs/DEPLOY.md`.

## Deploy changes (the wrinkle that will silently bite)

The hardened Dockerfile makes the app **write nothing to disk** and run as non-root `node`. A store breaks both assumptions:

1. **Writable, node-owned data dir.** Add *before* `USER node` in the Dockerfile:
   ```dockerfile
   RUN mkdir -p /app/data && chown node:node /app/data
   ```
   Docker seeds a fresh **named volume** from the image path's ownership on first mount, so the volume inherits `node:node` and the unprivileged user can write. (Skipping this → `EACCES` at runtime, silently caught by the fire-and-forget guard, and history mysteriously stays empty.)
2. **Compose volume + env** in `docker-compose.prod.yml`:
   ```yaml
   volumes:
     - osiris-data:/app/data
   environment:
     - OSIRIS_DB_PATH=/app/data/osiris.db
   # + a top-level `volumes: { osiris-data: {} }`
   ```
3. **Verify persistence across recreate**, not just restart: `docker compose up -d --force-recreate` must retain rows (that's what proves the volume, not the container FS, holds the data).

## Phases (each independently shippable, with a verify gate)

- **Phase 0 — spike (DONE).** Confirmed `node:sqlite` loads in Node 22 with `DatabaseSync`/`StatementSync`. Storage decision locked.

- **Phase 1 — persistence engine.** New `src/lib/persist.js`: `openDb()` (idempotent schema, graceful-off when `OSIRIS_DB_PATH` unset), `persistSnapshot(layer, entities)` (the reconcile transaction), `isPersistable(layer)`, `pruneOld()`. Wire the fire-and-forget call into `handleLayer`. Start the retention ticker in `createServer`/startup.
  - **Verify:** with `OSIRIS_DB_PATH=./data/osiris.db npm start`, `curl /api/layers/seismic` twice → rows present, `last_seen` advances; drop a quake from a mocked feed → its row flips to `status='closed'` with `closed_at`. Restart the process → rows survive. **Unset the path → zero behavior change** (diff `/api/health` + a layer response against `main`). `npm test` green.

- **Phase 2 — read API.** `GET /api/changes?since=ISO` → `{ since, added:[…], closed:[…] }`. `GET /api/history/:layer?since=&until=` → events active in the window. Both read-only, both behind the same graceful-off guard (return `{ enabled:false }` when persistence is disabled).
  - **Verify:** `test/persist.test.js` + a server-routing test (in-memory `:memory:` DB) assert added/closed partitioning by timestamp and the disabled-shape. `curl` round-trip.

- **Phase 3 — deploy plumbing.** Dockerfile `mkdir`/`chown`; compose volume + env; `.env.example` + `docs/DEPLOY.md` entries; suppress the experimental warning at launch (`CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]` or `NODE_NO_WARNINGS`).
  - **Verify:** real `docker build` + `up -d`, hit a persistable layer, `--force-recreate`, confirm rows survive and the container still runs as `node` (`docker exec … id` → uid 1000). No experimental warning in logs.

- **Phase 4 — frontend "What changed" panel (optional).** A recon-tab or topbar affordance calling `/api/changes?since=<lastVisit>`; surface added/closed counts per layer, click-to-fly. Reuses the existing detail-card renderer via stored `payload`. Pure client + the Phase 2 API; no new backend.
  - **Verify:** Playwright — appear/close a mocked event, confirm it shows in the panel and flies on click.

- **Phase 5 — timeline scrubber + durable alerts (future, deferred).** Needs a second append-only `entity_observations` table (mutable fields over time) for true point-in-time replay, and an `alert_state` table so the geofence/keyword engine (FUTURE-DATA-SOURCES cross-cutting) stops re-firing across restarts. Scoped separately — do not pull into this plan.

## Testing (zero-dep, `node:test`)

- `test/persist.test.js` against `new DatabaseSync(':memory:')`: reconcile inserts new / advances `last_seen` / closes absentees; retention prunes only old closed rows; `isPersistable` honors the allowlist; graceful-off when path unset.
- Extend `test/server.test.js` for `/api/changes` + `/api/history` (enabled and disabled shapes).
- Pattern for feeding snapshots: the existing `test/helpers/mock-fetch.js`.

## Open questions to resolve before Phase 1

1. **`telegram` entity ids — RESOLVED (2026-07-19): stable, keep in allowlist.** `telegram.js:67` builds `tg-${channel}-${data-post}`, where `data-post` is Telegram's canonical post permalink (`channel/<msg#>`) — the same post yields the same id across scrapes. Reconcile works correctly: a post holds identity while in the preview window and closes when it scrolls out of the last-10 slice (accurate). Minor edge: the rare `|| index` fallback (only when a block lacks `data-post`) uses a position-based id that can churn; harmless at this scale. Optional later hardening: persist only entities whose id came from `data-post`. Not a Phase 1 blocker.
2. **`conflict` today is static — RESOLVED (2026-07-19): kept, as a placeholder registry row.** Implemented in `src/adapters/layers.js` as `{ id: "conflict", load: null, persist: true }` — no backend adapter yet (so `/api/layers/conflict` still 404s and nothing is written today), but it stays in the derived default allowlist so the ACLED/GDELT swap is persistence-ready with no allowlist edit.
3. **WAL mode?** Single-process, low write rate — default rollback journal is fine. Revisit only if write contention ever appears (it won't at this scale).

---

*When a direction here is executed, record the outcome as a decisions-log entry (the persistence question for OSIRIS is currently unrecorded in the vault — only the sibling risk-radar precedent exists).*
