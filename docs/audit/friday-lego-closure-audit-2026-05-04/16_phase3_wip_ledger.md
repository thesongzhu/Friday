# Friday Phase 3.0 WIP Ledger

Date: 2026-05-05
Branch: `codex/friday-lego-closure-repair`
Protocol: `15_phase3_execution_protocol.md`

## Purpose

This ledger classifies the current mixed worktree before any further Phase 3 implementation. It exists to prevent accidental staging, accidental overwrite of user or historical changes, and accidental acceptance of unreviewed hunks.

The detailed machine-readable ledger is `16_phase3_wip_ledger.csv`. This Markdown file is the human-readable control summary.

## Current Git State

- Branch: `codex/friday-lego-closure-repair`
- Staged diff: none at preflight time.
- Tracked dirty files: 74.
- Untracked files visible to Git: 31 before adding Phase 3.0 files.
- Phase 3 status: not complete, not staged, not committed.
- Phase 3.0 outputs present: `15_phase3_execution_protocol.md`, `16_phase3_wip_ledger.md`, and `16_phase3_wip_ledger.csv`.

## Classification Rules

- `phase3_wip`: likely part of Phase 3 external Lego/runtime truth work, but still requires hunk-level announcement and review before staging.
- `audit_artifact`: audit output generated before Phase 3.0; must be preserved and not modified unless explicitly approved.
- `pending_review_hunk`: existing hunk must be reviewed and approved before it can be accepted.
- `protected_user_or_historical`: dirty or untracked content treated as user/historical work until explicitly reclassified.
- `needs_confirmation`: purpose is unclear or mixed; stop and ask before touching.
- `phase3_protocol`: Phase 3.0 protocol or ledger output approved by the user.

## Phase 3.0 Protocol Files

- `docs/audit/friday-lego-closure-audit-2026-05-04/15_phase3_execution_protocol.md` — `phase3_protocol`; approved Phase 3.0 protocol output.
- `docs/audit/friday-lego-closure-audit-2026-05-04/16_phase3_wip_ledger.md` — `phase3_protocol`; approved Phase 3.0 Markdown ledger output.
- `docs/audit/friday-lego-closure-audit-2026-05-04/16_phase3_wip_ledger.csv` — `phase3_protocol`; approved Phase 3.0 CSV ledger output.

## Audit Artifacts

The existing untracked audit directory files are `audit_artifact`. They are evidence inputs, not implementation work. Do not rewrite, normalize, or stage them as part of Phase 3 implementation unless the user separately approves an audit artifact commit.

- `docs/audit/friday-lego-closure-audit-2026-05-04/00_audit_ledger.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/00_inventory.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/00_scope.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/01_inventory.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/02_mechanism_map.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/03_route_and_runtime_closure.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/04_approval_policy_closure.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/05_external_capability_lifecycle.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/06_memory_skills_workflow_learning.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/07_system_runtime_default_on_readiness.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/08_test_truth_and_release_proof.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/09_findings_register.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/10_recommendations.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/11_entrypoint_closure_matrix.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/11_entrypoint_closure_matrix.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/12_dependency_matrix.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/12_dependency_matrix.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/13_repair_ready_master_ledger.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/13_repair_ready_master_ledger.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/14_decision_gates.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/14_decision_gates.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/15_regression_tests_map.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/15_regression_tests_map.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/16_inventory_scope_delta.csv`
- `docs/audit/friday-lego-closure-audit-2026-05-04/16_scope_inventory_reconciliation.md`
- `docs/audit/friday-lego-closure-audit-2026-05-04/friday_full_merged_audit.csv`

## Pending Review Hunk

- `test/unit/skills/converter/friday-skill-converter-service.test.ts` — `pending_review_hunk`.

This file contains the unauthorized test edit that added candidate staging, dry-run, activation, and promotion assertions while removing older direct-import positive expectations. The user chose to keep it as pending WIP, not to accept it. It must not be expanded, staged, or described as approved until it is re-reviewed inside the later external skill converter subphase.

## Protected User Or Historical Work

These files were previously identified as unrelated or protected dirty work, or they belong to areas outside the immediate external skill lifecycle implementation. Treat them as `protected_user_or_historical` unless the user explicitly reclassifies a hunk.

- `packages/friday-operator-client/src/system-client.ts`
- `src/learning/services/friday-self-healing-api-service.ts`
- `src/observability/services/friday-observability-api-service.ts`
- `test/unit/observability/services/friday-observability-api-service.test.ts`
- `test/unit/operator-client/friday-operator-client.test.ts`
- `test/integration/hub/friday-ui-api-route-closure.integration.test.ts`

## Likely Phase 3 External Lego WIP

These files appear related to Phase 3 external Lego lifecycle, availability truth, provider/plugin/MCP validation, route truth, UI truth, or release proof. This classification is not approval to stage or continue editing now. Inside a later approved subphase, every hunk must be announced with intent, impact, affected lines, and tests; stop and ask only for new issues, drift, unauthorized scope, or conflicts.

- `scripts/e2e/run-friday-external-closure.mjs`
- `src/agent/runtime/friday-agent-answer-alignment.ts`
- `src/agent/runtime/friday-agent-evidence-blocks.ts`
- `src/agent/runtime/friday-agent-system-prompt-builder.ts`
- `src/agent/tools/friday-agent-skill-import-tool.ts`
- `src/agent/tools/friday-agent-skill-tool.ts`
- `src/agent/tools/friday-agent-skills-list-tool.ts`
- `src/agent/tools/friday-agent-tool-registry.ts`
- `src/api/http/routes/friday-autonomy-routes.ts`
- `src/api/http/routes/friday-scan-migrate-routes.ts`
- `src/api/http/routes/friday-skill-converter-routes.ts`
- `src/api/http/routes/friday-skill-routes.ts`
- `src/api/model/friday-api-autonomy.types.ts`
- `src/api/model/friday-api-skill-converter.types.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/api/runtime/friday-deep-link-apply-service.ts`
- `src/autonomy/services/friday-capability-acquisition-service.ts`
- `src/autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.ts`
- `src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.ts`
- `src/autonomy/services/friday-plugin-upgrade-lifecycle-service.ts`
- `src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.ts`
- `src/autonomy/services/friday-skill-upgrade-lifecycle-service.ts`
- `src/autonomy/services/friday-workflow-upgrade-lifecycle-service.ts`
- `src/cli/friday-cli.ts`
- `src/hub/friday-hub-bootstrap.ts`
- `src/plugins/services/friday-plugin-service.ts`
- `src/plugins/services/friday-plugin-service.types.ts`
- `src/providers/model/friday-runtime-capabilities.ts`
- `src/providers/services/friday-provider-service.ts`
- `src/sessions/services/friday-deterministic-dispatch.ts`
- `src/skills/converter/index.ts`
- `src/skills/converter/services/friday-skill-candidate-store.ts`
- `src/skills/converter/services/friday-skill-converter-service.ts`
- `src/skills/converter/services/friday-skill-converter-service.types.ts`
- `src/skills/executor/friday-skill-executor.ts`
- `src/skills/executor/friday-skill-executor.types.ts`
- `test/e2e/friday-real-scenarios-e2e.test.ts`
- `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`
- `test/e2e/live/friday-real-journeys.e2e.test.ts`
- `test/e2e/live/friday-self-upgrade-channel-adapter-live.e2e.test.ts`
- `test/e2e/live/friday-self-upgrade-mcp-server-live.e2e.test.ts`
- `test/e2e/live/friday-self-upgrade-plugin-live.e2e.test.ts`
- `test/e2e/live/friday-self-upgrade-provider-profile-live.e2e.test.ts`
- `test/e2e/live/friday-self-upgrade-workflow-live.e2e.test.ts`
- `test/e2e/plugins/friday-plugin-local-lifecycle.test.ts`
- `test/e2e/setup-wizard.e2e.test.ts`
- `test/integration/hub/friday-hub-bootstrap-integration.test.ts`
- `test/unit/agent/runtime/friday-agent-answer-alignment.test.ts`
- `test/unit/agent/runtime/friday-agent-evidence-blocks.test.ts`
- `test/unit/agent/runtime/friday-agent-system-prompt-builder.test.ts`
- `test/unit/agent/tools/friday-agent-skill-import-tool.test.ts`
- `test/unit/agent/tools/friday-agent-tool-registry.test.ts`
- `test/unit/api/http/routes/friday-autonomy-routes.test.ts`
- `test/unit/api/http/routes/friday-scan-migrate-routes.test.ts`
- `test/unit/api/http/routes/friday-skill-converter-routes.test.ts`
- `test/unit/api/runtime/friday-deep-link-apply-service.test.ts`
- `test/unit/autonomy/friday-channel-adapter-upgrade-lifecycle-service.test.ts`
- `test/unit/autonomy/friday-controlled-autonomy-services.test.ts`
- `test/unit/autonomy/friday-mcp-server-upgrade-lifecycle-service.test.ts`
- `test/unit/autonomy/friday-plugin-upgrade-lifecycle-service.test.ts`
- `test/unit/autonomy/friday-provider-profile-upgrade-lifecycle-service.test.ts`
- `test/unit/autonomy/friday-skill-upgrade-lifecycle-service.test.ts`
- `test/unit/autonomy/friday-workflow-upgrade-lifecycle-service.test.ts`
- `test/unit/plugins/services/friday-plugin-service.test.ts`
- `test/unit/providers/model/friday-runtime-capabilities.test.ts`
- `test/unit/providers/services/friday-provider-service.test.ts`
- `test/unit/ui/ui-truth-regressions.test.ts`
- `ui/src/components/core/skill-import-wizard.tsx`
- `ui/src/components/core/skill-scanner-panel.tsx`
- `ui/src/components/deeplink/deeplink-preview-dialog.tsx`
- `ui/src/lib/api/scan-migrate.ts`
- `ui/src/routes/setup-page.tsx`

## Needs Confirmation

These items require special attention before any hunk is touched:

- `src/hub/friday-hub-bootstrap.ts` is broad and mixed. It may contain Phase 3 WIP and unrelated lifecycle/startup changes. Handle only by announced hunks inside the approved subphase scope.
- `src/api/runtime/friday-api-runtime.ts` is broad and central. Any hunk affects autonomy/provider/plugin/MCP/workflow/skill lifecycle dispatch.
- `scripts/e2e/run-friday-external-closure.mjs` is release proof logic. It must not be weakened to pass; it must be updated only to add real proof.
- `test/unit/skills/converter/friday-skill-converter-service.test.ts` includes an unauthorized pending hunk and must be re-reviewed before acceptance.
- Any route changing user-visible API semantics requires explicit user approval and must update matching UI/client/tests.

## Next Required Step

`16_phase3_wip_ledger.csv` has been created with one row per dirty or untracked file. Each row includes path, git status, category, rationale, touch policy, approval status, and recommended next action.

Do not resume Phase 3 implementation until the Markdown and CSV ledger are verified and reviewed by two isolated agents.
