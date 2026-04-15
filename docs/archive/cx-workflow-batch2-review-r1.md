> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Workflow Batch 2 Review — R1

**Date:** 2026-02-18
**Reviewer:** CX (gpt-5.3-codex)
**Scope:** Workflow Engine Batch 2: services, routes, jobs, runtime wiring

---

## Findings

1. **[Critical] Approval API routes are wired to stubs** — list always empty, get/approve/reject always throw not found.
   - `src/api/runtime/friday-api-runtime.ts:580, 583, 586, 589`

2. **[Critical] Webhook runtime wiring is placeholder** — treats pathToken as workflowId, uses empty workflowVersionId, fires as "event" instead of webhook registration lookup.
   - `src/api/runtime/friday-api-runtime.ts:604, 605, 606`

3. **[High] Trigger service interface doesn't match design Section 4** — exposes register/unregister/fireManual/matchEvent instead of sync*/handle*/setRegistrationEnabled. Execution service lacks sweepTimedOutRuns/sweepTimedOutNodes.
   - `src/workflows/services/friday-workflow-trigger-service.ts:17`
   - `src/workflows/services/friday-workflow-execution-service.ts:37`

4. **[High] Timeout job only calls lease reaping** — doesn't implement timed-out run/node sweeping per design.
   - `src/jobs/workflows/friday-workflow-timeout-job.ts:58`

5. **[High] Skill adapter checks manifest.kind instead of workflow invocation mode** — misses design requirement.
   - `src/workflows/services/friday-workflow-skill-node-adapter.ts:24, 73`

6. **[Medium] Trigger update route ignores enabled input** — registration returned unchanged.
   - `src/api/runtime/friday-api-runtime.ts:559, 566`

7. **[Medium] Missing POST /v1/workflow-runs/:runId/resume route** from design Section 7.
   - `src/api/http/routes/friday-workflow-run-routes.ts:26`

8. **[Medium] Event trigger bridge uses legacy matchEvent** — not design's handleEvent contract.
   - `src/workflows/services/friday-workflow-event-trigger-bridge.ts:39`

9. **[Medium] Test coverage gaps** — no event-trigger-bridge tests, skill adapter tests validate kind not invocation mode, timeout job tests only assert lease reaping.

## Verdict

**NOT APPROVED** — 2 Critical + 3 High must be fixed before R2.
