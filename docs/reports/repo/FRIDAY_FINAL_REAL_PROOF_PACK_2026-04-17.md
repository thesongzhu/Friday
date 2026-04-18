# Friday Final Real Proof Pack (2026-04-17)

## Baseline

- Canonical live-proof lane in this pass:
  - `FRIDAY_E2E_LIVE_ANTHROPIC=1`
  - `FRIDAY_ANTHROPIC_API_KEY`
  - no OpenAI/Ollama supplemental lane in the canonical deep-proof runs
- Current audit runtime:
  - `http://127.0.0.1:3191`
  - isolated `FRIDAY_STATE_DIR`
  - Anthropic-only auto-detected provider inventory
- Additional isolated temp runtimes were used for the live deep-chain and self-upgrade suites.
- Trust sources used in this pack:
  - current code
  - live HTTP / runtime / MCP / websocket behavior
  - SQLite readback
  - `/v1/autonomy/upgrade-status` API readback

## Verified Live Proofs

### Release truth baseline

- `npm run check:proof:no-mock-leaks`
  - Result: `No mock contamination markers found across 37 proof input file(s).`
- `npm run build:api`
  - Result: passed after the self-upgrade substrate and runtime wiring changes in this tranche.
- Current branch also re-ran the live suites that anchor this proof pack:
  - `test/e2e/live/friday-self-upgrade-workflow-live.e2e.test.ts`
  - `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`
  - `test/e2e/live/friday-self-upgrade-provider-profile-live.e2e.test.ts`
  - `test/e2e/live/friday-self-upgrade-plugin-live.e2e.test.ts`
  - `test/e2e/live/friday-self-upgrade-mcp-server-live.e2e.test.ts`
  - `test/e2e/live/friday-self-upgrade-channel-adapter-live.e2e.test.ts`
  - `test/e2e/live/friday-autonomous-restart.e2e.test.ts`
  - `test/e2e/live/friday-self-healing-live.e2e.test.ts`
  - `test/e2e/live/friday-learning-live.e2e.test.ts`
  - `test/e2e/live/friday-workflow-generator-maintenance-live.e2e.test.ts`
  - `test/e2e/live/friday-subagent-live.e2e.test.ts`
  - `test/e2e/live/friday-real-journeys.e2e.test.ts`

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

### Self-healing lesson readback and route truth

- Current isolated runtime workflow/provider/skill failure proof completed a second self-healing chain:
  - initial incident returned no matched lessons
  - the failing action produced a lesson/pattern writeback
  - the next matching incident read the lesson back and changed the route/plan behavior
  - anti-learning also proved a bad lesson can be suppressed and excluded from the next decision
- Guardrail closed in this pass:
  - `matchedLessonIds` is kept diagnosis-only and is no longer used to pretend that a manual resolve created a pre-matched lesson
- Conclusion:
  - self-healing is now live-proven not just for execute/rollback, but also for lesson write -> readback -> behavior changed truth

### Compaction trigger, writeback, and readback

- Current live runtime compaction proof completed end to end:
  - one run read three large files in the same session
  - SQLite recorded `agent.run.compaction_attempted`
  - SQLite recorded `agent.run.compaction_result` with:
    - `compacted=true`
    - `summaryPresent=true`
  - compaction memory rows persisted:
    - `compaction.summary`
    - `compaction.decisions`
    - `compaction.todos`
    - `compaction.files`
  - after `POST /v1/sessions/:sessionKey/reset`, a zero-tool follow-up run correctly recalled the compacted fact
- Conclusion:
  - compaction is now live-proven for trigger -> writeback -> reset -> readback
  - the learning live suite also proved behavior-changed evidence for session memory, compaction memory, and world-model reuse

### Autonomous restart recovery

- Current live isolated autonomous proof now completed full restart recovery:
  - a goal reached `planning`, `executing`, and `verifying` interruption points across separate runs
  - runtime was killed and restarted on the same SQLite stateDir
  - recoverable runs reappeared as `interrupted_recoverable`
  - nonrecoverable execution interruption reappeared as `interrupted_nonrecoverable`
  - real `resume_goal` HTTP runs completed the exact same goal / step when resumable
  - final SQLite state preserved same-step continuity and avoided duplicate step rows
- Conclusion:
  - autonomous persistence is now live-proven for restart -> resume_goal -> same-step completion, plus honest nonrecoverable stop behavior

### Workflow self-upgrade

- `test/e2e/live/friday-self-upgrade-workflow-live.e2e.test.ts`
- Real Anthropic lane proved:
  - `detect`
  - `adapt`
  - `replay`
  - `shadow`
  - `canary`
  - `promote`
  - `rollback`
- Triple-check:
  - live HTTP/runtime proof
  - SQLite workflow/version metadata readback
  - `/v1/autonomy/upgrade-status?kind=workflow&id=<workflowId>` readback
- Conclusion:
  - workflow subject now has a real self-upgrade chain instead of a boundary-only narrative

### Skill self-upgrade

- `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`
- Real Anthropic lane proved:
  - create a new skill
  - upgrade the same saved skill in place
  - `shadow`
  - `canary`
  - `promote`
  - blocked upgrade attempt followed by `rollback`
- Triple-check:
  - live skill generation / execution
  - SQLite skill row metadata readback
  - `/v1/autonomy/upgrade-status?kind=skill&id=<skillId>` readback
- Conclusion:
  - skill subject now has a real self-upgrade chain with rollback, not just explicit regenerate-and-save proof

### Provider profile self-upgrade

- `test/e2e/live/friday-self-upgrade-provider-profile-live.e2e.test.ts`
- Real Anthropic lane proved:
  - drift detect on provider/profile compatibility state
  - adapt + replay
  - `shadow`
  - `canary`
  - `promote`
  - `rollback`
- Triple-check:
  - live provider profile maintenance path
  - SQLite provider profile metadata readback
  - `/v1/autonomy/upgrade-status?kind=provider_profile&id=<providerId>` readback
- Conclusion:
  - provider profile subject now has a real upgrade lifecycle and promotion truth

### Plugin self-upgrade

- `test/e2e/live/friday-self-upgrade-plugin-live.e2e.test.ts`
- Real Anthropic lane proved:
  - compatibility detect
  - adapt + replay
  - `shadow`
  - `canary`
  - `promote`
  - `rollback`
- Triple-check:
  - live plugin route/runtime proof
  - SQLite plugin metadata readback
  - `/v1/autonomy/upgrade-status?kind=plugin&id=<pluginId>` readback
- Conclusion:
  - plugin subject now has a real upgrade lifecycle instead of a static inventory-only surface

### MCP server self-upgrade

- `test/e2e/live/friday-self-upgrade-mcp-server-live.e2e.test.ts`
- Real Anthropic lane proved:
  - inventory + schema drift detect
  - adapt
  - real replay through the live `mcpAdapter`
  - `shadow`
  - `canary`
  - `promote`
  - `rollback`
- Triple-check:
  - live MCP tool/resource replay
  - SQLite `autonomy_subject_upgrade_state` readback
  - `/v1/autonomy/upgrade-status?kind=mcp_server&id=<serverId>` readback
- Conclusion:
  - mcp_server subject now has a real upgrade chain rather than only safe-catalog route proof

### Channel adapter self-upgrade

- `test/e2e/live/friday-self-upgrade-channel-adapter-live.e2e.test.ts`
- Real Anthropic lane proved:
  - runtime drift detect on `webchat`
  - adapt
  - replay through a real websocket `/ws/chat` roundtrip
  - `shadow`
  - `canary`
  - `promote`
  - `rollback`
- Triple-check:
  - live websocket inbound/outbound replay
  - SQLite `autonomy_subject_upgrade_state` readback
  - `/v1/autonomy/upgrade-status?kind=channel_adapter&id=webchat` readback
- Conclusion:
  - channel_adapter subject now has a real upgrade chain without pulling Discord/desktop into this tranche

### Workflow generator maintenance

- `test/e2e/live/friday-workflow-generator-maintenance-live.e2e.test.ts`
- Real Anthropic lane proved:
  - publish a new version onto the same workflow record
  - verify the published version moved forward
  - roll publication back to the prior version
- Conclusion:
  - workflow generator maintenance is live-proven for publish-forward and rollback truth

### Subagent continuity

- `test/e2e/live/friday-subagent-live.e2e.test.ts`
- Real Anthropic lane proved:
  - normal parent -> child handoff completion
  - child failure without collapsing the parent run
  - rejection of detached handoff snapshot as final success
  - parent/child/subagent/session evidence surviving runtime restart
- Triple-check:
  - live agent runtime proof
  - API readback for parent run, child run, subagent listing/detail, and audit trail
  - SQLite/session evidence continuity after restart
- Conclusion:
  - subagent continuity is now real-proofed for artifact truth, merge truth, and restart safety

## Current Boundaries

- This tranche does **not** claim Discord, desktop permissions, or other external-channel closure.
- This tranche does **not** treat blocked env-gated surfaces (`packages`, `tenants`, desktop readiness, media-understanding) as verified.
- This tranche keeps `verified` reserved for independently checked end-to-end success; `executed` remains a weaker intermediate depth.
