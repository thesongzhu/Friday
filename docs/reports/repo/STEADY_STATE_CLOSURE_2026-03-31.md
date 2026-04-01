# Friday Steady-State Closure Report

Date: 2026-03-31 (America/Los_Angeles)

## Scope

This report captures the final local closure pass after the `675a84847adb3dfd91cb1bd115def86e879d895b` baseline uplift and the follow-up fixes for:

- channel-scoped session memory namespaces
- world-model production after `afterTurn`
- prompt registry / MCP dedup / plugin health / tool batching wiring
- tenant context propagation through runtime and provider fallback
- wizard persistence and restart recovery
- stale write blocking proof
- workflow approval restart durability
- self-healing evidence persistence and contract narrowing

## Confirmed Fixed

- Session memory now uses channel-scoped namespaces instead of the legacy cross-channel shared default.
- Guided wizard contexts are persisted in SQLite and can resume after restart.
- `afterTurn` now produces world-model data in real runs instead of only preparing schema.
- MCP read-only dedup is wired into the adapter path and produces runtime markers.
- Plugin health monitor now covers load-time and unload/deactivate failure paths.
- Tool batch execution is active in runtime and stale file writes are blocked before mutation.
- Tenant context now propagates through the remaining `executeRun(...)` and `runWithFallback(...)` paths that were previously missing it.
- Workflow approvals survive hub restart and can be approved after restart to resume the run.
- Directive-level self-healing steps now persist execution/rollback evidence into action records.

## Confirmed Preserved

- Local OpenAI supervised path remains usable for real work.
- Build still passes after the changes.
- Non-LLM real-scenario suite still passes.
- Hub/bootstrap integration suite still passes.
- Privacy-safe summaries remain intact; no raw tool input/output persistence was added.

## Real Validation Results

- `npm run build`
  - Result: PASS
- `FRIDAY_E2E_CORE=1 npx vitest run --project llm-e2e test/e2e/friday-real-scenarios-e2e.test.ts`
  - Result: PASS
  - Summary: `60 passed / 31 skipped`
- `npx vitest run test/unit/agent/runtime/friday-agent-runtime.test.ts`
  - Result: PASS
  - Summary: `88 passed`
- `npx vitest run test/integration/hub/friday-hub-bootstrap-integration.test.ts`
  - Result: PASS
  - Summary: `15 passed`
- `npx vitest run test/unit/providers/services/friday-provider-service.test.ts`
  - Result: PASS
  - Summary: `45 passed`
- `npm run test:e2e:closure:local`
  - Result: PASS on product path, with harness exit defect
  - Evidence:
    - Ledger: `/Users/jarvis/Projects/Friday/.friday/closure/2026-04-01T03-51-26-270Z/ledger.json`
    - Final observed summary: `24 PASS / 0 FAIL / 0 BLOCKER`
    - Readiness: `productReadyLocal = GO`, `overall = GO`

## Confirmed Remaining Gaps

These are no longer local runtime wiring gaps. They are either environment blockers or broader release-proof gaps:

- Dual-tenant live credential proof still needs two real tenant credential sets and a true end-to-end live run.
- Claude live matrix is still blocked by missing `FRIDAY_E2E_LIVE_ANTHROPIC` and Anthropic OAuth/token.
- Cloud live matrix is still blocked by missing `FRIDAY_E2E_CLOUD_*`.
- Docker smoke is still blocked on this host because Docker is not installed.
- Long-duration soak proof is still missing. Restart durability is now proven for wizard, automation replay, stale runs, and workflow approvals, but a 12h soak has not been completed.

## Known Harness Defect

- `scripts/e2e/run-friday-closure.mjs --local-only` still appears to hang after writing a successful ledger.
- This has now reproduced multiple times with the ledger already showing `GO`.
- Current interpretation:
  - product path: PASS
  - harness process cleanup / exit behavior: defective

## Release Interpretation

As of 2026-03-31 local time:

- Friday can be truthfully described as having a working **local OpenAI supervised path**.
- Friday should **not yet** be described as having full multi-environment long-duration release proof.
- Public docs should continue to avoid implying:
  - completed Claude live validation
  - completed cloud live validation
  - completed Docker local validation
  - completed 12h soak validation

## Recommended Next External Closure Order

1. Run dual-tenant live routing proof with two real tenant credential scopes.
2. Run Claude live matrix with Anthropic credentials.
3. Run cloud live matrix with `FRIDAY_E2E_CLOUD_*`.
4. Run Docker smoke on a docker-capable host or CI runner.
5. Run a 12h local OpenAI soak focused on session, realtime, approval, scheduler, and memory extraction.
