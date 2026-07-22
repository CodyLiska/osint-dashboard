# AI FINDINGS ✅

- ~~Cross-source correlation~~ **DONE (2026-07-21)** — `/api/intel/correlate?ip=` (`correlate()` in `src/adapters/intel.js`) joins the IP reputation fan-out + RDAP/OpenSanctions + country→centroid geolocation into one verdict. IP Intel search now shows a correlation banner (threat count / announcing AS / country / sanctions) above the per-source cards, with a "Locate on map" pin (`correlationBanner`/`correlationSummary` in `public/logic.js`). Live-verified on 8.8.8.8.
- ~~MITRE ATT&CK mapping~~ **DONE (2026-07-21)** — cyber/KEV entities are tagged with ATT&CK techniques derived from their NVD CWE weakness class via a curated table (`src/lib/attack.js`), surfaced as deep-linked tags on the detail card (`attackTags`) plus `meta.techniqueCoverage`. Weakness-derived heuristic (labelled "from CWE" in the UI), not per-CVE analyst mapping. Live: 50/80 cyber entities tagged.
- ~~Persistence Phase 5 (timeline scrubber)~~ **DONE (2026-07-21)** — append-on-change `entity_observations` table + `getSnapshotAt(layer, at)` point-in-time replay (`src/lib/persist.js`), `GET /api/snapshot/:layer?at=`, and a scrubber in the What-Changed tab that replays the map at a past instant (`scrubberTime`/`replayEntities` in logic; DOM in `app.js` renderMap replay branch). Backend live-verified; the DB-gated DOM/map path still wants a homelab Playwright pass (persistence is off on the dev Mac). Retention prunes observations on the same window.

# DATA SOURCES LEFT TO IMPLEMENT

- §4 SIGINT
- §5 Person/Entity
- §7 cyber
- §8 economic
- §9 environmental
- §13 health
- §14 imagery

# Smaller debts ✅

- ~~space and maritime test coverage~~ **DONE (2026-07-21)** — both now 100% line coverage. `test/adapter-maritime.test.js` stubs `globalThis.WebSocket` with a fake that fires open→messages→error to exercise the AIS collection path; `test/adapter-space.test.js` mocks the N2YO position API (`installJsonFetch`) to cover `n2yoSatellites()` + the base-severity SWPC alert branch.
- ~~weather severity placeholder~~ **DONE (2026-07-21)** — EONET severity is now derived per event category via `severityForCategory()` (`src/adapters/eonet.js`), so a severity filter/minSeverity rule discriminates on the weather layer (live: Severe Storms=4, Volcanoes=5, was a flat 3). **Telegram severity stays a constant by design** — posts carry no intensity and the layer is meant to be filtered on keyword/geofence, not severity (documented at `telegram.js:74`).
- ~~Alerting scope~~ **DONE (2026-07-21)** — optional `ALERT_RATE_LIMIT_ONLY` env (`src/lib/notify.js`): when truthy, only 429/403 failures alert; transient 5xx/network/timeout errors are suppressed (and don't consume the cooldown). Off by default. Tested.
- ~~README phase 7~~ **DONE (2026-07-21)** — authenticated higher-quota adapters marked done in the README. Concrete new instance: URLScan.io is now key-aware (`URLSCAN_API_KEY` → `API-Key` header + larger result window), graceful-off/never-required, joining OpenSky OAuth + NVD key. `.env.example` documents both new keys. Tested (header sent only when keyed).
