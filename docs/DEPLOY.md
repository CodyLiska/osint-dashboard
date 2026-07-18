# Deploying OSIRIS to the homelab server

LAN-only Docker Compose deploy. Single Node container, no database, no build step.

## Prerequisites

- Docker + Docker Compose v2 on the server (`docker compose version`).
- The server can reach the public internet (OSIRIS proxies external OSINT APIs).
- Client browsers viewing the dashboard also need internet (MapLibre GL + deck.gl load from CDNs).

## 1. Pick a free host port

The compose file publishes `WEB_PORT` (default `8092`) on the LAN. Confirm it is
free before deploying (do not assume):

```bash
ss -ltnp | grep 8092 || echo "8092 free"
docker ps --format '{{.Names}}\t{{.Ports}}'
```

If taken, set a different `WEB_PORT` in the server's `.env` (see below). Also
update `~/docker/_used-ports.md` so the inventory stays accurate.

## 2. Clone and configure

```bash
git clone <repo-url> osiris && cd osiris
```

The `.env` file is gitignored and does NOT ship in the repo. Create it on the
server from the template and fill in the keys you use:

```bash
cp .env.example .env
# edit .env: add OPENSKY_*, FIRMS_MAP_KEY, VIRUSTOTAL_API_KEY, etc.
# optionally set WEB_PORT=<port> here if 8092 was taken
```

All API keys are optional. Without them the corresponding layers fall back to
keyless/static behavior (e.g. FIRMS reports zero entities without a key). Copy
the real values from the dev box's `.env` over a secure channel (scp/ssh);
never commit them.

> `HOST` and `PORT` inside `.env` are ignored in the container: the compose file
> forces `HOST=0.0.0.0` and the internal `PORT=4173`. The only knob that matters
> for the LAN is `WEB_PORT`.

## 3. Build and run

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 4. Verify

```bash
curl -s http://localhost:${WEB_PORT:-8092}/api/health | head
```

Then open `http://<server-ip>:<WEB_PORT>/` from another LAN machine and confirm
the map loads and layers return counts. Optionally add a Dashy tile.

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## Notes

- State (response cache + source health) is in-memory and resets on restart. Nothing to back up.
- No auth or rate limiting: the API proxy routes are open. Keep this LAN-only.
  Do not expose the port to the internet without adding auth + rate limiting
  first (an open proxy would burn your API-key quota).
- Some feeds rate-limit or block scraping from certain IPs; failures surface as
  visible error entities rather than taking the dashboard down.
- Optional Slack alerting: set `SLACK_WEBHOOK_URL` in the server's `.env` to get a
  push when a source starts failing (rate-limits tagged 🚫, other errors ⚠️) and a
  ✅ when it recovers. Repeat alerts for the same source are throttled to once per
  `ALERT_COOLDOWN_MS` (default 15 min). Unset = no alerts, same as before.
