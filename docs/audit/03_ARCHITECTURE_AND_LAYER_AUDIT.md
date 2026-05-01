# Phase 3 - Architecture and Layer Audit

## Diagram

```text
UI routes
  -> ui/src/lib/api/client.ts
  -> src/api/http/friday-http-server.ts
  -> src/api/runtime/friday-api-runtime.ts
  -> route factories under src/api/http/routes
  -> services/engines under src/{agent,workflows,memory,channels,plugins,observability,security,...}
  -> repositories under src/**/persistence and src/state/sqlite
```

## Boundary Findings

| Severity | Finding | Evidence | Current Status |
| --- | --- | --- | --- |
| P1 resolved | Security layer imported rules layer regex helper. | Previous `npm run check:architecture-boundaries` failed on `src/security/multi-tenant/engine/policy-engine.ts` importing `../../../rules/engine/condition-evaluator.js`. | Fixed by local security-layer regex compiler/cache; `npm run check:architecture-boundaries` PASS. |
| P1 | Composition root remains too large. | `src/hub/friday-hub-bootstrap.ts` still wires most subsystems. | Open maintainability risk. |
| P1 | Agent/runtime files still have high complexity. | Prior lint reported many warnings and very large runtime functions. | Open maintainability/security-review risk. |
| P2 | Tests still mix mock proof and closed-loop proof. | Route/API/UI tests include stubs and skipped live lanes. | Open evidence-labeling risk. |

## Duplicate Mechanisms

- Multiple test evidence tiers: live runtime, mock hub, browser mock hub, route contract snapshots, real-world smoke. They are useful only when release status labels distinguish them.
- Multiple package-manager locks: npm and pnpm.
- Multiple channel modes: real, stub, disabled, sandbox-only.

## State Machine and Concurrency Risks

- Marketplace payment state machine risk is retired with marketplace removal.
- Native companion release concurrency now passes locally, but release scripts still share `dist/` outputs and locks; avoid concurrent manual release/install smokes.
- Workflow runtime has retry/checkpoint tests; external webhook idempotency and replay still need staging proof.

## Recommended Consolidation Plan

1. Split hub bootstrap into feature modules with explicit lifecycle start/stop ownership.
2. Keep architecture-boundary check in CI.
3. Add warning budgets for the largest security-sensitive runtime files.
4. Split mock proof from release proof in CI names and audit docs.
5. Add capability truth for stub/sandbox-only channel/plugin modes.
