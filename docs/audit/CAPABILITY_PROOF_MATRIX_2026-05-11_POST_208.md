# Friday Capability Proof Matrix - 2026-05-11 post-#208 ledger refresh

This file is a dated post-#208 ledger refresh of the evidence state for `origin/main`.
It supersedes [`CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md`](CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md) for the current SHA, but it does not retroactively rewrite the predecessor snapshots.

This is not a full repo line-by-line audit. It records only the post-#203 deltas that landed through PRs #204-#208 plus the Phase 4 read-only DeepSeek evidence audit. The authoritative product surface remains [`../current-source-of-truth.md`](../current-source-of-truth.md), and the authoritative evidence taxonomy remains [`../release-evidence-policy.md`](../release-evidence-policy.md).

## 1. Snapshot anchor

| Field | Value |
|---|---|
| Snapshot date (local) | 2026-05-11 |
| Snapshot date (UTC) | 2026-05-12 |
| `origin/main` SHA | `ce27d96f9602ce97b22fcc6ac6217d5be56f2d84` |
| Most recent merge | [#208 - test(e2e): gate DeepSeek visual restart proof](https://github.com/thesongzhu/Friday/pull/208) |
| Predecessor snapshot | [`CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md`](CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md), anchored at `9c27f9e98c1285818482e0dfe9a17ecb33aeb9c6` |
| Merged PRs since predecessor snapshot | #204 ledger reconciliation, #205 governance mirror/F-013 PARTIAL, #206 non-cloud/local goal boundary, #207 F-020 test hygiene, #208 F-018 DeepSeek visual gate |
| Current release-proof same-SHA status | **None** |

## 2. Workflow conclusion vs release proof

Recent Real Green Gate artifacts were downloaded/read for the PR heads below. Every one is `blocked_by_env`, ran zero scenarios, and is not release proof.

| PR | Head SHA | RGG run | Artifact `status` | Scenarios run/total/passed | Release proof? |
|---|---|---|---|---|---|
| #205 | `382fca3db2f91dda765525000cc5f18b5768e4d2` | `25703459628` | `blocked_by_env` | `0/0/0` | NO |
| #206 | `8fae5decfda81e2e1146d5e4a0d108063af58475` | `25712252858` | `blocked_by_env` | `0/0/0` | NO |
| #207 | `ec5b74c0cabefb85b7d3f0abf0e81b986774a915` | `25713044778` | `blocked_by_env` | `0/0/0` | NO |
| #208 | `98af5b3012182dafb0b60fda09716b80130e7e20` | `25714407851` | `blocked_by_env` | `0/0/0` | NO |

The common blocker is missing GitHub Actions runtime credentials:
`FRIDAY_BASE_URL_or_FRIDAY_ACCESS_TOKEN_or_FRIDAY_LOCAL_PASSPHRASE_or_FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN`.

`blocked_by_env` must never be described as pass. A workflow conclusion of `success` is plumbing-tier only when the artifact itself says `blocked_by_env`.

## 3. Evidence-tier definitions

Per [`../release-evidence-policy.md`](../release-evidence-policy.md), this snapshot uses these terms:

| Token | Meaning |
|---|---|
| `release-proof same-SHA` | A `passed` Real Green Gate artifact for the exact SHA, with scenarios total greater than zero, all scenarios passed, and no blockers. |
| `local real-runtime/provider` | A local live run against real runtime/provider components. Useful diagnostic evidence; not release proof. |
| `transcript-backed local PASS` | A local transcript contains command output showing pass, but no clean standalone per-test log artifact exists. Stronger than unknown, weaker than a preserved log file. |
| `blocked_by_env` | Required environment was absent, so the scenario did not run. Never pass. |
| `mock-only` | Unit/integration/mock coverage only. Not release proof. |
| `manual-external` | Requires an external sandbox/system such as Discord or deployed cloud. |
| `MISSING` | No applicable evidence found. |

## 4. Post-#208 capability deltas

### 4.A Governance mirror and owner-bypass ledger - F-013

PR #205 merged the repo-tracked mirror for the single-maintainer owner-bypass rule and flipped F-013 from `RESOLVED` to `PARTIAL`. This is governance bookkeeping only.

Post-#205 through post-#208 merge facts all show `reviews: []` and `reviewDecision: REVIEW_REQUIRED`. Branch protection still permits the implicit admin-owner path because `enforce_admins.enabled: false` remains platform-enabled. These facts are not reviewer proof and not release proof.

### 4.B Non-cloud/local goal boundary - F-009/F-014 scope

PR #206 added [`NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md`](NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md) and updated F-009/F-014 framing:

- F-009 cloud/Fly/deployed URL work remains `PARTIAL` and out of scope for the current non-cloud/local closure goal.
- F-014 OTEL/Grafana external observability remains `OPEN` and out of scope for the current non-cloud/local closure goal.

This does not resolve external launch readiness.

### 4.C Self-healing test hygiene - F-020

PR #207 moved `friday-self-healing-live` synthetic/broken skill fixture writes out of repo-tracked `<repo>/skills/` and into an `os.tmpdir()` fixture, with `FRIDAY_SKILLS_DIR` set before hub boot and restored after cleanup.

Evidence:

- `test/e2e/live/friday-self-healing-live.e2e.test.ts` no longer contains `path.join(process.cwd(), "skills")`.
- `git ls-files skills/ | wc -l` remained 177 during verification.
- No `e2e-skill-drift-*` directory was left under repo `skills/`.
- The focused live proof was not rerun with provider env; the file-level live gate skipped without env. This is diagnostic, not release proof.

Current tier for F-020: test-harness hygiene closed. No release-proof tier.

### 4.D DeepSeek autonomous restart visual gate - F-018

PR #208 added a lane-aware skip only for the fourth visual-verification `it` in `friday-autonomous-restart.e2e.test.ts`:

- DeepSeek skips the visual-only `it`, because the DeepSeek templates currently expose no vision model.
- The first three autonomous restart tests remain active for DeepSeek.
- The whole file is not skipped.
- OpenAI, Anthropic, and Ollama behavior was not weakened by this slice.

Current tier for DeepSeek autonomous restart visual verification: honestly excluded by capability gate, not a pass and not provider-agnostic vision proof.

### 4.E DeepSeek queue tests #1 and #6 - Phase 4 read-only audit

The original DeepSeek queue directory contains seven clean per-test logs:

- `01-provider-profile.log`
- `02-plugin.log`
- `03-workflow-upgrade.log`
- `04-workflow-generator-maintenance.log`
- `05-subagent.log`
- `06-learning.log`
- `07-self-healing.log`

It contains no clean log for:

- `friday-self-upgrade-mcp-server-live.e2e.test.ts`
- `friday-self-upgrade-channel-adapter-live.e2e.test.ts`

Phase 4 read-only audit found local Claude transcript evidence:

| Test | Transcript evidence | Current classification |
|---|---|---|
| `friday-self-upgrade-mcp-server-live.e2e.test.ts` | PASS `1/1`, single attempt, 414 ms test time | `transcript-backed local PASS`; missing clean log artifact |
| `friday-self-upgrade-channel-adapter-live.e2e.test.ts` | PASS `1/1`, single attempt, 334 ms test time | `transcript-backed local PASS`; missing clean log artifact |

GitHub Actions logs for PR #200/#201 showed these live tests skipped under CI live gates, so CI is not provider proof for these rows.

## 5. Open blockers after #208

| Finding / Surface | Current status | Why it remains open or blocked |
|---|---|---|
| F-008 live channels/Discord | OPEN | Needs rotated/safe sandbox token and recipient configuration outside prompts/logs. |
| F-009 cloud deployment | PARTIAL, out of current local goal | No Fly app/token/deployed URL/cloud smoke. |
| F-010 architecture debt | OPEN | Large hub/runtime composition remains. |
| F-011 audit trail lifecycle | OPEN | Expected DB-closed append failures still need deterministic shutdown behavior. |
| F-013 governance | PARTIAL | `enforce_admins.enabled: false` still permits implicit admin-owner merges. |
| F-014 OTEL/Grafana | OPEN, out of current local goal | External observability endpoint/export remains unconfigured. |
| F-016 packaging | OPEN | Phase 1 in-memory preview; SQLite registry/install/lifecycle/trusted-key/signature paths not wired. |
| F-017 skill lifecycle routes | OPEN | `/v1/skills/:skillId/verify` and lifecycle catalog/update/delete wiring remain blocked until approval gates and lifecycle service wiring land. |
| F-019 generator-to-candidate bridge | OPEN | Generator approve still bypasses the unified candidate/lifecycle store. |
| RGG same-SHA release proof | BLOCKED_BY_ENV | No artifact with `status: passed` and real scenarios for current SHA. |

## 6. What this snapshot does and does not say

This snapshot says:

- F-018 and F-020 have been closed at the local test-harness level by PRs #208 and #207 respectively.
- DeepSeek #1 and #6 are no longer unknown outcomes; they are transcript-backed local PASS, but still missing clean per-test log artifacts.
- Current `origin/main@ce27d96f` has zero release-proof same-SHA evidence.

This snapshot does not say:

- That F-017 or F-019 are resolved.
- That the DeepSeek lane is fully proven.
- That self-healing is fully closed; the skill-verification drift route still depends on F-017.
- That any `blocked_by_env` RGG artifact is a pass.
- That cloud deployment, Discord delivery, or OTEL/Grafana observability is complete.

## 7. Audit ledger

This refresh was assembled from:

- `gh pr view 205`, `206`, `207`, `208` metadata.
- Downloaded/read RGG artifacts under `/tmp/friday-pr205-rgg`, `/tmp/friday-pr206-rgg`, `/tmp/friday-pr207-rgg`, and `/tmp/friday-pr208-rgg`.
- [`./10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md).
- [`./NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md`](NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md).
- [`./CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md`](CAPABILITY_PROOF_MATRIX_2026-05-11_POST_203.md).
- `test/e2e/live/friday-self-healing-live.e2e.test.ts` at `origin/main@ce27d96f`.
- `test/e2e/live/friday-autonomous-restart.e2e.test.ts` at `origin/main@ce27d96f`.
- `/tmp/friday-deepseek-queue-20260511/`.
- `/Users/jarvis/.zsh_history` (redacted command-history check; no test output there).
- `/Users/jarvis/.claude/projects/-Users-jarvis-Projects-Friday/c417ec56-46b8-409e-81c3-9164de83bfe6.jsonl` (local transcript evidence for DeepSeek #1/#6).
- GitHub Actions logs for PR #200/#201 test jobs, which showed the relevant live tests skipped in CI.

This refresh is intentionally narrow. Rows from the predecessor matrices that are not mentioned here retain their previous classification until a future full matrix pass re-verifies them.
