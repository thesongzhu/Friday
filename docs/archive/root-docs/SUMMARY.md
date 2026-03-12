> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# Friday Release Regression Summary (Evidence-Driven)

Date: 2026-03-04 (America/Los_Angeles)

## Verdict

- Local and server-profile routes are validated with real tests and real runtime artifacts.
- Docker environment remains unverified in this run because Docker is not installed on host.
- Therefore: **partial GO** (`local-dev` + `server-profile`), **global all-environment GO blocked** until docker lane passes.

## ✅ Verified Passes (with evidence)

1. Core route closure + failure + delivery + desktop/mcp/discord closure:
   - Command: `npx vitest run test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts --reporter=verbose 2>&1`
   - Evidence: `artifacts/logs/local-openclaw-parity.log`
   - Result: `15 passed`
2. Agent error resilience + timeout + gate behavior + provider failover:
   - Command: included in local core pack
   - Evidence: `artifacts/logs/local-core-regression.log`
   - Result examples: `all providers return 500`, `agent run timeout`, `network error`, `HTTP 429 fallback`
3. Concurrency and isolation:
   - Command: included in local core pack
   - Evidence: `artifacts/logs/local-core-regression.log`
   - Result examples: `same correlationId dedupe`, `same-user/multi-user parallel isolation`
4. Reliability/idempotency/timeout sweep:
   - Command: `npx vitest run test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts test/e2e/workflows/friday-workflow-timeout-chain.test.ts --reporter=verbose`
   - Evidence: `artifacts/logs/local-reliability.log`
   - Result: `5 passed`
5. Marketplace install/entitlement gate closure:
   - Command: `npx vitest run test/integration/marketplace/friday-marketplace-install-closure.test.ts test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts --reporter=verbose`
   - Evidence: `artifacts/logs/local-marketplace-gates.log`
   - Result: `2 passed`
6. Server-profile runtime closure (real dist runtime):
   - Command: `NODE_ENV=production ... node dist/cli/friday-cli.js start`
   - Evidence: `artifacts/logs/server-runtime.log`, `artifacts/generated_files/server-profile/*.json`
   - Verified: `/v1/health` success + auth-protected failure envelopes with explicit error codes
7. Server-profile route tests:
   - Command: `NODE_ENV=production npx vitest run test/e2e/cli/friday-cli-start-runtime.test.ts test/e2e/api/friday-api-health-routes.test.ts --reporter=verbose`
   - Evidence: `artifacts/logs/server-profile-tests.log`
   - Result: `10 passed`

Executed total in this run: **75 passed, 0 failed**.

## ⚠️ Issues Found and Handled

1. Docker lane is blocked on host capability.
   - Evidence: `artifacts/logs/docker-smoke.log` (`docker: not installed`)
   - Handling: explicitly marked `NOT_CLOSED` in `CLOSURE_STATUS.md`; added CI `docker-e2e-verify` job (`scripts/ci/docker-e2e-smoke.sh`) so closure can be proven on docker-capable runner.
2. Desktop runtime check warns when shell env omits `FRIDAY_DESKTOP_ENABLED=true`.
   - Evidence: `artifacts/logs/local-smoke.log`
   - Handling: verified enabled path with explicit env set in `artifacts/logs/local-smoke-desktop-enabled.log`.
3. CI docker lane first run failed on bind address.
   - Evidence: GitHub Actions run `22701922287`, job `docker-e2e-verify` emitted repeated `curl: (56) Recv failure: Connection reset by peer`.
   - Root cause: container service was listening on `127.0.0.1` inside container namespace.
   - Handling: patched `Dockerfile`, `docker-compose.yml`, and `scripts/ci/docker-e2e-smoke.sh` to force `FRIDAY_HOST=0.0.0.0` for container runtime paths.

## ❌ Still Not Fully Supported in This Execution Context

1. Docker/container end-to-end validation on this host.
   - Required next step: complete one green CI run containing `docker-e2e-verify` and attach uploaded `artifacts/docker-e2e/*` evidence to close `docker` row in `CLOSURE_STATUS.md`.

## Key Deliverables Produced

- `CONTRACT.md`
- `ENV_MATRIX.md`
- `ROUTE_MAP.md`
- `TEST_REPORT.md`
- `CLOSURE_STATUS.md`
