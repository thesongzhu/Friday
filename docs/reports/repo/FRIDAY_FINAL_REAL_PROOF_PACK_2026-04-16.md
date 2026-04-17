# Friday Final Real Proof Pack (2026-04-16)

## Baseline

- Primary current runtime: `http://127.0.0.1:33152`
- Additional isolated temp runtimes were used for the rollback-backed self-healing E2E and the skill generator live E2E.
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

### Skill generator full closure

- Real Anthropic API-key E2E completed the full generator chain in an isolated temp runtime:
  - create session
  - generate draft
  - explicit self-test
  - evidence
  - approve/save
  - registry refresh
  - installed skill readback
  - `/v1/skills/:skillId/run` completed with `completionDepth="executed"`
- Conclusion:
  - skill generation is no longer just draft-level or dispatch-only proof

### Skill generator upgrade in place

- Real Anthropic API-key E2E regenerated the same saved skill id in place:
  - first save/install completed
  - second generator session kept the same skill id
  - installed version advanced to `2.0.0`
  - pre-approve draft self-test executed the temp draft for real and passed the behavioral marker check
  - post-upgrade `/v1/skills/:skillId/run` output changed from the previous run and contained the exact required `VERSION_TWO:<skillId>` marker
- Bound:
  - this proves explicit regenerate -> approve -> save can upgrade an installed skill in place
  - it does not prove a background autonomous version-tracking or self-upgrade loop
- Hardening added in this pass:
  - generator contract extraction now preserves requested manifest id/version and exact output markers
  - generated bundle validation now fails if required markers are missing from generated files
  - explicit self-test now runs the draft from a temp directory and blocks approval when exact runtime markers are missing
- Conclusion:
  - explicit upgrade-in-place is now live-proven with exact output-marker evidence
  - background autonomous version-tracking/self-upgrade is still not proven

### Self-healing execute and rollback

- Real Anthropic API-key E2E completed a rollback-backed self-healing lane in an isolated temp runtime:
  - created primary + secondary providers
  - set routing primary -> fallback
  - disabled low-risk auto-apply so the action stayed `planned`
  - reported a real model incident through `selfHealing.reportStructuredFailure(...)`
  - verified `/v1/auto-fix/actions` returned a planned action with rollback available
  - executed `/v1/auto-fix/actions/:actionId/execute`
  - verified routing switched to the configured fallback provider
  - rolled back `/v1/auto-fix/actions/:actionId/rollback`
  - verified routing returned to the original provider/model
- Conclusion:
  - self-healing now has live execute + verify + rollback evidence for model fallback, not just readiness or execute-only proof

### Self-healing auto-repair

- Real Anthropic API-key E2E also proved the user-path automatic lane:
  - low-risk auto-apply enabled
  - model incident reported with a configured fallback provider
  - action auto-applied without a manual `/execute`
  - `/v1/agent-loop/runs` reached final status `verified`
  - routing switched to the configured fallback provider
  - lesson extraction persisted on the resolved incident/action record
- Conclusion:
  - low-risk self-healing is not only manually executable; the automatic agent-loop path is also live-proven

### Self-healing lesson readback and route truth

- Current isolated runtime workflow-failure proof completed a second, separate self-healing chain:
  - repeated `/v1/uix/templates/deploy-workflow/execute` without `sessionId` to create the same failure fingerprint
  - approved the planned action, which auto-executed and failed
  - verified `extractedLesson` persisted into learning overview
  - re-triggered the same failure fingerprint
  - verified the next incident returned the learned lesson id in both `summary.matchedLessonIds` and `diagnosis.diagnosis.matchedLessonIds`
- Hardening added in this pass:
  - normalized diagnosis route output so the public incident summary and raw diagnosis record no longer disagree about matched lessons
- Conclusion:
  - self-healing is now live-proven not just for execute/rollback, but also for failed-fix lesson write -> readback on the next matching incident

### Compaction trigger, writeback, and readback

- Current live runtime compaction proof completed end to end:
  - one run read three large (~73 KB) files in the same session
  - SQLite recorded `agent.run.compaction_attempted`
  - SQLite recorded `agent.run.compaction_result` with:
    - `compacted=true`
    - `summaryPresent=true`
    - `estimatedTokensBefore=26921`
    - `estimatedTokensAfter=3401`
  - compaction memory rows persisted:
    - `compaction.summary`
    - `compaction.decisions`
    - `compaction.todos`
    - `compaction.files`
  - after `POST /v1/sessions/:sessionKey/reset`, a zero-tool follow-up run correctly recalled the compacted fact that the primary pilot channel was `Discord`
- Conclusion:
  - compaction is now live-proven for trigger -> writeback -> reset -> readback
  - the nuance is that compaction fired on the internal agent/subagent run that carried the large reads, not on the outer parent run envelope

### Autonomous restart recovery

- Current live isolated autonomous proof now completed full restart recovery:
  - a goal reached `verifying`
  - runtime was killed and restarted on the same SQLite stateDir
  - the same goal recovered as `interrupted_recoverable`
  - the same original step id recovered as `interrupted_recoverable`
  - a real `resume_goal` HTTP run completed the exact same goal and exact same step successfully
  - final SQLite state preserved the original step id in `step_ids_json`
  - final SQLite state kept exactly one step row for the goal
- Conclusion:
  - autonomous persistence is now live-proven for interrupted_recoverable -> restart -> resume_goal -> same-step completion

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
- Autonomous persistence same-step continuity is now verified on the live isolated runtime

## Verdict

- Current truth after this pass:
  - core runtime + auth + providers + routing + chat/assistant + MCP + satellite + IRC + heartbeat trigger + search freshness + compaction + skill upgrade-in-place + self-healing rollback + self-healing lesson readback have live evidence
  - desktop, marketplace, and non-IRC channels still remain blocked or partially proven
