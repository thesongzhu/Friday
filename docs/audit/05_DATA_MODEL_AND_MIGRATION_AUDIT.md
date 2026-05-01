# Phase 5 - Data Model and Migration Audit

## Verified

- Tracked tree migration integrity PASS: 75 migrations v001-v075 are contiguous and registered.
- Repo-root `npm run check:migrations` now PASS after quarantining untracked duplicate migration files such as `v038-retired-feature-reserved-a 3.ts` outside the repo; a temporary clean tracked-tree copy also passed the same script.
- Migration unit tests in full `npm test` passed.
- SQLite layer/repository tests passed for sessions, memory, workflows, plugins, scheduler, satellites, observability, auth, and security tables.

## Data Model Strengths

- Sessions/messages have idempotency and lifecycle tests.
- Workflow runs/checkpoints/triggers/approvals have persistence and state transition tests.
- Memory FTS and embedding repositories sanitize malformed input and handle fallback behavior.
- Satellite cursor and ack HMAC tests passed.
- Retired marketplace migrations remain contiguous without creating new active marketplace runtime access.

## Data Integrity Findings

| ID | Severity | Finding | Evidence | Current Status | Fix |
| --- | --- | --- | --- | --- | --- |
| DATA-001 | P1 resolved | Marketplace paid entitlement tables/routes were production-risky. | Active marketplace code/routes are removed; active-scope `rg` found no marketplace refs. | Resolved by retirement. | Keep migration reservations inert; do not reintroduce marketplace without new state machine and tests. |
| DATA-002 | P2 | Observability audit writes can fail after DB close in expected failure tests. | Full test logs include `OBS_AUDIT_APPEND_FAILED` and DB-closed errors in tests that exercise failure paths. | Open lifecycle hardening item. | Add drain/stop ordering and make unexpected late writes fail CI. |
| DATA-003 | P2 | Browser-local chat/session state can mask backend persistence. | UI uses local/session storage for some UX state. | Open. | Keep server persistence as source of truth and add reload-from-API browser tests. |
| DATA-004 | P2 resolved | Dirty local duplicate files can break filesystem-scanning gates. | `npm run check:migrations` failed on untracked `* 3.ts` migration copies before cleanup; root check passes after quarantine. | Resolved locally; quarantined at `/tmp/friday-audit-quarantine-20260501T220523Z/`. | Keep untracked generated/duplicate artifacts out of repo worktrees. |

## Migration/Runtime Gaps

- Production migration rollout, backup, restore, and rollback were not exercised against a real deployment target.
- No destructive migration/rollback commands were run.
