# Phase 6 and 8 - Test and Verification Report

## Commands Run

| Command | Result | Duration | Summary |
| --- | --- | --- | --- |
| `npm run check:migrations` | PASS | not captured | 75 migrations contiguous v001-v075 and migration array matches files. |
| `npm run check:secret-patterns` | PASS | not captured | No provider/API key shaped tracked secrets found. |
| `npm audit --audit-level=moderate --omit=dev` | FAIL | not captured | Two moderate axios advisories via `@larksuiteoapi/node-sdk`; suggested force fix would be breaking. |
| `npm run typecheck` | PASS | not captured | No TypeScript errors. |
| `npm run lint` | PASS_WITH_WARNINGS | not captured | 0 errors, 1353 warnings, including large/complex functions and security lint warnings. |
| `npm run build:api` | PASS | not captured | API TypeScript build succeeded. |
| `npm run build:ui` | PASS | 8.72s in first run; 7.48s during UI E2E | Vite production UI build succeeded; `vendor.css` 528.68 kB gzip 227.07 kB, main index JS about 172 kB gzip 53 kB. |
| `npm run check:architecture-boundaries` | FAIL | not captured | Security layer import escape in `src/security/multi-tenant/engine/policy-engine.ts`. |
| `npm run test:contracts:routes` | PASS | 11.35s | 5 files, 12 tests; route contract snapshot covers 368 routes. |
| `npm test` | FAIL | 580.38s | 819 files passed, 21 skipped, 3 failed; 10807 tests passed, 257 skipped, 5 failed; no type errors. |
| `npm run test:e2e:ui` | PASS_WITH_SKIPS | 29.04s test phase plus build | 1 browser E2E file passed, 9 skipped; 2 tests passed, 21 skipped. |
| `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" npm run test:docker:e2e:smoke` | INVALID_PASS | ~4m initial image build; cached later layers | Docker Desktop 4.71.0 / Docker 29.4.1 was available via Docker.app CLI and the script reported pass on default port 3141, but this result was discarded: an unrelated existing Friday server from `/Users/wenxindou/Friday` was already listening on `127.0.0.1:3141`, so the host-side health/auth assertions could have hit the wrong process. |
| `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" FRIDAY_DOCKER_PORT=43141 FRIDAY_DOCKER_SKIP_BUILD=true FRIDAY_TOKEN_SECRET=<temp-32+> npm run test:docker:e2e:smoke` | PARTIAL_FAIL | ~64s | Clean unique-port retry proved the container starts and `/v1/health` returns OK, but the runtime layer failed at `POST /v1/auth/login`: 401 `PASSWORDLESS_LOCALHOST_ONLY`. Container logs show host requests arrive from Docker Desktop gateway `192.168.65.1`, so localhost-only bypass auth is not usable from the host-published Docker port. |
| `npm run test:install:smoke` | PASS | ~54s | Packed tarball, installed in temp dir, `friday --help` worked, server started on port 19614, `/v1/health` returned `{"status":"ok","version":"1.0.0"}`, `/v1/auth/login` returned 200, bundled UI served, SIGINT shutdown exited 0. |
| Local production-mode CORS/auth/header smoke | PASS | not captured | Started `node dist/cli/friday-cli.js start --host 127.0.0.1 --port 41987` with temp state/token secret and `FRIDAY_CORS_ORIGINS=https://app.audit.example,https://admin.audit.example`. Verified `/v1/health`, allowed preflight to `/v1/auth/login`, denied-origin preflight, local login, and `/v1/auth/me` with bearer token. Allowed origin received CORS headers; denied origin did not; security headers included `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`; no cookies were set in this bearer/local-bypass flow. |
| `npm run check:all` | PASS | 4.8s | Migration integrity, adversarial suite integrity, SSD markers, and alignment guard all passed. |
| `npm run check:security-doctor` | PASS | 25s | 14 checks passed; targeted security doctor tests ran 56 tests and passed. |
| `npm run check:enablement-gaps` | FAIL | <1s | No `.env`; `FRIDAY_TOKEN_SECRET` unset; `FRIDAY_DESKTOP_ENABLED` not true; warnings for channels, MCP, browser mode. |
| `npm run check:ui-bundle-health` | PASS | <1s | Largest JS asset 188.58 KiB; total JS 1708.99 KiB; within enforced threshold. |
| `npm run release:check` | PASS | ~30s | `npm pack --dry-run` packed 3144 files; required dist files present; forbidden env/data/test patterns absent. |
| `npm run release:preflight` | FAIL_CONFIG | <1s | Failed fast because `FRIDAY_RELEASE_TAG` is required. |
| `npm run check:audit-integrity` | FAIL | 5.3s | 7 checks passed, 1 failed; targeted test import failed: `Cannot find package 'ajv'` from `src/errors/friday-error-codes.ts`. |
| `npm run validate:real-world:smoke` | PARTIAL_FAIL | 48s | 22 scenarios selected: 15 passed, 7 failed, 5 blocked. Default lane was DeepSeek `deepseek-v4-flash`; failures: 1 UI misroute, 4 UI loading, 5 environment/setup blocked, 1 LLM behavior, 1 tool bridge. Report: `docs/reports/ops/real-world-validation/2026-04-30T19-46-44-640Z-2hh53n`. |
| `npm run test:e2e:closure:local` | NO_GO_ABORTED | ~13m | Closure ledger reported `NO-GO`: 17 pass, 6 fail, 1 blocker, with failures in providers, UIX/templates, skill/workflow generators, sessions/agent/memory. It spawned `release:verify:repo`, which recursively reran the already-failing full suite; I stopped it after prolonged silence and cleaned up the orphaned server. |

## `npm test` Failures

- Missing test suite: `test/unit/reflex/friday-reflex-routes.test.ts` could not be found.
- Native companion integration timeout: `test/integration/system/friday-system-native-companion.integration.test.ts` timed out spawning real Swift companion and unix-socket RPC.
- Native companion release workflow failures in `test/integration/system/friday-system-companion-release.integration.test.ts`:
  - local release workflow timed out.
  - Sparkle key generation command failed.
  - concurrent local release timed out waiting for `.friday/locks/macos-release.lock`.
  - Homebrew metadata fallback failed because ad-hoc signing reported `resource fork, Finder information, or similar detritus not allowed`.

## Important Passing Coverage

- Auth service/middleware, RBAC, token revocation, client IP resolution, and rate-limit policy coverage.
- SSRF, path traversal, input validation, privilege escalation, approval boundary adversarial tests.
- Workflow CRUD/run/approval/trigger integration tests.
- Session persistence and lifecycle tests.
- Memory guard, PII, namespace isolation, FTS, embedding repository tests.
- Plugin signature/loader/core protection tests.
- Marketplace install closure, duplicate callback replay, entitlement guard, purchase-manager unit tests.
- CLI start runtime smoke starts HTTP server and shuts down.

## Verification Gaps

- Live LLM E2E: 98 tests skipped across `llm-e2e`.
- Browser E2E: 21 of 23 tests skipped.
- Live channel E2E: Discord/self-healing/reflex/blind-user/live suites skipped.
- Real billing provider webhook path not present, so cannot run true payment closed-loop.
- Docker runtime is partially verified through Docker Desktop by adding `/Applications/Docker.app/Contents/Resources/bin` to PATH. Clean unique-port evidence proves image start and health; the Docker E2E auth/bootstrap/plugins path fails because host-published requests are rejected as non-localhost (`192.168.65.1`) by passwordless local login.
- Real-world LLM smoke is now PARTIAL rather than UNKNOWN: default DeepSeek lane was healthy enough for some L3 scenarios, but failed multi-turn memory and tool-bridge scenarios and lacks fallback lane.
- Live Discord delivery remains unverified. A Discord bot token was supplied in chat and must be treated as exposed/rotated; the live suite also requires `FRIDAY_DISCORD_SETUP_USER_ID` and safe sandbox channel/user configuration before it can complete without guessing a target recipient.
