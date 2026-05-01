# Phase 6 and 8 - Test and Verification Report

Last updated: 2026-05-01

## Commands Run

| Command | Result | Duration | Summary |
| --- | --- | --- | --- |
| `rg -n "marketplace|/v1/marketplace|FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN|allowLocalBypassLogin|allowPasswordlessLocalLogin|\{ local: true \}|passwordless|PASSWORDLESS" src ui scripts test validation package.json .env.example docs/current-source-of-truth.md` | PASS | <1s | No active marketplace or passwordless-bypass references found. |
| `npm ci` | PASS | not captured | Clean worktree install completed; Node 23 emitted engine warnings only. |
| `npm audit --audit-level=moderate` | PASS | <1s | 0 vulnerabilities. |
| `npm run check:architecture-boundaries` | PASS | <1s | 5 checks passed. |
| `npm run check:migrations` | PASS | <1s | Clean worktree: 75 migrations contiguous and registered. |
| `npm run check:migrations` | PASS | <1s | Repo root after quarantining 30 untracked duplicate/local artifact files: 75 migrations contiguous and registered. |
| Untracked duplicate quarantine | PASS | <1s | 30 pre-existing untracked files moved outside the repo to `/tmp/friday-audit-quarantine-20260501T220523Z/`; manifest retained. |
| `npm run typecheck` | PASS | not captured | API, operator client, and UI typecheck completed. |
| `npm run test:contracts:update` | PASS | not captured | 5 files, 12 tests. |
| `npm run test:contracts:routes` | PASS | not captured | 5 files, 12 tests. |
| Focused unit tests | PASS | not captured | 4 files, 109 tests: memory recall, tool mutation, operational mode, v056 checksum compatibility. |
| `npm run build` | PASS | not captured | API TypeScript build and Vite UI production build completed. |
| `npm run test:docker:e2e-smoke` | PASS | ~111s | Docker runtime/bootstrap/plugins layers passed with unique ports and local passphrase bootstrap/login. |
| `npm run test:install:smoke` | PASS | ~17s | Packed/install temp project, CLI help, server start, `/v1/health`, passphrase login token, bundled UI, clean SIGINT shutdown. |
| Fresh real-world smoke | PASS | not captured | `docs/reports/ops/real-world-validation/2026-05-01T21-21-24-003Z-fresh/summary.json`: 27 passed, 0 failed/partial/blocked. |
| Current-config real-world smoke | PASS | not captured | `docs/reports/ops/real-world-validation/2026-05-01T21-26-47-671Z-current-config/summary.json`: 27 passed, 0 failed/partial/blocked. |
| New report secret scan | PASS | <1s | No full DeepSeek/OpenAI/Discord token patterns found in copied report directories. |
| `npm run lint` | PASS_WITH_WARNINGS | ~7s | 0 errors, 1334 existing warnings. |
| Earlier `npm test` | PASS | 267.50s | 775 files passed, 21 skipped; 10301 tests passed, 251 skipped; type errors 0. |
| Earlier `npm run test:e2e:ui` | PASS_WITH_SKIPS | ~218s | 10 files passed; 21 tests passed, 2 skipped. |
| Earlier `npm run check:ui-bundle-health` | PASS | <1s | Largest JS asset 188.58 KiB; total JS 1652.44 KiB; within threshold. |
| Earlier `npm run release:check` | PASS | not captured | Dry-run package contained required files and excluded forbidden env/data/test patterns. |

## Fixes Verified By Tests

- Marketplace and `/v1/marketplace/*` are removed from active source, UI, scripts, tests, validation catalog, and current source-of-truth docs.
- Passwordless local login and `{ local: true }` validation fallback are removed; Docker/install/E2E auth uses `localPassphrase`.
- Multi-turn memory recall now handles the current smoke wording and passes against both DeepSeek primary and OpenAI fallback lanes.
- Read-only tool-pack loading now allows safe `request_tool_pack` so filesystem-read roundtrip passes while write/execute tools remain protected.
- Current-config copied local state starts successfully with legacy v056 checksum accepted, without destructive migrations.

## Remaining Verification Gaps

- Live channel delivery, including Discord, still needs safe sandbox channel config and token rotation before proof.
- External production/staging deployment CORS/cookie/callback-domain behavior remains unverified because no target URL/domain/provider callback config was exercised.
- Pre-existing unrelated untracked duplicate files were quarantined outside the repo; root filesystem-scanning checks now match clean-branch truth.
- Lint passes but reports a large warning backlog: complexity, object-injection warnings, non-literal filesystem paths, and a few console warnings.
