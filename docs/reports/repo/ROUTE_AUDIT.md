> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Route Audit

Date: 2026-03-04 (America/Los_Angeles)

Legend:

- `闭环`: user-visible output confirmed
- `半闭环`: partial closure or internal-only output
- `不闭环`: no user-visible completion path

## R1 - HTTP envelope route closure

- Trigger: any `/v1/*` request
- Pipeline:
  1. `src/api/http/friday-http-server.ts:createFridayHttpServer`
  2. route lookup `routes.findRoute(...)`
  3. handler execution `await route.handler(ctx)`
  4. envelope output `{ ok, data/error, requestId }`
- Tool boundary: route-specific runtime/tool invocations
- State: request-scoped `ctx`, optional DB writes by handlers
- Output boundary: JSON response body (`sendJsonWithHeaders`)
- Observability: request log + `requestId`
- Failure points:
  - malformed JSON / path
  - auth/scope/rate-limit rejection
  - handler throw mapped via `buildErrorResponse`
- Status: `闭环`
- Evidence: `test/e2e/api/friday-api-workflows-routes.test.ts`, `test/e2e/api/friday-api-auth-rbac-errors.test.ts`

## R2 - Webchat/Discord inbound -> agent -> outbound delivery

- Trigger: channel inbound message
- Pipeline:
  1. `src/hub/friday-hub-bootstrap.ts:channelMessageHandler`
  2. session mirror + history load (`hubSessionService`)
  3. `agentRuntime.executeRun(...)`
  4. `channelRegistry.send(...)`
- Tool boundary: agent runtime tool executor (`src/agent/runtime/friday-agent-runtime.ts`)
- State: session messages + run state + channel correlation key
- Output boundary: channel outbound text + optional images
- Observability:
  - `routeId` and `correlationId` logged via `logChannelIssue`
  - error codes `E-CH-*`
- Failure points:
  - run failure
  - primary delivery failure
  - retry delivery failure
- Status: `闭环`
- Evidence: `test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts` cases `G`, `G2`, `G2 delivery failure closure`

## R3 - Agent run API lifecycle

- Trigger: `POST/GET /v1/agent/runs*`
- Pipeline:
  1. `src/api/http/routes/friday-agent-routes.ts:createFridayAgentRoutes`
  2. runtime start path from `src/api/runtime/friday-api-runtime.ts:startRun`
  3. `deps.agentRuntime.executeRun(...)`
  4. list/get/cancel/sse handlers return envelope/SSE
- Tool boundary: agent runtime tool execution
- State: run repository + session history + abort controller map
- Output boundary: JSON responses and SSE stream
- Observability: event emitter frames include run status/event type
- Failure points:
  - validation failure
  - run not found
  - already terminal on cancel
- Status: `闭环`
- Evidence: `test/e2e/api/friday-api-auth-rbac-errors.test.ts` + openclaw parity route tests

## R4 - Workflow run + evidence export route

- Trigger: `/v1/workflow-runs*`
- Pipeline:
  1. `src/api/http/routes/friday-workflow-run-routes.ts:createFridayWorkflowRunRoutes`
  2. `src/workflows/services/friday-workflow-execution-service.ts:executeRun`
  3. run state/node/timeline/evidence endpoints
- Tool boundary: node runner, retry bridge, workflow engine
- State: workflow run tables, evidence export records
- Output boundary: run metadata, nodes, timeline, evidence export/download response
- Observability: run IDs + event publication hooks
- Failure points:
  - workflow validation/auth failures
  - entitlement gate denials for marketplace listing
- Status: `闭环`
- Evidence: `test/e2e/api/friday-api-workflows-routes.test.ts`

## R5 - Browser tool artifact closure

- Trigger: agent tool `browser` with screenshot actions
- Pipeline:
  1. `src/agent/runtime/friday-agent-runtime.ts:runToolUse`
  2. `src/agent/tools/friday-agent-browser-tool.ts:execute -> handleScreenshot`
  3. artifact write path from browser manager
  4. tool result propagated to agent response/channel output
- Tool boundary: Playwright/browser manager
- State: browser sessions + artifact files
- Output boundary: user-visible path/attachment in route response
- Observability: `agent.run.tool_start/tool_end` with route/correlation
- Failure points:
  - invalid action args
  - browser disconnect/timeout
- Status: `闭环`
- Evidence: openclaw parity E2E case `C/G route closure: browser screenshot...`

## R6 - Desktop capability gate closure

- Trigger: agent tool `desktop`
- Pipeline:
  1. capability resolution `src/hub/bootstrap/friday-capability-gates.ts`
  2. tool availability in runtime
  3. if unavailable => `buildUnavailableToolMessage` in `friday-agent-runtime.ts`
- Tool boundary: desktop session manager (enabled case)
- State: desktop session and permission status
- Output boundary:
  - enabled => tool result delivered
  - disabled => explicit user guidance
- Observability: `agent.run.tool_end` includes `AGENT_TOOL_ERROR` for unavailable flow
- Failure points:
  - runtime not enabled
  - OS permissions missing
- Status: `闭环`
- Evidence: openclaw parity E2E cases `desktop enabled route closure` and `desktop disabled failure path`

## R7 - Marketplace entitlement/install gate closure

- Trigger: run requests with `marketplaceListingId`
- Pipeline:
  1. API route checks in `friday-workflow-run-routes.ts` / `friday-agent-routes.ts`
  2. entitlement guard `src/marketplace/engine/entitlement-guard.ts`
- Tool boundary: none (domain guard)
- State: entitlement + installation persistence
- Output boundary: allow run or explicit denial code
- Observability: error code in response
- Failure points:
  - no entitlement
  - install required but missing
- Status: `闭环`
- Evidence: `test/integration/marketplace/friday-marketplace-install-closure.test.ts`

## R8 - Not-enabled feature signaling closure

- Trigger: call feature path when route family not registered
- Pipeline:
  1. `createFridayHttpServer` route match miss
  2. observability-specific not-enabled messaging branch
- Tool boundary: none
- State: none
- Output boundary: explicit not-enabled error message
- Observability: requestId in response
- Failure points:
  - missing registration mistaken as generic 404
- Status: `闭环`
- Evidence: openclaw parity E2E case `F route unsupported path: observability API returns explicit not-enabled message`

## Route Closure Summary

- `闭环`: R1-R8
- `半闭环`: none in audited external contract routes
- `不闭环`: none in audited external contract routes
