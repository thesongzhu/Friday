# Current Real-World Smoke Rerun

Run date: 2026-05-01

Branch: `codex/audit-followup-production-verification`

Verification worktree: `/tmp/friday-fix-verify-20260501T211129Z-fix-verify`

Runtime audit root: `/tmp/friday-real-world-audit-20260501T211921Z`

Mode: targeted remediation plus verification. Product edits were limited to the failures discovered by the current real-world smoke rerun and to removing stale marketplace/passwordless validation/documentation references.

## Targeted Fixes

| Area | Files | Why it failed | Fix |
| --- | --- | --- | --- |
| Multi-turn memory | `src/sessions/services/friday-session-conversation-orchestrator.ts`, `test/unit/sessions/services/friday-session-conversation-orchestrator.test.ts` | The recall detector only matched narrow wording like "remember the code phrase"; the real scenario used "Remember this code phrase", so the first user turn was not injected as recallable context. | Broadened recallable-fact detection for exact/project/conversation/phrase wording and added focused coverage for `amber-cascade-17`. |
| Read-only file tool bridge | `src/agent/runtime/friday-agent-tool-mutation.ts`, `src/agent/runtime/friday-agent-operational-mode.ts`, related unit tests | `request_tool_pack` is a safe dynamic tool-pack loader, but it was treated as mutating/unknown in read-only mode, so the agent could not load the read tool to inspect `README.md`. | Classified `request_tool_pack` as non-mutating/read-category while write/execute tools remain blocked. |
| Current-config startup | `src/state/sqlite/migrations/v056-incentive-alignment-foundation.ts`, `test/unit/state/sqlite/friday-v056-incentive-alignment-foundation-schema.test.ts` | Copied local state had a legitimate legacy checksum for migration v056 and startup stopped before health/auth. | Added the legacy v056 checksum to `acceptedChecksums`; no destructive migration or table drop was added. |
| Marketplace/passwordless residue | `validation/real-world/catalog/scenarios.mjs`, `validation/real-world/lib/client.mjs`, `validation/real-world/lib/executors.mjs`, `validation/real-world/lib/local-auth.mjs`, `docs/current-source-of-truth.md` | Removed product features were still referenced by validation/docs, causing stale audit findings. | Removed active marketplace scenarios/scopes/docs and removed passwordless `{ local: true }` validation fallback/capability checks. |

## Baseline Checks

| Command | Location | Result | Evidence |
| --- | --- | --- | --- |
| `npm ci` | clean worktree | `PASS` | Installed 726 packages; `found 0 vulnerabilities`; Node 23 emitted engine warnings for packages declaring Node 20/22/24 ranges. |
| `npm audit --audit-level=moderate` | clean worktree | `PASS` | `found 0 vulnerabilities`. |
| `npm run check:architecture-boundaries` | clean worktree | `PASS` | 5 checks passed. Warning only: modified immutable-doc file was expected in this branch. |
| `npm run check:migrations` | clean worktree | `PASS` | 75 migrations, contiguous `v001-v075`; migration array matched discovered files. |
| `npm run check:migrations` | dirty repo root | `FAIL_NON_PRODUCT_LOCAL_POLLUTION` | Failed only because untracked local duplicate migration files ending ` 3.ts` are present in the root worktree. |
| `npm run typecheck` | clean worktree | `PASS` | API, operator client, and UI typecheck completed. |
| `npm run test:contracts:update` | clean worktree | `PASS` | 5 files, 12 tests. |
| `npm run test:contracts:routes` | clean worktree | `PASS` | 5 files, 12 tests. |
| Focused unit tests | clean worktree | `PASS` | 4 files, 109 tests: session recall, tool mutation, operational mode, v056 checksum compatibility. |
| `npm run build` | clean worktree | `PASS` | API TypeScript build and Vite UI production build completed. |
| `npm run test:docker:e2e-smoke` | clean worktree | `PASS` | Docker runtime/bootstrap/plugins layers all passed with local passphrase bootstrap/login on unique ports. |
| `npm run test:install:smoke` | clean worktree | `PASS` | Packed tarball, installed temp project, CLI help, `/v1/health`, localPassphrase login, bundled UI, clean SIGINT shutdown. |
| `npm run lint` | clean worktree | `PASS_WITH_WARNINGS` | 0 errors, 1334 warnings; warnings are existing complexity/object-injection/non-literal-fs/no-console classes. |

## Real-World Smoke: Fresh State

Status: `VERIFIED`

Report paths:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T21-21-24-003Z-fresh/`
- Summary: `docs/reports/ops/real-world-validation/2026-05-01T21-21-24-003Z-fresh/summary.json`
- Environment truth: `docs/reports/ops/real-world-validation/2026-05-01T21-21-24-003Z-fresh/environment-truth.json`
- Defect ledger: `docs/reports/ops/real-world-validation/2026-05-01T21-21-24-003Z-fresh/defect-ledger.md`

Runtime truth:

- Base URL: `http://127.0.0.1:62404`
- Auth source: `local_passphrase_login`
- Setup status: `needsSetup=false`
- Setup/profile truth mismatch: `false`
- Primary lane: DeepSeek `deepseek-v4-flash`
- Fallback lane: OpenAI `gpt-4o-mini`
- Result counts: `27 passed`, `0 failed`, `0 partial`, `0 blocked`
- Failure classes: none

## Real-World Smoke: Current-Config Copy

Status: `VERIFIED`

Report paths:

- Report root: `docs/reports/ops/real-world-validation/2026-05-01T21-26-47-671Z-current-config/`
- Summary: `docs/reports/ops/real-world-validation/2026-05-01T21-26-47-671Z-current-config/summary.json`
- Environment truth: `docs/reports/ops/real-world-validation/2026-05-01T21-26-47-671Z-current-config/environment-truth.json`
- Defect ledger: `docs/reports/ops/real-world-validation/2026-05-01T21-26-47-671Z-current-config/defect-ledger.md`

Runtime truth:

- Base URL: `http://127.0.0.1:62550`
- Original state copied from `/Users/wenxindou/Library/Application Support/Friday/state`; original state was not modified.
- Auth source: `local_passphrase_login`
- Setup status: `needsSetup=false`
- Setup/profile truth mismatch: `false`
- Primary lane: DeepSeek `deepseek-v4-flash`
- Fallback lane: OpenAI `gpt-4o-mini`
- Result counts: `27 passed`, `0 failed`, `0 partial`, `0 blocked`
- Failure classes: none

## Invalid/Non-Canonical Artifacts

- `docs/reports/ops/real-world-validation/2026-05-01T21-22-58-129Z-fresh-focused/` is a redundant focused rerun caused by a temporary orchestration-script bug that read artifact `status` instead of `result`. It also passed `27/27`, but the canonical Fresh evidence is the full smoke report above.
- `docs/reports/ops/real-world-validation/2026-05-01T21-28-24-404Z-current-config-focused/` exists only in the temporary clean worktree and was intentionally interrupted after both canonical full smokes had passed. It is not copied to the repo root and is not used for product conclusions.
- Earlier reports from `2026-05-01T00-*` and `2026-05-01T20-*` are superseded for current-code conclusions because they used stale passwordless/default-port assumptions or pre-fix code.

## Residual Mechanism Scan

Command:

```text
rg -n "marketplace|/v1/marketplace|FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN|allowLocalBypassLogin|allowPasswordlessLocalLogin|\{ local: true \}|passwordless|PASSWORDLESS" src ui scripts test validation package.json .env.example docs/current-source-of-truth.md
```

Result: `PASS` / no matches in active source, UI, scripts, tests, validation, package metadata, env example, or current source-of-truth doc.

Secret leak scan:

- Scanned the new Fresh, Current-config, and redundant Fresh-focused report directories for full DeepSeek/OpenAI/Discord token patterns.
- Result: `PASS`, no full API key or Discord token pattern found.

## Old Report Comparison

| Old issue | Current status | Evidence |
| --- | --- | --- |
| `auth.source=passwordless_local_login` in old report | `RESOLVED` | Both canonical reports show `auth.source=local_passphrase_login`. |
| Fallback lane blocked/missing | `RESOLVED` | Both canonical reports resolve OpenAI fallback lane with `gpt-4o-mini`. |
| `l3-multi-turn-memory` failed on default/fallback | `RESOLVED` | Both canonical reports pass all 27 smoke artifacts. |
| `l4-file-tool-roundtrip` failed in read-only mode | `RESOLVED` | Both canonical reports pass all 27 smoke artifacts. |
| Current-config v056 checksum startup blocker | `RESOLVED` | Current-config copied state started, authenticated, configured providers, and passed full smoke. |
| Root `check:migrations` failure | `OPEN_LOCAL_WORKTREE_ONLY` | Clean worktree passes; root still has unrelated untracked duplicate migration files. |

## Verification Status

- `VERIFIED`: clean build, npm audit, architecture boundaries, clean migrations, typecheck, route contracts, focused unit tests, Docker passphrase smoke, install smoke, lint with warnings, Fresh real-world smoke, Current-config real-world smoke, primary/fallback provider lanes, passphrase auth, setup/profile truth, secret scan.
- `FAILED`: none in the canonical current-code smoke reports.
- `BLOCKED`: no local product smoke blocker remains.
- `OPEN_LOCAL_WORKTREE_ONLY`: root migration check remains polluted by unrelated untracked duplicate files.
- `GRAY`: external deployed CORS/cookie/callback-domain behavior and live channel delivery remain outside this local smoke proof.

## Recommended Next Fixes

1. Clean or quarantine untracked local duplicate files in the original worktree so root-level filesystem scans match clean-branch truth.
2. Rotate provider keys and the Discord token exposed in this conversation.
3. Run live Discord/channel E2E only against a safe sandbox channel after token rotation.
4. Run external staging deployment smoke when a real staging URL/domain/callback config exists.
5. Add a small regression check to prevent the real-world validation helper from misreading artifact `result` as `status` in future local orchestration scripts.
