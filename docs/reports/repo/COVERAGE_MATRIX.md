> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# CONTRACT Coverage Matrix

Legend:
- `PASS`: executed and passed
- `PARTIAL`: docker runtime smoke covers only subset of this promise
- `NOT_RUN`: no docker per-promise execution evidence in this workstation run

| promise_id | success test | failure test | local | server/prod-like | docker |
|---|---|---|---|---|---|
| P1 | `tests/contract/P1_cli_runtime/success.sh` | `tests/contract/P1_cli_runtime/failure.sh` | PASS | PASS | PASS (smoke via CI) |
| P2 | `tests/contract/P2_http_envelope/success.sh` | `tests/contract/P2_http_envelope/failure.sh` | PASS | PASS | PASS (smoke via CI) |
| P3 | `tests/contract/P3_agent_run_traceable/success.sh` | `tests/contract/P3_agent_run_traceable/failure.sh` | PASS | PASS | NOT_RUN |
| P4 | `tests/contract/P4_workflow_lifecycle/success.sh` | `tests/contract/P4_workflow_lifecycle/failure.sh` | PASS | PASS | NOT_RUN |
| P5 | `tests/contract/P5_channel_delivery/success.sh` | `tests/contract/P5_channel_delivery/failure.sh` | PASS | PASS | NOT_RUN |
| P6 | `tests/contract/P6_browser_artifact/success.sh` | `tests/contract/P6_browser_artifact/failure.sh` | PASS | PASS | NOT_RUN |
| P7 | `tests/contract/P7_desktop_capability/success.sh` | `tests/contract/P7_desktop_capability/failure.sh` | PASS | PASS | NOT_RUN |
| P8 | `tests/contract/P8_marketplace_gating/success.sh` | `tests/contract/P8_marketplace_gating/failure.sh` | PASS | PASS | NOT_RUN |
| P9 | `tests/contract/P9_not_enabled_explicit/success.sh` | `tests/contract/P9_not_enabled_explicit/failure.sh` | PASS | PASS | PARTIAL (AUTH/feature-disabled envelope evidence only) |
| P10 | `tests/contract/P10_traceability_fields/success.sh` | `tests/contract/P10_traceability_fields/failure.sh` | PASS | PASS | NOT_RUN |

## Evidence Paths

- local logs: `artifacts/logs/contract-local-run.log`
- server logs: `artifacts/logs/contract-server-run.log`
- local per-case artifacts: `artifacts/contract/local/...`
- server per-case artifacts: `artifacts/contract/server/...`
- docker CI log: `artifacts/contract/docker/ci-docker-e2e.log`
- docker CI artifacts: `artifacts/contract/docker/ci-artifacts/...`

