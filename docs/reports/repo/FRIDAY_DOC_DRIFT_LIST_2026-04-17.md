# Friday Doc Drift List (2026-04-17)

## Resolved In This Pass

- `search latestness`
  - Before: `FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-16` and `FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-16` still classified search freshness as `not proven`.
  - Now:
    - [FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-17.md](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-17.md) marks it `verified`.
    - [FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.md](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.md) marks it `verified`.
  - Evidence:
    - `/v1/health` still reports `capabilities.search.latestness=provider_backed`
    - [FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md) contains dated live MCP search proof
  - Decision:
    - treat `/v1/health` as capability snapshot
    - treat the proof pack as the stronger live-proof layer

- `self-healing loop`
  - Before: stale audit output still said `partially verified` or `not proven`.
  - Now:
    - 2026-04-17 audit outputs classify it `verified`.
  - Evidence:
    - proof pack section `Self-healing execute and rollback`
    - proof pack section `Self-healing lesson readback and route truth`

- `compaction`
  - Before: stale audit output still said `not proven`.
  - Now:
    - 2026-04-17 audit outputs classify it `verified`.
  - Evidence:
    - proof pack section `Compaction trigger, writeback, and readback`

- `autonomous persistence`
  - Before: stale audit output still said `partially verified`.
  - Now:
    - 2026-04-17 audit outputs classify it `verified`.
  - Evidence:
    - proof pack section `Autonomous restart recovery`
    - same-step `resume_goal` and SQLite continuity are now reflected in the generated audit

- `autonomous run truth surface`
  - Before:
    - a real autonomous user task surfaced internal `plan/action/verify` child runs in the same default `/v1/agent/runs` list as the top-level user run
    - this produced conflicting “completed” summaries even when only one top-level result should have been shown to the user
  - Fix:
    - [friday-agent-runtime.ts](/Users/jarvis/Projects/Friday/src/agent/runtime/friday-agent-runtime.ts) now persists run-level `metadata.surface` even when no `packId` exists
    - [friday-agent-routes.ts](/Users/jarvis/Projects/Friday/src/api/http/routes/friday-agent-routes.ts) now hides internal autonomous runs from default `/v1/agent/runs` and `/v1/agent/runs/summary`
    - the filter covers both:
      - `autonomous:*`
      - `subagent:autonomous:*`
  - Live re-check:
    - fresh isolated runtime on `http://127.0.0.1:51390`
    - top-level run `70289343-8d5c-4347-b02f-489cf242d006`
    - SQLite still recorded `4` internal autonomous runs
    - default `/v1/agent/runs?limit=20` returned only the top-level `agent:chat:live-proof` run
    - default `/v1/agent/runs/summary` returned `totalRuns=1`
  - Status:
    - closed in branch for user-facing list/summary truth
    - internal runs remain available through SQLite and correlated audit evidence, not through the default user list

## Remaining Drift / Open Risk

- `packaging / multi-tenant wording`
  - Current source still gates these deps behind:
    - `FRIDAY_PACKAGING_ENABLED === "true"`
    - `FRIDAY_MULTI_TENANT_ENABLED === "true"`
  - Current authenticated live runtime on `http://127.0.0.1:33241` returned:
    - `/v1/packages -> 200 { items: [] }`
    - `/v1/security/tenants -> 200 { items: [] }`
  - Risk:
    - docs can drift if they imply “always enabled by code” or “always env-gated” without recording the actual runtime enablement that produced the evidence bundle
  - Needed follow-up:
    - capture and publish the exact runtime env/enablement context for the proof runtime

- `desktop readiness`
  - Still blocked by real system permissions, not a documentation issue:
    - `screen_recording`
    - `input_monitoring`
    - `automation`
  - Current live evidence:
    - `/v1/health capabilities.system.healthStatus=degraded`
    - `/v1/health capabilities.system.companionReadiness=degraded`

- `marketplace hidden truth`
  - Still empty in the current runtime:
    - `/v1/skills/catalog = 0`
    - `/v1/marketplace/sources = 0`
    - `/v1/marketplace/assets = 0`
  - This remains acceptable only because marketplace is hidden; it is not a ready public surface.

- `non-IRC external channels`
  - Still not live-proven in this environment.
  - Discord remains the next real external wiring target once credentials are available.

- `background autonomous self-upgrade`
  - Still not proven by this pass.
  - The proof pack only proves explicit, supervised upgrade-in-place for generated skills.

- `autonomous audit visibility`
  - Before:
    - `GET /v1/agent/runs/:runId/audit` only surfaced `agent.run.*`
    - real `autonomous.*` evidence existed in SQLite and event storage but was invisible through the audit route
  - Fix:
    - [friday-agent-routes.ts](/Users/jarvis/Projects/Friday/src/api/http/routes/friday-agent-routes.ts) now includes `autonomous.*` in the audit surface
    - [friday-agent-routes.test.ts](/Users/jarvis/Projects/Friday/test/unit/api/http/routes/friday-agent-routes.test.ts) now locks that behavior
  - Live re-check:
    - main autonomous run `4ccb239b-e0c8-4d0f-9caf-6399054f57d0`
    - `/v1/agent/runs/:runId/audit` returned `37` events total
    - `31` of them were `autonomous.*`
    - last autonomous event was `autonomous.goal.completed`
  - Status:
    - closed in branch for audit visibility
    - separate multi-run UX ambiguity remains open

## Script Root Cause Closed

- Root cause fixed in [run-release-truth-audit.mjs](/Users/jarvis/Projects/Friday/scripts/quality/run-release-truth-audit.mjs):
  - audit generation now reads the latest final proof pack for:
    - search freshness
    - self-healing execute/rollback
    - compaction
    - autonomous restart recovery
  - this prevents the 2026-04-16 stale classifications from being re-emitted on every rerun

## Current Truth

- The generated 2026-04-17 audit set is now the canonical repo snapshot for this pass:
  - [FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-17.md](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-17.md)
  - [FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.md](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.md)
  - [FRIDAY_CLAIM_MATRIX_2026-04-17.json](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_CLAIM_MATRIX_2026-04-17.json)
  - [FRIDAY_DEFECT_LEDGER_2026-04-17.json](/Users/jarvis/Projects/Friday/docs/reports/repo/FRIDAY_DEFECT_LEDGER_2026-04-17.json)
