> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# CONTRACT Closure Status

Closure criterion: Trigger -> pipeline/tool -> user-visible output (or explicit user-visible failure) + structured evidence.

| promise_id | local | server/prod-like | docker | overall |
|---|---|---|---|---|
| P1 | Closed | Closed | Closed (CI smoke) | Closed |
| P2 | Closed | Closed | Closed (CI smoke) | Closed |
| P3 | Closed | Closed | Not validated in docker | Half-closed |
| P4 | Closed | Closed | Not validated in docker | Half-closed |
| P5 | Closed | Closed | Not validated in docker | Half-closed |
| P6 | Closed | Closed | Not validated in docker | Half-closed |
| P7 | Closed | Closed | Not validated in docker | Half-closed |
| P8 | Closed | Closed | Not validated in docker | Half-closed |
| P9 | Closed | Closed | Partial docker evidence | Half-closed |
| P10 | Closed | Closed | Not validated in docker | Half-closed |

## Proof (Representative)

- P1 success/failure:
  - `artifacts/contract/local/P1_cli_runtime/success/result.json`
  - `artifacts/contract/local/P1_cli_runtime/failure/result.json`
  - `artifacts/contract/server/P1_cli_runtime/success/result.json`
  - `artifacts/contract/server/P1_cli_runtime/failure/result.json`
- P5 channel delivery failure observability:
  - `artifacts/contract/local/P5_channel_delivery/failure/test.log`
  - `artifacts/contract/server/P5_channel_delivery/failure/test.log`
  - includes `E-CH-OUTBOUND-001`, `routeId`, `correlationId`
- P6 browser artifact closure:
  - `artifacts/contract/local/P6_browser_artifact/success/test.log`
  - `artifacts/contract/server/P6_browser_artifact/success/test.log`
- P7 desktop explicit enablement behavior:
  - `artifacts/contract/local/P7_desktop_capability/success/test.log`
  - `artifacts/contract/local/P7_desktop_capability/failure/test.log`
- Docker runtime proof:
  - `artifacts/contract/docker/ci-docker-e2e.log`
  - `artifacts/contract/docker/ci-artifacts/health.json`
  - `artifacts/contract/docker/ci-artifacts/login.json`

## Remaining Gap

- Full per-promise docker contract suite (`tests/contract/P*/success|failure.sh`) was not executed in this workstation run because `docker` CLI is unavailable locally.
- A runnable script is now provided: `tests/contract/run-all-docker.sh`.

