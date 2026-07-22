# OSIRIS — Work Plan

Outstanding work organized by **workstream** (how to work it), not by key status
(how it was audited — that audit is preserved as the appendix at the bottom).

**Organizing principles:**
1. The 40 sources built on 2026-07-22 are **dormant until shipped** → deploy is P0.
2. "Keyed" ≠ "blocked" — it's *waiting on a free registration*: a Cody action → then a build batch.
3. Imagery-that-needs-tiling clusters into **one infra epic** regardless of key status.

**Critical path:** A first. Then B and C-Tier-1 can run in parallel (B needs nothing;
C-Tier-1 just needs ~5 free keys in `.env`). D is a separate focused project. E/F are background.

---

## A — Ship what's built  ·  P0 (blocks everything's value)

Nothing new should stack on an unverified base.

- [ ] Commit this session (40 sources, 399 tests) — draft message written in-session
- [ ] **Redeploy** to the homelab (working tree is ahead of the deployed image incl. `b7f9bc6`)
- [ ] **Homelab post-deploy verification:**
  - [ ] persistence store writing (`/api/changes`, `/app/data`)
  - [ ] alerting posture (`docker compose logs | grep '[alerts]'`)
  - [ ] AISStream reachability *from the server* (`nc -z -w 8 stream.aisstream.io 443` — blocked from the Mac)
  - [ ] Playwright the Phase 5 scrubber + map replay (needs `OSIRIS_DB_PATH` set)
- [ ] **Close the 3 open API keys** (`docs/API-KEY-STATUS.md`):
  - [ ] UCDP — activate the token
  - [ ] ReliefWeb — real `RELIEFWEB_APPNAME` once approved
  - [ ] AISStream — re-check reachability on `ubuntu-g2`

## B — Keyless build batch  ·  P1 (zero external dependency — verify-first works)

The only "just build it" bucket. **Worked 2026-07-22 — probing killed 5 of 7; the 2 real wins shipped.**

- [x] **Map layer:** Submarine Cable Map (§1) — DONE. 717 cables as the app's first deck.gl LINE layer (`src/adapters/cables.js`, `PathLayer`), Infrastructure group. Live-fetched (not bundled — clean GeoJSON).
- [x] **Social recon:** Mastodon (§5) — DONE. New "Social" tab, keyless public hashtag timeline (`src/adapters/social.js`).
- [~] **Reclassified / dropped on probing** (see `FUTURE-DATA-SOURCES.md`):
  - World Bank Debarred (§2) → **keyed** (API gated, 401) → moved to Group C
  - ECDC (§13) → deferred (no clean keyless endpoint; EU-only) → Group F
  - Nextstrain (§13) → skipped (phylogeny trees, not situational) → Group F
  - NASA DONKI (§10) → skipped (redundant with the `space` layer) → Group F
  - V-Dem / Freedom House (§11) → **still open** (annual dataset downloads, low value; unprobed — do last if ever)

## C — Key-gated build batch  ·  P2 (gated on Cody registering free keys)

Skill-ready — same pattern as the 10 working keyed sources. Sequence: **Cody registers → I build the adapter + activate its `.env.example` placeholder → Cody pastes the key → I verify.** The **shopping list with registration URLs + effort tags lives at the bottom of `.env.example`** ("KEYS TO ACQUIRE"). Effort tags below: `[instant]` self-serve in minutes · `[self-serve]` account + steps · `[approval]` email/application/manual grant.

- [ ] **Already wired — just add the key (no build):**
  - [ ] **Full OpenSanctions** (§2) — set the existing `OPENSANCTIONS_API_KEY`; upgrades Sanctions search from the OFAC/UN/UK mirror to the hosted API (EU lists + PEPs). `[self-serve]`
- [ ] **Tier 1 (do these — easy free-reg, high value):**
  - [ ] FRED (§8) `[instant]` → Econ tab
  - [ ] EIA (§8) `[instant]` → Econ tab
  - [ ] OpenAQ (§1) `[instant]` → air-quality layer
  - [ ] AlienVault OTX (§2) `[instant]` → Intel fan-out (today just a pivot link)
  - [ ] ACLED (§1) `[approval]` → makes the static `conflict.json` live/credible (needs key **+** registered email)
- [ ] **Tier 2 (if wanted):**
  - [ ] OpenCellID (§12) `[self-serve]` · Electricity Maps (§12) `[self-serve]` · Global Forest Watch (§9) `[self-serve]` · UN Comtrade (§8) `[self-serve]`
  - [ ] OpenCorporates (§5) `[approval]` → Entity tab · ENTSO-E (§12) `[approval]` · HealthMap (§13) `[approval]` · WOAH (§13) `[approval]` · IFES ElectionGuide (§11) `[approval]`
  - [ ] World Bank Debarred (§5) `[approval]` → entity-screening (reclassified keyed 2026-07-22: WB API-gateway subscription, 401 without)
- [ ] **Not a key / skip:**
  - GEM (§12) — NOT a keyed API (dataset download/request); re-probe before treating as Group C
  - HIBP (§5) — paid, skip

## D — Imagery tiling epic  ·  mostly DONE; COG part PARKED (decided 2026-07-22)

**Probing collapsed this epic.** GIBS serves GOES pre-tiled, so geostationary near-real-time
was a raster add, not COG tiling. Combined with the earlier "Scenes" thumbnails, the core
imagery value is delivered without breaking the zero-dep / single-container rule.

- [x] **NOAA GOES** (§14) — DONE. `gibs-goes-east` + `gibs-goes-west` GeoColor raster layers
      (GIBS WMTS, `today: true` near-real-time date mode). No tiling needed. Band13 IR / Dust /
      FireTemp are one-row follow-ons if wanted.
- [x] *(earlier)* "Scenes" tab — recent Sentinel-2 10m thumbnails per location (no tiler).
- [~] **PARKED — full-res COG-on-map** (decided *defer* 2026-07-22): overlaying full-res
      Sentinel-2 `visual` / Umbra / Maxar / Landsat / Copernicus **as live map layers** needs COG
      tiling (titiler sidecar = 2nd container, or client-side geotiff.js = heavy browser lib) —
      both break a core rule for ~20% more value over the thumbnails. **Trigger to revisit:** a
      real need to overlay/zoom full-res imagery on the map in context with other layers.

## E — Layout polish  ·  opportunistic (non-blocking)

The 4 open `docs/PLAN-layout.md` questions — one tiny UX pass if the pane ever feels off.

- [ ] Overlay dismissible by clicking the map? (leaning no)
- [ ] Opening a recon tab from elsewhere auto-opens the pane? (only if deep-links are added)
- [ ] Is 390px still right now that it floats? (a one-line `--recon-width` change)
- [ ] Does the left pane want the overlay treatment too? (probably not — in continuous use)

## F — Parked (revisit only on an external trigger)

- **Deferred** (viable but blocked):
  - APRS.fi — needs a "Signals" recon tab + `APRS_FI_API_KEY`; keyed response unverifiable from here
  - Hudson Rock Cavalier — re-probe when the host recovers (was timeout/502 at build)
  - CertStream — needs a persistent server-side WebSocket collector
  - Safecast — needs the realtime/device endpoint (the archive API has no live pulse)
  - CDC Socrata (wastewater) — needs a county-FIPS→centroid table (US-only, no lat/lon)
- **Dead** (won't easily revisit): FCC ULS (API decommissioned), PhishTank (Cloudflare + key), disease.sh + WHO (no live keyless signal)
- **Skipped:** IAEA PRIS (no API; WRI covers nuclear)
- **Hardware** (only if the homelab gets an RTL-SDR): §4a SDR rows (ADS-B, AIS, APRS, rtl_433, ACARS, NAVTEX, P25, GSM…)

---

# Appendix — source audit by key status (as of 2026-07-22)

> Reference snapshot as of 2026-07-22. The source of truth is the `DONE`/`DEFERRED`/`DEAD`
> markers in `docs/FUTURE-DATA-SOURCES.md`. **42 sources implemented; every unmarked row
> below is genuinely untouched.** (Group B built Submarine Cable Map + Mastodon and
> reclassified World Bank Debarred to keyed — reflected below.)

## KEYLESS (untouched → Group B, except the tiling ones → Group D)

- §11 V-Dem / Freedom House (unprobed; annual datasets, low value — do last if ever)
- §13 ECDC (no clean endpoint found — deferred → F) + Nextstrain (phylogeny trees, not situational — skipped → F)
- §14 NOAA GOES (needs tiling → D), Umbra / Maxar Open Data / OpenAerialMap (needs tiling → D)
- ~~§1 Submarine Cable Map~~ **DONE** (Group B) · ~~§5 Mastodon~~ **DONE** (Group B)

## KEYED (untouched → Group C)

- §1 ACLED, OpenAQ
- §2 Full OpenSanctions *(already wired — just add the key)*, AlienVault OTX
- §5 HIBP (paid — skip), OpenCorporates, **World Bank Debarred** *(reclassified keyed 2026-07-22)*
- §8 EIA, FRED, UN Comtrade
- §9 Global Forest Watch
- §11 IFES ElectionGuide
- §12 ENTSO-E, Electricity Maps, OpenCellID  ·  **GEM = not a keyed API (dataset), skip**
- §13 HealthMap, WOAH
- §14 Copernicus, Landsat, Planet NICFI (need tiling → D)
- ~~§10 NASA DONKI~~ skipped (redundant with the `space` layer → F)

## HARDWARE (→ Group F)

- §4a SDR rows (ADS-B, AIS, APRS, rtl_433, ACARS, NAVTEX, P25, GSM…)

## DEFERRED — viable but blocked, revisit-able (→ Group F)

- APRS.fi — keyed + per-callsign (recon-shaped, no home yet); keyed response unverifiable
- Hudson Rock Cavalier — host was down at build (timeout/502)
- CertStream — WebSocket stream, doesn't fit the request/response model
- Safecast — API live but returns a frozen 2019/2022 archive, no live pulse
- CDC Socrata (wastewater) — live but US-only, FIPS-keyed, no lat/lon

## DEAD — won't easily revisit (→ Group F)

- FCC ULS (API decommissioned)
- PhishTank (Cloudflare + key)
- disease.sh + WHO

## SKIPPED

- IAEA PRIS (no API; WRI covers nuclear)
