# NEW PROJECT IDEA

- Aviation / Maritime / CCTV -Situational-awareness features.
- Cyber (CVE/NVD) - IT-security domain.
- Conflict zones - Geopolitical, global.
- Crypto tracing / OFAC / Sanctions / Telegram OSINT - Financial-crime/OSINT tooling.

Key Capabilities
Domain | Data | Points Sources
Aviation Commercial, Private, Military, Jets OpenSky Network
Maritime 39 Global Ports, 10 Chokepoints Static Naval Intel
CCTV 2,000+ Cameras TfL, WSDOT, Caltrans, NYC DOT, VicRoads + more
Seismic Real-time M2.5+ USGS Earthquake API
Fires Active Hotspots NASA FIRMS
News 24/7 Live Streams 25+ Global Broadcasters
Weather Severe Events NASA EONET
Space Solar Weather, Satellites NOAA SWPC, N2YO
Cyber CVE Threats, Vulnerability Scanning NVD, Custom Scanner
Conflict 13 Active Zones Static OSINT Intel
Crypto BTC + ETH Wallet Tracing, OFAC SDN Match blockstream.info, Blockscout, OpenSanctions
Sanctions Person / Org / Vessel SDN Search OpenSanctions (US OFAC SDN mirror)
Telegram OSINT Geoparsed Posts from Public Channels t.me/s/<channel> web preview

---

## Intelligence Layers

- 16 toggleable data layers with real-time entity counts
- GPU-accelerated rendering — all map data rendered via WebGL, not DOM
- Progressive loading — data fetched on-demand when layers are activated
- Viewport-aware — only loads relevant data for the visible region

## Telegram OSINT Layer

- Public-channel feed scraped from the unauthenticated t.me/s/<channel> web preview — no Bot API token, no MTProto
- Default curated set of 5 channels (EN + RU/UA war reporting), overridable via OSIRIS_TELEGRAM_CHANNELS
- Posts are geoparsed against a multilingual place dictionary (EN + Cyrillic + Arabic) and plotted on the map
- Click any cyan dot to read the post and jump to the original on Telegram

## Crypto Wallet Intelligence

- BTC lookups via blockstream.info (Esplora API, keyless)
- ETH lookups via Blockscout's public ETH instance (eth.blockscout.com, keyless)
- Every lookup is cross-checked against the OFAC SDN sanctioned-address list (mirrored from 0xB10C/ofac-sanctioned-digital-currency-addresses)
- Sanctioned wallets surface a red SANCTIONED — OFAC SDN badge in the RECON panel

## OFAC SDN Cross-Check

- Standalone SANCTIONS tab in the RECON toolkit — full-text search across persons, organisations, vessels and aircraft
- WHOIS and IP-intel routes auto-cross-check registrant / ASN-owner names against the SDN list and surface an inline alert
- Data sourced from OpenSanctions (CC-BY 4.0) — keyless, ~7 MB cached in-memory for 24h

## Conflict Zone Monitoring

- 13 active conflict/tension zones with severity-coded warning markers
- Active Wars: Ukraine, Gaza, Sudan, Myanmar, DRC, Yemen
- High Tension: Syria, Lebanon, Sahel, Somalia, Red Sea
- Elevated: Taiwan Strait, Korean DMZ

## Performance Optimized

- 75% reduction in edge requests vs initial release
- Aggressive polling relaxation (15-30 min intervals for stable data)
- Static data served from memory (zero external API calls for news feeds)
- layerFetchedRef prevents duplicate API requests
