> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# Friday Contract

Date: 2026-03-04 (America/Los_Angeles)

This contract captures active, externally visible promises verified in this release regression.

## P1 - CLI can start Friday runtime and expose API service

- Entrypoint: `CLI`
- Trigger: `friday start`
- Example input: `friday start --host 127.0.0.1 --port 3141`
- Success (user-visible): API becomes reachable and returns structured JSON envelopes.
- Failure (user-visible): startup exits with explicit error/log context.
- Error standards: startup/log errors include actionable message; HTTP failures include `requestId`.

## P2 - HTTP API always returns structured envelopes

- Entrypoint: `Web/API`
- Trigger: `/v1/*` calls
- Example input: `GET /v1/health`, `GET /v1/auth/me` (without token)
- Success: `{ ok: true, data, requestId }`
- Failure: `{ ok: false, error: { code, message }, requestId }`
- Error standards: route/auth/validation failures map to explicit codes (`VALIDATION_ERROR`, etc.)

## P3 - Agent run APIs produce traceable run results

- Entrypoint: `Web/API`
- Trigger: `/v1/agent/runs*`
- Example input: `POST /v1/agent/runs {"task":"...","providerId":"...","model":"..."}`
- Success: run accepted/completed with retrievable run state and events.
- Failure: explicit run errors (`AGENT_RUN_NOT_FOUND`, `AGENT_RUN_ALREADY_TERMINAL`, tool/runtime errors).

## P4 - Workflow run lifecycle is closed-loop

- Entrypoint: `Web/API`
- Trigger: `/v1/workflow-runs*`
- Example input: `POST /v1/workflow-runs {"workflowId":"...","versionNumber":1}`
- Success: start -> terminal run -> timeline/nodes/evidence endpoints accessible.
- Failure: explicit code + error message in response envelope.

## P5 - Channel ingress/egress reaches user-visible completion

- Entrypoint: `Discord/Webchat` (and channel framework)
- Trigger: inbound message
- Example input: inbound channel event (`MESSAGE_CREATE` / webchat frame `{type:"message"}`)
- Success: outbound reply text and optional attachments delivered to channel user.
- Failure: explicit fallback delivery text with code (`E-CH-OUTBOUND-001`) and correlation reference.

## P6 - Browser tool delivers visible artifacts

- Entrypoint: `Agent tool runtime` (via API/channel)
- Trigger: tool action `browser` screenshot/snapshot flow
- Example input: agent task that triggers `browser` action `screenshot`/`snapshot`
- Success: screenshot/file artifact exists, is non-empty, and is referenced in user output.
- Failure: explicit tool error text and event-level `errorCode`.

## P7 - Desktop capability behavior is explicit

- Entrypoint: `Agent tool runtime`
- Trigger: tool action `desktop`
- Example input: agent task triggering desktop `session_info`
- Success (enabled): desktop session/action result returned to user.
- Failure (disabled): explicit enablement guidance `FRIDAY_DESKTOP_ENABLED=true`.

## P8 - Marketplace run gating enforces entitlement/install policy

- Entrypoint: `Web/API`
- Trigger: run request with `marketplaceListingId`
- Example input: run request referencing marketplace listing before/after install
- Success: entitled/installed principal can run.
- Failure: explicit `MARKETPLACE_ENTITLEMENT_REQUIRED` or `MARKETPLACE_INSTALL_REQUIRED`.

## P9 - Not-enabled features fail explicitly, never fake-success

- Entrypoint: `Web/API`
- Trigger: unsupported route family call (e.g., observability when disabled)
- Example input: `GET /v1/observability/traces` when observability routes are not wired
- Success: clear not-enabled message.
- Failure standard: no silent success; response still includes structured error envelope.

## P10 - Traceability fields are emitted across key stages

- Entrypoint: `Web/API + Agent + Channels`
- Trigger: run execution and delivery flows
- Example input: agent run and channel delivery events for one correlation scope
- Success: logs/events include correlation context (`requestId`, `runId`, `correlationId`, `routeId` as applicable).
- Failure: error paths still preserve structured error code and contextual IDs.
