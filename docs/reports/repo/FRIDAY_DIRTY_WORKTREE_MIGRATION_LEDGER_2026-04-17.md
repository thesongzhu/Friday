# Friday Dirty Worktree Migration Ledger (2026-04-17)

## Baseline

- Clean implementation tree: `/Users/jarvis/Projects/Friday-final-closure-audit`
- Branch: `codex/final-closure-audit`
- Baseline commit: `origin/main@116ed08`
- Source input tree: `/Users/jarvis/Projects/Friday`

## Classification Rules

- `forward-port`: isolated fix or feature slice that is coherent on its own, has clear regression coverage, and does not drag in generated noise or unfinished autonomy rewrites.
- `rebuild-cleanly`: directionally useful, but coupled to broader unfinished deep-chain work, stale proof lanes, or large runtime behavior rewrites that must be redone from the clean tree.
- `discard`: generated output, temporary artifact, stale report noise, or low-signal drift not fit for migration.

## Migration Ledger

| Area | Source paths | Classification | Migration mode | Notes |
| --- | --- | --- | --- | --- |
| Release-proof mainline already merged | release-proof browser lane, `friday-real-journeys`, audit sync from PR #137 | already in `main` | none | Baseline already includes the real-browser release-proof cutover. |
| Local-only commit `117eb62` | `test/e2e/live/_helpers/api.ts`, `validation/real-world/lib/executors.mjs` | rebuild-cleanly | conditional | Do not carry automatically. Only reapply if new branch CI reproduces the same secret false-positive. |
| Session/principal alignment | `src/api/http/routes/friday-session-routes.ts`, `src/api/runtime/friday-api-runtime.ts`, `test/unit/api/http/routes/friday-session-routes.test.ts` | forward-port | manual port | Small runtime/API fix that preserves session user/account context without forcing default account/user overwrites. |
| Self-healing lesson/plan fixes | `src/api/http/routes/friday-self-healing-route-mappers.ts`, `src/learning/services/friday-auto-fix-plan-service.ts`, `src/learning/services/friday-error-diagnosis-service.ts`, `src/learning/services/friday-self-healing-api-service.ts`, matching unit tests | forward-port | manual port | Coherent slice: disable-skill remediation for skills lifecycle failures, disabled-lesson filtering, matched-lesson summary fix. |
| Workflow generator maintenance target | `src/api/http/routes/friday-workflow-generator-routes.ts`, `src/api/model/friday-api-workflow.types.ts`, `src/workflows/generator/**`, matching unit tests | forward-port | manual port | Existing-workflow maintenance support is isolated enough to port with unit coverage. Live proof remains a separate later lane. |
| Skill generator approval evidence gating | `src/skills/generator/services/friday-skill-generator-service.ts`, matching unit tests | forward-port | manual port | Good standalone validation hardening: require explicit self-test evidence before approve/save. |
| Converter file-vs-directory guards | `src/skills/converter/converters/friday-n8n-node-converter.ts`, `src/skills/converter/converters/friday-openai-gpt-action-converter.ts`, matching unit tests | forward-port | manual port | Tight bug fix; prevents reading directories as files. |
| Memory file sync warning noise | `src/memory/sync/friday-memory-file-sync-service.ts`, matching unit tests | forward-port | manual port | Small correctness fix for bracket-prefixed plain text. |
| OpenAI responses content mapping | `src/agent/runtime/friday-agent-llm-client.ts` | forward-port | manual port | Isolated protocol fix; keep separate from broader runtime rewrites. |
| Preference injector compaction leakage | `src/agent/runtime/friday-agent-preference-injector.ts` | forward-port | manual port | Small correctness fix: avoid treating compaction memory as global user preference. |
| Autonomous engine file-state inspection and restart work | `src/agent/autonomous/**`, `test/e2e/live/friday-autonomous-restart.e2e.test.ts`, helper `test/e2e/live/_helpers/autonomous.ts` | rebuild-cleanly | defer | Large runtime behavior rewrite plus stale multi-provider proof lane. Rework later from clean tree. |
| Runtime exact-literal/subagent auto-recovery logic | `src/agent/runtime/friday-agent-runtime.ts`, related tests | rebuild-cleanly | defer | Coupled to subagent behavior changes and exact-output enforcement. Too large to trust as a blind port. |
| Subagent orchestration rewrite | `src/agent/subagent/**`, `src/agent/tools/friday-agent-subagent-tools.ts`, `src/agent/tools/friday-agent-tool-registry.ts`, `src/hub/friday-hub-bootstrap.ts`, `docs/SUBAGENT-DESIGN.md`, related tests, `test/e2e/live/friday-subagent-live.e2e.test.ts` | rebuild-cleanly | defer | Broad semantic change with stale OpenAI live proof references; redo after clean runtime review. |
| Generator maintenance live suites | `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`, `test/e2e/live/friday-workflow-generator-maintenance-live.e2e.test.ts` | rebuild-cleanly | defer | Tests still use `LIVE_PROVIDER_KIND` multi-lane helpers; keep out until Anthropic-only deep-proof lane is rebuilt. |
| Learning / compaction live suite | `test/e2e/live/friday-learning-live.e2e.test.ts` | rebuild-cleanly | defer | Uses stale multi-provider lane; later clean rebuild needed for true Anthropic-only deep proof. |
| Self-healing live suite | `test/e2e/live/friday-self-healing-live.e2e.test.ts` | rebuild-cleanly | defer | Same issue as above plus broader bundled-skill setup. |
| Playbook upgrade boundary live suite | `test/e2e/live/friday-playbook-upgrade-boundary-live.e2e.test.ts` | rebuild-cleanly | defer | Valuable later, but not part of safe immediate migration. |
| Dirty doc drift extensions | `docs/reports/repo/FRIDAY_DOC_DRIFT_LIST_2026-04-17.md` additions about subagent/generator live proof | discard | drop | References stale OpenAI live-lane evidence and not yet-clean deep-proof status. |
| Managed skill mutations | `managed-skills/shell-skill-current-datetime/**`, `managed-skills/live-maint-*`, `managed-skills/datetime-*`, `managed-skills/real-e2e-import-test` | discard | drop | Generated or temporary artifacts. Do not migrate. |
| Ops real-green-gate artifacts | `docs/reports/ops/real-green-gate/**` | discard | drop | Runtime artifact output, not source. |

## Immediate Execution Order

1. Port the isolated `forward-port` fixes only.
2. Run targeted unit/regression coverage for each migrated slice.
3. Commit migrated slices in narrow logical batches.
4. Push and let CI decide whether `117eb62` needs a clean reapplication.
5. Treat all `rebuild-cleanly` items as follow-up implementation work, not part of this migration batch.
