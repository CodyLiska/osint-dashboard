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

## Alert rules (optional)

Geofence + keyword rules that notify on Slack. Off unless you enable it, and it
**requires historical persistence** — the alert dedupe lives in that store.

The rules file is **gitignored**, because rules encode what you are watching.
That means `git pull` will not deliver it and it must be placed on the server by
hand. It is also excluded from the image (`.dockerignore`) so it is never baked
into a layer; it reaches the container through the read-only bind mount that
`docker-compose.prod.yml` already declares (`./config:/app/config:ro`).

```bash
# on the server, in the repo directory
cp config/alert-rules.example.json config/alert-rules.json
nano config/alert-rules.json          # see the example for the shape
docker compose -f docker-compose.prod.yml up -d
```

**Check the startup line before trusting it.** The server states its alerting
posture at boot in every case:

```bash
docker compose -f docker-compose.prod.yml logs | grep '\[alerts\]'
```

| Line | Meaning |
| ---- | ------- |
| `disabled: OSIRIS_DB_PATH is not set` | Persistence is off, so alerting cannot run |
| `idle: no rules file at <path>` | Enabled, but no rules exist yet |
| `active: N rule(s) … → Slack` | Live |
| `active: … → log only (no SLACK_WEBHOOK_URL)` | Live, but messages only reach the container log |

**Do a dry run first.** Uncomment `OSIRIS_ALERT_DRY_RUN: "1"` in
`docker-compose.prod.yml` and watch a cycle. Dry run evaluates rules and logs
what *would* fire without sending or recording anything, so it is repeatable —
and it is the only way to discover that a rule is silently inert (a `minSeverity`
above a layer's constant severity validates fine and then never matches).
A broad rule will hit the per-rule cap of 20/hour immediately; that is the flood
guard working, not an error.

Rules are re-read whenever the file's mtime changes, so editing them does not
need a restart.

## Historical persistence (optional)

The compose file enables a durable event history via built-in `node:sqlite` (no
npm deps), stored on a named Docker volume `osiris-data` mounted at `/app/data`
(`OSIRIS_DB_PATH=/app/data/osiris.db`). This powers "what changed since X",
trends, and survival across restart. It persists only live, event-shaped,
stable-id layers (`seismic,weather,cyber,news,conflict,telegram`); kinematic and
static layers are excluded. Closed events older than `OSIRIS_RETENTION_DAYS`
(default 90) are pruned automatically.

To run **stateless** (old behavior), comment out `OSIRIS_DB_PATH` and the
`volumes:` block in `docker-compose.prod.yml`.

Verify persistence survives a container *recreate* (not just a restart) — this
is what proves the volume, not the container filesystem, holds the data:

```bash
curl -s "http://localhost:${WEB_PORT:-8092}/api/layers/seismic" >/dev/null   # populate
docker compose -f docker-compose.prod.yml up -d --force-recreate
curl -s "http://localhost:${WEB_PORT:-8092}/api/history/seismic" | head       # rows survive
docker compose -f docker-compose.prod.yml exec osiris id                       # uid=1000(node)
```

Read endpoints (return `{ "enabled": false }` when persistence is off):

- `GET /api/changes?since=<ISO>` — events added/closed since a timestamp (defaults to 24h ago).
- `GET /api/history/:layer?since=&until=` — events active in a time window.

Back up the volume with `docker run --rm -v osiris-data:/data -v "$PWD":/backup alpine tar czf /backup/osiris-data.tgz -C /data .`.

## Notes

- Response cache + source health are in-memory and reset on restart. The optional SQLite event history (above) is the only durable state; unset `OSIRIS_DB_PATH` for the original stateless behavior.
- No auth or rate limiting: the API proxy routes are open. Keep this LAN-only.
  Do not expose the port to the internet without adding auth + rate limiting
  first (an open proxy would burn your API-key quota).
- Some feeds rate-limit or block scraping from certain IPs; failures surface as
  visible error entities rather than taking the dashboard down.
- Optional Slack alerting: set `SLACK_WEBHOOK_URL` in the server's `.env` to get a
  push when a source starts failing (rate-limits tagged 🚫, other errors ⚠️) and a
  ✅ when it recovers. Repeat alerts for the same source are throttled to once per
  `ALERT_COOLDOWN_MS` (default 15 min). Unset = no alerts, same as before.
