> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Global Apply Plan (v1)

## Goal
Apply the deterministic pipeline globally across Friday backend so execution becomes:
- Stable: every run is constrained by deterministic pre/post checks.
- Reproducible: successful runs are captured as reusable playbooks.
- Traceable: every decision/artifact has auditable trace context.

## Scope (This Plan Includes Previous Discussed Issues)
This plan explicitly includes issues discussed earlier:
- Missing global route registration for deterministic pipeline APIs.
- Partial wiring (modules exist but not connected in production runtime).
- Missing unified run trace and decision evidence.
- Legacy-path drift (new modules exist but execution path still bypasses them).
- Release-readiness and real-world test evidence requirements.

## Phased Rollout
1. Shadow mode
- Evaluate rules/acceptance/retry/playbook selection, do not block legacy completion.
- Persist full traces and gate results.

2. Warn mode
- Block only high-risk policy violations.
- Enforce acceptance on critical artifact types; warn on non-critical.

3. Enforce mode
- Fail-closed on rule denial and critical acceptance failure.
- Playbook selection and feedback enabled by default.

## Work Packages

### WP-01 Composition Root and Feature Flags
- Files:
  - `src/hub/friday-hub-bootstrap.ts`
  - `src/api/runtime/friday-api-runtime.types.ts`
- Implementation:
  - Add deterministic pipeline runtime composition.
  - Add env-driven mode controls:
    - `FRIDAY_PIPELINE_MODE=shadow|warn|enforce`
    - `FRIDAY_PIPELINE_ENABLE=true|false`
    - `FRIDAY_PLAYBOOK_AUTO_LEARN=true|false`
- Acceptance criteria:
  - Runtime startup logs effective mode.
  - Missing deterministic deps fail fast only when pipeline enabled.

### WP-02 API Route Surface Wiring
- Files:
  - `src/api/runtime/friday-api-runtime.ts`
  - `src/api/http/routes/friday-deterministic-pipeline-routes.ts`
- Implementation:
  - Register deterministic routes in main runtime:
    - `/v1/rules/*`
    - `/v1/node-runner/*`
    - `/v1/acceptance/*`
    - `/v1/retry/*`
    - `/v1/playbooks/*`
- Acceptance criteria:
  - API contract snapshot includes new route surface.
  - Auth scopes are enforced and tested.

### WP-03 Rules Engine Integration
- Files:
  - `src/rules/engine/rule-engine.ts`
  - `src/rules/persistence/friday-rules-repository.ts`
  - `src/node-runner/engine/rules-context-builder.ts`
- Implementation:
  - Boot rule engine and load active bundles at startup.
  - Ensure evaluation contexts include required scopes and run/workflow metadata.
  - Persist evaluation logs with redaction.
- Acceptance criteria:
  - Rule decisions contain matched rule IDs and audit references.
  - Denied actions are deterministic and traceable.

### WP-04 NodeRunner Global Path
- Files:
  - `src/workflows/runtime/friday-workflow-runtime.ts`
  - `src/workflows/engine/friday-workflow-node-runner-facade.ts`
  - `src/node-runner/engine/node-runner-pipeline.ts`
- Implementation:
  - Route supported node types through NodeRunner in shadow mode first.
  - Keep explicit fallback to legacy executor for unsupported/unsafe nodes.
- Acceptance criteria:
  - For supported nodes, step-level traces exist for all 6 stages.
  - No regression in existing workflows under fallback scenarios.

### WP-05 Acceptance Gate Enforcement
- Files:
  - `src/workflows/engine/friday-workflow-acceptance-gate.ts`
  - `src/acceptance/engine/test-suite-runner.ts`
- Implementation:
  - Run acceptance checks before run completion.
  - Enforce severity-based policy by mode.
- Acceptance criteria:
  - Critical failures block completion in enforce mode.
  - Warn-only behavior is deterministic in shadow/warn mode.

### WP-06 Unified Retry Taxonomy
- Files:
  - `src/workflows/engine/friday-workflow-unified-retry-bridge.ts`
  - `src/retry/engine/retry-orchestrator.ts`
- Implementation:
  - Map failure categories: schema/quality/policy/tool/budget/logic.
  - Record retry decisions with strategy and cost metadata.
- Acceptance criteria:
  - No uncontrolled retry loops.
  - Retry traces include reason and escalation state.

### WP-07 Playbook Selection + Learning Loop
- Files:
  - `src/workflows/engine/friday-workflow-playbook-bridge.ts`
  - `src/playbook/engine/*`
- Implementation:
  - Intake selection before run execution.
  - Feedback recording on completion.
  - Promotion and rollback policies.
- Acceptance criteria:
  - Similar tasks can reuse promoted playbooks.
  - Promotion decisions are auditable.

### WP-08 Unified Trace Contract
- Files:
  - `src/workflows/engine/friday-workflow-pipeline-event-taxonomy.ts`
  - trace persistence modules
- Implementation:
  - Emit canonical pipeline events for rules/node/acceptance/retry/playbook.
  - Correlate all events by runId/workflowId/nodeId.
- Acceptance criteria:
  - Single run trace reconstructs why a result passed/failed.

### WP-09 Compatibility and Migration
- Files:
  - `src/state/sqlite/migrations/*`
- Implementation:
  - Keep old checksum compatibility.
  - Add forward migrations for deterministic pipeline persistence.
  - Add rollback-safe migration checks.
- Acceptance criteria:
  - Existing installations upgrade without data loss.
  - Legacy run data remains queryable.

### WP-10 Release Readiness and Test Gating
- Files:
  - CI workflows + docs reports
- Implementation:
  - Add mandatory matrix: unit, contract, e2e core, live provider.
  - Produce PASS/FAIL/BLOCKED checklist per module.
- Acceptance criteria:
  - Release blocked if any P0 module fails.

## Detailed Test Plan

### Unit tests
- Rules: matching, deny/allow precedence, bundle filters, audit records.
- NodeRunner: 6-step ordering, schema failures, pre/post rule failures.
- Acceptance: schema/quant/quality checks and severity handling.
- Retry: category mapping, backoff, budget and circuit-breaker behavior.
- Playbook: selection thresholds, score updates, promotion/rollback.
- Trace: schema validation and event linkage integrity.

### E2E tests
- Happy path full run with artifacts and acceptance pass.
- Schema fail -> repair or fail with explicit reason.
- Policy fail -> blocked with audit reference.
- Tool fail/rate-limit -> retry policy path observed.
- Budget fail -> stop with deterministic classification.
- Concurrent runs -> no state corruption.
- Restart recovery -> active runs recover cleanly.

### Live tests
- Real provider run (OpenAI key path).
- Real workflow with retries, acceptance, and trace export.
- Validate final artifact quality and deterministic evidence chain.

## Definition of Done
1. Stable
- Global execution path passes deterministic gates (rules + acceptance + retry) with mode controls.

2. Reproducible
- Successful runs auto-record playbook feedback and can be selected on similar future runs.

3. Traceable
- Every decision point has structured trace evidence and can be audited end-to-end.
