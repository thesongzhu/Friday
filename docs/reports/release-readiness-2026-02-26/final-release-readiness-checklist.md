> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Release Readiness Checklist (2026-02-26)

Target scope: rerun previously skipped/gated scenarios by environment (local/cloud, real providers/keys where available).

Commit baseline: `e6a93aa04f41ddd9d46f6eb9b594e7f46bd96f75`

## Summary

- PASS: 4 modules
- FAIL: 3 modules
- BLOCKED: 1 module

## Module Status

| Module | Environment | Status | Evidence |
|---|---|---|---|
| CI baseline checks (11 success + previously failing 3 recovered) | GitHub Actions | PASS | [Run 22428789675](https://github.com/thesongzhu/Friday/actions/runs/22428789675) |
| Full core E2E batch (A–F) | Local | PASS | `./docs/reports/release-readiness-2026-02-26/evidence/full-e2e-core.log` |
| Real scenarios (non-LLM block) | Local | PASS | `./docs/reports/release-readiness-2026-02-26/evidence/real-scenarios-core.log` |
| Setup wizard API + provider detection (A/B) | Local + Ollama | PASS | `./docs/reports/release-readiness-2026-02-26/evidence/setup-wizard-real-ollama.log` |
| Setup wizard real scenarios (C17, C18) | Local + Ollama | FAIL | `./docs/reports/release-readiness-2026-02-26/evidence/setup-wizard-real-ollama.log` |
| Live real journeys (10 scenarios) | Local + Ollama | FAIL | `./docs/reports/release-readiness-2026-02-26/evidence/live-ollama-real-journeys.log`, `./docs/reports/release-readiness-2026-02-26/evidence/live-ollama-real-journeys-failure-summary.md` |
| Cloud provider API path (OpenAI: login/create/routing/validate) | Cloud provider key (`OPENAI_API_KEY`) | PASS | `./docs/reports/release-readiness-2026-02-26/evidence/cloud-openai-real-smoke.log`, `./docs/reports/release-readiness-2026-02-26/evidence/cloud-openai-completions-smoke.log` |
| Cloud agent runtime against OpenAI | Cloud provider key (`OPENAI_API_KEY`) | FAIL | `./docs/reports/release-readiness-2026-02-26/evidence/cloud-openai-real-smoke.log`, `./docs/reports/release-readiness-2026-02-26/evidence/cloud-openai-completions-smoke.log` |
| Anthropic live cloud suites (`friday-llm-e2e`, anthropic section in real-scenarios) | Cloud (Anthropic OAuth) | BLOCKED | `./docs/reports/release-readiness-2026-02-26/evidence/llm-e2e-anthropic-gated.log`, `./docs/reports/release-readiness-2026-02-26/evidence/cloud-anthropic-gate-check.log` |

## Key Findings

### PASS findings

1. `test/e2e/friday-full-e2e.test.ts` with `FRIDAY_E2E_CORE=1`:
- 99 passed, 1 skipped, 0 failed.
- Skipped item is `C6 Validate provider (real API call — LLM)` (intentional in suite).

2. `test/e2e/friday-real-scenarios-e2e.test.ts` with `FRIDAY_E2E_CORE=1` (`--project llm-e2e`):
- 60 passed, 31 skipped, 0 failed.
- Non-LLM scenario block executes successfully.

3. `test/e2e/setup-wizard.e2e.test.ts` with `E2E_OLLAMA=1 E2E_REAL=1`:
- Category A/B coverage is green.

4. Cloud OpenAI provider lifecycle smoke:
- Health/login/provider create/routing/validate all PASS with real `OPENAI_API_KEY`.

### FAIL findings

1. Live Ollama journeys long suite (`test/e2e/live/friday-real-journeys.e2e.test.ts`):
- 2 passed, 8 failed.
- Failure pattern includes repeated `TOKEN_EXPIRED` / `401` in mid-to-late scenarios.
- Indicates auth token lifecycle mismatch for long-running E2E (>15 min).

2. Setup wizard real scenarios:
- `C17` expected 200 but got 404 on agent run path.
- `C18` skill import completed but imported skill missing from skills list assertion.

3. Cloud OpenAI agent runtime path:
- `openai-responses`: failed with `Missing required parameter: tools[0].name`.
- `openai-completions`: failed with `Invalid schema for function 'browser' ... array schema missing items`.
- Provider validate passes but tool/function schema sent to OpenAI is not fully compatible in runtime path.

### BLOCKED findings

1. Anthropic live cloud suites are not runnable in current environment:
- Missing `FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN` or `FRIDAY_ANTHROPIC_OAUTH_REFRESH_TOKEN`.
- Gate vars also unset (`FRIDAY_E2E_LIVE_ANTHROPIC`, etc.).

## Release Decision Snapshot

- Current recommendation: **NO-GO** for "full cross-environment release readiness".
- Reason: local real long-journey failures + cloud OpenAI runtime incompatibility + blocked Anthropic live validation.

## Minimal unblock checklist

1. Fix/refresh auth strategy for long E2E journey runs (token refresh or suite-side refresh usage).
2. Resolve OpenAI tool schema compatibility in agent runtime path.
3. Fix setup wizard scenario regressions (`C17`, `C18`).
4. Run Anthropic live suites with valid OAuth credentials and attach evidence logs.
