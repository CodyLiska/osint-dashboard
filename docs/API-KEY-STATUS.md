# API Key Status

Verification of the API keys in `.env`, so open items survive across sessions.

**Last verified:** 2026-07-21 (from the macOS dev machine, not the homelab).

Each keyed provider was probed with one minimal authenticated request matching how
its adapter actually authenticates. Slack (`SLACK_WEBHOOK_URL`) was **deliberately
not tested** — no send paths are exercised during verification.

## Summary

| Provider | Status | Notes |
|---|---|---|
| OpenSky (OAuth2) | ✅ working | token issued, `expires_in=1800s` |
| NASA FIRMS | ✅ working | quota 5000 / 10 min, 0 used |
| N2YO | ✅ working | ISS position returned |
| NewsAPI | ✅ working | 200 |
| NVD | ✅ working | 200 with `apiKey` header (higher rate limit active) |
| VulnCheck | ✅ working | 200 with Bearer token |
| AbuseIPDB | ✅ working | 200 |
| GreyNoise | ✅ working | accepted |
| abuse.ch Auth-Key | ✅ working | `query_status=ok` — covers ThreatFox + URLhaus + MalwareBazaar |
| VirusTotal | ✅ working | 200 |
| **UCDP** | ❌ **invalid token** | see item 1 |
| **ReliefWeb** | ❌ **appname not approved** | see item 2 |
| **AISStream** | ⚠️ **unverified** | not a key problem — see item 3 |

Intentionally empty (keyless by design, no action needed): `OPENSANCTIONS_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `OSIRIS_DB_PATH`.

Housekeeping: `.env` has a stray junk line `v=` (likely a fat-finger during editing);
harmless, but delete it.

## Open items

### 1. UCDP — invalid token (real problem)
The token is rejected: **`Invalid or inactive API token.`** Confirmed it's the token
itself, not a header/format issue — the endpoint *is* gated (without any token it
returns "API token required"; with your token it still 401s).

- **Fix:** get a valid/activated token from ucdp.uu.se and set `UCDP_ACCESS_TOKEN`.
  Note: tokens may need an activation step after registration — confirm the account
  is activated and the token copied without truncation (still 18 chars, still
  rejected on the 2026-07-21 re-check).
- **Impact: low.** Per the `.env.example` note, GDELT already provides keyless
  conflict coverage, so the map isn't blind — it's just missing UCDP's
  death-counted GED layer.

### 2. ReliefWeb — awaiting appname approval (in progress)
Response: **`403: You are not using an approved appname.`** ReliefWeb v2 requires an
approved appname before it works.

- **Status (2026-07-21):** approval request submitted — `RELIEFWEB_APPNAME` is
  currently the placeholder note `[[ GOOGLE FORM REQUEST SENT ]]`, so it still 403s.
- **Fix when approved:** replace that placeholder with the real approved appname
  string from ReliefWeb.
- **Impact: low.** GDACS covers disasters keyless.

### 3. AISStream — can't verify from this machine (not a key problem)
The WebSocket handshake fails because **`stream.aisstream.io` (136.243.173.177) is
unreachable on TCP 443 from this network** — DNS resolves fine and the apex
`aisstream.io` returns 200, but the streaming host's port 443 is blocked/refused
here. AISStream authenticates via the subscribe message *after* connecting, so the
key can't be tested until connectivity works.

- **Next step:** verify from the homelab server (`ubuntu-g2`, 192.168.12.230), or
  check whether the local network/ISP blocks that Hetzner IP.
- **Quick reachability check to run on the homelab:**
  ```sh
  nc -z -w 8 stream.aisstream.io 443 && echo "reachable" || echo "blocked"
  ```
  If reachable there, re-run the key probe from the homelab to confirm the key.
