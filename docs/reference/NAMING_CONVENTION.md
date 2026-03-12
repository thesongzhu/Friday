> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# Naming Convention

Date: 2026-03-04 (America/Los_Angeles)

## Contract Naming Rules

## 1) API operationId

- Rule: dot-separated, lowercase namespaces.
- Pattern: `<domain>.<resource>.<action>`
- Examples:
  - `agent.runs.cancel`
  - `workflows.builder.import_bundle`
  - `node_runner.executions.get`

## 2) Error codes

- Rule:
  - Business/domain errors: `DOMAIN_REASON` (e.g., `MARKETPLACE_INSTALL_REQUIRED`)
  - Runtime delivery/system channel errors: `E-<domain>-<category>-<nnn>` (e.g., `E-CH-OUTBOUND-001`)
  - Warning class: `W-...`
- Requirement:
  - every user-facing failure must expose `error.code` or deterministic textual code marker.

## 3) Trace fields

- Rule:
  - `requestId`: HTTP request scope
  - `correlationId`: end-to-end operation scope across components
  - `traceId`: observability trace envelope scope
- Requirement:
  - log payloads that cross boundaries should include at least `correlationId`.

## 4) Capability gates

- Rule:
  - Gate env names must use `FRIDAY_<CAPABILITY>_ENABLED` when possible.
  - Non-standard defaults (opt-out via `!= false`) must be documented in enablement map.

## Migration Strategy (Low-Churn)

1. PR1 (non-breaking):
   - add naming lint checks for new routes and error codes.
   - document compatibility aliases in API docs.
2. PR2 (alias stage):
   - introduce normalized operationId aliases in contract layer.
   - keep old names for one release cycle.
3. PR3 (cleanup):
   - remove deprecated aliases after clients migrate.

## Guardrails

- Do not mass-rename internal symbols without external contract benefit.
- Prioritize externally visible stability over internal cosmetic consistency.
