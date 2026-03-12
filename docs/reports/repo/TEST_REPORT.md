> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Friday Final Regression Test Report

Date: 2026-03-04 (America/Los_Angeles)
Commit under test: `b480dd1` + working tree updates in this run
Artifacts root: `./artifacts`

## Scope

Validated with real commands and real runtime behavior across environments declared in `ENV_MATRIX.md`:

- `local-dev` (full)
- `server-profile` (full for runtime boot + API envelope + CLI route contracts)
- `docker` (blocked on host capability; see below)

## Environment A: local-dev

### A1. Smoke (startup/dependency/config)

Command:

```bash
node -v
npm -v
npx playwright --version
npm run -s check:desktop-runtime
npm run -s check:enablement-gaps
FRIDAY_DESKTOP_ENABLED=true npm run -s check:desktop-runtime
```

Evidence:

- Log: `artifacts/logs/local-smoke.log`
- Log: `artifacts/logs/local-smoke-desktop-enabled.log`

Result:

- Node/npm/playwright present.
- Desktop runtime gate can be enabled (`FRIDAY_DESKTOP_ENABLED=true`) and runtime check passes.
- Enablement gap checker passed.

### A2. Core Routes E2E + Failure + Concurrency + Observability

Command:

```bash
npx vitest run \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  test/e2e/mock/friday-mock-error-resilience.e2e.test.ts \
  test/e2e/mock/friday-mock-multi-turn.e2e.test.ts \
  test/integration/agent/friday-browser-resilience-integration.test.ts \
  test/adversarial/concurrency-race.test.ts \
  --reporter=verbose
```

Evidence:

- Log: `artifacts/logs/local-core-regression.log`
- Result summary: `5 test files passed`, `43 tests passed`

Additional observability-focused rerun (stderr+stdout combined):

```bash
npx vitest run test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts --reporter=verbose 2>&1
```

Evidence:

- Log: `artifacts/logs/local-openclaw-parity.log`
- Contains structured delivery failure signal with code/route/correlation:
  - `[E-CH-OUTBOUND-001]`
  - `routeId: 'hub.channel.delivery.primary'`
  - `correlationId: '<uuid>'`

### A3. Reliability (retry/timeout/idempotency)

Command:

```bash
npx vitest run \
  test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts \
  test/e2e/workflows/friday-workflow-timeout-chain.test.ts \
  --reporter=verbose
```

Evidence:

- Log: `artifacts/logs/local-reliability.log`
- Result summary: `2 test files passed`, `5 tests passed`

### A4. Marketplace entitlement/install gate closure

Command:

```bash
npx vitest run \
  test/integration/marketplace/friday-marketplace-install-closure.test.ts \
  test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts \
  --reporter=verbose
```

Evidence:

- Log: `artifacts/logs/local-marketplace-gates.log`
- Result summary: `2 test files passed`, `2 tests passed`
- Verified behavior:
  - install required before run
  - run allowed after install
  - tenant isolation preserved
### A5. User-visible artifact closure evidence

Artifacts copied from runtime evidence outputs to stable report paths:

- Browser screenshot: `artifacts/screenshots/browser-latest.png` (16578 bytes)
- Discord attachment image: `artifacts/screenshots/discord-latest.png` (16578 bytes)
- Desktop enabled output: `artifacts/generated_files/desktop-session-info.json`
- Desktop disabled explicit hint: `artifacts/generated_files/desktop-disabled-result.txt`
- MCP visible output: `artifacts/generated_files/mcp-list-servers.json`
- Source mapping for copied files: `artifacts/reports/copied-evidence-sources.txt`

## Environment B: server-profile

### B1. Build (production artifact)

Command:

```bash
npm run build
```

Evidence:

- Log: `artifacts/logs/server-build.log`
- Result: `dist/*` built successfully (API + UI).

### B2. Real dist runtime boot + HTTP closure

Command used:

```bash
NODE_ENV=production \
FRIDAY_PORT=18777 \
FRIDAY_HOST=127.0.0.1 \
FRIDAY_STATE_DIR=<tmp> \
FRIDAY_TOKEN_SECRET=release-regression-secret \
node dist/cli/friday-cli.js start
```

During run, real HTTP requests were executed:

- `GET /v1/health` -> success
- `GET /v1/auth/me` -> failure envelope (`UNAUTHORIZED`)
- `GET /v1/setup/status` -> failure envelope (`UNAUTHORIZED`)
- `POST /v1/auth/login` -> failure envelope (`INVALID_CREDENTIALS`)

Evidence:

- Runtime log: `artifacts/logs/server-runtime.log`
- Response bodies:
  - `artifacts/generated_files/server-profile/health.json`
  - `artifacts/generated_files/server-profile/auth-me.json`
  - `artifacts/generated_files/server-profile/setup-status.json`
  - `artifacts/generated_files/server-profile/login.json`
- HTTP status captures:
  - `artifacts/generated_files/server-profile/auth-me.status`
  - `artifacts/generated_files/server-profile/setup-status.status`
  - `artifacts/generated_files/server-profile/login.status`

### B3. Production-profile route tests

Command:

```bash
NODE_ENV=production npx vitest run \
  test/e2e/cli/friday-cli-start-runtime.test.ts \
  test/e2e/api/friday-api-health-routes.test.ts \
  --reporter=verbose
```

Evidence:

- Log: `artifacts/logs/server-profile-tests.log`
- Result summary: `2 test files passed`, `10 tests passed`

## Environment C: docker

Command:

```bash
command -v docker
command -v docker && docker --version
command -v docker && docker compose version
```

Evidence:

- Log: `artifacts/logs/docker-smoke.log`

Result:

- `docker` binary is not installed on this host.
- Docker runtime regression suite cannot execute in this run.
- Container environment remains **unverified** (not equivalent to pass).
- CI remediation added: workflow job `docker-e2e-verify` executes `scripts/ci/docker-e2e-smoke.sh` on `ubuntu-latest` and uploads `artifacts/docker-e2e/*`.
- First CI execution evidence: run `22701922287` failed in `docker-e2e-verify` due container binding to `127.0.0.1`; patched to `FRIDAY_HOST=0.0.0.0` (Dockerfile + compose + CI script), rerun required for final closure.

## Totals (executed in this run)

- Local core/failure/concurrency suite: `43 passed`
- Local parity closure suite rerun (with full stderr evidence): `15 passed`
- Local reliability suite: `5 passed`
- Local marketplace gate suite: `2 passed`
- Server-profile suite: `10 passed`

Total executed tests in this run: **75 passed, 0 failed**.

## Requirement Coverage Matrix

| Required check | Covered by | Evidence |
|---|---|---|
| Configuration load/defaults | Smoke + server runtime | `artifacts/logs/local-smoke.log`, `artifacts/logs/server-runtime.log` |
| Permission/security gating | Desktop/readOnly/auth failure cases | `artifacts/logs/local-openclaw-parity.log`, `artifacts/logs/local-core-regression.log`, `artifacts/generated_files/server-profile/auth-me.json` |
| Tool invocation | Browser/Desktop/MCP/FS tool cases | `artifacts/logs/local-openclaw-parity.log`, `artifacts/logs/local-core-regression.log` |
| Runtime state transitions | Agent/workflow/scheduler tests | `artifacts/logs/local-core-regression.log`, `artifacts/logs/local-reliability.log` |
| Logging/traceability | Delivery failure with structured fields | `artifacts/logs/local-openclaw-parity.log` (`E-CH-OUTBOUND-001`, `routeId`, `correlationId`, `runId`) |
| Output delivery to user | Webchat/Discord closure + screenshot/file artifacts | `artifacts/screenshots/browser-latest.png`, `artifacts/screenshots/discord-latest.png`, `artifacts/logs/local-openclaw-parity.log` |
| Failure handling | Provider/network/timeout/invalid input/not-enabled/install-gate | `artifacts/logs/local-core-regression.log`, `artifacts/logs/local-openclaw-parity.log`, `artifacts/logs/local-marketplace-gates.log`, `artifacts/generated_files/server-profile/login.json` |
| Retry/timeout recovery | 429 fallback + workflow timeout sweep + delivery retry | `artifacts/logs/local-core-regression.log`, `artifacts/logs/local-reliability.log`, `artifacts/logs/local-openclaw-parity.log` |
| Concurrency/isolation | Same-correlation dedupe + multi-user parallel | `artifacts/logs/local-core-regression.log` |

## Reproduce (exact sequence)

```bash
mkdir -p artifacts/logs artifacts/screenshots artifacts/generated_files artifacts/reports

# local smoke
npm run -s check:desktop-runtime
npm run -s check:enablement-gaps
FRIDAY_DESKTOP_ENABLED=true npm run -s check:desktop-runtime

# local core + failures + concurrency
npx vitest run \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  test/e2e/mock/friday-mock-error-resilience.e2e.test.ts \
  test/e2e/mock/friday-mock-multi-turn.e2e.test.ts \
  test/integration/agent/friday-browser-resilience-integration.test.ts \
  test/adversarial/concurrency-race.test.ts \
  --reporter=verbose

# local observability evidence
npx vitest run test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts --reporter=verbose 2>&1

# reliability
npx vitest run \
  test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts \
  test/e2e/workflows/friday-workflow-timeout-chain.test.ts \
  --reporter=verbose

# marketplace install/entitlement gates
npx vitest run \
  test/integration/marketplace/friday-marketplace-install-closure.test.ts \
  test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts \
  --reporter=verbose

# server-profile
npm run build
NODE_ENV=production npx vitest run \
  test/e2e/cli/friday-cli-start-runtime.test.ts \
  test/e2e/api/friday-api-health-routes.test.ts \
  --reporter=verbose
```
