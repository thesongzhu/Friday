> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# CONTRACT Regression Test Report

Date: 2026-03-05 (America/Los_Angeles)
Branch: `main`
Base SHA: `fb805d5dc11ad1d8a179a17b4269c5e493812d04`

## Environment

| env | runtime | execution mode | status |
|---|---|---|---|
| local | macOS 26.2, node v22.22.0, npm 10.9.4, vitest 4.0.18 | real contract suite (`tests/contract/run-all-local.sh`) | PASS (20/20) |
| server/prod-like | macOS 26.2, `NODE_ENV=production` | real contract suite (`tests/contract/run-all-server.sh`) | PASS (20/20) |
| docker | GitHub Actions ubuntu-24.04 job `docker-e2e-verify` | real container smoke + API closure checks (`scripts/ci/docker-e2e-smoke.sh`) | PASS (runtime smoke); full per-promise suite not run in this workstation |

## Commands Executed

```bash
# local
bash tests/contract/run-all-local.sh 2>&1 | tee artifacts/logs/contract-local-run.log

# server/prod-like
bash tests/contract/run-all-server.sh 2>&1 | tee artifacts/logs/contract-server-run.log

# docker local attempt (blocked on this workstation)
bash tests/contract/run-all-docker.sh > artifacts/logs/contract-docker-run.log 2>&1
# exit code recorded at artifacts/logs/contract-docker-run.exit (127)

# docker CI evidence (real run)
gh run view 22702288521 --job 65822053471 --log > artifacts/contract/docker/ci-docker-e2e.log
gh run download 22702288521 -n docker-e2e-22702288521 -D artifacts/contract/docker/ci-artifacts
```

## Per-Promise Result (local + server)

All promises `P1..P10` have `success + failure` contract tests and both environments passed.

Evidence roots:
- local: `artifacts/contract/local/P*/{success,failure}/{test.log,result.json,command.sh}`
- server: `artifacts/contract/server/P*/{success,failure}/{test.log,result.json,command.sh}`

Quick totals:
- local: 20/20 PASS
- server: 20/20 PASS

## Docker Evidence

Source run:
- workflow run: `22702288521`
- job: `docker-e2e-verify` (`65822053471`)
- head sha: `fb805d5dc11ad1d8a179a17b4269c5e493812d04`

Evidence files:
- `artifacts/contract/docker/ci-docker-e2e.log`
- `artifacts/contract/docker/ci-artifacts/health.json`
- `artifacts/contract/docker/ci-artifacts/auth-me.json`
- `artifacts/contract/docker/ci-artifacts/login.json`
- `artifacts/contract/docker/ci-artifacts/container.log`

Key assertions observed in CI log:
- `[docker-e2e] assertions passed`
- `[docker-e2e] completed`
- artifact uploaded: `docker-e2e-22702288521`

Key API evidence from downloaded artifact:
- `/v1/health` => `ok:true` with `requestId`
- `/v1/auth/me` => `401` + `UNAUTHORIZED`
- `/v1/auth/login` empty body => `401` + `AUTH_METHOD_REQUIRED`

## Fix Applied During Regression

Issue encountered in server/prod-like contract run:
- `P3` initially failed with `AUTH_METHOD_REQUIRED` during admin login in mock env bootstrap.

Fix:
- Updated `test/e2e/mock/_helpers/mock-env.ts` to support production-safe login flow:
  - try passwordless local login first,
  - fallback to bootstrap-status check,
  - bootstrap local passphrase when required,
  - then login using `localPassphrase`.

Post-fix rerun:
- `tests/contract/run-all-server.sh` completed PASS (20/20).
