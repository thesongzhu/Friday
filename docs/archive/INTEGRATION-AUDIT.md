> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

**CRITICAL**
1. Agent API is not wired into hub bootstrap, so all agent endpoints are absent (404).
`src/api/runtime/friday-api-runtime.ts:757` only registers `createFridayAgentRoutes(...)` when both `deps.agentRuntime` and `deps.agentEventEmitter` exist, but hub does not pass either in `src/hub/friday-hub-bootstrap.ts:519`. These deps are defined in `src/api/runtime/friday-api-runtime.types.ts:83` and `src/api/runtime/friday-api-runtime.types.ts:85`.
Fix: instantiate `AgentRuntime` and `AgentEventEmitter` in hub (`src/agent/runtime/friday-agent-runtime.ts:29`, `src/agent/runtime/friday-agent-event-emitter.ts:22`) and pass them into `createFridayApiRuntime(...)`.

2. Subagent API is not wired, so subagent routes are absent (404).
`src/api/runtime/friday-api-runtime.ts:812` registers subagent routes only when `deps.subagentRegistry` exists. Hub does not pass it in `src/hub/friday-hub-bootstrap.ts:519`, though the dep exists in `src/api/runtime/friday-api-runtime.types.ts:87`.
Fix: create and pass `SubagentRegistry` from hub (`src/agent/subagent/friday-subagent-registry.ts:23`).

3. SSE endpoint for agent run events is effectively broken by missing route registration.
`/v1/agent/runs/:runId/events` is defined in `src/api/http/routes/friday-agent-routes.ts:184`, and HTTP server SSE support exists via raw response injection in `src/api/http/friday-http-server.ts:532`, but route block is never mounted because item #1 is missing.
Fix: same as #1; once agent routes are mounted, SSE path is available.

4. WebSocket realtime gateway is not wired to transport.
`FridayHttpServerDeps` requires `wsGateway` (`src/api/http/friday-http-server.ts:25`) and CLI passes it (`src/cli/friday-cli-run-loop.ts:35`), but server never uses it and always rejects upgrades with `501` (`src/api/http/friday-http-server.ts:577`, `src/api/http/friday-http-server.ts:582`).
Fix: implement real upgrade handling and frame dispatch through `wsGateway`, or remove WS contract until implemented.

**IMPORTANT**
1. Full missing-dependency diff (CreateFridayApiRuntimeDeps vs hub call):
Missing in hub call at `src/hub/friday-hub-bootstrap.ts:519`: `accessTokenTtlSec`, `refreshTokenTtlSec`, `agentRuntime`, `agentEventEmitter`, `subagentRegistry`.
Defined in deps interface at `src/api/runtime/friday-api-runtime.types.ts:63`, `src/api/runtime/friday-api-runtime.types.ts:64`, `src/api/runtime/friday-api-runtime.types.ts:83`, `src/api/runtime/friday-api-runtime.types.ts:85`, `src/api/runtime/friday-api-runtime.types.ts:87`.
Fix: wire critical missing deps now (agent/subagent); decide whether to expose/pass TTL config.

2. Agent cancel path has a latent wiring bug even after mounting routes.
Abort controller is inserted after `executeRun` returns (`src/api/runtime/friday-api-runtime.ts:768`, `src/api/runtime/friday-api-runtime.ts:773`), so cancel lookup (`src/api/runtime/friday-api-runtime.ts:798`) cannot stop an in-flight run.
Fix: allocate `runId` first, store controller before awaiting runtime execution, pass that `runId` into `executeRun`.

3. Session services are not hub-composed (created internally by API runtime).
Hub does not create/pass `FridaySessionService` or `FridaySessionMemoryExtractionService`; API runtime creates them internally (`src/api/runtime/friday-api-runtime.ts:723`, `src/api/runtime/friday-api-runtime.ts:732`).
Fix: either keep as intentional architecture and document it, or move creation to hub and inject through expanded runtime deps.

4. Fleet/security integration is wired (no 404 gap).
`FridayFleetDashboardService` is created (`src/api/runtime/friday-api-runtime.ts:173`) and security routes are registered (`src/api/runtime/friday-api-runtime.ts:633`) with revoke handlers (`src/api/runtime/friday-api-runtime.ts:635`, `src/api/runtime/friday-api-runtime.ts:642`).
Fix: none required for route wiring.

**MINOR**
1. Conditional route-registration audit (all `if (deps.xxx)` blocks):
True/wired: `skillGenerator+skillRegistry` (`src/api/runtime/friday-api-runtime.ts:678`), `converterService` (`src/api/runtime/friday-api-runtime.ts:688`), `workflowGenerator` (`src/api/runtime/friday-api-runtime.ts:697`), `memoryService` (`src/api/runtime/friday-api-runtime.ts:707`, `src/api/runtime/friday-api-runtime.ts:731`), `pluginService+pluginManifestLoader` (`src/api/runtime/friday-api-runtime.ts:747`).
False/not wired: `agentRuntime+agentEventEmitter` (`src/api/runtime/friday-api-runtime.ts:757`), `subagentRegistry` (`src/api/runtime/friday-api-runtime.ts:812`).

2. UI→API mismatch check requested (`sessions.ts`, `workflows.ts`): no 404 registration gaps found.
Sessions UI endpoints (`ui/src/lib/api/sessions.ts:106`) map to registered session routes (`src/api/http/routes/friday-session-routes.ts:333`).
Workflows UI endpoints (`ui/src/lib/api/workflows.ts:58`) map to registered workflow routes (`src/api/http/routes/friday-workflow-routes.ts:39`).

**FIX PLAN**
1. In `src/hub/friday-hub-bootstrap.ts`, add agent composition: create `AgentEventEmitter`, `AgentLlmClient`, tool registry, and root `AgentRuntime`.
2. In the same file, create `SubagentRegistry` with `createChildRuntime(...)` that reuses the same composition path for child runs.
3. Pass `agentRuntime`, `agentEventEmitter`, and `subagentRegistry` into `createFridayApiRuntime(...)` at the hub call site.
4. Patch `startRun/cancelRun` logic in `src/api/runtime/friday-api-runtime.ts` so cancellation can target active runs.
5. Implement real WS upgrade handling in `src/api/http/friday-http-server.ts` using `deps.wsGateway` (or explicitly de-scope/remove WS deps until implemented).
6. Optionally expose/pass `accessTokenTtlSec` and `refreshTokenTtlSec` from hub config to API runtime.
7. Add integration tests that boot hub+HTTP and assert: agent routes exist, subagent routes exist, SSE path responds, and WS upgrade no longer returns 501.