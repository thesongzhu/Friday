# Friday Final Real Proof Pack (2026-04-16)

## Baseline

- Base runtime: `http://127.0.0.1:33141`
- Trust sources used in this pack:
  - current code
  - live HTTP/MCP/runtime behavior
  - external roundtrip evidence
  - `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16.{md,json}`

## Verified Live Proofs

### Release truth baseline

- `node scripts/quality/check-proof-no-mock-leaks.mjs`
  - Result: `No mock contamination markers found across 12 proof input file(s).`
- `FRIDAY_BASE_URL=http://127.0.0.1:33141 node scripts/quality/run-release-truth-audit.mjs`
  - Wrote:
    - `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16.md`
    - `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16.json`
    - `docs/reports/repo/FRIDAY_DEFECT_LEDGER_2026-04-16.json`
    - `docs/reports/repo/FRIDAY_CLAIM_MATRIX_2026-04-16.json`
    - `docs/reports/repo/FRIDAY_UNUSED_CODE_AUDIT_2026-04-16.json`
    - `docs/reports/repo/FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-16.{md,json}`

### Search freshness

- Proof method:
  - authenticated MCP `tools/call`
  - tool: `web_search`
  - args: `query="OpenAI latest news April 2026"`, `freshness="month"`, `numResults=3`
- Result:
  - HTTP `200`
  - returned dated Google News RSS results
  - sample dates:
    - `Wed, 15 Apr 2026 16:00:00 GMT`
    - `Tue, 14 Apr 2026 01:02:10 GMT`
    - `Tue, 31 Mar 2026 07:00:00 GMT`
- Conclusion:
  - current runtime search is not just reporting `provider_backed` in `/v1/health`
  - the live tool path returned time-bounded, dated results

### Heartbeat trigger

- Initial broken state:
  - `POST /v1/heartbeat/trigger` returned `404`
  - root cause: TUI/client referenced a route that was not registered in HTTP routes
- After route wiring:
  - env-off runtime: `POST /v1/heartbeat/trigger` returned `503 HEARTBEAT_UNAVAILABLE`
  - conclusion: route exists and reports the real env gate instead of pretending to work
- After env-on runtime:
  - runtime started with:
    - `FRIDAY_HEARTBEAT_ENABLED=true`
    - `FRIDAY_HEARTBEAT_ACTIVE_HOURS_ENABLED=false`
  - `POST /v1/heartbeat/trigger` returned `200`
  - payload:
    - `status="ok"`
    - `actionRequired=false`
    - `responseText="HEARTBEAT_OK"`
  - `GET /v1/heartbeat/status` moved to:
    - `result="ok"`
    - non-null `lastRunAt`
  - mirrored session evidence:
    - `GET /v1/sessions/system:default:heartbeat/messages?limit=3` returned the stored assistant heartbeat message and tool calls
- Conclusion:
  - heartbeat trigger is now a real runtime lane, not a dead TUI affordance

### IRC external channel

- Real external message roundtrip completed against Libera IRC
- Evidence already present in live runtime:
  - `/v1/channels` reports `webchat` and `irc`
  - `/v1/sessions?channel=irc` returns a live IRC session
  - latest message list includes a real user/assistant exchange
- Conclusion:
  - at least one non-webchat external channel is genuinely wired

### MCP

- Real MCP JSON-RPC path proved live through `/v1/mcp`
- Verified methods:
  - `initialize`
  - `tools/list`
  - `tools/call`
- Verified live tools:
  - `read`
  - `memory_search`
  - `capabilities`
  - `task_status`
  - `web_search`
- Conclusion:
  - MCP is a real operator surface, not mock-only scaffolding

### Satellite protocol

- Real live protocol sequence completed:
  - register
  - pairing list/get
  - approve
  - handshake
  - capabilities
  - heartbeat
  - commands poll
  - events poll
  - sync pull
  - sync push
  - revoke
- Conclusion:
  - satellite pairing/runtime routes form a real protocol chain

## Fixed Real Defects In This Pass

1. Missing heartbeat trigger route
   - Before: TUI called `/v1/heartbeat/trigger`, runtime returned `404`
   - After: route registered as `observability.heartbeat.trigger`

2. Heartbeat env-gate opacity
   - Before: no way to distinguish “missing route” from “feature not enabled”
   - After: env-off runtime returns `503 HEARTBEAT_UNAVAILABLE`

3. Heartbeat session mirror crash
   - Before: heartbeat default session key was `system:heartbeat`, which crashed session-key parsing during assistant mirror
   - After:
     - default key is `system:default:heartbeat`
     - legacy `system:<chat>` keys normalize to canonical 3-segment form
     - live heartbeat message persistence succeeded

## Still Blocked / Not Proven

- Desktop remains blocked by missing permissions:
  - `screen_recording`
  - `input_monitoring`
  - `automation`
- Marketplace remains hidden and empty:
  - `/v1/skills/catalog = 0`
  - `/v1/marketplace/sources = 0`
  - `/v1/marketplace/assets = 0`
- Packages and tenants routes exist but are still empty in current runtime:
  - `/v1/packages = 200` with empty list
  - `/v1/security/tenants = 200` with empty list
- Non-IRC external channels remain unproven because credentials/platform wiring are absent in the current environment
- Compaction is still not proven end-to-end with a fresh trigger/writeback/readback artifact
- Autonomous persistence is still not proven end-to-end with a restart/recovery artifact

## Verdict

- Current truth after this pass:
  - core runtime + auth + providers + routing + chat/assistant + MCP + satellite + IRC + heartbeat trigger + search freshness have live evidence
  - desktop, marketplace, non-IRC channels, compaction, and autonomous persistence still need separate live proof or remain blocked
