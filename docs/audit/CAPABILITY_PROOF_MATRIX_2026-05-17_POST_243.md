# Friday Capability Proof Matrix - 2026-05-17 post-#243 ledger refresh

This file is a dated post-#243 ledger refresh for current `origin/main`.
It supersedes [`CAPABILITY_PROOF_MATRIX_2026-05-12_POST_216.md`](CAPABILITY_PROOF_MATRIX_2026-05-12_POST_216.md) for current-state reading, but does not rewrite earlier historical snapshots.

This is not a full repo line-by-line audit and it is not product release proof. It is a Phase 15 docs-truth reconciliation snapshot built from the per-phase completion reports under `/Users/example/Desktop/friday_vertical_closure_phase_reports_2026-05-12/` and the live source under `src/`. The authoritative product surface remains [`../current-source-of-truth.md`](../current-source-of-truth.md) and the authoritative evidence taxonomy remains [`../release-evidence-policy.md`](../release-evidence-policy.md).

## 1. Snapshot anchor

| Field | Value |
|---|---|
| Snapshot date (UTC) | 2026-05-17 |
| `origin/main` SHA | `42fac20fa5f5bfd33e23addc400d9fb98bb35ee8` |
| Most recent merge | [#243 - Phase 14.5D - Rollback matrix and closeout receipt (module_28d)](https://github.com/thesongzhu/Friday/pull/243) |
| Predecessor snapshot | [`CAPABILITY_PROOF_MATRIX_2026-05-12_POST_216.md`](CAPABILITY_PROOF_MATRIX_2026-05-12_POST_216.md), anchored at `0568431cbd5b6c89e7e824e1f54cc6edc3d9f38b` |
| Merged PRs since predecessor snapshot | #217-#221 baseline / consolidation work, #222 Phase 02a, #223 Phase 02b, #224 Phase 04, #225 Phase 05, #226 Phase 06, #227-#229 conveyor governance docs, #228 Phase 07, #230 Phase 08, #231 Phase 09, #232 Phase 10, #233 Phase 11, #234 Phase 12, #235-#238 Phase 13.5 A/B/C/D, #239 Phase 14.5A, #240 Phase 14 / Phase 06 release-proof slice, #241 Phase 14.5B, #242 Phase 14.5C, #243 Phase 14.5D |
| Phase 15 status at this snapshot | docs-truth reconciliation in progress; this file itself is part of the Phase 15 slice |

## 2. How this snapshot is built

Each row below cites the per-phase completion report or REPORTS_INDEX row that recorded the merge facts. Workflow `success` alone is plumbing-tier; only artifacts with `status: passed` for the same head SHA, nonzero scenarios, all scenarios passed, and empty `blocked_reasons` are release-proof eligible. `blocked_by_env` is not pass. Phase 15 docs-truth changes do not change any of these proof tiers and do not produce new product capability proof.

## 3. Phase proof tier ledger

| Phase | PR | Merge SHA | RGG truth | Status as recorded | Notes / honest debt |
|---|---|---|---|---|---|
| 02a Media understanding provider loop | #222 | `4ac409d6` | same-SHA `status=passed`, scenarios `76/76/76`, blocked_reasons `[]`, evidence kinds all 4 | `release-complete` | Real OpenAI vision provider registered, doctor + analyze proved; surface remains runtime-gated by `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` plus resolvable `env:OPENAI_API_KEY`. |
| 02b Social link to capability loop | #223 | `2feb34a3` | same-SHA `status=passed`, scenarios `76/76/76` | `partial` | Partial slice merged; residual shadow -> canary -> promote -> verify -> learning/asset record forwarded to later phase. |
| 03 GitHub repo to skill loop | — | local | not_applicable | `completed` | Local real-runtime proof chain (import -> shadow -> canary -> promote -> verify -> run -> rollback) under `FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS=true`; no PR opened in that pass. |
| 04 Capability acquisition install/register/verify | #224 | `98d9b09e` | same-SHA `status=passed`, scenarios `76/76/76` | `release-complete` | Real-runtime of specific `approveRun()` path remains blocked_by_env / not attempted. |
| 05 Entity learning and asset inventory | #225 | `7228d99b` | not waited post-merge | `completed-merged` | Local real-runtime + real-browser proof; knowledge category proof remains blocked_by_config (invalid/missing `FRIDAY_MASTER_KEY`). |
| 06 Skill merge and upgrade lifecycle | #226 + Phase 14 slice #240 | `135644cf` + `8ee0c873` | Phase 06 same-SHA `status=passed` via Phase 14 PR #240 (`1a1c9668` head, scenarios `79/79/79`) carry-forward to merge `8ee0c873` by exact tree parity | `merged` then Phase 14 slice `release-proof closed via carry-forward` | rollback route success remained blocked by `canonical_approval_digest_mismatch` until the Phase 14 slice closed the release-proof carry-forward. |
| 07 Discovery, MCP, deeplink bridge | #228 | `caec7db4` | PR-head same-SHA `status=passed`, scenarios `76/76/76` | `release-complete` | Post-merge CI/RGG not waited per Stage 8 no-wait rule. |
| 08 Studio, pack, cross-border productization | #230 | `d4c66ec4` | same-SHA `status=passed`, scenarios `76/76/76` | `release-complete` | Module 09 + Module 10 closed; no Phase 14 debt forwarded. |
| 09 Channels and workflows live E2E | #231 | `cc4a06c5` | same-SHA `status=passed`, scenarios `78/78/78` | `release-complete` | Module 12 + Module 13 closed; external deployed webhook smoke forwarded to Phase 14 debt. |
| 10 Memory, learning, self-heal loop | #232 | `4343adf1` | same-SHA `status=passed`, scenarios `78/78/78` | `release-complete` | Module 15 closes skill failure -> regenerate_skill lifecycle; workflow regeneration explicitly out of Module 15 scope. |
| 11 Packaging, plugins, tenants, distribution | #233 | `a5239ac7` | PR-head same-SHA `status=passed`, scenarios `78/78/78` | `partial` | SQLite persistence for packaging + multi-tenant + real signature verification shipped. Named Phase 14 debt: `module_16_packaging_release_proof_roundtrip`, `module_17_full_upgrade_lifecycle_evidence_harness`, `module_18_cross_tenant_denial_rgg_assertion`. `FRIDAY_PACKAGING_ENABLED` and `FRIDAY_MULTI_TENANT_ENABLED` default-on flips remain explicit stop points. |
| 12 Fleet, observability, release proof | #234 | `b06a6967` | same-SHA `status=passed`, scenarios `78/78/78` (PR-head `b771d252`) | `partial` | Named Phase 14 debt: `module_19_multihost_satellite_real_send`, `module_20_external_alerts_real_send_slack`, `module_20_external_alerts_real_send_smtp`, `module_20_external_observability_otel_exporter`, `module_20_external_observability_grafana_endpoint`. |
| 13 Conditional surfaces: TTS, desktop, email | — | no merge | not_applicable (Phase 13 closed as truth-reconciliation only) | `completed_report_only` | Per user decision 2026-05-15: `module_23` desktop clean-machine notarization and `module_24` real TTS provider proof are explicitly out of scope / not_configured unless separately re-approved. Phase 13 made no product code changes and no release-complete claim. |
| 13.5 Evidence-backed task orchestration | #235-#238 | `8d3f3d9a` | post-merge main RGG run `25965896129` failed with scenarios `77/78/78` and blocked_reasons `[external channel suite is not fully passed]` | `phase14_5e-debt-complete` | 13.5D product slice landed with PR-head same-SHA proof; external channel live proof was forwarded to Phase 14.5E. Discord `l6-discord-channel-roundtrip` failed with `DISCORD_CONNECTION_FAILED` post-merge. |
| 13.6 Architecture boundary extraction | — | no merge | not_applicable | `not_started` | Parked unless `CURRENT_ROUTE_MAP` resumes it. Scope strictly limited to one low-risk no-behavior-change package extraction; refactor alone is not release proof. |
| 14 Real release proof catch-up (Phase 06 slice) | #240 | `8ee0c873` | same-SHA `status=passed`, scenarios `79/79/79` (PR-head `1a1c9668`); exact tree parity to merge | `phase_06_slice_merged_phase_02b_04_05_07_13_debts_pending` | Phase 06 release-proof debt closed via same-SHA RGG carry-forward. Phase 02b residuals, Phase 04 `approveRun()` real-runtime path, Phase 05 knowledge-category proof, and future Phase 07-13 release-proof gaps remain UNADDRESSED in this slice and forward to subsequent Phase 14 slices. Phase 13 `module_23` / `module_24` remain explicitly out of scope / not_configured. |
| 14.5A Owner/session/channel capability gate | #239 | `4a82f373` | PR-head proof | merged | WP-001 runtime-auth slice; no scope creep. |
| 14.5B One-click repair and recovery doctor | #241 | `074f5c8f` | PR-head proof | merged | — |
| 14.5C Workflow evidence fail-closed | #242 | `9d2400bc` | PR-head proof | merged | — |
| 14.5D Rollback matrix and closeout receipt | #243 | `42fac20f` | PR-head proof | merged | Current `origin/main` HEAD at this snapshot. |
| 14.5E Configured-channel live proof | #244 | open / blocked | same-SHA RGG run `25987473608` at PR-head `4a8af48c` failed with external channel prerequisite missing | `completed_report_only` (user-approved partial/blocked) | Discord configured and proof-attempted; Lark/Feishu and Telegram remain `not_configured` / `blocked_by_env`. PR #244 remains open and unmerged. `blocked_by_env` is not pass. Do not retry external channel live proof unless credentials/test spaces are configured and explicitly approved. |
| 15 Doc truth reconciliation | this PR | pending | not_applicable for product capability | `in_progress` | Docs-truth only. Updating `docs/current-source-of-truth.md`, `docs/architecture/agent-package-rfc.md`, `docs/architecture/multi-tenant-security-rfc.md`, this new audit snapshot, `CHANGELOG.md`, the Phase 15 completion report, and the `REPORTS_INDEX.csv` Phase 15 row only. No product code, tests, runtime, API snapshots, branch protection, GitHub state, credentials, release-proof standard, or governance semantics are changed. |
| 16 Local maintainer operator workflow | — | not started | not_applicable | `not_started` | Local-only operator phase; not Friday product release proof. |
| 17 User-owned cloud worker setup UX | — | not started | not_applicable | `not_started` | 17B live certification requires protected GitHub Environment Secrets + manual workflow_dispatch; missing cloud/DNS credentials are `blocked_by_env`, not pass. |

## 4. What this snapshot does and does not say

This snapshot says:

- Phase 02a media-understanding has same-SHA release proof via PR #222 (`4ac409d6`); the surface remains runtime-gated by `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` plus a resolvable `env:OPENAI_API_KEY`.
- Phase 11 packaging + multi-tenant SQLite persistence shipped via PR #233 (`a5239ac7`) and real signature verification is wired through the bootstrap publish handler; both surfaces remain default-off behind `FRIDAY_PACKAGING_ENABLED=true` / `FRIDAY_MULTI_TENANT_ENABLED=true` and Phase 11 closed `partial` with named Phase 14 release-proof debt for `module_16`, `module_17`, and `module_18`.
- Phase 14 Phase 06 release-proof slice closed via same-SHA RGG carry-forward; Phase 02b / 04 / 05 / 07-13 release-proof gaps remain unaddressed in that slice.
- Phase 14.5 closed Phase 14.5A-D with PR-head proof; Phase 14.5E closed as user-approved partial/blocked report-only outcome. Discord was the only configured live-proof target; Lark/Feishu and Telegram remain `not_configured` / `blocked_by_env`.
- `FRIDAY_MASTER_KEY` and `FRIDAY_TOKEN_SECRET` are internal runtime secrets generated and stored by the local or user-owned cloud runtime. Ordinary user setup must not be told to paste them; maintainer CI or release-proof jobs may configure protected environment secrets only when a production-like proof explicitly requires them.

This snapshot does not say:

- That Phase 11, Phase 14, Phase 14.5E, Phase 13 `module_23`, Phase 13 `module_24`, or Phase 15 are product release-complete.
- That `blocked_by_env` is a pass.
- That the `FRIDAY_PACKAGING_ENABLED` or `FRIDAY_MULTI_TENANT_ENABLED` default-on flips have been validated.
- That the docs-truth reconciliation pass itself produces any new product capability proof.

## 5. Audit ledger

This refresh was assembled from:

- `git log --oneline --max-count=20 origin/main` at SHA `42fac20fa5f5bfd33e23addc400d9fb98bb35ee8`.
- Per-phase completion reports under `/Users/example/Desktop/friday_vertical_closure_phase_reports_2026-05-12/`.
- `REPORTS_INDEX.csv` rows for `phase_02a`, `phase_02b`, `phase_03`, `phase_04`, `phase_05`, `phase_06`, `phase_07`, `phase_08`, `phase_09`, `phase_10`, `phase_11`, `phase_12`, `phase_13`, `phase_13_5`, `phase_13_6`, `phase_14`, `phase_14_5`, `phase_15`, `phase_16`, `phase_17`.
- Current source references for `src/packaging/persistence/friday-package-sqlite-store.ts`, `src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.ts`, `src/media-understanding/providers/friday-openai-vision-provider.ts`, and the related env gates in `src/hub/friday-hub-bootstrap.ts`.
- [`./10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md).
- [`../current-source-of-truth.md`](../current-source-of-truth.md).
- [`../release-evidence-policy.md`](../release-evidence-policy.md).
