# AI FINDINGS

- Cross-source correlation - Open — link an IP from a cyber feed → a sanctions hit → a geolocation
- MITRE ATT&CK mapping - Open — tag cyber/KEV items with technique IDs
- Persistence Phase 5 — a timeline scrubber, needing an append-only entity_observations table for true point-in-time replay. Note the plan lists an alert_state table here too, but Phase 2's alert_log already solved that, so Phase 5 is now smaller than written.

# DATA SOURCES LEFT TO IMPLEMENT

- §4 SIGINT
- §5 Person/Entity
- §7 cyber
- §8 economic
- §9 environmental
- §13 health
- §14 imagery

# Smaller debts

- space and maritime test coverage (74% / 38%) — the WebSocket AIS path and the N2YO satellite path, both deliberately hard.
- weather/telegram severity are placeholder constants — deriving real values from EONET category would make escalation work on more than 2½ layers
- Alerting scope — source-health alerts fire on all failures; a rate-limit-only filter was noted as optional
- README phase 7 — authenticated higher-quota adapters, needs real keys
