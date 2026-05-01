# Current Real-World Smoke Rerun

Run date: 2026-05-01

Branch: `codex/audit-followup-production-verification`

Commit: `08c28b60bb4379e30da9d30a914e4027bb2d4aa0`

Mode: audit-only. No product-code edits. No test assertion edits. No result rewriting. Real provider calls. Passphrase auth only.

## Execution Setup

- Clean detached worktree: `/tmp/friday-real-world-audit-20260501T203436Z-closedloop/worktree`
- Temp state root: `/tmp/friday-real-world-audit-20260501T203436Z-closedloop/`
- Production build was run in the clean worktree before smoke execution.
- Fresh smoke used isolated state, isolated home, unique ports, `localPassphrase` bootstrap/login, DeepSeek primary, and OpenAI fallback.
- `PLAYWRIGHT_BROWSERS_PATH=/Users/wenxindou/Library/Caches/ms-playwright` was set for the final valid browser run. An earlier run without this was marked invalid for UI conclusions because temporary `HOME` made Playwright look in an empty cache.
- Current-config smoke copied `/Users/wenxindou/Library/Application Support/Friday/state` into a temporary state dir and did not modify the original local state.
- Secret scan against the new report directories and local config truth files found no full OpenAI or DeepSeek key patterns.

## Baseline Checks

| Command | Location | Result | Evidence |
| --- | --- | --- | --- |
| `npm ci` | clean worktree | `PASS` | Installed 726 packages; `found 0 vulnerabilities`; Node 23 emitted engine warnings for packages that declare Node 20/22/24 ranges. |
| `npm audit --audit-level=moderate --omit=dev` | clean worktree | `PASS` | `found 0 vulnerabilities` |
| `npm run check:architecture-boundaries` | clean worktree | `PASS` | 5 checks passed, 0 failed. |
| `npm run check:migrations` | clean worktree | `PASS` | 75 migrations, contiguous `v001-v075`; migration array matched discovered files. |
| `npm run typecheck` | clean worktree | `PASS` | `tsc --noEmit`, operator client, and UI typecheck completed. |
| `npm run build` | clean worktree | `PASS` | API TypeScript build and Vite UI production build completed. |
| `npm run test:docker:e2e-smoke` | clean worktree | `PASS` | Docker 29.4.1 / Compose v5.1.3, unique port `61816`, runtime/bootstrap/plugins layers passed via passphrase bootstrap/login. |
| `npm run check:migrations` | dirty repo root | `FAIL_NON_PRODUCT_LOCAL_POLLUTION` | Failed only because untracked local files `v038... 3.ts`, `v039... 3.ts`, `v042... 3.ts`, and `v055... 3.ts` are present. Clean worktree passed. |

## Fresh Install Smoke

Status: `FAILED`

Valid full smoke report:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T20-41-59-682Z-75e6o3/`
- Summary: `docs/reports/ops/real-world-validation/2026-05-01T20-41-59-682Z-75e6o3/summary.json`
- Environment truth: `docs/reports/ops/real-world-validation/2026-05-01T20-41-59-682Z-75e6o3/environment-truth.json`
- Defect ledger: `docs/reports/ops/real-world-validation/2026-05-01T20-41-59-682Z-75e6o3/defect-ledger.md`
- Local setup/config truth: `docs/reports/ops/real-world-validation/2026-05-01T20-41-59-682Z-75e6o3/local-config-truth.json`

Runtime truth:

- Base URL: `http://127.0.0.1:61944`
- Auth source: `local_passphrase_login`
- User: `admin-001`, role `admin`
- Setup/profile checks: `GET /v1/setup/status`, `GET /v1/uix/user-profile`, `GET /v1/providers`, `GET /v1/providers/health`, and `GET /v1/model-routing` all returned `200`.
- Primary lane: DeepSeek `deepseek-v4-flash`
- Fallback lane: OpenAI `gpt-4o-mini`
- UI request count: 4 UI scenarios, each with 28 measured requests; no UI wrong-surface failures.

Full smoke result:

- `passed`: 24
- `failed`: 3
- `partial`: 0
- `blocked`: 0
- Failure classes: `llm_behavior=2`, `tool_bridge=1`

Failed scenarios:

| Scenario | Lane | Result | Evidence | Assessment |
| --- | --- | --- | --- | --- |
| `l3-multi-turn-memory` | DeepSeek default | `FAILED` | Turn 2 completed but said session anchors only contained run status, not the remembered phrase. | Same-session second run does not receive the first user phrase/content as usable context. |
| `l3-multi-turn-memory` | OpenAI fallback | `FAILED` | Turn 2 completed but said the requested code phrase was not specified in context. | Reproduces on fallback provider, so this is product/session-context wiring, not provider-specific behavior. |
| `l4-file-tool-roundtrip` | DeepSeek default | `FAILED` | Agent completed but said only HTTP/web tools were available and `request_tool_pack` was blocked by `readOnly`; it could not read `README.md`. | Read-only agent execution lacks a safe filesystem-read tool while write/execute remain blocked. |

Focused rerun:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T20-45-34-871Z-79ss61/`
- Result: `failed=3`
- Same failure classes: `llm_behavior=2`, `tool_bridge=1`
- Assessment: all 3 full-smoke failures are reproducible in a new fresh runtime with the same provider lanes.

Invalid UI-noise run retained for audit trail:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T20-39-08-849Z-aq270z/`
- Result: `20 passed / 7 failed`
- Invalid portion: 4 UI failures were caused by missing Playwright browser cache under temporary `HOME`, not by product UI behavior. This run is not used for UI conclusions.

## Current-Config Smoke

Status: `BLOCKED`

Artifact:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T20-44-current-config-blocked/`
- Summary: `docs/reports/ops/real-world-validation/2026-05-01T20-44-current-config-blocked/summary.json`
- Server log: `docs/reports/ops/real-world-validation/2026-05-01T20-44-current-config-blocked/current-server.log`

Startup blocker:

```text
MIGRATION_CHECKSUM_MISMATCH for version 56 (v056-incentive-alignment-foundation)
expected ecf806db146c814c924660980d44067a454f8c23b633fd4c00c2cf5c2570c078
found    36666c7bc0d6fe25228bd23ab9f8bbc29262c9cd4bb2319c93fd281d0504800c
```

Assessment: the copied current local state cannot start on this commit before HTTP health, auth, setup, provider configuration, or smoke validation. The copied DB was not edited to bypass this.

## Residual Mechanism Scan

Marketplace:

- `rg -n "marketplace|/v1/marketplace" src ui scripts test package.json .env.example` returned no matches in clean worktree.
- `rg -n "marketplace|/v1/marketplace" dist` returned no matches after build.
- Remaining references exist outside product runtime scope:
  - `validation/real-world/catalog/scenarios.mjs` still defines `l1-marketplace-ui` and `l2-marketplace-requests-contract`.
  - `validation/real-world/lib/local-auth.mjs` still includes `marketplace.read`, `marketplace.write`, and `marketplace.admin` scopes in minted-token role fixtures.
  - `docs/current-source-of-truth.md` still documents `/v1/marketplace/*` as canonical surfaces.

Passwordless/local bypass:

- Product runtime scan did not find `FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN`, `allowLocalBypassLogin`, or `allowPasswordlessLocalLogin` in `src`, `ui`, `scripts`, `test`, `package.json`, or `.env.example`.
- Remaining validation harness references:
  - `validation/real-world/lib/client.mjs` still has a fallback request body `{ local: true }` and labels that path `passwordless_local_login` if no explicit credentials are provided.
  - `validation/real-world/lib/executors.mjs` still checks browser auth capability fields named `allowLocalBypassLogin` and `allowPasswordlessLocalLogin`.
- This run passed explicit `--local-passphrase`; `environment-truth.json` confirms `auth.source=local_passphrase_login`, so the current smoke result did not use passwordless auth.

## Old Report Comparison

Old contaminated report: `docs/reports/ops/real-world-validation/2026-05-01T00-41-12-583Z-nfz40j/`

- Old report used `auth.source=passwordless_local_login`, so it remains invalid for current-code conclusions.
- Old setup redirect failures disappeared in the valid fresh rerun.
- Old fallback blocked cases disappeared after configuring a real OpenAI fallback.
- Current persistent failures are only `l3-multi-turn-memory` and `l4-file-tool-roundtrip`.
- Current-config remains blocked by the same v056 checksum mismatch.

## Verification Status

- `VERIFIED`: clean build, npm audit, architecture boundaries, migrations in clean worktree, typecheck, Docker passphrase smoke, fresh passphrase auth, setup-complete state, DeepSeek primary lane, OpenAI fallback lane, UI route smoke, API contract smoke scenarios, provider routing/fallback availability.
- `FAILED`: multi-turn memory on DeepSeek default and OpenAI fallback; read-only filesystem tool roundtrip.
- `BLOCKED`: current-config smoke from copied local state due v056 migration checksum mismatch.
- `INVALID_RUN`: the first fresh run `2026-05-01T20-39-08-849Z-aq270z` for UI conclusions only; old report `2026-05-01T00-41-12-583Z-nfz40j` for current-code conclusions because it used passwordless auth.

## Recommended Next Fixes

1. Fix session memory/context handoff so a second agent run with the same `sessionKey` receives the first user turn content, not only a terse run-status summary.
2. Fix read-only tool bridge policy so safe filesystem read tools are available when `constraints.readOnly=true`, while write/execute tools remain blocked.
3. Resolve the v056 local-state migration checksum mismatch by determining whether `36666c7b...` is a legitimate historical checksum that should be accepted or whether the local state needs an explicit repair path.
4. Remove or retire marketplace references from `validation/real-world/*` and `docs/current-source-of-truth.md` so audit/catalog tooling no longer reports deleted product surfaces.
5. Remove passwordless fallback branches from `validation/real-world/lib/client.mjs` and rename/remove stale browser-auth capability references in `validation/real-world/lib/executors.mjs`.
6. Clean or quarantine untracked local duplicate files (`* 2.md`, `* 3.ts`) because they make root-level scans and migration checks fail even though clean worktree checks pass.
7. Rotate the provider keys exposed in this conversation after testing.
