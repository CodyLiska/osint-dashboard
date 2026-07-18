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
- No committed test suite yet (geoparse + sanctions-cross-check were verified via throwaway node scripts).
- Still NOT promoted/deployed: when feature-stable, relocate to `06_Production_Apps/Homelab_Sever/` and deploy per `docs/DEPLOY.md`.
