> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# Route Map

Date: 2026-03-04 (America/Los_Angeles)

All routes below are mapped to concrete code and include closure boundary expectations.

## Route R1 - CLI start -> hub/api boot -> user-visible HTTP service

- Trigger: `friday start` CLI
- Pipeline:
  1. `src/cli/friday-cli.ts` (`parseArgs`, start dispatch)
  2. `src/cli/friday-cli-run-loop.ts` (`runFridayCliLoop`)
  3. `src/hub/friday-hub-bootstrap.ts` (`createFridayHub`, `hub.start`)
  4. `src/api/http/friday-http-server.ts` (`createFridayHttpServer`, `listen`)
- Tool boundary: runtime service init (provider/browser/desktop/channels)
- Output boundary: HTTP endpoints reachable (`/v1/health`, `/v1/auth/*`)
- State flow: request-level `requestId`; run-level IDs from runtime
- Failure points: bad port binding, missing token secret, DB/init failure

## Route R2 - Web/API run request -> agent runtime -> JSON output envelope

- Trigger: `POST /v1/agent/runs`
- Pipeline:
  1. `src/api/http/friday-http-server.ts` route dispatch
  2. `src/api/http/routes/friday-agent-routes.ts` (`agent.runs.start`)
  3. `src/api/runtime/friday-api-runtime.ts` (`startRun`)
  4. `src/agent/runtime/friday-agent-runtime.ts` (`executeRun`)
- Tool boundary: `runToolUse` inside agent runtime
- Output boundary: `{ ok:true, data:{ runId,status,response... }, requestId }`
- State flow: `requestId` (HTTP) + `runId` + tool event `correlationId`
- Failure points: validation, tool errors, timeout, policy guard

## Route R3 - Workflow run API -> workflow engine -> timeline/evidence user output

- Trigger: `POST /v1/workflow-runs` + follow-up GET endpoints
- Pipeline:
  1. `src/api/http/routes/friday-workflow-run-routes.ts`
  2. `src/workflows/services/friday-workflow-execution-service.ts` (`executeRun`)
  3. repositories in `src/workflows/persistence/*`
- Tool boundary: node runner bridge / skill invocation boundaries
- Output boundary: run status, nodes, timeline, evidence/export endpoints
- State flow: `requestId`, `runId`, workflow node records
- Failure points: validation, entitlement gate, node execution errors, retry exhaustion

## Route R4 - Channel inbound (Discord/Webchat) -> agent -> outbound delivery

- Trigger: inbound message from channel plugin
- Pipeline:
  1. channel adapter `src/channels/*/friday-*-channel.ts`
  2. registry callback in `src/hub/friday-hub-bootstrap.ts` (`channelMessageHandler`)
  3. `agentRuntime.executeRun`
  4. `channelRegistry.send` primary + fallback retry path
- Tool boundary: agent tool execution during run
- Output boundary: user-visible channel message + optional image attachments
- State flow: `correlationId = channel:<kind>:<chatId>:<msgId>`, plus `runId`
- Failure points:
  - primary delivery failure (`E-CH-OUTBOUND-001`)
  - retry delivery failure (`E-CH-OUTBOUND-RETRY-001`)
  - run failure (`E-CH-RUN-001`)

## Route R5 - Browser tool route closure

- Trigger: agent tool use `browser`
- Pipeline:
  1. `src/agent/runtime/friday-agent-runtime.ts` (`runToolUse`)
  2. `src/agent/tools/friday-agent-browser-tool.ts` (`execute` + action handler)
  3. `src/browser/friday-browser-manager.ts`
- Tool boundary: Playwright/browser process
- Output boundary: artifact path/base64 returned and surfaced to user output
- State flow: tool event `routeId=agent.execute.tool`, `correlationId=runId`
- Failure points: invalid args, browser unavailable/timeout/disconnect

## Route R6 - Desktop tool gate + execution route

- Trigger: agent tool use `desktop`
- Pipeline:
  1. capability gate `src/hub/bootstrap/friday-capability-gates.ts`
  2. runtime unavailable handling `src/agent/runtime/friday-agent-runtime.ts` (`buildUnavailableToolMessage`)
  3. when enabled -> `src/agent/tools/friday-agent-desktop-tool.ts`
- Tool boundary: native desktop adapter/session manager
- Output boundary:
  - enabled: actionable desktop result
  - disabled: explicit enablement hint (`FRIDAY_DESKTOP_ENABLED=true`)
- State flow: tool-end events with `errorCode` and `correlationId`
- Failure points: disabled gate, permission denied, desktop session disconnected

## Route R7 - Marketplace entitlement/install gate

- Trigger: run request with `marketplaceListingId`
- Pipeline:
  1. `src/api/http/routes/friday-agent-routes.ts` or `friday-workflow-run-routes.ts`
  2. guard in `src/marketplace/engine/entitlement-guard.ts`
- Tool boundary: none (domain guard)
- Output boundary: allow run OR explicit domain error code
- State flow: principal + listing + entitlement/install rows
- Failure points:
  - `MARKETPLACE_ENTITLEMENT_REQUIRED`
  - `MARKETPLACE_INSTALL_REQUIRED`

## Route R8 - Not-enabled feature signaling (explicit, non-silent)

- Trigger: request to route family not registered (example observability)
- Pipeline:
  1. HTTP route lookup miss in `src/api/http/friday-http-server.ts`
  2. capability-specific not-enabled message branch
- Tool boundary: none
- Output boundary: explicit user-facing message with error envelope
- State flow: `requestId` persisted in response
- Failure points: generic 404 ambiguity if feature-specific branch regresses

## Route R9 - CLI integration tests as user-facing boot contract

- Trigger: `runFridayCliLoop` integration flow
- Pipeline:
  1. `src/cli/friday-cli-run-loop.ts`
  2. API server startup and graceful shutdown
- Tool boundary: none required for base boot
- Output boundary: HTTP responses, graceful exit code
- State flow: runtime start/stop lifecycle transitions
- Failure points: shutdown signal handling, port close race
