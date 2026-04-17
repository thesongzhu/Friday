# Friday Deep Rebuild Ledger Addendum (2026-04-17)

## Baseline

- Implementation tree: `/Users/jarvis/Projects/Friday-deep-closure-bac8ef2`
- Branch: `codex/deep-closure-bac8ef2`
- Baseline commit: `origin/main@bac8ef2`
- Read-only source trees:
  - `/Users/jarvis/Projects/Friday`
  - `/Users/jarvis/Projects/Friday-final-closure-audit`

## Rules

- This tranche only rebuilds the six `rebuild-cleanly` deep-chain buckets.
- Source code from the dirty tree is reference-only. Do not copy unreviewed files or generated artifacts.
- Every bucket must pass:
  - targeted tests
  - real Anthropic proof
  - current-phase rerun after each fix
  - previous-phase regression before advancing

## Buckets

| Bucket | Dirty reference | Clean rebuild target | First proof lane |
| --- | --- | --- | --- |
| 1. Autonomous restart matrix | `src/agent/autonomous/**`, `test/e2e/live/friday-autonomous-restart.e2e.test.ts`, `test/e2e/live/_helpers/autonomous.ts` | autonomous checkpointing, resume semantics, restart-safe proof in new tree | local runtime + SQLite readback + HTTP goal status |
| 2. Self-healing full matrix | `src/learning/services/**`, `src/api/http/routes/friday-self-healing-route-mappers.ts`, `test/e2e/live/friday-self-healing-live.e2e.test.ts` | provider/workflow/skill failure loops, rollback, lesson readback, anti-learning | local runtime + API/DB/oracle verification |
| 3. Learning / compaction behavior changed | `src/agent/runtime/**`, `src/learning/**`, `test/e2e/live/friday-learning-live.e2e.test.ts` | compaction trigger/readback, four-layer learning deltas | paired live tasks with A/B readback oracle |
| 4. Generator repair / migration / rollback | `src/skills/generator/**`, `src/workflows/generator/**`, `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`, `test/e2e/live/friday-workflow-generator-maintenance-live.e2e.test.ts` | repair-first skill/workflow maintenance, verified rollback | provider-backed generation + real execution + registry readback |
| 5. Background self-upgrade | `test/e2e/live/friday-playbook-upgrade-boundary-live.e2e.test.ts` plus upgrade-related runtime/registry paths discovered during rebuild | detect/adapt/replay/shadow/canary/promote-or-rollback for six subject classes | isolated live upgrade replay with promotion audit |
| 6. Subagent continuity | `src/agent/subagent/**`, `src/agent/tools/friday-agent-subagent-tools.ts`, `src/agent/tools/friday-agent-tool-registry.ts`, `src/hub/friday-hub-bootstrap.ts`, `docs/SUBAGENT-DESIGN.md`, `test/e2e/live/friday-subagent-live.e2e.test.ts` | parent/child continuity, artifact completeness, restart-safe evidence | runtime + DB/artifact trail + merge readback |

## Explicitly Excluded Inputs

- `managed-skills/live-maint-*`
- `managed-skills/datetime-*`
- `managed-skills/real-e2e-import-test`
- `docs/reports/ops/real-green-gate/**`
- temporary runtime state, temp providers, temp skills, and generated audit dumps

## Conditional Carry-Over

- Commit `117eb62` stays excluded by default.
- Only reapply its secrets-baseline allowlist logic if this branch reproduces the exact same false positive under CI.

## Current Rebuild Status

- Phase 0 substrate: completed on branch `codex/deep-closure-bac8ef2`.
- Bucket 1 autonomous restart matrix:
  - Clean rebuild completed and regression-hardened.
  - Code/status:
    - Anthropic-only deep-proof helper landed.
    - direct `toolExecutor` path landed for autonomous actions.
    - deterministic file-state observation/verification landed for autonomous file proofs.
    - Anthropic-only live restart suite landed in `test/e2e/live/friday-autonomous-restart.e2e.test.ts`.
    - hub surface now exposes `autonomousEngine` for real proof harnesses.
    - closed SQLite read-pool access now fails explicitly instead of dereferencing an empty connection slot.
    - shutdown-time compaction-context and new-file realpath noise were reduced so proof logs reflect real failures instead of expected teardown gaps.
    - browser checkpoint/session readback now suppresses long missing-session false alarms during restart recovery.
  - Verification:
    - targeted unit tests: passed
    - TypeScript/typecheck: passed
    - real Anthropic proof: passed on 2026-04-17 via `FRIDAY_E2E_LIVE_ANTHROPIC=1` + Anthropic API-key lane
    - live evidence:
      - planning interruption resumes to verified completion with SQLite/readback-backed file artifact
      - active execution interruption is classified `interrupted_nonrecoverable` and `resumeGoal` is rejected
      - verifying interruption resumes same step and avoids duplicate step rows
    - residual:
      - verifying live case still needed `retry x1` in the most recent full-suite run, so the matrix is verified but not yet fully de-flaked
  - Exit:
    - satisfied for Phase 1 advancement
    - residual flake remains tracked and must be watched during later phase regressions and final audit
- Bucket 2 self-healing full matrix:
  - Clean rebuild completed in the clean tree without porting the dirty live suite wholesale.
  - Code/status:
    - `matchedLessonIds` route-mapper semantics are now diagnosis-only; manual resolve lesson writeback no longer backfills that field.
    - clean Anthropic-only self-healing live suite landed in `test/e2e/live/friday-self-healing-live.e2e.test.ts`.
    - provider fallback, rollback, lesson readback, anti-learning, workflow retry, and skill-drift disable paths now share one deep-proof harness with API and SQLite readback.
  - Verification:
    - targeted unit and API tests: passed
    - real Anthropic proof: passed on 2026-04-17 via `FRIDAY_E2E_LIVE_ANTHROPIC=1` + Anthropic API-key lane
    - previous-phase regression: autonomous restart matrix passed again after Phase 2 changes
    - live evidence:
      - low-risk model fallback auto-applies, extracts a lesson, and the next matching incident reads that lesson back and changes the planned action
      - manual execute + rollback over `/v1/auto-fix/actions/:actionId/{execute,rollback}` restores routing and is confirmed in SQLite
      - disabled lesson suppresses future diagnosis/action lesson matches for the same fingerprint
      - failed workflow run is recovered by restoring the missing skill and replaying the failed node to completion
      - skill verification drift raises a `disable_skill` remediation that verifies and leaves the skill disabled
  - Exit:
    - satisfied for Phase 2 advancement
