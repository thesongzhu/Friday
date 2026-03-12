> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Naming Audit

Date: 2026-03-04 (America/Los_Angeles)

## Inconsistencies Found

## N1 - API `operationId` style mixed (dot-namespace vs camelCase)

- Examples:
  - `src/api/http/routes/friday-agent-routes.ts:81` -> `agent.runs.start`
  - `src/api/http/routes/friday-agent-routes.ts:215` -> `cancelAgentRun`
  - `src/api/http/routes/friday-workflow-builder-routes.ts:86` -> `workflows.importBundle`
  - `src/api/http/routes/friday-deterministic-pipeline-routes.ts:147` -> `nodeRunner.execute`
- Impact:
  - API contract tooling and docs generation become inconsistent.
  - Harder to grep or automate policy by operation namespace.
- Decision:
  - Must unify for external contract in staged migration (see `NAMING_CONVENTION.md`).

## N2 - Request correlation vocabulary mixed by layer

- Examples:
  - HTTP layer uses `requestId` (`src/api/http/friday-http-server.ts:405`)
  - Agent/channel uses `correlationId` and `routeId` (`src/agent/runtime/friday-agent-runtime.ts`, `src/hub/friday-hub-bootstrap.ts:2016`)
  - Some audit/legacy types still expose `traceId` (`src/hub/services/friday-hub-memory-state.types.ts:23`)
- Impact:
  - Cross-system tracing can be confusing without explicit mapping.
- Decision:
  - Keep all three terms but define strict semantics:
    - `requestId`: HTTP request scope
    - `correlationId`: cross-component operation scope
    - `traceId`: observability trace envelope scope

## N3 - Error code namespace mixed (`VALIDATION_ERROR` vs domain-prefixed)

- Examples:
  - generic `VALIDATION_ERROR` in many API routes
  - domain-specific codes like `AGENT_TOOL_ERROR`, `MARKETPLACE_INSTALL_REQUIRED`, `E-CH-OUTBOUND-001`
- Impact:
  - Human readability is okay, but machine classification needs code-family conventions.
- Decision:
  - Keep generic top-level validation code for shared API behavior.
  - Require domain prefixes for runtime execution/delivery/tool errors.

## N4 - Feature-gate defaults encoded with both `EqualsTrue` and `NotFalse`

- Evidence:
  - `src/hub/bootstrap/friday-capability-gates.ts`
- Impact:
  - Naming implies boolean flags but default semantics differ (opt-in vs opt-out).
- Decision:
  - Keep behavior, but document each gate default explicitly in enablement docs and map.

## N5 - Internal vs external naming drift for routing feature

- Example:
  - `src/routing/*` exists with clear domain naming, but not composed into external runtime path.
- Impact:
  - Name appears first-class but behavior is internal-only.
- Decision:
  - Either wire feature or mark as experimental/internal in docs and exports.

## Must-Unify vs Can-Remain

Must unify (external contract/core concepts):

1. API `operationId` naming pattern
2. error-code family prefixes for runtime delivery/tool failures
3. tracing field semantics documentation (`requestId/correlationId/traceId`)
4. core concept terms: `route`, `tool`, `workflow`, `skill`, `delivery`

Can remain mixed (for compatibility or internal detail):

1. legacy aliases where migration would break clients
2. third-party imposed names (provider APIs)
3. internal helper variable naming not exposed in API/log contracts
