# Friday 3-Day Change Reality Check (2026-04-17)

## Source

- Source report: `/Users/jarvis/Desktop/Friday-3天变更报告-2026-04-12至15.md`
- Source present: true
- Source major heading count: 15
- Base URL: http://127.0.0.1:3141

## Reality Matrix

| Claim ID | Report Section | Claim | Classification | Real Evidence | Verification Method |
| --- | --- | --- | --- | --- | --- |
| release-proof-lane | 发布证明 | release:verify 现在代表真实发布证明，而不是 repo-only/mock 结果。 | verified | package.json release:verify -> npm run release:proof:real | Inspect package.json and release truth taxonomy. |
| tests-as-proof | 总览 / 测试状态 | 10,016 tests passing 可以直接当作发布证明。 | de-scoped | Mock-contract, mock-hub, and browser-mock-hub evidence are retained for regression speed, but they are excluded from release proof. | README, docs/current-source-of-truth.md, package.json release:verify routing. |
| heartbeat-route | PR #130 / 新 API 端点 | 公开 heartbeat 路由是 /v1/observability/heartbeat/status。 | de-scoped | /v1/heartbeat/status -> 200; legacy /v1/observability/heartbeat/status -> 404. | Live HTTP probe plus src/api/http/routes/friday-observability-routes.ts. |
| cli-gemini-removed | PR #130 / CLI 变更 | attach-cli 的 gemini 目标已经彻底移除。 | verified | CLI help and auth validation only allow attach-cli codex|claude. | src/cli/friday-cli.ts scan. |
| channel-persona | PR #124 / Channel Persona 系统 | 频道 persona 读写已真实可用。 | verified | write=200, read=200, clear=200. | Live PUT/GET/PUT roundtrip on /v1/channels/discord/persona. |
| channels-surface | PR #124 / Channels 页面 | Channels 已进入真实可进入的 UI/operator surface。 | verified | /v1/channels status=200; router /channels=true. | Live /v1/channels plus UI route census. |
| plugins-surface | 发布准备 / Plugins | Plugins 已进入真实可进入的 UI/operator surface。 | verified | /v1/plugins status=200; router /plugins=true. | Live /v1/plugins plus UI route census. |
| skills-marketplace-readiness | 技能 / 市场 | 技能目录、source、marketplace assets 已达到可公开浏览状态。 | partially verified | /v1/skills=54, /v1/skills/catalog=0, /v1/marketplace/sources=0, /v1/marketplace/assets=0. | Live runtime inventory and marketplace probes. |
| skill-run-route | 技能执行 | /v1/skills/:skillId/run 已真实打通。 | not proven | skillId=ai-inference, probeKind=built-in, status=404, returnedStatus=n/a, completionDepth=n/a. | Live POST /v1/skills/ai-inference/run against a real provider-backed runtime. Route must return completed + executed, not dispatch-only acceptance. |
| memory-create-route | Memory 路由 | /v1/memory/items 的真实写入/读取/删除链路已打通。 | verified | create=200, read=200, delete=200. | Live POST/GET/DELETE roundtrip on /v1/memory/items. |
| packaging-runtime | PR #130 / 打包 API | /v1/packages/* 现在默认就是当前 runtime 的公开能力。 | blocked-by-env | /v1/packages status=404; current runtime only wires packaging when FRIDAY_PACKAGING_ENABLED=true. | Live GET /v1/packages plus src/hub/friday-hub-bootstrap.ts gate. |
| multi-tenant-runtime | 安全 / 多租户 | 多租户 runtime surface 当前已经默认可用。 | blocked-by-env | /v1/security/tenants status=404; current runtime only wires tenant routes when FRIDAY_MULTI_TENANT_ENABLED=true. | Live GET /v1/security/tenants plus src/hub/friday-hub-bootstrap.ts gate. |
| media-understanding-runtime | media-understanding | media-understanding 当前 runtime 已默认可用。 | blocked-by-env | Hub bootstrap only wires media-understanding behind FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true; current runtime proof pack has not exercised a live enabled lane. | src/hub/friday-hub-bootstrap.ts gate plus release-truth docs. |
| desktop-readiness | 桌面适配器 / 桌面路由 | 桌面能力现在已经达到默认可发布的 ready 状态。 | blocked-by-env | /v1/health system.healthStatus=safe_mode, companionReadiness=degraded. | Live /v1/health capability snapshot. |
| search-latestness | 搜索 | 当前 runtime 的 search freshness 已经被真实验证。 | verified | /v1/health capabilities.search.latestness=unverified; docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md also contains a live MCP dated-query proof with time-bounded results. | Live /v1/health capability snapshot plus latest final proof-pack MCP dated-query evidence. |
| self-healing-loop | 自我修复 | 自我修复闭环已经被真实打通到 execute/verify/rollback。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md contains live execute + verify + rollback evidence for model fallback self-healing plus separate lesson write/readback proof. | Latest final proof-pack live self-healing lane plus live /v1/auto-fix/actions reachability probe. |
| compaction-proof | PR #129 / 语义压缩 | compaction 已经被真实证明会触发、写入 memory，并被后续 run 读回。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md contains live compaction trigger, SQLite writeback, memory row persistence, and reset-session readback evidence. | Latest final proof-pack live compaction artifact review. |
| autonomous-persistence-proof | PR #132 / 自主引擎 SQLite 持久化 | autonomous persistence 已被真实证明可跨重启恢复。 | verified | docs/reports/repo/FRIDAY_FINAL_REAL_PROOF_PACK_2026-04-16.md contains live interrupted_recoverable -> restart -> resume_goal -> same-step completion evidence backed by SQLite readback. | Latest final proof-pack autonomous restart artifact review plus SQLite continuity checks. |
