# Friday Capability Proof Matrix - 2026-05-12 post-#216 ledger refresh

This file is a dated post-#216 ledger refresh for current `origin/main`.
It supersedes [`CAPABILITY_PROOF_MATRIX_2026-05-11_POST_208.md`](CAPABILITY_PROOF_MATRIX_2026-05-11_POST_208.md) for current-state reading, but does not rewrite earlier historical snapshots.

This is not a full repo line-by-line audit. It records the local/non-cloud closure deltas that landed after #208 through #216. The authoritative product surface remains [`../current-source-of-truth.md`](../current-source-of-truth.md), and the authoritative evidence taxonomy remains [`../release-evidence-policy.md`](../release-evidence-policy.md).

## 1. Snapshot anchor

| Field | Value |
|---|---|
| Snapshot date (local) | 2026-05-12 |
| Snapshot date (UTC) | 2026-05-12 |
| `origin/main` SHA | `0568431cbd5b6c89e7e824e1f54cc6edc3d9f38b` |
| Most recent merge | [#216 - docs(audit): defer external-env proof from local closure](https://github.com/thesongzhu/Friday/pull/216) |
| Predecessor snapshot | [`CAPABILITY_PROOF_MATRIX_2026-05-11_POST_208.md`](CAPABILITY_PROOF_MATRIX_2026-05-11_POST_208.md), anchored at `ce27d96f9602ce97b22fcc6ac6217d5be56f2d84` |
| Merged PRs since predecessor snapshot | #209 post-#208 ledger refresh, #210 lifecycle approval gates, #211 lifecycle hub wiring, #212 generator-to-candidate bridge, #213 base-route architecture seam, #214 audit-drain shutdown lifecycle, #215 packaging honesty, #216 external-env boundary |
| Current release-proof same-SHA status | **None** |

## 2. Workflow conclusion vs release proof

Recent workflow `success` results are plumbing-tier unless the `real-green-gate-result.json` artifact itself reports `status: passed` with real scenarios. The latest RGG artifact read during closeout for PR #216 was:

| PR | Head SHA | RGG run | Artifact `status` | Scenarios run/total/passed | Release proof? |
|---|---|---|---|---|---|
| #216 | `562af5a02243e84c24a0f4ec30f94d0963e69ff4` | `25723783816` | `blocked_by_env` | `0/0/0` | NO |

The blocker remains missing live-runtime GitHub Actions credentials:
`FRIDAY_BASE_URL_or_FRIDAY_ACCESS_TOKEN_or_FRIDAY_LOCAL_PASSPHRASE_or_FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN`.

`blocked_by_env` must never be described as pass. This snapshot is local/code/governance bookkeeping, not same-SHA release proof.

## 3. Post-#208 local closure deltas

| Finding / Surface | Current status after #216 | Evidence boundary |
|---|---|---|
| F-010 hub/runtime architecture | `PARTIAL` | PR #213 extracted the base API route installer into `src/api/runtime/friday-api-runtime-base-routes.ts`. One local seam is complete; broader composition debt remains. |
| F-011 audit trail lifecycle | `RESOLVED` | PR #214 tracks and drains pending background audit appends during shutdown and surfaces `OBS_AUDIT_BACKGROUND_APPEND_FAILED` instead of hiding late-write failures. |
| F-016 packaging | `PARTIAL` | PR #215 narrowed documentation to Phase 1 in-memory preview truth. SQLite registry/install/trusted-key/signature Phase 2 remains future work. |
| F-017 skill lifecycle routes | `RESOLVED` for current local route-wiring and approval-gate goal | PR #210 added canonical approval gates for lifecycle `update` and `delete`; PR #211 wired `createFridaySkillLifecycleService` into hub runtime. This is not live-provider or release proof. |
| F-019 generator-to-candidate bridge | `RESOLVED` for current local bridge goal | PR #212 returns candidate metadata from generator approval and routes generated skills through the candidate/lifecycle handoff. This is not DeepSeek live rerun proof. |
| F-008 live channels / Discord | `OPEN`, out of current goal | Requires owner-provided sandbox token and recipient IDs outside prompts/logs. |
| F-009 cloud deployment | `PARTIAL`, out of current goal | Requires Fly app/token/deployed URL/cloud smoke. |
| F-014 external OTEL/Grafana | `OPEN`, out of current goal | Requires external observability endpoint/export verification. |
| RGG same-SHA release proof | out of current goal, blocked by env | Requires owner-configured live runtime secrets and an artifact with `status: passed`; current artifacts remain `blocked_by_env`. |

## 4. What this snapshot does and does not say

This snapshot says:

- The current non-cloud/local closure goal has local/code/doc evidence for F-010 partial seam work, F-011 shutdown audit drain, F-016 packaging honesty, F-017 lifecycle gate+wiring, and F-019 generator candidate handoff.
- F-008, F-009, F-014, and RGG same-SHA proof are explicitly outside the current goal and remain future external-env or cloud work.
- Current `origin/main@0568431c` has no same-SHA release proof artifact.

This snapshot does not say:

- That cloud deployment, live channel delivery, OTEL/Grafana export, or same-SHA release proof is complete.
- That `blocked_by_env` is a pass.
- That packaging Phase 2 or default-on package distribution is implemented.
- That local code closure is a substitute for live-provider or release-grade proof.

## 5. Audit ledger

This refresh was assembled from:

- `gh pr view` metadata for #209 through #216.
- `gh pr checks` snapshots for #210 through #216; #216 initially showed `test` pending during the closeout pass, and a later fresh-read showed all checks successful.
- The PR #216 RGG artifact downloaded/read during Stage 8: `status=blocked_by_env`, scenarios `0/0/0`.
- [`./10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md).
- [`./NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md`](NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md).
- [`../current-source-of-truth.md`](../current-source-of-truth.md).
- Current source references for skill lifecycle routing, generator candidate bridge, and observability audit-drain shutdown behavior.
