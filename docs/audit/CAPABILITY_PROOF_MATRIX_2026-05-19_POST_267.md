# Friday Capability Proof Matrix - 2026-05-19 post-#267 public v1 local refresh

This file is a dated post-#267 ledger refresh for current `origin/main`.
It supersedes [`CAPABILITY_PROOF_MATRIX_2026-05-17_POST_243.md`](CAPABILITY_PROOF_MATRIX_2026-05-17_POST_243.md) for public v1 local claim reading, but does not rewrite earlier historical snapshots.

This is not a full repo line-by-line audit and it is not product release proof by itself. It is a Phase 19 release-proof-debt reconciliation snapshot built from the Phase 18B-H issue ledgers under `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/`, the Phase 18A completion report, the public v1 workflow package under `/Users/jarvis/Desktop/friday_public_v1_workflow_2026-05-18/`, and the live source under `docs/` and `validation/real-world/`. The authoritative product surface remains [`../current-source-of-truth.md`](../current-source-of-truth.md) and the authoritative evidence taxonomy remains [`../release-evidence-policy.md`](../release-evidence-policy.md).

## 1. Snapshot Anchor

| Field | Value |
|---|---|
| Snapshot date (UTC) | 2026-05-19 |
| `origin/main` SHA | `be7d31d4b8651c41494770e8e562cd2bd35c20d8` |
| Most recent merge | [#267 - Phase 18H Product Truth / Package Hygiene](https://github.com/thesongzhu/Friday/pull/267) |
| Predecessor snapshot | [`CAPABILITY_PROOF_MATRIX_2026-05-17_POST_243.md`](CAPABILITY_PROOF_MATRIX_2026-05-17_POST_243.md), anchored at `42fac20fa5f5bfd33e23addc400d9fb98bb35ee8` |
| Public v1 local track | Local UI + operator + non-technical independent-use readiness, with release-facing claims limited to current proof |
| Explicit non-claims | Channel/cloud live proof, external OTEL/Grafana proof, three-cloud certification, PR #244 channel proof, release-complete-all |

## 2. How This Snapshot Is Built

Workflow `success` alone is plumbing-tier. Only a `real-green-gate-result.json` artifact with `status: passed` for the same head SHA, nonzero scenarios, all scenarios passed, and empty blockers is release-proof eligible. `blocked_by_env`, wrong SHA, missing artifacts, mock-only output, and stale output are not pass.

Phase 18A-H PR-head RGG artifacts provide merge-hygiene and same-SHA proof for their shipped slices. They do not by themselves prove the Phase 18A live UI/LLM acknowledgement + SSE tail, which remains `blocked_by_env` until a safe provider environment is available. They also do not turn explicit non-claims into release-complete channel/cloud/external-observability proof.

## 3. Public V1 Local Phase Ledger

| Phase | PR | Merge SHA | RGG Truth | Issue Closure | Status / Notes |
|---|---|---|---|---|---|
| 18A Verified Golden Path + Baseline Guard | #247 | `9f2e71f5` | same-SHA PR-head `status=passed`, scenarios `82/82/82`, blockers `[]` | 11 mapped issues dispositioned in Phase 18A report | Public v1 non-claims preserved: no release-ready, no channel control, no cloud live certification, no PR #244 mutation, no release-complete-all claim. Live UI/LLM acknowledgement + SSE tail remains `blocked_by_env` and is not closed by this matrix. |
| 18B Safety / False Success / Secret / Data-loss Closure | #248-#259 | `b28a399f` | latest closure PR #259 same-SHA `status=passed`, scenarios `82/82/82`, blockers `[]` | 29/29 terminal | Public-v1-reachable safety, false-success, secret, approval replay, data-loss, and desktop/system safety blockers closed or explicitly dispositioned. |
| 18C Setup And First-Run UX | #260-#261 | `19f917ff` | latest closure PR #261 same-SHA `status=passed`, scenarios `82/82`, blockers `[]` | 4/4 terminal | Setup/provider/start path issues closed; WAL setup remains fail-closed per user decision. |
| 18D Skeptical Mode / User Constitution | #262 | `3dc362e9` | same-SHA `status=passed`, scenarios `82/82/82`, blockers `[]` | 2/2 terminal | User Constitution and Skeptical Mode productized without weakening memory or approval gates. |
| 18E Frugal Mode Productization | #264 | `7a18ea4e` | same-SHA `status=passed`, scenarios `82/82`, blockers `[]` | 2/2 terminal | Frugal/Standard/Strict routing modes productized; cheaper routing cannot bypass safety/approval/provider gates. |
| 18F API / UI / SDK Contract Reconciliation | #265 | `8b8fc9c` | same-SHA `status=passed`, scenarios `82/82/82`, blockers `[]` | 8/8 terminal | Public v1 API/UI/SDK contract drift closed or honestly classified; operator client remains internal-only for public v1. |
| 18G Desktop / System Boundary | #266 | `ca78f493` | same-SHA `status=passed`, scenarios `82/82/82`, blockers `[]` | 2/2 terminal | Residual desktop/system issues closed without claiming Linux/Windows native desktop parity. |
| 18H Product Truth / Package Hygiene | #267 | `be7d31d4` | same-SHA `status=passed`, scenarios `82/82/82`, blockers `[]` | 10/10 terminal | Public v1 docs/package truth no longer overclaims channel/cloud, AGI-like positioning, release-complete-all, or local maintainer workflow as product runtime. |

## 4. Phase 19 Release-Proof Debt Reconciliation

| Issue | Classification | Evidence | Phase 19 Disposition |
|---|---|---|---|
| `P1-009` Phase 14 forwarded debt still open | `existing_covered_for_public_v1_local_track_truth` plus `future_no_claim` for external slices | Phase 18B-H close their public v1 local issues with terminal ledgers and same-SHA RGG for the shipped slices; Phase 18A preserves an honest `blocked_by_env` live UI/LLM acknowledgement + SSE tail and does not claim release-ready. Remaining historical Phase 14 debt that depends on external multi-host, channel, cloud, default-on packaging/tenant flips, or external provider/manual environments is not part of the public v1 local track. | Phase 19 closes this issue only as truth/de-scope for public v1 local claims: do not claim release-ready until the Phase 18A provider-gated tail has real proof; historical external/default-on debts stay out of scope unless a later phase claims those surfaces. |
| `P2-007` External observability / OTEL / Grafana still not closed | `future_no_claim` | `docs/current-source-of-truth.md` now states that Slack/SMTP require `external_alerts.ready` and real external proof before release-complete alert-dispatch claims, and that OTEL/Grafana external export remains future/no-claim for public v1 local. `validation/real-world/catalog/scenarios.mjs` keeps Slack/SMTP as manual external scenarios behind `external_alerts.ready`. | No external OTEL/Grafana release-complete claim is made for public v1 local. Internal observability remains active; external export remains future/no-claim. |

## 5. What This Snapshot Says

- Public v1 local track wording is bounded to local UI + operator + non-technical independent-use readiness, but release-facing claims must still honor provider/env proof gaps.
- Phase 18B-H have terminal issue dispositions and same-SHA RGG evidence for their shipped PR slices; Phase 18A preserves a provider-gated live UI/LLM acknowledgement + SSE residual as `blocked_by_env`.
- Historical Phase 14 release-proof debts that require external systems, channel/cloud environments, default-on packaging/tenant flips, or external observability are not public v1 local blockers when they are not claimed.
- Slack/SMTP external alert dispatch and OTEL/Grafana export cannot be described as release-complete until a same-SHA RGG/manual-external proof path actually runs with the required environment.

## 6. What This Snapshot Does Not Say

- It does not claim release-complete-all.
- It does not claim Discord/Lark/Telegram channel control or PR #244 closure.
- It does not claim Alibaba/Tencent/Volcengine cloud live certification.
- It does not claim external OTEL/Grafana proof.
- It does not claim the Phase 18A live UI/LLM acknowledgement + SSE tail is closed.
- It does not treat `blocked_by_env`, workflow success alone, mock-only output, or missing artifacts as pass.

## 7. Audit Ledger

This refresh was assembled from:

- `git log --oneline --max-count=30 origin/main` at SHA `be7d31d4b8651c41494770e8e562cd2bd35c20d8`.
- `/Users/jarvis/Desktop/friday_public_v1_workflow_2026-05-18/PUBLIC_V1_OFFICIAL_PHASE_MAP.md`.
- `/Users/jarvis/Desktop/friday_public_v1_workflow_2026-05-18/PUBLIC_V1_PHASE_ISSUE_MAP.csv`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18b_safety_false_success_secret_data_loss_closure.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18c_setup_first_run_ux.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18d_skeptical_mode_user_constitution.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18e_frugal_mode_productization.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18f_api_ui_sdk_contract_reconciliation.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18g_desktop_system_boundary.json`.
- `/Users/jarvis/Desktop/READ/friday-conveyor-handoffs/issue-ledger/phase_18h_product_truth_package_hygiene.json`.
- [`./10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md).
- [`../current-source-of-truth.md`](../current-source-of-truth.md).
- [`../release-evidence-policy.md`](../release-evidence-policy.md).
- `validation/real-world/catalog/scenarios.mjs`.
- `validation/real-world/lib/env-truth.mjs`.
