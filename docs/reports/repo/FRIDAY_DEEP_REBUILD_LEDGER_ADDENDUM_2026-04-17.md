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
