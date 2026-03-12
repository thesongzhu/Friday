> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 3: Clawdbot-to-Friday Adaptation Plan
# CX (gpt-5.3-codex) — 2026-02-18

1. **Batch 1 (CC Task): Fix blocker #2 hub wiring first**
Scope: `src/hub/friday-hub-bootstrap.ts`, `src/hub/index.ts`, `src/api/runtime/friday-api-runtime.types.ts`, `src/workflows/runtime/friday-workflow-runtime.types.ts`.
What to do: wire `createFridayWorkflowRuntime` + `createFridayApiRuntime` inside hub bootstrap, expose them on `FridayHub`, and add startup/shutdown ordering hooks for runtime lifecycles.
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server.impl.ts:275-389`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server.impl.ts:695-739`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-close.ts:9-128`.
Friday adaptation: keep Friday naming (`Friday*` types, `createFriday*` factories, `FRIDAY_*` constants for defaults/timeouts).
Complexity: **L**.

2. **Batch 2 (CC Task): Fix blocker #1 CLI starts API listener**
Scope: `src/cli/friday-cli.ts`, new `src/cli/friday-cli-run-loop.ts`, `src/hub/friday-hub-bootstrap.ts`, new `src/api/http/friday-http-server.ts`.
What to do: replace `--port ... future use` behavior with real listener start; add a run loop that starts hub+API server, handles `SIGINT/SIGTERM`, and performs graceful close.
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/cli/gateway-cli/run.ts:264-286`, `/opt/homebrew/lib/node_modules/clawdbot/src/cli/gateway-cli/run-loop.ts:21-145`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-runtime-state.ts:129-183`.
Friday adaptation: map `runGatewayLoop` -> `runFridayCliLoop`, `startGatewayServer` -> `startFridayApiServer`.
Complexity: **M**.

3. **Batch 3 (CC Task): Fix blocker #3 approval request caller chain**
Scope: `src/workflows/services/friday-workflow-execution-service.ts`, `src/workflows/runtime/friday-workflow-runtime.ts`, `src/api/runtime/friday-api-runtime.ts`, `src/workflows/services/friday-workflow-approval-service.types.ts`.
What to do: when approval node is hit, execution must call approval creation (`requestForNode`) before pausing run; persist run/node linkage so approve/reject can safely resume the intended run.
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-methods/exec-approval.ts:21-137`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/exec-approval-manager.ts:43-104`, `/opt/homebrew/lib/node_modules/clawdbot/src/agents/bash-tools.exec.ts:453-571`.
Friday adaptation: inject a `requestNodeApproval` callback into execution deps, keep public types `Friday*`, and raise `FridayDomainError` at service boundaries.
Complexity: **L**.

4. **Batch 4 (CC Task): Fix blocker #4 trigger persistence registration caller chain**
Scope: `src/workflows/services/friday-workflow-trigger-service.ts`, `src/workflows/services/friday-workflow-crud-service.ts`, `src/api/runtime/friday-api-runtime.ts`, `src/workflows/runtime/friday-workflow-runtime.ts`.
What to do: call `upsertManyForVersion` from publish/sync flow; on publish, persist trigger registrations and refresh in-memory registrations; on startup, reload/sync published triggers.
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-methods/cron.ts:73-144`, `/opt/homebrew/lib/node_modules/clawdbot/src/cron/service/ops.ts:17-49`, `/opt/homebrew/lib/node_modules/clawdbot/src/cron/service/ops.ts:92-177`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server.impl.ts:411-417`.
Friday adaptation: use “mutate -> persist -> re-arm/reload” pattern for triggers.
Complexity: **L**.

5. **Batch 5 (CC Task): Deep import cleanup (Friday-internal)**
Scope: `src/api/runtime/friday-api-runtime.ts`, `src/jobs/sessions/friday-session-lifecycle-job.ts`, `src/jobs/sessions/friday-session-memory-extraction-job.ts`, `src/jobs/sessions/friday-session-memory-extraction-job.types.ts`, plus listed alias-bypass files.
What to do: replace deep relatives with canonical aliases/barrels, keep import groups at top-of-file.
Clawdbot code needed: **No** (internal cleanup).
Complexity: **S**.

6. **Batch 6 (CC Task): Dead code cleanup (Friday-internal)**
Scope: `src/api/realtime/friday-realtime-subscription-service.ts`, `src/sessions/services/friday-session-memory-extraction-llm-client.ts`.
What to do: remove or internalize dead exports (`computeCursorHmac`, `verifyCursorHmac`, `_EXTRACTION_SYSTEM_PROMPT`, `_validateLlmResponse`, `_parseJsonFromText`); keep test helpers in dedicated test-helper modules if needed.
Clawdbot code needed: **No** (internal cleanup).  
Note: dormant workflow approval/trigger methods become live from Batches 3-4.
Complexity: **S**.

7. **Batch 7 (CC Task): Circular dependency containment (mostly Friday-internal)**
Scope: `src/config/friday-config-path.ts`, `src/state/index.ts`, `src/state/sqlite/friday-sqlite.types.ts`, barrel files in large SCC (`src/workflows/index.ts`, etc.).
What to do: break `config <-> state` via leaf-module imports; reduce cross-domain wildcard barrel re-exports that create SCC fan-in.
Clawdbot code needed: **No direct copy**; pattern inspiration only (composition root importing leaves, not barrel chains).
Complexity: **M**.

8. **Batch 8 (CC Task): Style-guide conformance pass (Friday-internal)**
Scope: `src/api/model/friday-api-session.types.ts`, 12 wildcard barrel files, operationId files: `src/api/http/routes/friday-fleet-routes.ts`, `src/api/http/routes/friday-security-routes.ts`, `src/api/http/routes/friday-workflow-routes.ts`, `src/api/http/routes/friday-workflow-run-routes.ts`.
What to do: move stray imports to top, replace `export *` with explicit exports, normalize `operationId` to lowercase dot segments, ensure new constants use `FRIDAY_*`.
Clawdbot code needed: **No**.
Complexity: **M**.

9. **Batch 9 (CC Task): Type-safety hardening (uses Clawdbot patterns)**
Scope: hotspots in `src/workflows/services/friday-workflow-execution-service.ts`, `src/workflows/services/friday-workflow-trigger-service.ts`, `src/workflows/engine/friday-workflow-node-executor.ts`, `src/api/runtime/friday-api-runtime.ts`, route handlers with heavy casts.
What to do: add typed validators/guards for route params/body/query and workflow graph/node configs; reduce `as unknown as`; convert boundary `Error` throws to `FridayDomainError`.
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-methods/cron.ts:21-218`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/server-methods/exec-approval.ts:21-206`.
Complexity: **L**.

10. **Batch 10 (CC Task): Integration harness foundation + 21-file test rollout**
Scope: new helpers `test/e2e/api/_helpers/friday-api-test-server.helper.ts` (required), plus `test/e2e/_helpers/friday-test-hooks.helper.ts`, `test/e2e/_helpers/friday-test-mocks.helper.ts`, `test/integration/_helpers/friday-time-harness.helper.ts`.
What to do: build Claw-style isolated test runtime setup (temp home/env, deterministic ports, start/stop helpers, retry-on-port-collision, optional WS client, fake timer harness for cron/timeout tests).
Clawdbot reference: `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/test-helpers.server.ts:88-173`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/test-helpers.server.ts:174-278`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/test-helpers.server.ts:280-282`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/test-helpers.server.ts:334-401`, `/opt/homebrew/lib/node_modules/clawdbot/src/gateway/test-helpers.mocks.ts:191-531`, `/opt/homebrew/lib/node_modules/clawdbot/src/cron/service.test-harness.ts:23-66`, `/opt/homebrew/lib/node_modules/clawdbot/src/cron/isolated-agent.test-harness.ts:7-51`.
Complexity: **M**.

21-file harness dependency check:
1) `test/integration/state/sqlite/friday-migration-chain.test.ts` -> Claw harness: **No**  
2) `test/integration/hub/friday-hub-bootstrap-integration.test.ts` -> **Yes (temp home/env isolation)**  
3) `test/e2e/cli/friday-cli-start-runtime.test.ts` -> **Yes (process loop + free-port + graceful shutdown)**  
4) `test/e2e/skills/friday-skill-lifecycle.test.ts` -> **Yes (workspace/home harness)**  
5) `test/e2e/plugins/friday-plugin-local-lifecycle.test.ts` -> **Yes (fs fixture + env harness)**  
6) `test/e2e/plugins/friday-plugin-marketplace-lifecycle.test.ts` -> **Yes (mocked network + harness)**  
7) `test/integration/sessions/friday-session-lifecycle.test.ts` -> **No**  
8) `test/integration/sessions/friday-session-memory-extraction-integration.test.ts` -> **Yes (timer harness recommended)**  
9) `test/e2e/workflows/friday-workflow-approval-chain.test.ts` -> **Yes (API server harness)**  
10) `test/e2e/workflows/friday-workflow-trigger-chain.test.ts` -> **Yes (API + timer harness)**  
11) `test/e2e/workflows/friday-workflow-timeout-chain.test.ts` -> **Yes (timer harness)**  
12) `test/integration/memory/friday-memory-service-pipeline.test.ts` -> **No**  
13) `test/integration/memory/guard/friday-memory-guard-pii-namespace.test.ts` -> **No**  
14) `test/e2e/api/friday-api-skills-routes.test.ts` -> **Yes (API server harness)**  
15) `test/e2e/api/friday-api-plugins-routes.test.ts` -> **Yes (API server harness)**  
16) `test/e2e/api/friday-api-workflows-routes.test.ts` -> **Yes (API server harness)**  
17) `test/e2e/api/friday-api-sessions-memory-routes.test.ts` -> **Yes (API server harness)**  
18) `test/e2e/api/friday-api-approvals-routes.test.ts` -> **Yes (API server harness)**  
19) `test/e2e/api/friday-api-auth-rbac-errors.test.ts` -> **Yes (API server harness)**  
20) `test/e2e/integration/friday-workflow-skill-memory-chain.test.ts` -> **Partial (workspace harness recommended)**  
21) `test/e2e/integration/friday-plugin-event-workflow-session-chain.test.ts` -> **Yes (full harness: API + event timing + env isolation)**

