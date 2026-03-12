> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# Friday Route Closure Status

Date: 2026-03-04 (America/Los_Angeles)
Source maps: `CONTRACT.md`, `ROUTE_MAP.md`, `TEST_REPORT.md`

## Route-by-route closure

| Promise | Route | Status | Evidence |
|---|---|---|---|
| P1 CLI runtime boot | R1 | CLOSED | `artifacts/logs/server-profile-tests.log` (`run_loop_starts_http_server`, `run_friday_cli_loop_starts_and_shuts_down`), `artifacts/logs/server-runtime.log` |
| P2 Structured HTTP envelope | R2 | CLOSED | `artifacts/generated_files/server-profile/health.json`, `auth-me.json`, `setup-status.json`, `login.json` |
| P3 Agent run traceable output | R2 | CLOSED | `artifacts/logs/local-core-regression.log` (`Friday Mock Error Resilience E2E`, `Friday Mock Multi-Turn E2E`) |
| P4 Workflow lifecycle closure | R3 | CLOSED | `artifacts/logs/local-reliability.log` (`friday-workflow-timeout-chain`) |
| P5 Channel delivery closure (webchat/discord) | R4 | CLOSED | `artifacts/logs/local-openclaw-parity.log` (`G route closure`, `G2 route closure`), `artifacts/screenshots/discord-latest.png` |
| P6 Browser artifact closure | R5 | CLOSED | `artifacts/logs/local-openclaw-parity.log` (`C/G route closure`), `artifacts/screenshots/browser-latest.png` |
| P7 Desktop explicit behavior (enabled/disabled) | R6 | CLOSED | `artifacts/logs/local-openclaw-parity.log` (`desktop enabled route closure`, `desktop disabled failure path`), `artifacts/generated_files/desktop-session-info.json`, `desktop-disabled-result.txt` |
| P8 Marketplace policy gating / replay safety | R7 | CLOSED | `artifacts/logs/local-marketplace-gates.log` (`requires install before workflow run and allows run after install`), `artifacts/logs/local-reliability.log` (`duplicate checkout callback`) |
| P9 Not-enabled route explicit failure | R8 | CLOSED | `artifacts/logs/local-openclaw-parity.log` (`observability API returns explicit not-enabled message`) |
| P10 Correlation/route observability | R4/R5/R6 | CLOSED | `artifacts/logs/local-openclaw-parity.log` (`E-CH-OUTBOUND-001` block includes `routeId`, `correlationId`, `runId`) |

## Failure-handling closure checks

- Tool unavailable / provider error: closed (`all providers return 500`, `network error`, `timeout error`) via `artifacts/logs/local-core-regression.log`.
- Permission/gate reject: closed (`desktop disabled failure path`, `readOnly blocks exec/write`) via `artifacts/logs/local-openclaw-parity.log` and `local-core-regression.log`.
- Timeout handling: closed (`agent run timeout`, `workflow timeout sweeps`) via `local-core-regression.log` and `local-reliability.log`.
- Output delivery failure retry: closed (`G2 delivery failure closure`) via `local-openclaw-parity.log`.
- Concurrency/isolation: closed (`multi-user parallel`, `same correlationId dedupe`) via `local-core-regression.log`.

## Environment closure

| Environment | Status | Notes |
|---|---|---|
| local-dev | CLOSED | Full smoke + core + failure + concurrency + reliability executed and passed. |
| server-profile | CLOSED | Built `dist`, started real production-like runtime, validated success/failure HTTP envelopes, ran production-profile tests. |
| docker | NOT_CLOSED (local host) / CI-LANE PATCHED | Host lacks Docker binary so local container run cannot execute (`artifacts/logs/docker-smoke.log`). CI `docker-e2e-verify` exists and uploads `artifacts/docker-e2e/*`; first run `22701922287` failed on container bind address and was patched (`FRIDAY_HOST=0.0.0.0`) pending green rerun. |

## Release gate implication

- Functional closure for local-dev and server-profile is verified by executed tests and artifacts.
- Full all-environment closure requires one successful `docker-e2e-verify` CI run after host-binding patch commit.
