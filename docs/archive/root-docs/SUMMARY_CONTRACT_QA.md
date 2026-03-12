> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# SUMMARY CONTRACT QA

## Verdict

- local + server/prod-like CONTRACT regression: **PASS** (all promises have success+failure tests, 40/40 cases passed).
- docker environment: **runtime smoke PASS in CI evidence**, but **full per-promise docker contract suite not completed in this workstation run**.

## ✅ Verified Promises (with reproducible command + evidence)

Repro commands:

```bash
bash tests/contract/run-all-local.sh 2>&1 | tee artifacts/logs/contract-local-run.log
bash tests/contract/run-all-server.sh 2>&1 | tee artifacts/logs/contract-server-run.log
```

Evidence:
- `artifacts/contract/local/P*/{success,failure}/result.json`
- `artifacts/contract/server/P*/{success,failure}/result.json`
- `artifacts/logs/contract-local-run.log`
- `artifacts/logs/contract-server-run.log`

Promise status (local + server):
- P1..P10: success PASS + failure PASS.

## ⚠️ Fixed During This Regression

1. Production-like auth bootstrap/login mismatch in mock env (`P3` initially failed with `AUTH_METHOD_REQUIRED`).
   - Fix file: `test/e2e/mock/_helpers/mock-env.ts`
   - Change: added production-safe admin login flow (`bootstrap/status` + optional `local-passphrase` + passphrase login fallback).
   - Validation: reran `bash tests/contract/run-all-server.sh` and got 20/20 PASS.

## ❌ Not Fully Satisfied Yet

1. Full docker per-promise contract run (`P1..P10`, success+failure each) not executed on this machine.
   - Reason: local `docker` CLI unavailable (`docker --version` => command not found).
   - Current fallback evidence (real CI run):
     - `artifacts/contract/docker/ci-docker-e2e.log`
     - `artifacts/contract/docker/ci-artifacts/*`
   - Gap impact: strict “all environments full-contract parity” remains partially unverified.

## Docker Evidence (real run already captured)

```bash
gh run view 22702288521 --job 65822053471 --log > artifacts/contract/docker/ci-docker-e2e.log
gh run download 22702288521 -n docker-e2e-22702288521 -D artifacts/contract/docker/ci-artifacts
```

Observed:
- `[docker-e2e] assertions passed`
- `[docker-e2e] completed`
- `health.json` => `ok:true` + `requestId`
- `auth-me.json` => `UNAUTHORIZED`
- `login.json` => `AUTH_METHOD_REQUIRED`

