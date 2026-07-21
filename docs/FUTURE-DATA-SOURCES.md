# Future Data Sources

Candidate feeds to make OSIRIS more robust (fewer single points of failure, richer
enrichment) and more complete (new intelligence domains). Ranked bias: **keyless-first**,
because every keyed source is another secret in `.env` behind the no-auth LAN proxy.

Nothing here is committed to. This is a planning catalog — drill into any row before building.

## Legend

- **Key** — `none` (keyless) · `free-reg` (free but needs registration/key) · `paid` · `demo` (shared demo key, rate-limit risk)
- **License** — usage terms that matter if OSIRIS ever leaves the homelab
- **Reliability** — subjective risk of throttling / instability based on how the source is offered
- **Effort** — rough build cost: new adapter + layer, or a recon-tab query, or just an enrichment call
- **Integration** — `layer` (renders on the map: adapter → `data.js`/`layers.js`) · `recon` (query in a recon tab) · `enrich` (per-IP/indicator lookup, no map presence)

---

## Status (updated 2026-07-20)

**27 sources implemented across 5 batches** — see the `DONE` markers on the rows below. 0 deferred, 1 skipped for having no API (`IAEA PRIS`, see §12). Both 2026-07-19 deferrals were cleared on 2026-07-21: `ransomware.live` via its keyless RSS feed, `GPSJam` via a build-time H3 centroid table. **Both deferral notes had named the wrong cause** — a deferral note goes stale exactly like a catalog row, so re-probe before trusting one.

### GPSJam: how H3 cells get placed (build-time centroid table)

GPSJam keys its data by H3 resolution-4 cell id with no coordinates.
`cellToLatLng` is the H3 algorithm — icosahedral face lookup, gnomonic
projection, IJK coordinates — so rather than hand-port several hundred lines of
maths that fails *silently* when subtly wrong, the conversion is done once
against the real library and the runtime ships a lookup table.

- **Build:** `npm install --no-save h3-js && node scripts/build-h3-centroids.mjs`,
  then `rm -rf node_modules`. `h3-js` is deliberately never added to
  `package.json`; the server stays zero-dep and the table is regenerated only if
  H3 changes its encoding (which the script asserts, rather than assumes).
- **Encoding was chosen by measurement**, not estimate. At 288,122 cells: naive
  JSON keyed by the full 15-char id is **16 MB**, short-keyed JSON is **6.3 MB**,
  the shipped binary is **2.2 MB**. Every id is `84` + 5 variable hex chars +
  `ffffffff`, so the key is 20 bits and fits a uint32; coordinates are int16
  scaled ×100 (~1.1 km, against cells ~22 km across). The binary also needs no
  `JSON.parse`, so the server holds one Buffer instead of a 288k-key object —
  which matters on a homelab container.
- **Lookup** is a binary search over the sorted keys (`src/lib/h3.js`), not a
  Map, for the same heap reason.
- **Validated against the source of truth:** 5,002 random cells round-tripped
  against `h3-js` with 0 misses and a worst deviation of 557 m — exactly the
  ×100 rounding half-step, i.e. quantisation only, no algorithmic error. On live
  data `meta.unmappedCells` is **0**, and the worst-interference cells land on
  Kaliningrad, the Black Sea and Kashmir — the documented jamming hotspots,
  which is the check that would fail loudly if the decoding were wrong.

- **Batch 1 (core keyless):** GDELT, abuse.ch (ThreatFox / URLhaus / Feodo), Shodan InternetDB, CelesTrak.
- **Batch 2 (hazards + conflict / cyber-IP):** GDACS, UCDP GED (optional-keyed), NWS warning polygons; Tor exit, Spamhaus DROP, MalwareBazaar (optional-keyed), crt.sh.
- **Batch 3 (internet health / cyber-deepening):** RIPEstat, IODA, Cloudflare Radar (optional-keyed); URLScan.io, Ransomwhere, CISA ICS advisories, VulnCheck (optional-keyed).
- **Batch 4 (air domain):** adsb.lol military aircraft (upgraded the `military-air` layer off the OpenSky heuristic).
- **Batch 5 (critical infra + humanitarian):** WRI power plants (bundled static), OpenInfraMap via Overpass, US State Dept travel advisories; ReliefWeb (optional-keyed).

> **Probe before trusting a row in this file.** Batch 5 found three of its five
> candidate rows stale: ReliefWeb v1 is decommissioned (410) and v2 is
> registration-gated, IAEA PRIS has no API at all, and the WRI "dataset" is a
> 12MB CSV inside a ZIP. The `Key: none` column reflects what was true when the
> row was written, not what is true today.

Cross-cutting **Historical persistence (`node:sqlite`)** is also DONE (with the read API + "What Changed" panel). Still open cross-cutting: alert-rules engine, cross-source correlation, MITRE ATT&CK mapping.

Reusable infra unlocked along the way: the layer registry (one row + one adapter per source), the `/api/intel/ip` and `/api/intel/domain` fan-outs, the `deck.PolygonLayer` render path (NWS), the two-body orbit propagator, and the shared country-centroid lookup (IODA / Cloudflare).

---

## 1. Map-layer sources (render on the map)

These wire in like existing layers: one adapter normalizing to `{ entities, meta }`, plus
`data.js` / `layers.js` registration and an icon.

| Source                  | Domain                  | Endpoint                              | Key      | License                          | Reliability                                | What it adds                                                                                                                                                                                                                                                                         | Effort                       |
| ----------------------- | ----------------------- | ------------------------------------- | -------- | -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **GDELT 2.0**           | Global events / news    | `api.gdeltproject.org` (Events + GKG) | none     | Open, attribution                | Good — stable, updates ~15 min             | DONE 2026-07-19 as a keyless map layer (`gdelt.js`, via GDELT's static Events file feed since the GEO GeoJSON API is dead). Georeferenced global event stream with tone/theme tags; complements NewsAPI headlines with mapped events                                                                                                                                 | Medium (new adapter + layer) |
| **ACLED**               | Armed conflict events   | `api.acleddata.com`                   | free-reg | **Non-commercial + attribution** | Good                                       | Authoritative georeferenced conflict events. Makes the static `conflict.json` live and credible                                                                                                                                                                                      | Medium                       |
| **UCDP GED**            | Armed conflict events   | `ucdpapi.pcr.uu.se`                   | none     | Open, attribution                | Good                                       | DONE 2026-07-19 as an OPTIONAL-KEYED layer (`ucdp.js`). NOTE: API now needs a free access token (401 x-ucdp-access-token) — catalog `none` is stale. Graceful-off when unset; GDELT is the keyless conflict answer                                                                   | Medium                       |
| **GDACS**               | Global disasters        | `gdacs.org` (GeoJSON/RSS)             | none     | Open                             | Good                                       | DONE 2026-07-19 as a keyless map layer (`gdacs.js`); alertlevel→severity, stable eventid, persist:true. Floods/quakes/cyclones/droughts/volcanoes                                                                                                                                    | Medium                       |
| **NOAA / NWS**          | Severe weather (US)     | `api.weather.gov`                     | none     | US Gov public domain             | Good                                       | DONE 2026-07-19 as a keyless POLYGON layer (`nws.js`), the app's first non-point deck layer. Keeps alerts with real geometry + centroid for cluster/feed/detail. Severe-weather warning polygons (CONUS)                                                                             | Medium                       |
| **CelesTrak**           | Satellites (orbital)    | `celestrak.org` (TLE/JSON)            | none     | Open, attribution                | Good                                       | DONE 2026-07-19 as the keyless space-layer satellite fallback. CelesTrak serves orbital _elements_, not positions, so `src/lib/orbit.js` propagates them with a zero-dep two-body model (approximate; validated <0.2deg vs operational GEO sats). Used when `N2YO_API_KEY` is absent | Medium                       |
| **adsb.fi / adsb.lol**  | Military aircraft       | `api.adsb.fi`, `api.adsb.lol`         | none     | Open (community)                 | Medium — community-run, best-effort uptime | DONE 2026-07-19 via adsb.lol (`adsb.js`) as the `military-air` source with OpenSky fallback; adds real aircraft types + better coverage. NOTE: adsb.fi `/v2/mil` 404s now; adsb.lol is primary                                                                                                                                            | Medium                       |
| **Feodo Tracker**       | Botnet C2 IPs           | `feodotracker.abuse.ch`               | none     | CC0                              | Good                                       | DONE 2026-07-19 as an IP-intel C2 enricher (`feodoLookup` in `intel.js`, in the `/api/intel/ip` fan-out). Keyless blocklist has no coords + few entries, so it flags a queried IP as a known C2 rather than being a map layer                                                        | Low–Medium                   |
| **OpenAQ**              | Air quality             | `api.openaq.org`                      | free-reg | Open                             | Good                                       | Global air-quality stations. Cheap environmental / CBRN-adjacent signal                                                                                                                                                                                                              | Medium                       |
| **Submarine Cable Map** | Internet infrastructure | TeleGeography dataset                 | none     | Attribution (check terms)        | Medium — dataset, not a live API           | Submarine cable routes + landing points. Thematically pairs with the maritime chokepoints layer                                                                                                                                                                                      | Medium                       |

## 2. Recon-tab sources (query by name/indicator)

These slot into a recon tab like the existing sanctions / CVE / crypto queries.

| Source                  | Domain                 | Endpoint                 | Key                        | License                      | Reliability | What it adds                                                                                                                                                                                        | Effort     |
| ----------------------- | ---------------------- | ------------------------ | -------------------------- | ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Full OpenSanctions**  | Sanctions / PEPs       | `api.opensanctions.org`  | free-reg (self-host: none) | CC-BY-NC (commercial = paid) | Good        | Expands current OFAC/UN/UK to EU lists, PEPs, more entities — same query shape you already built                                                                                                    | Low–Medium |
| **World Bank Debarred** | Corruption / debarment | World Bank listing       | none                       | Open                         | Good        | Firms/individuals barred from World Bank contracts — entity-screening dimension                                                                                                                     | Low        |
| **URLhaus**             | Malicious URLs         | `urlhaus-api.abuse.ch`   | free-reg                   | CC0                          | Good        | DONE 2026-07-19 as an optional-keyed source in the `/api/intel/ip` fan-out (`urlhausHostLookup`, reuses `ABUSE_CH_AUTH_KEY`). Malicious-URL host lookup. NOTE: the API now needs a free abuse.ch Auth-Key (401 without); keyless only via the ~10MB bulk feed | Low–Medium |
| **ThreatFox**           | IOCs (IP/domain/hash)  | `threatfox-api.abuse.ch` | free-reg                   | CC0                          | Good        | DONE 2026-07-19 as an optional-keyed source in the `/api/intel/ip` fan-out (`threatFoxLookup`, reuses `ABUSE_CH_AUTH_KEY`). IOC search. NOTE: the API now needs a free abuse.ch Auth-Key (401 without)                                                        | Low–Medium |
| **AlienVault OTX**      | Threat pulses          | `otx.alienvault.com/api` | free-reg                   | Free                         | Good        | Pull threat pulses (currently only a pivot link). Community threat context by indicator                                                                                                             | Low–Medium |

## 3. Enrichment sources (per-IP / per-indicator, no map presence)

Cheap enrichers that augment existing Intel-tab IP lookups. No new layer, no new tab —
just extra fields on a result.

| Source                  | Domain          | Endpoint                           | Key  | License               | Reliability | What it adds                                                                                                 | Effort |
| ----------------------- | --------------- | ---------------------------------- | ---- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| **Shodan InternetDB**   | Exposed hosts   | `internetdb.shodan.io`             | none | Free (fair use)       | Good        | DONE 2026-07-19 (`shodanInternetDb` in the `/api/intel/ip` fan-out). Per-IP open ports / CVEs / tags, the "what's exposed on this host" dimension without a paid Shodan key      | Low    |
| **Tor exit list**       | Anonymity infra | `check.torproject.org` (exit list) | none | Open                  | Good        | DONE 2026-07-19 (`torExitLookup` in the `/api/intel/ip` fan-out). Flags a queried IP that is a Tor exit node | Low    |
| **Spamhaus DROP/EDROP** | Bad netblocks   | `spamhaus.org/drop`                | none | Free (non-commercial) | Good        | DONE 2026-07-19 (`spamhausDropLookup`, CIDR-containment). Flags IPs in hijacked / do-not-route netblocks     | Low    |

## 4. Radio / SIGINT sources

These span integration types, so an **Integration** column is added.

| Source          | Endpoint                                | Key      | License              | Reliability                 | Integration    | What it adds                                                                                                                    | Effort     |
| --------------- | --------------------------------------- | -------- | -------------------- | --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **GPSJam**      | `gpsjam.org/data/*.csv`                 | none     | Open                 | Good                        | layer          | DONE 2026-07-21 (`gpsjam` layer, keyless). The 2026-07-19 note was wrong about the format — it is **gzipped CSV, never JSON**, which is why every `.json` probe 404'd. Rows are keyed by **H3 res-4 cell id** with no coordinates, resolved via a bundled build-time centroid table (`src/lib/h3.js`, see §GPSJam note below). Filtered to ≥5 aircraft and ≥2% bad ratio → ~1,500 cells/day with real severity spread | Medium     |
| **APRS.fi**     | `api.aprs.fi`                           | free-reg | Free non-commercial  | Good                        | layer          | Live amateur-radio station positions (APRS-IS). Ground-based emitter presence                                                   | Medium     |
| **SatNOGS**     | `network.satnogs.org`, `db.satnogs.org` | none     | Open                 | Good                        | layer / recon  | Open satellite ground-station network + radio observation DB. Pairs with the satellite layer                                    | Medium     |
| **FCC ULS**     | `fcc.gov` ULS (bulk / query)            | none     | US Gov public domain | Good                        | recon / enrich | US transmitter/callsign license DB — resolve a callsign or licensee to location                                                 | Low–Medium |
| **PSKReporter** | `pskreporter.info`                      | none     | Free                 | Medium — query-rate limited | layer / recon  | Ham-radio reception + HF propagation reports. Signal-propagation / activity picture                                             | Medium     |

### 4a. Local SDR collection (self-hosted, RTL-SDR)

Not APIs — **decoder software** run as sidecar processes on the homelab server, emitting
local JSON/MQTT that an OSIRIS adapter ingests. Turns OSIRIS from an API consumer into a
sensor platform. Coverage = antenna + line-of-sight; a feed reports `configured:true` only
when the local decoder is running. Key/License columns don't apply — cost is hardware +
setup. Reference dongle: **RTL-SDR v3** (~500 kHz–1.766 GHz, HF via direct sampling).

| Signal                    | Freq                  | Decoder                          | Feeds / new layer                                                                | Legal                                                                                       | Effort                   |
| ------------------------- | --------------------- | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| **ADS-B aircraft**        | 1090 MHz              | `dump1090-fa` / `readsb`         | Existing **aviation** layer (local ground truth, no OpenSky dependency)          | Fine                                                                                        | Low — best first project |
| **UAT aircraft (US)**     | 978 MHz               | `dump978`                        | Aviation (general-aviation + weather uplink)                                     | Fine                                                                                        | Low                      |
| **AIS ships**             | 161.975 / 162.025 MHz | `rtl-ais` / AISdecoder           | Existing **maritime** layer (local ground truth)                                 | Fine                                                                                        | Medium — 2-channel       |
| **APRS**                  | 144.39 MHz            | `direwolf`                       | §4 **APRS** layer, self-collected                                                | Fine                                                                                        | Medium                   |
| **rtl_433 ISM**           | 433 / 915 MHz         | `rtl_433`                        | NEW local-sensor layer: weather stations, **TPMS** (vehicle IDs), utility meters | Privacy-sensitive (TPMS = trackable IDs)                                                    | Low — JSON/MQTT out      |
| **ACARS / VDL2**          | 131 / 136 MHz         | `acarsdec` / `dumpvdl2`          | NEW aircraft-ops-message feed                                                    | Receive OK; divulging content grey                                                          | Medium                   |
| **NOAA APT weather sat**  | 137 MHz               | `satdump` / `wxtoimg`            | Satellite imagery → space layer                                                  | Fine                                                                                        | Medium                   |
| **SAME / EAS alerts**     | 162.4–162.55 MHz      | `multimon-ng`                    | Emergency alerts (ties §1 NWS)                                                   | Fine                                                                                        | Low                      |
| **NAVTEX**                | 518 kHz (HF)          | YaND / `multimon-ng`             | Maritime navigational warnings                                                   | Fine                                                                                        | Medium                   |
| **HFDL oceanic aircraft** | HF (direct sampling)  | `dumphfdl`                       | Aviation — fills ADS-B ocean gaps                                                | Receive OK                                                                                  | Medium–High              |
| **WSPR / FT8**            | HF                    | WSJT-X                           | Propagation / ham activity (ties §4 PSKReporter)                                 | Fine                                                                                        | Medium                   |
| **POCSAG / FLEX pagers**  | VHF / UHF             | `multimon-ng`                    | —                                                                                | ⚠ **Legally sensitive** — decoding/divulging often illegal (US ECPA). Research/receive-only | —                        |
| **P25 / trunked**         | VHF / UHF             | OP25 / SDRTrunk / trunk-recorder | —                                                                                | ⚠ **Legally sensitive** + often encrypted. Research only                                    | —                        |
| **GSM control channels**  | 900 / 1800 MHz        | `gr-gsm`                         | —                                                                                | ⚠ **Legally sensitive** — traffic decode illegal; tower-ID grey. Research only              | —                        |

**Pattern:** decoder sidecar → local JSON/MQTT/HTTP → OSIRIS adapter (`{entities, meta}`,
`configured` gated on feed presence). ADS-B / AIS / APRS local collection is a _robustness_
win — it removes the external-API single point of failure for layers you already ship.

## 5. Person / Entity OSINT sources

Breach data and social/entity resolution. **Note:** several sources here carry
privacy/legal weight — breach and social data on individuals should stay LAN-only and be
handled deliberately, not scattered on a public map.

| Source                   | Endpoint                      | Key      | License              | Reliability                     | Integration    | What it adds                                                                                   | Effort     |
| ------------------------ | ----------------------------- | -------- | -------------------- | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| **Hudson Rock Cavalier** | `cavalier.hudsonrock.com`     | none     | Free                 | Good                            | recon          | Keyless infostealer-infection check by email / domain / username. Strong keyless breach signal | Low–Medium |
| **Have I Been Pwned**    | `haveibeenpwned.com/api/v3`   | paid     | Commercial           | Good                            | recon          | Breach exposure by email / domain. The reference breach source                                 | Low        |
| **Gravatar**             | `gravatar.com/{hash}`         | none     | Free                 | Good                            | enrich         | Email → public profile / avatar / linked accounts                                              | Low        |
| **GitHub API**           | `api.github.com`              | free-reg | Free                 | Good                            | recon / enrich | Username or email → repos, activity, associated identities                                     | Low        |
| **Wikidata**             | `query.wikidata.org` (SPARQL) | none     | CC0                  | Good                            | recon / enrich | Structured facts on people / orgs — entity resolution and disambiguation                       | Medium     |
| **OpenCorporates**       | `api.opencorporates.com`      | free-reg | CC-BY-SA             | Medium — rate-limited free tier | recon          | Company registry data, officers, jurisdictions. Corporate/beneficial-ownership dimension       | Medium     |
| **SEC EDGAR**            | `data.sec.gov`                | none     | US Gov public domain | Good                            | recon          | US company filings, ownership, insiders — keyless corporate OSINT                              | Medium     |
| **Mastodon**             | instance `/api/v1`            | none     | Varies by instance   | Medium                          | recon / layer  | Federated public-post search (X/Twitter free API is gone). Social-signal layer                 | Medium     |

## 6. Internet / telecom health

Fills the gap between the cyber and geospatial layers — where is the internet itself
degraded or under attack.

| Source               | Endpoint                           | Key      | License          | Reliability | Integration    | What it adds                                                                                                            | Effort     |
| -------------------- | ---------------------------------- | -------- | ---------------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Cloudflare Radar** | `radar.cloudflare.com` API         | free-reg | Free (API token) | Good        | layer / recon  | DONE 2026-07-19 as an optional-keyed outage layer (`cloudflare.js`, CLOUDFLARE_API_TOKEN) with outage-cause metadata; graceful-off                                                 | Medium     |
| **RIPEstat**         | `stat.ripe.net/data`               | none     | Open             | Good        | recon / enrich | DONE 2026-07-19 (`ripeStatLookup` in the `/api/intel/ip` fan-out). ASN + prefix + AS holder per IP; keyless network-forensics pivot          | Low–Medium |
| **IODA**             | `ioda.inetintel.cc.gatech.edu` API | none     | Open             | Good        | layer          | DONE 2026-07-19 as a keyless map layer (`ioda.js`); country-level outages geolocated via a bundled country-centroid dataset. Maps internet shutdowns onto conflict zones | Medium     |

## 7. Cyber threat — deeper

Extends §1 Feodo / §2 URLhaus·ThreatFox with victim + phishing intelligence.

| Source                  | Endpoint                  | Key      | License               | Reliability                   | Integration    | What it adds                                                                                                                                                                                           | Effort     |
| ----------------------- | ------------------------- | -------- | --------------------- | ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **ransomware.live**     | `ransomware.live/rss.xml` | none     | Free                  | Good                          | layer          | DONE 2026-07-21 (`ransomware` layer, keyless). The 2026-07-19 deferral was half right: the JSON API did move — it is now `api-pro.ransomware.live` behind a free-but-required key — but the **RSS feed is keyless and carries everything needed** (victim, group, ISO2 country, disclosure time, last 200). Placed on country centroids; 5 of 200 carry `N/A` country and are dropped rather than guessed | Low–Medium |
| **OpenPhish**           | `openphish.com/feed.txt`  | none     | Free (community feed) | Good                          | recon / enrich | Active phishing-URL feed. Flag/enrich indicators against live phishing infra                                                                                                                           | Low        |
| **PhishTank**           | `phishtank.org` API       | free-reg | Free                  | Medium — key issuance limited | recon          | Community-verified phishing URL lookup                                                                                                                                                                 | Low        |
| **MalwareBazaar**       | `bazaar.abuse.ch` API     | none     | CC0                   | Good                          | recon / enrich | DONE 2026-07-19 as an optional-keyed Intel-tab "File hash" lookup (`malwareBazaarLookup`, reuses `ABUSE_CH_AUTH_KEY`). Completes the abuse.ch suite                                                    | Low        |
| **crt.sh**              | `crt.sh`                  | none     | Open                  | Good                          | recon          | DONE 2026-07-19 in the new Intel-tab domain fan-out (`crtShLookup`/`domainIntel`, `/api/intel/domain`). Keyless subdomain enumeration; rides cachedResilient + allSettled since crt.sh is flaky (502s) | Low        |
| **CertStream**          | `certstream` (WebSocket)  | none     | Free                  | Medium — WS stream            | recon / layer  | Live feed of newly-issued TLS certs → phishing / typosquat domain detection                                                                                                                            | Medium     |
| **CISA ICS Advisories** | `cisa.gov/ics` (RSS/JSON) | none     | US Gov public domain  | Good                          | recon / layer  | DONE 2026-07-19 (`icsAdvisories`, keyless RSS). Cyber-tab keyword "ics" returns CISA OT/ICS advisories in the CVE result shape                                                                                                                             | Low        |
| **URLScan.io**          | `urlscan.io/api`          | free-reg | Free                  | Good                          | recon          | DONE 2026-07-19 (`urlScanLookup` in the `/api/intel/domain` fan-out; keyless public search). Recent scans: resolved IPs, hosting countries, page titles                                                                                                                                 | Low–Medium |
| **VulnCheck**           | `api.vulncheck.com`       | free-reg | Free community        | Good                          | recon / enrich | DONE 2026-07-19 as optional-keyed (`vulnCheckKev`, VULNCHECK_API_TOKEN). Cyber-tab keyword "vulncheck"; graceful-off                                                                                                                 | Low–Medium |
| **Ransomwhere**         | `ransomwhe.re`            | none     | Open                  | Good                          | recon          | DONE 2026-07-19 (`ransomwhereAddresses` cached-set check in btc/ethLookup). Flags a wallet as a known ransomware payment address next to the OFAC verdict                                                                                                                           | Low        |

## 8. Economic / financial signals

Macro + energy signals that contextualize geopolitical events (sanctions bite, energy
leverage, trade dependence).

| Source                | Endpoint             | Key      | License              | Reliability           | Integration   | What it adds                                                                             | Effort     |
| --------------------- | -------------------- | -------- | -------------------- | --------------------- | ------------- | ---------------------------------------------------------------------------------------- | ---------- |
| **EIA**               | `api.eia.gov`        | free-reg | US Gov public domain | Good                  | recon / layer | US + global energy prices, production, stocks (oil, gas, power). Energy-leverage picture | Medium     |
| **World Bank**        | `api.worldbank.org`  | none     | Open (CC-BY)         | Good                  | recon         | Keyless macroeconomic indicators (GDP, debt, trade) by country                           | Low–Medium |
| **UN Comtrade**       | `comtradeapi.un.org` | free-reg | Open                 | Medium — rate-limited | recon         | International trade flows — who depends on whom for what goods                           | Medium     |
| **FRED**              | `api.stlouisfed.org` | free-reg | Free                 | Good                  | recon         | US/global economic time series (rates, inflation, employment)                            | Low–Medium |
| **Frankfurter (ECB)** | `frankfurter.app`    | none     | Free                 | Good                  | enrich        | Keyless FX exchange rates (ECB reference). Cheap currency context                        | Low        |

## 9. Environmental / climate

Extends the hazard picture (§1 GDACS/NWS/FIRMS/EONET) with geophysical + CBRN-adjacent signals.

| Source                       | Endpoint                               | Key      | License              | Reliability | Integration | What it adds                                                               | Effort     |
| ---------------------------- | -------------------------------------- | -------- | -------------------- | ----------- | ----------- | -------------------------------------------------------------------------- | ---------- |
| **Smithsonian GVP**          | `volcano.si.edu` (weekly report / WFS) | none     | Open, attribution    | Good        | layer       | Global volcanic eruption activity. Keyless                                 | Medium     |
| **Global Forest Watch**      | GFW API                                | free-reg | CC-BY                | Good        | layer       | Deforestation / forest-loss alerts — land-use and resource-pressure signal | Medium     |
| **Safecast**                 | `api.safecast.org`                     | none     | CC0                  | Good        | layer       | Crowdsourced radiation readings. CBRN-adjacent environmental monitoring    | Medium     |
| **NOAA Tsunami (PTWC/NTWC)** | `tsunami.gov`                          | none     | US Gov public domain | Good        | layer       | Tsunami warnings/watches. Pairs with the USGS seismic layer                | Low–Medium |

## 10. Space weather

The environmental-effects half of the space domain (CelesTrak §1 covers orbital tracking).

| Source         | Endpoint                 | Key                 | License              | Reliability | Integration   | What it adds                                                                                                     | Effort     |
| -------------- | ------------------------ | ------------------- | -------------------- | ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| **NOAA SWPC**  | `services.swpc.noaa.gov` | none                | US Gov public domain | Good        | layer / recon | Solar flares, geomagnetic storms, Kp index, aurora forecast. Keyless. Affects HF comms + GPS — ties to §4 SIGINT | Low–Medium |
| **NASA DONKI** | `api.nasa.gov` DONKI     | free-reg (demo key) | US Gov public domain | Good        | recon         | Space-weather event notifications (CME, solar flares, radiation storms) with analysis                            | Low        |

## 11. Civil unrest / political

Note heavy overlap with §1 **ACLED** and **GDELT** (protests/events) — these add
humanitarian, advisory, and governance framing rather than raw event streams.

| Source                              | Endpoint                   | Key      | License              | Reliability | Integration    | What it adds                                                                                       | Effort     |
| ----------------------------------- | -------------------------- | -------- | -------------------- | ----------- | -------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| **ReliefWeb (UN OCHA)**             | `api.reliefweb.int`        | **free-reg** | Open             | Good        | recon / layer  | **DONE 2026-07-20** — `reliefweb` layer, optional-keyed. NOT keyless: v1 decommissioned (410), v2 rejects unregistered callers ("not an approved appname"). Set `RELIEFWEB_APPNAME`; graceful-off without it. No coordinates in the schema → placed on country centroids | Medium     |
| **US State Dept Travel Advisories** | `travel.state.gov/_res/rss/TAsTWs.xml` | none | US Gov public domain | Good | layer / recon  | **DONE 2026-07-20** — `advisories` layer. Keyless RSS, 208 countries. Titles parse as "Country - Level N: advice"; feed lists each country ~twice so entries are deduped to the highest level. Levels 1/2/3/4 → severity 1/2/4/5 | Low–Medium |
| **IFES ElectionGuide**              | `electionguide.org`        | free-reg | Free                 | Medium      | recon          | Upcoming elections calendar — flashpoint scheduling                                                | Low        |
| **V-Dem / Freedom House**           | annual datasets            | none     | Open (datasets)      | Good        | recon / enrich | Governance / democracy indices for entity + country context                                        | Medium     |

## 12. Infrastructure / energy

Critical-infrastructure and energy assets/flows — the physical + grid layer beneath the
event streams.

| Source                        | Endpoint                     | Key      | License   | Reliability | Integration   | What it adds                                                                                | Effort     |
| ----------------------------- | ---------------------------- | -------- | --------- | ----------- | ------------- | ------------------------------------------------------------------------------------------- | ---------- |
| **OpenInfraMap**              | `overpass-api.de/api/interpreter` | none | ODbL   | Medium      | layer         | **DONE 2026-07-20** — `infrastructure` layer. Substations + communications towers (NOT plants; WRI covers those). Viewport-scoped: refuses above `OVERPASS_MAX_AREA` (12 deg2) since the shared endpoint rate-limits (429) and gateway-times-out. Each feature type gets its own `out` budget or dense substations crowd out every tower. A `remark` in a 200 response means the query timed out — treated as failure, never cached as an empty area | Medium     |
| **WRI Global Power Plant DB** | dataset ZIP (WRI v1.3.0)     | none     | CC-BY     | Good        | layer         | **DONE 2026-07-20** — `power-plants` static layer, 3,245 of 34,936 plants (`capacity >= 500MW` OR nuclear at any size), 814KB. Bundled not fetched: the upstream is a frozen 2021 12MB CSV inside a ZIP. Regenerate with `node scripts/build-power-plants.mjs`. Its 195 nuclear sites cover what IAEA PRIS would have provided | Low–Medium |
| **Global Energy Monitor**     | GEM datasets / trackers      | free-reg | CC-BY     | Good        | layer / recon | Plants, pipelines, LNG terminals, coal/steel trackers. Asset-level energy geography         | Medium     |
| **ENTSO-E Transparency**      | `transparency.entsoe.eu` API | free-reg | Free      | Good        | recon / layer | European electricity load, generation, cross-border flows                                   | Medium     |
| **Electricity Maps**          | `api.electricitymap.org`     | free-reg | Free tier | Good        | layer / recon | Real-time grid production + carbon intensity by zone                                        | Low–Medium |
| **IAEA PRIS**                 | `pris.iaea.org`              | none     | Open      | Good        | recon / layer | **SKIPPED 2026-07-20** — no API. PRIS is an ASP.NET site serving HTML only; there is no JSON/CSV endpoint, so this would mean scraping stateful WebForms pages. The WRI power-plant layer already carries all 195 nuclear sites with coordinates and capacity, so the scrape would buy nothing. Revisit only if reactor *status* (operational/shutdown/under-construction) becomes worth the fragility | Low–Medium |
| **OpenCellID**                | `opencellid.org` API         | free-reg | CC-BY-SA  | Medium      | layer         | Cell-tower locations — telecom-infra + geolocation reference                                | Medium     |

## 13. Health / biosurveillance

Outbreak and public-health signals — epidemic early warning and zoonotic/CBRN-adjacent
monitoring.

| Source            | Endpoint                        | Key      | License              | Reliability | Integration   | What it adds                                                                   | Effort     |
| ----------------- | ------------------------------- | -------- | -------------------- | ----------- | ------------- | ------------------------------------------------------------------------------ | ---------- |
| **WHO**           | GHO API / Disease Outbreak News | none     | Open                 | Good        | recon         | Authoritative outbreak notices + global health indicators                      | Medium     |
| **disease.sh**    | `disease.sh`                    | none     | Open                 | Good        | recon / layer | Keyless epidemic-data aggregator API (influenza, COVID, etc.) by country       | Low        |
| **HealthMap**     | `healthmap.org` API             | free-reg | Free                 | Medium      | layer         | Real-time disease-outbreak map, multi-source aggregated                        | Medium     |
| **CDC (Socrata)** | `data.cdc.gov`                  | none     | US Gov public domain | Good        | recon / layer | US surveillance datasets (respiratory, wastewater, mortality)                  | Low–Medium |
| **ECDC**          | ECDC datasets / feeds           | none     | Open                 | Good        | recon         | European surveillance + communicable-disease threat reports                    | Medium     |
| **Nextstrain**    | `nextstrain.org` (open data)    | none     | Open                 | Good        | recon         | Pathogen genomic surveillance — variant/lineage phylogenies                    | Medium     |
| **WOAH WAHIS**    | `wahis.woah.org`                | free-reg | Open                 | Medium      | recon         | Animal / zoonotic disease outbreaks (avian flu, ASF) — spillover early warning | Medium     |

## 14. Imagery / remote-sensing

Satellite + aerial imagery and derived Earth-observation products. **Architectural note:**
OSIRIS today is point/vector-oriented (deck.gl scatter/icon layers over `{entities, meta}`).
Imagery is _raster_ — it needs a different render path (MapLibre raster/tile source or
deck.gl `TileLayer`/`BitmapLayer`) and a tile/COG-aware adapter, not the entity model.
That makes this domain a bigger lift than the others, but it's the one that adds a genuinely
new _visual_ dimension (change detection, SAR through cloud/night, nighttime-lights economics).

| Source                    | Endpoint                         | Key      | License               | Reliability | Integration   | What it adds                                                                                                                   | Effort      |
| ------------------------- | -------------------------------- | -------- | --------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| **Copernicus Data Space** | `dataspace.copernicus.eu`        | free-reg | Open                  | Good        | layer / recon | Core free EO: Sentinel-1 (SAR, all-weather/night), Sentinel-2 (10 m optical), Sentinel-5P (atmospheric NO₂/CH₄/CO)             | High        |
| **NASA GIBS / Worldview** | `gibs.earthdata.nasa.gov`        | none     | Open                  | Good        | layer         | Keyless global daily browse tiles (MODIS/VIIRS true-color, thermal, etc.). Easiest imagery starting point — standard tile URLs | Medium      |
| **Earth Search (STAC)**   | `earth-search.aws.element84.com` | none     | Open                  | Good        | recon / layer | Keyless STAC index to Sentinel-2 + Landsat on AWS Open Data — search scenes by bbox/date/cloud, stream COGs                    | Medium–High |
| **Landsat (USGS)**        | EarthExplorer / M2M API          | free-reg | US Gov public domain  | Good        | layer         | 50-yr optical archive — long-baseline change detection                                                                         | Medium–High |
| **NOAA GOES / Himawari**  | AWS Open Data                    | none     | US Gov public domain  | Good        | layer         | Geostationary weather imagery, near-real-time full-disk. Keyless                                                               | Medium      |
| **VIIRS Black Marble**    | NASA (Nighttime Lights)          | free-reg | Open                  | Good        | layer         | Nighttime-lights — economic-activity proxy + power-outage / conflict-damage detection                                          | Medium      |
| **Umbra Open Data**       | Umbra SAR archive                | none     | CC-BY                 | Good        | layer / recon | Free high-res SAR samples — sub-meter, sees through cloud/dark                                                                 | Medium      |
| **Maxar Open Data**       | Maxar ODP                        | none     | CC-BY-NC              | Good        | layer         | Event-triggered high-res optical (disaster/crisis response)                                                                    | Medium      |
| **Planet NICFI Basemaps** | Planet NICFI                     | free-reg | Free (restricted use) | Good        | layer         | High-res tropical basemaps (deforestation, land-use) — free under the NICFI program                                            | Medium      |
| **OpenAerialMap**         | `openaerialmap.org`              | none     | CC-BY                 | Medium      | layer         | Open aerial / drone imagery, community-contributed                                                                             | Medium      |

---

## Cross-cutting enhancements (not new sources, but higher impact than most single feeds)

Worth weighing against the source list — a few of these make the data you _already_ have
far more complete than any one new feed would.

- **Historical persistence (optional SQLite)** — DONE 2026-07-19. Built on `node:sqlite`
  (zero-dep): `src/lib/persist.js` reconcile store, `GET /api/changes` + `/api/history/:layer`,
  and the frontend "What Changed" panel. Optional via `OSIRIS_DB_PATH`; event-shaped layers
  (seismic/weather/cyber/news/telegram/conflict/gdacs/ioda) feed it.
- **Geofence + keyword alert rules engine** — build on the existing Slack notify: "alert if
  any military aircraft enters this bbox" / "any sanctioned vessel in this strait."
- **Cross-source correlation** — link an IP from a cyber feed → a sanctions hit → a geolocation.
- **MITRE ATT&CK mapping** — tag cyber/KEV items with technique IDs for analyst context.

---

## Suggested first batch — COMPLETE (all four shipped 2026-07-19)

If picking a starting set, bias to keyless + high map/recon impact:

1. **GDELT** — biggest map impact, keyless.
2. **abuse.ch (ThreatFox + URLhaus + Feodo)** — makes Cyber/Intel tabs genuinely powerful, keyless.
3. **Shodan InternetDB** — cheap, high-value enrichment on existing IP lookups, keyless.
4. **CelesTrak** — removes the `N2YO_API_KEY` requirement for the space layer, keyless.

Then decide whether **persistence** (SQLite) jumps the queue ahead of new sources.
