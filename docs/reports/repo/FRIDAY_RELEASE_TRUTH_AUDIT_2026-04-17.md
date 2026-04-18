# Friday Release Truth Audit (2026-04-17)

## Baseline

- Release truth baseline: README, docs/current-source-of-truth.md, live runtime, UI router, and current public route contract.
- Base URL: http://127.0.0.1:3191
- Verdict: **shipable with explicit de-scope**

## Runtime Snapshot

| Surface | Evidence |
| --- | --- |
| /v1/health | status=200 latestness=provider_backed |
| /v1/setup/status | providerCount=1 |
| /v1/skills | installed=57 |
| /v1/skills/catalog | catalog=0 |
| /v1/marketplace/sources | sources=0 |
| /v1/marketplace/assets | assets=0 |
| /v1/plugins | status=200 |
| /v1/heartbeat/status | status=200 |
| /v1/packages | status=404 |
| /v1/security/tenants | status=404 |

## Evidence Taxonomy

- Script counts: `{"mock-contract":98,"real-provider":6,"real-runtime":4,"cloud-live":2,"browser-mock-hub":1,"mock-hub":2,"real-browser":1}`
- Test counts: `{"mock-hub":11,"mock-contract":745,"real-runtime":12,"real-provider":17,"cloud-live":1,"manual-external":5,"real-browser":4}`

## Claim Matrix

| Surface | Claim | Real evidence | Status |
| --- | --- | --- | --- |
| README.md badge | README top-level trust signals are evidence-driven rather than 10,000+ test-count proof. | README uses a Release Truth badge and no longer presents 10,000+ tests as ship proof. | aligned |
| release:verify | release:verify is reserved for live release proof and does not route through repo-only mock gates. | release:verify -> npm run release:proof:real | aligned |
| Search freshness truth | Search freshness has live proof, while /v1/health remains a runtime capability snapshot. | /v1/health reports capabilities.search.latestness=provider_backed; docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md separately proves dated live MCP search results. | aligned |
| Skills inventory vs marketplace | Skills catalog and marketplace sources are currently populated and ready for public browsing. | /v1/skills=57, /v1/skills/catalog=0, /v1/marketplace/sources=0, /v1/marketplace/assets=0. | bounded |
| Plugin distribution | Plugin lifecycle is a first-class user-facing UI surface. | /v1/plugins status=200; router has /plugins=true. | aligned |
| Usage page | Usage reflects provider billing truth. | usage-page.tsx explicitly labels token/cost figures as runtime usage, not billing truth. | aligned |
| MCP page | An empty MCP page means Friday is broken. | mcp-page.tsx explicitly models empty MCP as a configuration state. | aligned |
| docs/current-source-of-truth.md | Current docs distinguish runtime snapshot from product promise. | current-source-of-truth includes runtime snapshot / release truth language. | aligned |

## Defect Ledger

| Surface | Severity | Release impact | Verification |
| --- | --- | --- | --- |
| provider routing | P0 | Closed in branch. Keep the isolated real-runtime proof and regression coverage in the release pack. | npx vitest run test/unit/providers/services/friday-provider-service.test.ts + docs/reports/repo/FRIDAY_PROVIDER_SHAPE_RUNTIME_PROOF_2026-04-15.md |
| release proof lane | P1 | Closed in branch. Keep repo-ready and real-proof lanes separate in docs, CI, and release notes. | node scripts/quality/run-release-truth-audit.mjs |
| README and public messaging | P1 | Closed for this branch snapshot, but remains a process risk that needs continuous review. | Manual doc audit plus node scripts/quality/run-release-truth-audit.mjs |
| search latestness | P2 | Closed for live proof. Keep `/v1/health` framed as capability state and reserve stronger claims for the proof pack. | GET /v1/health plus latest final proof-pack MCP dated-query evidence. |
| plugin distribution | P2 | Closed for routed UI availability. Keep operator-only install and marketplace boundaries explicit in UI copy. | Route census plus live /v1/plugins response check |

## Code-Only / Bounded

| Category | Surface | Evidence |
| --- | --- | --- |
| bounded-empty | marketplace catalog | installedSkills=57, catalogSkills=0, sources=0, marketplaceAssets=0. |
| unused-ui-file | unrouted ui route modules | none |

## Mock Contamination Signals

- none in the scanned proof inputs

## Repo-Only Mock Signals

- test/e2e/ui/_helpers/browser-env-mock.ts: createMockHubEnv
- test/e2e/ui/_helpers/browser-env-mock.ts: localStorage.setItem

## 3-Day Report Reality Check

| Claim | Classification | Evidence |
| --- | --- | --- |
| release:verify 现在代表真实发布证明，而不是 repo-only/mock 结果。 | verified | package.json release:verify -> npm run release:proof:real |
| 10,016 tests passing 可以直接当作发布证明。 | de-scoped | Mock-contract, mock-hub, and browser-mock-hub evidence are retained for regression speed, but they are excluded from release proof. |
| 公开 heartbeat 路由是 /v1/observability/heartbeat/status。 | de-scoped | /v1/heartbeat/status -> 200; legacy /v1/observability/heartbeat/status -> 404. |
| attach-cli 的 gemini 目标已经彻底移除。 | verified | CLI help and auth validation only allow attach-cli codex|claude. |
| 频道 persona 读写已真实可用。 | verified | write=200, read=200, clear=200. |
| Channels 已进入真实可进入的 UI/operator surface。 | verified | /v1/channels status=200; router /channels=true. |
| Plugins 已进入真实可进入的 UI/operator surface。 | verified | /v1/plugins status=200; router /plugins=true. |
| 技能目录、source、marketplace assets 已达到可公开浏览状态。 | partially verified | /v1/skills=57, /v1/skills/catalog=0, /v1/marketplace/sources=0, /v1/marketplace/assets=0. |
| /v1/skills/:skillId/run 已真实连通到 executed 深度，但这不等于独立验证过的最终产物。 | partially verified | skillId=ai-inference, probeKind=built-in, status=200, returnedStatus=completed, completionDepth=executed. |
| /v1/memory/items 的真实写入/读取/删除链路已打通。 | verified | create=200, read=200, delete=200. |
| /v1/packages/* 现在默认就是当前 runtime 的公开能力。 | blocked-by-env | /v1/packages status=404; current runtime only wires packaging when FRIDAY_PACKAGING_ENABLED=true. |
| 多租户 runtime surface 当前已经默认可用。 | blocked-by-env | /v1/security/tenants status=404; current runtime only wires tenant routes when FRIDAY_MULTI_TENANT_ENABLED=true. |
| media-understanding 当前 runtime 已默认可用。 | blocked-by-env | Hub bootstrap only wires media-understanding behind FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true; current runtime proof pack has not exercised a live enabled lane. |
| 桌面能力现在已经达到默认可发布的 ready 状态。 | blocked-by-env | /v1/health system.healthStatus=degraded, companionReadiness=degraded. |
| 当前 runtime 的 search freshness 已经被真实验证。 | verified | /v1/health capabilities.search.latestness=provider_backed; docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md also contains a live MCP dated-query proof with time-bounded results. |
| 自我修复闭环已经被真实打通到 execute/verify/rollback。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md contains live execute + verify + rollback evidence for model fallback self-healing plus separate lesson write/readback proof. |
| compaction 已经被真实证明会触发、写入 memory，并被后续 run 读回。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md contains live compaction trigger, SQLite writeback, memory row persistence, and reset-session readback evidence. |
| autonomous persistence 已被真实证明可跨重启恢复；`exact content` deterministic file verification 只在独立 live restart 子链、SQLite/helper provenance、最终文件产物三者一致时计入 verified。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-17.md contains live interrupted_recoverable -> restart -> resume_goal -> same-step completion evidence backed by SQLite readback, plus a dedicated planning-interruption `exact content` lane with `verificationMethod=deterministic_file` and a persisted `content*` pattern family. |

## Artifacts

- Audit JSON: `docs/reports/repo/FRIDAY_RELEASE_TRUTH_AUDIT_2026-04-17.json`
- Defect ledger JSON: `docs/reports/repo/FRIDAY_DEFECT_LEDGER_2026-04-17.json`
- Claim matrix JSON: `docs/reports/repo/FRIDAY_CLAIM_MATRIX_2026-04-17.json`
- Code-only audit JSON: `docs/reports/repo/FRIDAY_UNUSED_CODE_AUDIT_2026-04-17.json`
- 3-day reality check JSON: `docs/reports/repo/FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.json`
- 3-day reality check MD: `docs/reports/repo/FRIDAY_3DAY_CHANGE_REALITY_CHECK_2026-04-17.md`
