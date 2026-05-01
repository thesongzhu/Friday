# Phase 6 and 8 - Test and Verification Report

## Commands Run

| Command | Result | Duration | Summary |
| --- | --- | --- | --- |
| `rg -n "marketplace|/v1/marketplace|FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN|allowLocalBypassLogin|allowPasswordlessLocalLogin|\{ local: true \}|PASSWORDLESS" src ui scripts test package.json .env.example` | PASS | <1s | No active product/test/script references found. |
| `npm audit --audit-level=moderate --omit=dev` | PASS | <1s | 0 vulnerabilities after `axios` override. |
| `npm run check:architecture-boundaries` | PASS | <1s | 5 checks passed, 0 failed after security policy regex helper was localized. |
| `npx vitest run --project default test/unit/security/multi-tenant/engine/policy-engine.test.ts test/unit/rules/engine/condition-evaluator.test.ts` | PASS | not captured | 2 files, 86 tests passed. |
| `npm run check:audit-integrity` | PASS | not captured | 8 checks passed; targeted audit tests passed. |
| `npm run typecheck` | PASS | not captured | No TypeScript errors. |
| Docker clean passphrase smoke with unique port 43142 | PASS | not captured | Image/container health, passphrase bootstrap/login, and runtime/bootstrap/plugins assertions passed. |
| `npm run test:e2e:ui` | PASS_WITH_SKIPS | ~218s | 10 files passed; 21 tests passed, 2 skipped. |
| `npm run validate:real-world:smoke` | PARTIAL_FAIL | not captured | Latest report `2026-05-01T00-41-12-583Z-nfz40j`: 22 selected, 15 passed, 6 failed, 1 partial, 5 blocked. |
| `npm run test:install:smoke` | PASS | ~18s | Packed/install temp project, CLI help, server start, `/v1/health`, passphrase login, bundled UI, clean SIGINT shutdown all passed. |
| `npm test` | PASS | 267.50s | 775 files passed, 21 skipped; 10301 tests passed, 251 skipped; type errors 0. |
| `npm run check:migrations` | FAIL_DIRTY_WORKTREE | <1s | Failed only on untracked duplicate migration files with names ending ` 3.ts`. |
| `node scripts/quality/check-migrations.mjs` in temporary tracked-only copy | PASS | not captured | 75 migrations contiguous; array exactly matches discovered migration files. |
| `npm run test:contracts:routes` | PASS | 7.54s | 5 files, 12 tests; type errors 0. |
| `npm run test:contracts:update` | PASS | 9.55s | 5 files, 12 tests; no snapshot changes observed. |
| `npm run check:ui-bundle-health` | PASS | <1s | Largest JS asset 188.58 KiB; total JS 1652.44 KiB; within threshold. |
| `npm run release:check` | PASS | not captured | 3141 files packed in dry run; required files present; forbidden env/data/test patterns absent. |
| `npm run check:enablement-gaps` | FAIL_CONFIG | <1s | Bare process env lacks `.env`, `FRIDAY_TOKEN_SECRET`, and `FRIDAY_DESKTOP_ENABLED=true`. |
| `FRIDAY_TOKEN_SECRET=<temp-32+> FRIDAY_DESKTOP_ENABLED=true FRIDAY_CHANNELS_JSON='{"instances":[]}' FRIDAY_MCP_SERVERS='[{"id":"local-test","command":"node"}]' FRIDAY_BROWSER_PRESENTATION_MODE=auto npm run check:enablement-gaps` | PASS_WITH_WARNING | <1s | Passed with one warning: `.env` file absent, current process env used. |
| `git diff --name-only -z \| xargs -0 detect-secrets-hook --baseline .secrets.baseline` | BASELINE_UPDATED | <1s | No full secret values printed; hook updated tracked baseline line numbers for `test/e2e/setup-wizard.e2e.test.ts` after test edits. |

## Fixes Verified By Tests

- Architecture boundary failure fixed without importing rules-layer internals into security layer.
- Production dependency audit fixed by overriding transitive `axios` to a patched version.
- Setup wizard browser regression fixed by injecting the real passphrase-login token into the browser context; the test no longer relies on passwordless auto-login.

## Remaining Verification Gaps

- Real-world LLM smoke is not release-green: UI misroute/loading, environment, LLM behavior, and tool-bridge failures remain.
- Live channel delivery, including Discord, is unverified without safe sandbox target env.
- External production deployment/CORS/cookie/callback domains remain unverified because no deployment target URL/provider callback config is present.
- Dirty local untracked duplicate files should be cleaned outside this branch to prevent local gate confusion.
