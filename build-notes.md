# Pulling Real Data

- aviation: OpenSky API, authenticated with your .env keys
- fires: NASA FIRMS, now multi-source real active fire detections
- weather: NASA EONET severe storms/floods/volcanoes
- seismic: USGS M2.5+ earthquake feed
- telegram: public Telegram preview scraping plus local geoparsing
- cyber: NVD CVE API
- Recon crypto lookups: Blockstream BTC + Blockscout ETH
- Recon sanctions search: OpenSanctions

# Still Hard Coded / Static

- ports: 39 hard-coded global ports in public/data.js
- chokepoints: 10 hard-coded maritime chokepoints
- cctv: 10 sample camera locations only, not real camera feeds/API
- conflict: 13 hard-coded conflict/tension zones
- news: hard-coded broadcaster links/locations, not live headlines or stream status
- space: 2 hard-coded placeholder points for NOAA SWPC / N2YO
- maritime: currently just reuses the static ports dataset, no AIS/live vessels
- military: no real source yet; currently toggles but has no data
- crypto map layer: no plotted map entities yet; crypto works only in the Recon lookup panel
- sanctions map layer: no plotted map entities yet; sanctions works only in the Recon search panel

# FOLLOW UPs

- how often are each groups data updated?
