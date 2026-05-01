# Phase 5 - Data Model and Migration Audit

## Verified

- `npm run check:migrations` PASS: 75 migrations v001-v075 are contiguous and registered.
- Migration unit tests cover many schema slices: sessions, memory, plugins, scheduler, desktop/system remote tables, marketplace actor isolation, learning metrics, workflow artifacts, etc.
- SQLite layer tests passed for transactions, rollback, close, checkpoint, and concurrent initialization.

## Data Model Strengths

- Many tables have explicit repository tests.
- Sessions/messages have idempotency and lifecycle tests.
- Workflow runs/checkpoints/triggers have persistence and state transition tests.
- Memory FTS and embedding repositories sanitize/query malformed input and handle fallback.
- Marketplace request/support actor isolation migration v055 backfills/quarantines legacy rows.
- Satellite cursor and ack HMAC tests passed.

## Data Integrity Findings

| ID | Severity | Finding | Evidence | Risk | Fix |
| --- | --- | --- | --- | --- | --- |
| DATA-001 | P0 | Paid entitlement rows can be created by user-facing purchase completion route. | `src/api/http/routes/friday-marketplace-commerce-routes.ts:926-927`. | Entitlements table can become source of false paid access. | Only verified billing/reconciliation path may write paid entitlements. |
| DATA-002 | P1 | Billing webhook records/events are modeled but not reachable through API runtime. | Billing handler exists; route not found. | Tables can remain unused/dead while purchase state changes elsewhere. | Wire route and processing jobs, then test from raw webhook to entitlement. |
| DATA-003 | P2 | Marketplace buyer tenant ID uses principal ID at checkout. | `src/api/http/routes/friday-marketplace-commerce-routes.ts:817-818`. | Tenant analytics/access can diverge from intended tenant ownership. | Normalize tenant ID helper and enforce in tests. |
| DATA-004 | P2 | Observability audit writes can fail after DB close in tests. | `npm test` output shows `TypeError: The database connection is not open` and `OBS_AUDIT_APPEND_FAILED`. | Shutdown/background job races can drop or fail audited operations. | Add lifecycle drain/stop ordering and fail tests on late writes. |
| DATA-005 | P2 | Browser-local chat history can mask backend persistence. | `ui/src/hooks/use-chat-session.ts` stores last messages locally. | UI may show a conversation that is not durable server state. | Make server persistence the source of truth or label local drafts clearly. |

## Migration/Runtime Gaps

- Scratch-from-empty migration path is well tested locally, but production migration rollout/backup/rollback was not verified.
- No destructive migration/rollback commands were run.
- Native companion release tests can leave `.friday/locks/macos-release.lock`; one failure timed out waiting for that lock.
