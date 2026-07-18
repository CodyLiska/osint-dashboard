# Next-Session Plan — three remaining issues

Written 2026-07-18. Fix these three, in this order:

1. **Frontend has no automated tests** (`public/app.js`, ~1,200 lines) — a refactor there wouldn't be caught by CI.
2. **ETH wallet lookup broken** — `eth.blockscout.com` was unreachable (HTTP 000) last session; BTC works.
3. **Ports cold-start-while-NGA-down still errors** — resilience serves stale only once something is cached; a cold boot while NGA is 503-ing has nothing to serve.

Everything below is grounded in the code as of commit `e12d3c1`. Line numbers may drift — re-grep if they don't match.

---

## 0. Session bootstrap (read first — saves time)

**Run / test:**
- `npm start` → server on `http://localhost:4173`.
- `npm test` → `node --test test/*.test.js` (78 tests, **zero npm deps** — keep it that way).
- Measure coverage: `node --test --experimental-test-coverage test/*.test.js`.

**Environment gotchas learned last session:**
- **`node` is not always on the PATH in Bash sub-shells / pipelines.** Use the full path when a bare `node` fails: `/Users/codyliska/.nvm/versions/node/v22.23.1/bin/node`. Same for `curl` → `/usr/bin/curl`.
- **The user often has their own server running on :4173.** Do NOT kill it. Run throwaway test servers on another port: `PORT=4199 node server.js &` and hit `http://127.0.0.1:4199`. Kill only that PID when done (`lsof -nP -i :4199`).
- **Foreground `sleep` may be blocked** — use a `Bash` `sleep` step or background tasks; don't `sleep` inside the app.
- **Browser verification = Playwright MCP.** Pattern that worked repeatedly:
  - `localStorage.clear()` then `location.reload()` to reset to default layers.
  - Seed state before reload: `localStorage.setItem("osiris.ui.v1", JSON.stringify({ enabled:[...ids], viewport:{center:[lon,lat], zoom} }))`.
  - To read module-internal `state`, add a **temporary** `window.__st = state;` right before `initMap();` at the bottom of `app.js`, verify, then **remove it** (grep `__st` to confirm it's gone).
  - Wait ~3–5 s after load for async layer fetches before asserting.
  - Clean up `.playwright-mcp/` and any screenshots afterwards.
- **Test-fetch mocking:** `test/helpers/mock-fetch.js` exports `installJsonFetch(objOrFn)` and `installFetch(objOrFn)` (the latter serves strings-as-text for XML/HTML). Both stub `globalThis.fetch` and clear the cache; call the returned restore fn in `finally`. For stateful mocks (e.g. 503-then-200), assign `globalThis.fetch` directly and import `clearCache` from `src/lib/cache.js`.
- **Resilience helpers already exist** (built last session, relevant to issue 3): `cachedResilient()` (dedup + stale-serve) and `fetchJsonRetry()`/`fetchTextRetry()`/`withRetry()` in `src/lib/{cache,http}.js`.

---

## Issue 1 — Frontend unit tests for `public/app.js`

### Why it's hard
`app.js` is a browser ES module: it references CDN globals (`maplibregl`, `deck`), uses `document`/`localStorage`/`window`, and **executes side effects at the bottom** (`initMap()`, `renderLayerControls()`, `setInterval(...)`, etc.). Importing it in Node crashes. Adding jsdom/Playwright as a test runner would introduce npm deps — against this project's zero-dep rule.

### Approach: extract pure logic → `public/logic.js`, unit-test with `node:test`
Move the DOM/deck-free functions into a new **side-effect-free** module `public/logic.js`, import them back into `app.js`, and test `public/logic.js` directly (Node can import it because it touches no browser globals). Rendering/DOM stays manually + Playwright-verified.

### Functions to extract (current `public/app.js` line refs)
Pure, move as-is or lightly parameterized:
- `escapeHtml` (`:970`) — trivial, used everywhere; export and re-import.
- `clusterPoints(rows, zoom)` (`:453`) — grid clustering. Already pure.
- `shouldCluster(id, rows, zoom)` (`:446`) — needs `CLUSTER_LAYERS` (`:85`), `CLUSTER_MIN_POINTS`, `CLUSTER_MAX_ZOOM`. Move those consts into `logic.js` and re-import into `app.js`.
- `byPriority(a, b)` (`:996`) — feed sort comparator.
- `detailRows(item)` (`:909`) — returns `[label, value]` pairs.
- `snapshotEntity(item)` (`:1405`) — trims an entity for export.
- `kvRow` (`:1156`), `extLink` (`:1161`), `sanctionDetail` (`:1167`), `intelLinks(kind,q)` (`:1235`), `cveDetail(row)` (`:1263`) — pure HTML/string builders.

Refactor into new pure helpers (extract the logic out of the stateful function):
- **Dead-reckoning math** — inside `deadReckonAircraft` (`:558`). Extract `advancePosition({lat, lon, velocity, track}, dtSeconds) → {lat, lon}` (the `dist = speed*dt`, `dLat`, `dLon` math). Keep the mutate-state loop in `app.js`, have it call the pure fn.
- **Severity filter** — inside `visibleEntities` (`:440`). Extract `filterBySeverity(rows, minSeverity) → rows`.
- **Feed aggregation** — inside `renderFeeds` (`:1001`). Extract `buildFeed(enabledIds, getVisible, { limit, perLayer }) → rows[]` where `getVisible(id)` returns that layer's visible entities. Keep the DOM render + click wiring in `app.js`.

### Steps
1. `git checkout -b frontend-logic-tests` (don't work on `main`).
2. Create `public/logic.js`; move the functions/consts above into it with `export`.
3. In `app.js`, add `import { escapeHtml, clusterPoints, shouldCluster, buildFeed, advancePosition, filterBySeverity, detailRows, snapshotEntity, kvRow, extLink, sanctionDetail, intelLinks, cveDetail, CLUSTER_LAYERS, CLUSTER_MIN_POINTS, CLUSTER_MAX_ZOOM } from "./logic.js";` and delete the now-moved definitions. Wire `deadReckonAircraft`/`visibleEntities`/`renderFeeds` to call the extracted helpers.
4. Write `test/frontend-logic.test.js` importing from `../public/logic.js`. High-value cases:
   - `advancePosition`: a 246 m/s aircraft on heading 112° over 4 s moves ~984 m east+south (this exact case was verified live last session — reuse it).
   - `clusterPoints`: N points in one grid cell at low zoom → 1 cluster with `count`; spread points → singles; splits as zoom increases.
   - `shouldCluster`: true only when `id ∈ CLUSTER_LAYERS && rows ≥ MIN && zoom < MAX`.
   - `buildFeed`: respects per-layer cap (≤4/layer), only enabled layers, severity→recency order, total ≤ limit. (This is the exact bug fixed last session — lock it in.)
   - `filterBySeverity`: drops rows below `minSeverity`, keeps all at `minSeverity=1`.
   - `sanctionDetail`/`cveDetail`/`intelLinks`: output contains the expected labels/links (e.g. cveDetail includes `nvd.nist.gov/vuln/detail`).
5. `npm test` — should stay green plus the new file. Then browser-smoke `app.js` (Playwright) to confirm the extraction didn't break rendering (toggle a layer, open a detail card, check the feed).

### What stays manually/Playwright-verified (document, don't test in CI)
`initMap`, `renderMap`, `buildIconLayer`, `showDetail`, `renderLayerControls`, map interactions — they need a real browser + deck.gl. Add a short **manual smoke checklist** to this file (toggle layers, cluster/uncluster by zoom, click map icon → detail, search an address, expand a sanctions/CVE result, Feeds tab). Do NOT add a browser test-runner dep.

### Effort: ~M (the extraction is mechanical but touches many spots; go function-by-function, run `node --check public/app.js` often).

---

## Issue 2 — ETH wallet lookup

### Current state
`src/adapters/recon.js`:
- `btcLookup` (`:109`) → `fetchJson("https://blockstream.info/api/address/{addr}")` — **works**.
- `ethLookup` (`:122`) → `fetchJson("https://eth.blockscout.com/api/v2/addresses/{addr}")` — **fails** (host unreachable, HTTP 000 last session).
- Both do `Promise.all([chainFetch, sanctionedCrypto().catch(()=>[])])`. **The chain fetch is NOT caught**, so if `eth.blockscout.com` fails the whole `ethLookup` rejects and the OFAC sanctioned result is lost too.
- Frontend `runWalletLookup` just `JSON.stringify`s `payload.data` and shows an **Etherscan** explorer link (set last session — reachable regardless of the data source). Any `data` shape is fine.

### Steps
1. **Diagnose first** from the homelab network (not the dev sandbox — it may be blocked only there): `curl -sS -m 15 -o /dev/null -w '%{http_code}\n' https://eth.blockscout.com/api/v2/addresses/0x0000000000000000000000000000000000000000`. If it's `200` there, the endpoint is fine and you only need step 3 (graceful degradation). If `000`/`5xx`, replace it (step 2).
2. **Replace the ETH data source** with a reachable keyless option (ranked):
   - **Public RPC, balance-only (most reliable, keyless):** `POST https://ethereum.publicnode.com` (or `https://cloudflare-eth.com`) body `{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<addr>","latest"]}` → `result` is hex wei. Convert to ETH for display. Simple + robust; no tx history.
   - **Blockchair (address stats, keyless, ~30 req/min):** `GET https://api.blockchair.com/ethereum/dashboards/address/{addr}` → richer (balance, counts).
   - **Ethplorer demo key (keyless):** `GET https://api.ethplorer.io/getAddressInfo/{addr}?apiKey=freekey` → ETH + tokens.
   - **Etherscan** only if you'll add a free `ETHERSCAN_API_KEY` to `.env`/`.env.example` (not keyless).
   Recommend the **public RPC balance** for reliability; add Blockchair as a nicer-data option if desired.
3. **Make it degrade gracefully** (do this regardless): restructure `ethLookup` so a failed chain fetch still returns the OFAC result:
   ```js
   const [chain, ofac] = await Promise.allSettled([...]) // or wrap the chain fetch in try/catch
   return { chain: "ETH", address, sanctioned: containsAddress(ofac, address), data: chainOk ? chainData : { error: chainErr.message } };
   ```
   Use `fetchJsonRetry` (timeout + retry) for the chain fetch. Apply the same pattern to `btcLookup` for symmetry.
4. **Test** (`test/adapter-recon.test.js`, extend it): mock fetch to (a) return chain data + assert `sanctioned` true/false via the OFAC XML fixture already in that file; (b) make the chain fetch throw and assert `ethLookup` still returns `{ sanctioned, data: { error } }` instead of rejecting.

### Effort: ~S. Note: `ethLookup`/`btcLookup` are **not** cached (per-address user lookups), so no `cachedResilient` needed — just `fetchJsonRetry` + the try/catch.

---

## Issue 3 — Ports cold-start fallback

### Current state
`src/adapters/ports.js`: `portsLayer` (`:111`) → `cachedResilient("nga:wpi", 24h, () => fetchJsonRetry(wpiUrl))` where `wpiUrl` (`:7`) is the NGA World Port Index. `cachedResilient` serves stale **only if a prior value is cached**. On a **cold boot while NGA is 503-ing**, nothing is cached → it throws → the client shows a "ports unavailable" error entity. NGA WPI data is public-domain U.S. Gov, so bundling a snapshot is fine.

### Approach: bundle a static fallback dataset used only on cold failure
1. **Generate the fallback (one-time, when NGA is up):** fetch the WPI, keep a useful subset (all Large/Medium harbors + first-ports-of-entry — a few hundred rows), write `public/data/ports-fallback.json`. Quick generator to run once:
   ```js
   // scratch: node this once when NGA responds, then commit the output file
   const r = await (await fetch("https://msi.nga.mil/api/publications/world-port-index?output=json")).json();
   const keep = (r.ports||[]).filter(p => ["L","M"].includes(String(p.harborSize).toUpperCase()) || String(p.firstPortOfEntry).toUpperCase()==="Y");
   require("fs").writeFileSync("public/data/ports-fallback.json", JSON.stringify({ dataset:"ports-fallback", updated:new Date().toISOString().slice(0,10), count:keep.length, ports:keep }));
   ```
2. **Load it server-side** the same way the gazetteer does — see `src/lib/gazetteer.js:12`: `JSON.parse(readFileSync(new URL("../../public/data/ports-fallback.json", import.meta.url), "utf8"))`. Load once at module top of `ports.js`.
3. **Wire the fallback:** wrap the `cachedResilient(...)` call in try/catch. On throw (cold + upstream down), use the bundled `ports` array and set `meta.stale = true` and `meta.fallback = true`. The `.layer-row.flagged` ⚠ indicator already keys on `meta.stale`, so this surfaces automatically ("Showing cached data — upstream currently unavailable").
   ```js
   let result;
   try { result = await cachedResilient("nga:wpi", 24*60*60_000, () => fetchJsonRetry(wpiUrl)); }
   catch { result = { value: { ports: fallbackPorts }, cached: true, stale: true, fallback: true }; }
   ```
   Then read `result.value.ports` as today; add `fallback: Boolean(result.fallback)` to `meta`.
4. **Test** (`test/adapter-ports.test.js`, extend it): with `clearCache()` and a mock `globalThis.fetch` that always 503s → assert `portsLayer()` returns the fallback entities (length > 0) and `meta.stale === true && meta.fallback === true` (instead of rejecting). The existing retry-then-503 test already covers the retry path.

### Effort: ~S–M (mostly generating + committing the fallback JSON). Keep the subset small (a few hundred KB max) — don't commit all 2,951 ports.

---

## Suggested order
1. **Issue 3 (ports fallback)** — smallest, highest user-visible value, isolated to one adapter.
2. **Issue 2 (ETH)** — small, self-contained; verify reachability first.
3. **Issue 1 (frontend tests)** — largest; do on its own branch; run `node --check` constantly during the extraction.

Each on its own branch off `main`; keep `npm test` green; browser-smoke after frontend changes. When done, update `CLAUDE.md` (remove the resolved known-issues) and this file.
