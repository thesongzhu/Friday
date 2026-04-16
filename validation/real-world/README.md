# Friday Real-World Validation

This framework lives outside `test/` on purpose. It is an operator-facing real-world validation program for Friday, not a unit/integration assertion suite.

## Goals

- Use the real runtime, real UI, and real providers.
- Keep catalog, execution, and reporting independent from existing `test/` fixtures and pass criteria.
- Record blocking prerequisites explicitly instead of hiding gaps behind mocks.

## Layout

- `catalog/scenarios.mjs`: the scenario inventory. Each scenario declares layer, surface, routing family, provider lane policy, budgets, evidence, and execution kind.
- `lib/env-truth.mjs`: L0 prerequisite truth collection. Resolves auth, setup, `uix.user-profile`, provider lanes, and operator-declared desktop/channel/cloud/satellite readiness.
- `lib/executors.mjs`: black-box execution for HTTP probes, UI probes, agent runs, workflow approval roundtrips, generator loops, persona checks, and manual external lanes. UI probes now distinguish load noise from wrong-surface misroutes such as authenticated sessions landing on `/onboarding`.
- `lib/judge.mjs`: deterministic rubric plus optional cross-provider LLM judge.
- `lib/reporting.mjs`: coverage matrix, stability report, performance report, and defect ledger output.
- `lib/runner.mjs`: suite orchestration, repetitions, soak handling, and report materialization.
- `scripts/validation/run-real-world-validation.mjs`: CLI entrypoint.

## Suites

- `smoke`: fast pre-change pass.
- `daily`: daily regression with a slightly wider surface.
- `nightly`: deep regression, including generator loops and soak scenarios.
- `weekly`: includes manual external/distributed lanes.

## Commands

```bash
npm run validate:real-world:catalog
npm run validate:real-world:smoke
npm run validate:real-world:daily
npm run validate:real-world:nightly
npm run validate:real-world:weekly
```

Useful flags:

```bash
node scripts/validation/run-real-world-validation.mjs --list-scenarios
node scripts/validation/run-real-world-validation.mjs --suite smoke --scenario l3-summary-misroute-guard
node scripts/validation/run-real-world-validation.mjs --suite nightly --layer L5 --judge never
node scripts/validation/run-real-world-validation.mjs --suite smoke
node scripts/validation/run-real-world-validation.mjs --suite smoke --mint-local-admin-token
```

## Environment

Default runtime target:

- `FRIDAY_BASE_URL`: defaults to `http://127.0.0.1:3141`
- `FRIDAY_UI_BASE_URL`: defaults to `FRIDAY_BASE_URL`
- `FRIDAY_ACCESS_TOKEN`: optional bearer token for non-local auth
- `FRIDAY_LOCAL_PASSPHRASE`: optional local passphrase for `/v1/auth/login`
- `FRIDAY_AUTH_EMAIL` / `FRIDAY_AUTH_PASSWORD`: optional email/password login pair
- `--mint-local-admin-token` is a fallback for special environments only; prefer real login whenever the runtime already supports it

Operator-only local mint fallback:

- `FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN=true` enables short-lived local access-token minting for this validation harness.
- `FRIDAY_REAL_WORLD_MINT_STATE_DB_PATH`: optional override for the state DB path.
- `FRIDAY_REAL_WORLD_MINT_TOKEN_SECRET_FILE`: optional override for the token-secret file. Defaults to `~/.friday/token.secret`.
- `FRIDAY_REAL_WORLD_MINT_USER_ID`: optional owner/admin user id selector.
- `FRIDAY_REAL_WORLD_MINT_USER_EMAIL`: optional owner/admin email selector.
- `FRIDAY_REAL_WORLD_MINT_TENANT_ID`: optional tenant override. Defaults to the selected user id.
- `FRIDAY_REAL_WORLD_MINT_ACCESS_TOKEN_TTL_SEC`: optional access-token TTL override. Defaults to `3600`.

This mint path is intentionally opt-in. It does not modify Friday's public API contract and should only be used when real credentials are unavailable but the operator still needs to drive real-world validation against a local runtime.

Operator-declared prerequisite flags:

- `FRIDAY_REAL_WORLD_DESKTOP_READY=true|false`
- `FRIDAY_REAL_WORLD_EXTERNAL_CHANNELS_READY=true|false`
- `FRIDAY_REAL_WORLD_CLOUD_READY=true|false`
- `FRIDAY_REAL_WORLD_SATELLITE_READY=true|false`
- `FRIDAY_REAL_WORLD_MCP_READY=true|false`

These flags intentionally declare truth for prerequisites that cannot be inferred safely from the local repo alone. Missing flags show up as `unknown`, which blocks the corresponding manual lanes instead of pretending they passed.

## Outputs

Each run writes to:

- `docs/reports/ops/real-world-validation/<runId>/`

Artifacts include:

- `summary.json`
- `environment-truth.json`
- `catalog.json`
- `artifacts.json`
- `grouped.json`
- `coverage-matrix.md`
- `stability-report.md`
- `performance-report.md`
- `defect-ledger.md`
- `attempts/**`
- `screenshots/**`

`docs/reports/ops/real-world-validation/latest.json` is updated to point at the latest run.

## Current Classification Notes

- `ui_misroute`: the UI loaded, but the final route landed on the wrong surface. Example: `/chat` redirecting an authenticated, setup-complete session to `/onboarding`.
- `environment-truth.json` now stores both `setupStatus` and `userProfile` so onboarding-vs-setup mismatches are explicit in the evidence, instead of being buried in screenshots.
