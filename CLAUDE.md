# OSIRIS Situational Dashboard, Claude notes

Static-first OSINT situational-awareness dashboard. See `README.md` for the full feature list and run instructions.

## Architecture (quick map)

- `server.js`: Node HTTP server (no framework, no npm deps). Serves `public/` and handles `/api/*`. Binds `HOST` (default `127.0.0.1`; the container and compose set `0.0.0.0`) on `PORT` (default 4173).
- `public/`: vanilla-JS frontend (`app.js`, `data.js`, `index.html`, `styles.css`). MapLibre GL and deck.gl load from CDN in the browser. Client features: localStorage persistence (layers/viewport/recon history/min-severity), zoom-aware grid clustering + severity filter, per-layer polling, JSON snapshot export.
- `public/data/*.json`: versioned static datasets with provenance (`gazetteer`, `chokepoints`, `cctv`, `conflict`). The browser fetches the layer datasets; `src/lib/gazetteer.js` reads `gazetteer.json` via `readFileSync`.
- `src/adapters/*`: one module per intelligence layer; each normalizes an upstream feed to `{ entities, meta }`. `intel.js` also has the keyless RDAP `whoisLookup` + `sanctionsCrossCheck`.
- `src/lib/*`: `cache` (in-memory TTL Map), `health` (source telemetry), `http` (fetch helpers), `normalize`, `gazetteer` (geoparse + confidence for text feeds).
- No database. Cache and health are in-memory and reset on restart.

## Run

`npm start`, then open http://localhost:4173. API keys are optional (see `.env.example`); each layer falls back to keyless or static behavior without its key.

## Deploy

Packaged for a LAN-only single-container Docker Compose homelab deploy: `Dockerfile`, `docker-compose.prod.yml`, and `docs/DEPLOY.md`. NOT yet deployed or promoted, still active dev in `01_Projects`. When feature-stable, relocate to `06_Production_Apps/Homelab_Sever/` and deploy per `docs/DEPLOY.md`.

Keep it LAN-only: the `/api/intel/*` and `/api/crypto/*` routes proxy external services using your API keys with no auth or rate limiting. Do not expose to the internet without adding auth and rate limiting first.

## Status / Next

Active development. 7 of 8 README build phases done (2026-07-17): gazetteer + confidence (1), clustering + severity filters (2), per-layer polling (3), localStorage persistence (4), WHOIS/RDAP + OpenSanctions cross-check (5), versioned JSON datasets (6), snapshot export (8). All uncommitted on `main`.

Remaining / next:
- README phase 7: authenticated adapters for additional higher-quota sources (open-ended; needs real API keys). `.env.example` documents all optional keys (FREE/PAID tagged).
- Dead data to resolve: `staticLayers` no longer holds the unused `ports`/`news`/`space` arrays (they had no `staticKey`); confirm they should stay dropped.
- Still NOT promoted/deployed: when feature-stable, relocate to `06_Production_Apps/Homelab_Sever/` and deploy per `docs/DEPLOY.md`.

Uncommitted changes this session (2026-07-17), verified but not yet committed:
- Fixed a listener leak in `renderLayerControls` (`public/app.js`) — the per-render `{ once:true }` `change` listener accumulated and fired duplicate upstream fetches on every toggle (8x measured). Now one delegated listener wired once via `wireLayerControls()`.
- `military` layer (no adapter) renders disabled/dimmed as "(soon)" instead of silently doing nothing (`public/app.js`, `public/styles.css`).
- Added inline SVG favicon (`public/index.html`) — removes the 404.
- Slack alerting on source failure/recovery: `src/lib/notify.js` (new), wired into `withHealth` (`src/lib/health.js`); `src/lib/http.js` attaches `error.status` so 429/403 are detectable. Config: `SLACK_WEBHOOK_URL`, `ALERT_COOLDOWN_MS` (see `.env.example`, `docs/DEPLOY.md`).
- Added a test suite: `npm test` (`node --test test/*.test.js`, zero deps). 67 tests in `test/`, ~74% line coverage overall (measure with `node --test --experimental-test-coverage test/*.test.js`):
  - lib: `normalize`, `cache`, `gazetteer` (geoparse word-boundary/confidence), `health`, `notify` (alerting: rate-limit tagging, cooldown, recovery), `http` (status attachment) — all ~100%.
  - adapters (via `test/helpers/mock-fetch.js` — `installJsonFetch`/`installFetch` stub global `fetch` + clear cache): `usgs`/`ports`/`eonet`/`opensky` normalization; `recon` (85%: OFAC crypto-address XML parse, BTC/ETH sanctioned flag, cryptoLayer, sanctionsLayer grouped+individual, sanctionsSearch fallback, cveSearch); `intel` (61%: whoisLookup domain+IP RDAP parse, sanctionsCrossCheck name filtering + name-level match).
  - `server.js` routing (73%): static serving, traversal block, `/api/health`, `/api/layers/:layer`, `/api/crypto/btc`, `/api/sanctions`, `/api/cves`, `/api/intel/whois`, and 400/404 error paths.
- Minor `server.js` refactor for testability: exports `createServer()` and only calls `.listen()` when run directly (`node server.js`), so tests import the handler without binding a port. No behavior change to `npm start`.

## Known issues / future enhancements

- **ETH wallet lookup broken** — `eth.blockscout.com` unreachable (connection fails, HTTP 000); returns raw "fetch failed" with no fallback. BTC (Blockstream) works. `src/adapters/recon.js:122`. Verify host is down/moved vs. blocked; add a fallback provider or a clearer error. Note: neither BTC nor ETH has a fallback if the chain-data host itself fails — only the OFAC check is wrapped in `.catch()`.
- **`military` layer** is a placeholder — no adapter; shown disabled as "(soon)". Implement an adapter or remove the entry from `layerDefinitions` (`public/data.js`).
- **Alerting scope** — Slack alerts fire on ALL source failures (rate-limits tagged 🚫, other errors ⚠️), cooldown-throttled per source. If non-rate-limit noise is unwanted, add a rate-limit-only filter in `src/lib/notify.js`.
- **Optional Docker hardening** — Dockerfile runs as root; add `USER node`.
- **Test coverage gap** — covered (~74% overall): all `src/lib/*`, adapters `usgs`/`ports`/`eonet`/`opensky`/`recon`/`intel`, and `server.js` routing. Still near-zero (funcs 0%): adapters `cyber` (KEV/NVD/EPSS merge), `firms` (CSV parse), `telegram` (HTML geoparse), `space` (NOAA SWPC/N2YO), `maritime`, `news`. Partial remainders: `recon` UN/UK sanctions XML parsers (~lines 279–356) and `intel` VirusTotal/AbuseIPDB/GreyNoise lookups (need keys). The `mock-fetch.js` pattern extends to all; `telegram`/`cyber` are the higher-value next targets.
- **Frontend untested** — `public/app.js` (~1070 lines) and `public/data.js` have NO automated tests; verified only via manual Playwright. A browser-test harness would be a separate, larger effort.
- **Deploy prerequisite** — the documented deploy flow (`git clone` / `git pull`) means uncommitted fixes above must be committed + pushed before deploying, or the server pulls stale code.
