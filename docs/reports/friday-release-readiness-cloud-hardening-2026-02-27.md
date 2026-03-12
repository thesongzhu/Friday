> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Release Readiness — Cloud Harness + Security Hardening

- Generated (UTC): 2026-02-27T06:42:00Z
- Branch: `codex/cloud-e2e-readiness-hardening`
- Base comparison: `origin/main`
- Head commit at generation: `dca92a6`

## Scope

This report covers the post-merge hardening slices after cloud harness landed on `main`:

1. Tenant-boundary enforcement for optional API route families.
2. Run-evidence authorization and run-level evidence export persistence.
3. Playbook persistence and global rule-gate wiring.
4. Cloud E2E harness readiness and CI baseline gate wiring.
5. Full local regression pass for changed behavior.

## Module PASS/FAIL/BLOCKED

| Module | Status | Evidence |
|---|---|---|
| Optional route family runtime wiring (multi-tenant, observability, packaging, desktop, discovery, marketplace, satellite) | PASS | `test/unit/api/runtime/friday-api-runtime-extra-route-registration.test.ts` |
| Tenant-boundary enforcement wrappers (multi-tenant + packaging + marketplace) | PASS | `test/unit/api/runtime/friday-api-runtime-extra-route-registration.test.ts` (11 passing tests) |
| Run evidence access control (owner/tenant/satellite/privileged) | PASS | `test/unit/api/runtime/friday-api-runtime-run-evidence-access.test.ts` |
| Run evidence export file persistence/download path | PASS | `test/integration/workflows/friday-workflow-run-evidence.test.ts` |
| Playbook SQLite persistence + workflow runtime integration | PASS | `test/integration/playbook/friday-playbook-sqlite-store.test.ts`, `test/integration/workflows/friday-workflow-playbook-persistence.test.ts` |
| Global rule gate application in agent + workflow invoke path | PASS | `test/unit/agent/runtime/friday-agent-runtime.test.ts` + runtime wiring changes |
| Full local regression suite | PASS | `npm test` => `507 passed, 5 skipped` files; `7967 passed, 217 skipped` tests |
| Lint / typecheck / migration chain / SSD markers | PASS | `npm run -s lint`; `npm run -s typecheck`; `npm run -s check:migrations`; `npm run -s check:ssd` |
| Cloud live E2E real execution (remote target) | BLOCKED | Harness exists, but this local run had no cloud env credentials: `test/e2e/live/friday-cloud-journeys.e2e.test.ts` skipped (4/4) |
| CI cloud OpenAI baseline job on `main` | BLOCKED (pending merge) | Job added in `.github/workflows/ci.yml` but only executes on `push` to `main`; current branch-only verification is static/config-level |

## Commands Executed

- `npx vitest run test/unit/api/runtime/friday-api-runtime-extra-route-registration.test.ts test/unit/api/runtime/friday-api-runtime-run-evidence-access.test.ts`
- `npm test`
- `npm run -s lint`
- `npm run -s typecheck`
- `npm run -s check:migrations`
- `npm run -s check:ssd`
- `npx vitest run test/e2e/live/friday-cloud-journeys.e2e.test.ts`

## Recent CI Evidence (main branch)

- Latest successful CI on main (`0c640ae`):
  - [Run 22473263584](https://github.com/thesongzhu/Friday/actions/runs/22473263584)

## Changed Test Coverage in This Slice

- Added tenant matrix scenarios (allow + deny) for:
  - same-tenant principals
  - privileged cross-tenant principals
  - satellite restrictions
- Added run-evidence access scenarios for:
  - `hub.admin` privileged access
  - originating satellite allow + unrelated satellite deny

## Residual Risks / Open Items

1. Cloud live E2E still depends on real cloud env contract and credentials (`FRIDAY_E2E_CLOUD_*`).
2. New `cloud-e2e-openai` CI job cannot be observed until this branch lands on `main` and secrets/vars are configured.
3. UI-level workflows are not validated in this slice (backend/runtime focus only).

## Release Recommendation

- Backend hardening scope in this branch: **READY**.
- Cloud production-readiness claim: **NOT READY** until cloud live E2E is executed with real credentials and passing evidence is attached.
