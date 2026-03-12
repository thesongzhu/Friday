> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# REMAINING_ENABLEMENT_GAPS

## 本轮已关闭的 gaps

| 能力域 | 处理结果 | 证据 |
|---|---|---|
| MCP 未启用 | 已启用 `FRIDAY_MCP_SERVERS`（1 server） | `reports/enablement/runtime-env-snapshot.log`, `reports/enablement/launchd-stdout-fresh.log`, `reports/enablement/artifacts/mcp-list-servers-*.json` |
| Discord secret policy 兼容模式 | 已切 `FRIDAY_CHANNEL_SECRET_POLICY=strict`，并改为 env-ref 通道配置 | `reports/enablement/check-enablement-gaps.log`, `reports/enablement/runtime-env-snapshot.log` |
| 生产鉴权 secret 未显式设置 | 已配置 `FRIDAY_TOKEN_SECRET` | `reports/enablement/runtime-env-snapshot.log`, `reports/enablement/check-enablement-gaps.log` |
| Browser host CDP 不稳定 | 已切稳定模式 `FRIDAY_BROWSER_USE_HOST_CHROME=false` | `reports/enablement/runtime-env-snapshot.log`, `reports/enablement/check-enablement-gaps.log` |

## 仍未 fully enabled 的项（当前剩余）

| 能力域 | 开关/检查点 | 当前值 | 建议启用方式 | 风险 | 验证测试 |
|---|---|---|---|---|---|
| Desktop 完整控制权限 | macOS TCC 授权（Accessibility/Screen Recording/Input Monitoring/Automation） | 部分授权（adapter 仍报告 1 项 denied） | 在系统设置中给 Friday/Terminal 完整授权 | 部分动作可能失败（输入/屏幕相关） | desktop `check_permissions` + `execute` 动作 E2E |
| 主动任务（Heartbeat） | `FRIDAY_HEARTBEAT_ENABLED` | false（默认） | 若需要主动巡检再开启，并配置 active-hours | 额外 token 成本与通知噪音 | heartbeat 调度/抑制 E2E |
| 跨渠道身份统一 | `FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED` | false（默认） | 多渠道运营时开启并配置 `FRIDAY_CHANNEL_IDENTITY_MAP` | 映射错误会导致身份串线 | 多用户多渠道并发隔离 E2E |
| 高质量搜索 Provider | `FRIDAY_SEARCH_PROVIDER=serper/tavily` + API key | 未启用 | 配置 `FRIDAY_SERPER_API_KEY` 或 `FRIDAY_TAVILY_API_KEY` | 第三方成本与可用性风险 | provider 成功/失败降级 E2E |

## A-G 能力域现状

- A) Tool 总开关 + allowlist：`desktop`、`browser`、`mcp` 已启用并有闭环 E2E。
- B) Browser：稳定模式已启用（非 host CDP）；截图闭环已验证。
- C) 文件系统输出：artifact 写盘闭环已验证，desktop file_operation 仍受 sandbox root 限制。
- D) 网络访问：Discord + web provider 可用；高质量搜索 provider 取决于外部 key。
- E) Discord 交付：成功路径和 fallback 路径都已通过 E2E。
- F) 日志与 trace：`routeId/toolName/correlationId/errorCode` 在失败路径可追踪。
- G) sandbox/权限：运行时沙箱已生效；剩余主要是 OS 级权限（TCC）。

## 结论

本轮把“可由配置与代码直接收敛”的 gaps 都已处理并验证。剩余项主要是部署策略选择或 OS 权限层问题，不属于代码缺失。
