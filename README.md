# OSIRIS Situational Dashboard

Static-first OSINT dashboard for aviation, maritime, CCTV, seismic, fires, weather, news, space, cyber, conflict, crypto, sanctions, and Telegram OSINT workflows.

## Run

```bash
npm start
```

Open `http://localhost:4173`.

No package install is required for the first version. The app uses a small Node server for static files and keyless API proxy routes, while MapLibre GL and deck.gl load from public CDNs in the browser.

## Implemented Baseline

- 16 toggleable intelligence layers with live entity counts.
- WebGL map rendering through MapLibre GL plus deck.gl scatter layers.
- Progressive layer loading with a `fetched` guard to avoid duplicate requests.
- Viewport-aware aviation refresh using the visible map bounds.
- Static maritime, chokepoint, CCTV, conflict, news, and space intelligence layers.
- Live USGS M2.5+ earthquake feed.
- NASA FIRMS active-fire adapter for viewport-bounded thermal detections.
- NASA EONET event feed for severe weather categories.
- OpenSky Network state lookup for visible aircraft, with optional OAuth client-credentials support.
- Normalized `/api/layers/:layer` routes returning `{ entities, meta }`.
- Source-health telemetry at `/api/health`.
- Telegram public-preview ingestion from `t.me/s/<channel>` with multilingual place matching.
- BTC lookups through Blockstream and ETH lookups through Blockscout.
- OFAC sanctioned crypto-address cross-check using the 0xB10C mirror.
- OpenSanctions search tab for persons, organizations, vessels, and aircraft.
- NVD CVE keyword search over a rolling 30-day window.

## Environment

`OSIRIS_TELEGRAM_CHANNELS` overrides the default comma-separated Telegram source list:

```bash
OSIRIS_TELEGRAM_CHANNELS=disclosetv,Faytuks,liveukraine_media,wartranslated,Middle_East_Spectator,BNONews npm start
```

When `OSIRIS_TELEGRAM_CHANNELS` is unset, OSIRIS uses a grouped global public-preview list covering global alerting, Ukraine/Russia, Middle East, Africa, Asia-Pacific, Europe, and the Americas. `OSIRIS_TELEGRAM_MAX_CHANNELS` controls the maximum number of channels loaded from the comma-separated list.

`PORT` overrides the local server port:

```bash
PORT=4300 npm start
```

Optional live-source credentials:

```bash
OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=... npm start
FIRMS_MAP_KEY=... npm start
FIRMS_SOURCES=VIIRS_NOAA20_NRT,VIIRS_SNPP_NRT,MODIS_NRT FIRMS_DAY_RANGE=1 npm start
```

OpenSky works anonymously with lower quota. Supplying OAuth client credentials enables authenticated state-vector calls. NASA FIRMS requires a free `FIRMS_MAP_KEY`; without it, the fire layer stays available but reports zero active FIRMS entities.

## Source Notes

The first version favors keyless public endpoints. Some feeds may rate-limit, block scraping, or change response shape. The server returns source errors as map entities when a layer fails, so the dashboard remains operable while making the broken integration visible.

Telegram ingestion only reads unauthenticated public web previews. Use it for public-channel monitoring, not private-channel access or account automation.

## Next Build Phases

1. Replace the small place dictionary with a proper gazetteer and confidence scoring.
2. Add clustering and severity filters for high-volume layers.
3. Add per-layer polling intervals.
4. Persist layer visibility, map viewport, and recon history in local storage.
5. Add WHOIS and IP intelligence routes with OpenSanctions name cross-checks.
6. Move large static datasets into versioned JSON files with provenance fields.
7. Add authenticated adapters for additional sources that allow higher quotas.
8. Add exportable incident snapshots for analyst reports.
