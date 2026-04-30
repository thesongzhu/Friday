# Phase 3 - Architecture and Layer Audit

## Diagram

```text
UI routes
  -> ui/src/lib/api/client.ts
  -> src/api/http/friday-http-server.ts
  -> src/api/runtime/friday-api-runtime.ts
  -> route factories under src/api/http/routes
  -> services/engines under src/{agent,workflows,marketplace,memory,channels,...}
  -> repositories under src/**/persistence and src/state/sqlite
```

## Boundary Violations and Hotspots

| Severity | Finding | Evidence | Risk |
| --- | --- | --- | --- |
| P1 | Architecture boundary check fails | `npm run check:architecture-boundaries` failed: security layer import escape in `src/security/multi-tenant/engine/policy-engine.ts` importing `../../../rules/engine/condition-evaluator.js`. | Security engine depends across layer boundary, increasing coupling and accidental privilege bleed. |
| P1 | Composition root is too large | `src/hub/friday-hub-bootstrap.ts` is thousands of lines and wires nearly every subsystem. | High blast radius, hard reviewability, difficult lifecycle ordering. |
| P1 | Agent/runtime files have extreme function size/complexity | ESLint PASS with 1353 warnings; examples include `src/agent/runtime/friday-agent-runtime.ts` functions over 2600 lines and complexity 458. | Maintainers cannot reason about state transitions or security-sensitive tool execution easily. |
| P1 | Paid marketplace path trusts authenticated API caller too much | `POST /v1/marketplace/purchases/:id/complete` grants entitlement with only `marketplace.write` and tenant access. | Business/payment boundary lives in ordinary API route rather than provider-verified service boundary. |
| P2 | Tenant ID source is inconsistent in marketplace checkout | `buyerTenantId` and `buyerPrincipalId` both use `requirePrincipalId(ctx)` at `src/api/http/routes/friday-marketplace-commerce-routes.ts:817-818`. | Tenant-scoped queries and reports can collapse user and tenant identity. |
| P2 | Many route tests use stubs only | Examples: workflow builder route tests say handlers are never invoked; API skills route E2E uses mock converter. | Route existence is tested, not closed-loop behavior. |

## Duplicate Mechanisms

- Multiple evidence tiers: live runtime, mock hub, browser mock hub, route contract snapshots. This is good when labeled, but dangerous if mock evidence is used as release evidence.
- Multiple auth paths: local bypass, local passphrase, bearer/session tokens, bootstrap.
- Multiple plugin modes: full and stub.
- Multiple lockfiles: `package-lock.json` and `pnpm-lock.yaml`.

## State Machine and Concurrency Risks

- Marketplace paid purchase state is not guarded by a provider-verified transition.
- Billing webhook handler has dedupe by external ID, but no HTTP route was found to invoke it.
- Native companion release tests showed release lock timeouts, proving concurrency/cleanup is fragile in release scripts.
- Workflow runtime has retry/checkpoint tests, but production webhook idempotency and replay behavior need external smoke coverage.

## Recommended Consolidation Plan

1. Move paid entitlement transitions behind a verified billing service and remove user-facing completion.
2. Wire billing webhook HTTP route with raw-body signature verification, idempotency, and non-success default for unknown event types.
3. Split hub bootstrap into feature modules with explicit lifecycle start/stop ownership.
4. Fix architecture-boundary import and add CI gate.
5. Promote closed-loop tests out of stubs for marketplace, channels, plugins, and UI critical paths.
