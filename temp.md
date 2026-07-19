🟡 Medium

- Dockerfile runs as root — no USER node (already in your known-issues; still open).
- Stale docs after my ETH fix:
  - README.md:29 — "ETH lookups through Blockscout" (now ethereum.publicnode.com RPC).
  - server.js:165 — health telemetry labels the source "Blockscout ETH".
  - dev-notes.md:47 (gitignored, low priority).
- ETH is now balance-only — the new RPC gives balance without the tx history/counts Blockscout provided. Acceptable tradeoff, but a functional reduction. Blockchair or Ethplorer (? apiKey=freekey) would restore richer data if you want it later.

🟢 Lower / pre-existing

- Test gaps: adapters cyber, firms, telegram, space, maritime, news have no tests (0% funcs); public/data.js untested; the /api/crypto/eth server route likely has no test (btc does). telegram/cyber are the highest-value next targets.
- Branch not merged / origin diverged — the deploy flow (git pull) needs these 7 commits pushed; my fixes are on fix-eth-ports-frontend-tests, unmerged.
- .DS_Store clutter (./.DS_Store, ./src/.DS_Store) — gitignored, not tracked, just noise.
