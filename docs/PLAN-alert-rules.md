# Implementation Plan — Geofence + Keyword Alert Rules

Status: **proposed**, not started. Log a `decisions-log.md` entry on execution.

## Goal

Turn OSIRIS from a dashboard you have to look at into one that tells you when
something matters. Today 25 sources feed the map and the reconcile store records
what appeared and disappeared, but nothing reaches you unless you open the tab.
The only existing alerting is *operational* (a source went down, via
`src/lib/notify.js`); there is no *intelligence* alerting.

A rule says: **in this area, on these layers, matching these words, at or above
this severity — tell me.**

## Non-goals (explicitly out of scope)

- **No rule-authoring UI in this plan.** Rules are a hand-edited JSON file
  (Phase 4 adds a read-only Alerts tab; an editor comes later, once the rule
  semantics have proven themselves in real use).
- **No new notification channels.** Slack only, reusing the existing webhook.
  Email/webhook fan-out is a later concern.
- **No correlation across sources.** "Aircraft AND outage in the same box within
  10 minutes" is a genuinely different feature (cross-source correlation, still
  open in `FUTURE-DATA-SOURCES.md`). One rule matches one entity.
- **No alerting on layers that are not persisted.** See the coupling decision
  below — this is a real limitation, not an oversight.

## Design decisions (settled)

### Rules live in a JSON file, not the database

`config/alert-rules.json`, hot-reloaded on change. Zero dependencies, no schema
migration, no CRUD API, and diffable. The dashboard is LAN-only and
single-operator, so the multi-user problems a DB-backed rule table solves do not
exist here.

### Alerting requires `OSIRIS_DB_PATH`

Alerts ride the reconcile step, so "new" means `first_seen` and an entity alerts
**exactly once, ever** — across restarts and redeploys. That durable dedupe is
the whole reason to couple to the DB. The alternative (an in-memory seen-set)
re-alerts on everything currently active after every deploy, which is noisy in
precisely the situation where alerts matter.

Consequence to accept: with persistence off, the alert engine is inert and says
so at startup. Production already sets `OSIRIS_DB_PATH`; bare local dev does not.

Second consequence, and the sharper one: **only `persist: true` layers can
alert.** Today that is `weather, seismic, telegram, cyber, news, conflict,
gdacs, ioda, reliefweb`. Notably absent: `aviation`, `military-air`, `maritime`
(kinematic, deliberately excluded) and `infrastructure` (viewport-scoped). A
"military aircraft entered this box" rule is therefore **not buildable on this
design** — see Open questions.

### Triggers are appear + escalate

- **Appear** — an entity matching the rule is seen for the first time.
- **Escalate** — an already-seen entity's severity crosses the rule's
  `minSeverity` boundary *upward* (`previous < minSeverity <= current`).

Crossing the boundary, rather than any severity increase, is what keeps routine
churn quiet: an M4.1 quake becoming M4.2 is not an event, an M4 becoming M6 is.

## Rule schema

```json
[
  {
    "id": "taiwan-strait",
    "enabled": true,
    "layers": ["seismic", "ioda", "gdacs"],
    "geofence": { "type": "bbox", "west": 118.0, "south": 21.5, "east": 123.0, "north": 26.5 },
    "minSeverity": 3
  },
  {
    "id": "nuclear-keywords",
    "enabled": true,
    "layers": ["gdelt", "news", "telegram"],
    "keywords": ["reactor", "enrichment", "IAEA"],
    "minSeverity": 4
  },
  {
    "id": "near-phoenix",
    "enabled": true,
    "geofence": { "type": "circle", "lat": 33.45, "lon": -112.07, "radiusKm": 150 }
  }
]
```

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `id` | yes | Stable, unique. Part of the dedupe key, so renaming a rule re-arms it. |
| `enabled` | no (default `true`) | Turn a rule off without deleting it. |
| `layers` | no (default: all persisted layers) | Layer ids, validated against the registry at load. |
| `geofence` | no | `bbox` (west/south/east/north) or `circle` (lat/lon/radiusKm, haversine). |
| `keywords` | no | Case-insensitive, matched on **word boundaries** against `name` + `summary` + `text`. |
| `minSeverity` | no (default `1`) | Also the escalation boundary. |

**All present conditions must match (AND); rules are independent (OR).** A rule
with no conditions at all matches every entity on every persisted layer, which
is almost never wanted — the loader warns on it.

### Not every layer has real coordinates — geofences must know the difference

Audited across the 9 `persist: true` layers, and this constrains the feature
more than anything else in this plan:

| Layer | Coordinate source | Geofence |
| ----- | ----------------- | -------- |
| `seismic`, `weather`, `gdacs` | real, from upstream | supported |
| `telegram` | gazetteer geoparse (carries `confidence`) | allowed, see below |
| `ioda`, `reliefweb` | country centroid | country-granular only |
| `cyber`, `news` | **synthetic** | **rejected at load** |
| `conflict` | never reconciles (`load: null`) | not alertable |

`cyber` and `news` position entities by scattering them around a hardcoded
anchor — `lon + Math.cos(index * 0.85) * 3.5` about Washington DC for CVEs. The
coordinate is a function of **array index**, so it is not a location at all, and
it *changes between fetches* as the feed reorders. A geofence over these layers
would fire on fabricated positions and could fire and unfire arbitrarily. Those
layers are perfectly good keyword+severity targets; they must simply never be
geofence targets.

Therefore: tag each layer in the registry with a `geo` provenance
(`"real" | "country" | "synthetic" | "none"`), and have `loadRules()` **reject a
geofence rule targeting a synthetic-coordinate layer** with a clear message
rather than silently matching nonsense.

Two consequences to state plainly:

- **Country-centroid layers are country-granular, not spatial.** An `ioda`
  outage in Russia sits at Russia's centroid (98.7E, 59N — central Siberia). A
  bbox over eastern Ukraine will never match a Russia-wide outage; a bbox over
  Siberia will. For these layers prefer matching the `country` field over a
  geofence, and consider a `countries: ["RU","UA"]` rule condition instead.
- **Geoparsed `telegram` coordinates are a guess.** A rule should be able to set
  `minConfidence: "Medium"` so a Low-confidence geoparse does not trigger a
  geofence alert.

### Two matching details that will otherwise bite

1. **Keywords match on word boundaries, not substrings.** The gazetteer has
   already been through this: a substring match fires "London" inside
   "Londonderry". Reuse the boundary approach from `src/lib/gazetteer.js`
   (`(?:^|[^\p{L}])needle(?:[^\p{L}]|$)` with the `u` flag) rather than
   `String.includes`.
2. **A bbox crossing the antimeridian is not `west < east`.** A Pacific rule
   (e.g. west 170, east -170) inverts. Handle the wrap explicitly, or validate
   and reject it at load with a clear message. Do not let it silently match
   nothing.

## Where it hooks in

The path already exists; this adds one classification step and one consumer.

```
handleLayer (server.js)
  → sendJson(response)                    [unchanged, response already sent]
  → persistSnapshot(layer, entities, meta) [returns a classification]
      → reconcile()  ... upsert + close-absentees
  → evaluateAlerts(layer, classification)  [NEW, fire-and-forget, try/catch]
      → matchRules() → dedupe via alert_log → batched postToSlack()
```

`reconcile()` currently returns nothing. It must return
`{ appeared: [], escalated: [], closed: [] }`. To do that it needs the prior
state, so before the upsert loop it selects `entity_id, severity, status` for
the layer into a Map and classifies each entity against it. That is one extra
indexed SELECT per fetch over a bounded row count — negligible, and it makes
reconcile's behaviour far easier to assert in tests than it is today.

Alerting stays **after** the response and inside a `try/catch`, exactly like the
existing persist call. An alerting bug must never affect a layer response.

## Anti-noise design (the part that decides whether this is usable)

An alert engine that cries wolf gets muted, and a muted alert engine is worse
than none. Four mechanisms, in order of importance:

1. **Batch per evaluation.** One reconcile producing 12 matches sends **one**
   Slack message listing them, never 12 messages. This is the single biggest
   noise factor, because a seismic swarm or a GDELT burst arrives all at once.
2. **Durable dedupe.** A new `alert_log` table keyed
   `(rule_id, layer, entity_id, reason)` — an entity alerts once per rule per
   reason, permanently. This is what the DB coupling buys.
3. **Per-rule cooldown.** A `maxPerHour` guard (default 20) so a
   pathologically broad rule degrades to a summary ("rule `x` matched 340 more")
   rather than flooding.
4. **Startup suppression.** On a cold start with an empty DB, *every* entity is
   "new". The first reconcile per layer after boot must seed without alerting,
   or enabling the feature pages you with 3,000 alerts. This is the failure mode
   most likely to be discovered in production rather than in tests.

### Schema addition

```sql
CREATE TABLE IF NOT EXISTS alert_log (
  rule_id    TEXT NOT NULL,
  layer      TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  reason     TEXT NOT NULL,           -- 'appeared' | 'escalated'
  fired_at   TEXT NOT NULL,
  severity   INTEGER,
  name       TEXT,
  payload    TEXT,
  PRIMARY KEY (rule_id, layer, entity_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_alert_log_fired ON alert_log (fired_at);
```

It doubles as the data source for the Phase 4 Alerts tab and as an audit trail
("why did I get paged at 3am"). Pruned by the existing retention job.

## Configuration (all optional; unset = today's behaviour)

```bash
OSIRIS_ALERT_RULES_PATH=./config/alert-rules.json   # default; missing file = disabled
OSIRIS_ALERT_MAX_PER_HOUR=20                        # per-rule flood guard
OSIRIS_ALERT_DRY_RUN=                               # set to 1 to log matches, send nothing
SLACK_WEBHOOK_URL=                                  # already exists; no webhook = log only
```

`OSIRIS_ALERT_DRY_RUN` is worth building in Phase 1, not bolted on later: it is
how you tune a geofence against live data without spamming the channel.

## The deploy wrinkle that will silently bite

`docs/DEPLOY.md` deploys by `git pull`. The rules file will be **gitignored** —
it encodes what you are watching, which is closer to tasking than to config, and
does not belong in a repo. Therefore:

- `git pull` will **not** deliver it, and the engine will silently start disabled
  on the server while working perfectly on your laptop.
- The container needs it mounted: add `./config:/app/config:ro` to
  `docker-compose.prod.yml` alongside the existing `osiris-data` volume.
- Ship a committed `config/alert-rules.example.json` so the shape is discoverable,
  mirroring how `.env.example` documents the env vars.
- **Log loudly at startup** which path was read and how many rules loaded. A
  silently-disabled alert engine is the worst outcome this feature has, because
  it is indistinguishable from "nothing has happened yet".

## Phases (each independently shippable, with a verify gate)

**Phase 1a — Coordinate provenance on the registry.** Add `geo` to every row in
`src/adapters/layers.js` (`"real" | "country" | "synthetic" | "none"`) and export
`geoProvenance(id)`. Phase 1 cannot validate a geofence without it.
*Verify:* a test asserting every registry row declares `geo`, so a new source
cannot be added without stating it.

**Phase 1b — Matching, genuinely pure.** New `src/lib/alert-rules.js`, split
along the same seam every adapter here already uses (pure `parseX` + thin impure
wrapper):

| Function | Purity | Responsibility |
| -------- | ------ | -------------- |
| `parseRules(json)` | pure | Validate → `{ rules, errors }`. No I/O, no throwing. |
| `matchRule(rule, entity)` | pure | The primitive. One rule, one entity, boolean. |
| `matchBatch(rules, entities)` | pure | → `Map<ruleId, entity[]>` |
| `loadRules(path)` | impure | Thin: read file → `parseRules` → last-good retention. |

`matchBatch` returns **per-rule groups, not per-entity rules**, because that is
what delivery consumes — one Slack message per rule listing its matches. Getting
this backwards means Phase 3 regroups everything Phase 1 just built.

Validation rules, with the two failure modes kept distinct:

- **Malformed JSON** → keep the entire previous rule set, log, change nothing.
- **Valid JSON, one bad rule** → drop that rule, load the rest, report which and
  why. One typo must not disable every other rule.
- **A rule with no conditions is rejected, not warned.** It would match every
  entity on every persisted layer; that is a typo, not an intent. Fail loud.
- **A geofence on a `geo: "synthetic"` layer is rejected** (`cyber`, `news`) —
  the coordinates are array-index artifacts.
- **Unknown layer id is rejected**, naming the id. This is the identifier-drift
  class of bug that has bitten this codebase before.

Logging follows the existing `console.error("[alerts] …")` prefix convention
used by `[persist]`.

*Verify:* unit tests only, no filesystem needed for any validation test. Nothing
in the app changes.

**Phase 2 — Classification.** `reconcile()` returns
`{ appeared, escalated, closed }`; `persistSnapshot` passes it through; add the
`alert_log` table and `hasFired`/`recordFired`. Startup suppression lands here.
*Verify:* persist tests assert classification and that a cold seed suppresses.

**Phase 3 — Delivery. DONE 2026-07-20.** `src/lib/alerts.js`: `selectAlerts`
(decides, takes an explicit handle), `formatAlert` (one message per rule), and
`evaluateAlerts` (the impure wrapper), wired fire-and-forget into `handleLayer`.
Rules hot-reload by mtime via `currentRules()`. Dry run, per-rule hourly cap,
and escalation threshold-crossing all implemented.
*Verified:* end-to-end dry run against live USGS data — 3 rules loaded, real
quake names/severities/coordinates rendered, truncation and the flood-guard
summary both fired, and `alert_log` stayed empty while entities still persisted.

> **Found during Phase 3:** with no `SLACK_WEBHOOK_URL` and dry-run off, a real
> evaluation consumed the dedupe while the message went nowhere — those events
> could never have alerted again once a webhook was added. The log is now
> treated as a delivery channel when no webhook is configured.

**Phase 4 — Visibility.** A 7th recon tab, "Alerts", reading `alert_log` via a
new `GET /api/alerts?since=`, mirroring the "What Changed" tab. Graceful-off
shape `{ enabled: false }` when persistence is disabled, matching `/api/changes`.
*Verify:* Playwright, as with the Changes tab.

## Testing (zero-dep, `node:test`)

The matcher is pure, so most of the value is cheap:

- bbox inside/outside/edge; **antimeridian wrap**; circle radius at the boundary
- keyword word-boundary (the "Londonderry" case must not match "London")
- AND across conditions, OR across rules, condition-less rule warns
- escalation fires only on an upward boundary crossing, not on any bump
- dedupe: the same entity never alerts twice for the same rule+reason
- **cold start seeds without alerting** — the highest-value test here
- invalid JSON keeps the previous rules and does not crash the poll path
- one invalid rule is dropped while the remaining valid rules still load
- a condition-less rule is rejected, not loaded with a warning
- a geofence targeting `cyber` / `news` is rejected at load
- unknown layer id in a rule is reported at load, not silently ignored
- `matchBatch` groups by rule id, so delivery never has to regroup

Every validation test runs against `parseRules(object)` with no filesystem
access; only the thin `loadRules` wrapper needs a temp file.

## Open questions to resolve before Phase 1

1. ~~**Kinematic layers cannot alert.**~~ **Answered: accept the gap.** Rules on
   `aviation` / `military-air` / `maritime` are out of scope; no second matching
   path is built. Matching therefore lives entirely in the reconcile step, which
   keeps the design to one code path.
2. **Should escalation re-arm?** If severity falls back below the threshold and
   crosses again, is that a second alert or noise? Leaning: re-arm only after the
   entity closes.
3. **Quiet hours / severity floor for delivery?** Deferred, not built. Revisit
   once there is real alert volume to judge against.

5. **Escalation only meaningfully applies to `seismic`, `gdacs`, and sometimes
   `cyber`.** The other alertable layers emit a constant severity, so they can
   never escalate (see the annotations at each constant, and the severity
   contract in `src/lib/normalize.js`). This is a property of the sources, not a
   defect, but it means the escalate trigger is narrower than it sounds.

6. **A rule can validate and still be inert.** `minSeverity: 4` on a layer whose
   severity is a constant 3 loads clean and never matches. Not statically
   detectable without running the adapters, and a declared per-layer severity
   range would drift. Mitigated by dry run now; rule-health tracking
   (`last_matched_at`, never-matched surfacing) belongs in Phase 4.
4. ~~**Does `conflict` ever reconcile?**~~ **Answered: no.** `layerEntities`
   returns `null` for a `load: null` row, so `handleLayer` throws 404 before
   reaching `persistSnapshot`. `conflict` is `persist: true` in the registry but
   is rendered client-side from `public/data/conflict.json` and never produces a
   server snapshot, so it has no history and cannot alert until it is swapped to
   a live adapter. Do not list it as alertable.
