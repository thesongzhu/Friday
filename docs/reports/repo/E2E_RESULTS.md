> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# E2E_RESULTS

## 执行时间

- 本轮执行时间：2026-03-04 17:43-17:45 (America/Los_Angeles)

## 执行命令与结果

### 0) 本机 enablement hardening

命令：

```bash
npm run ops:harden-local-enablement
```

结果：`PASS`

效果（已写入 `.env`）：

- `FRIDAY_CHANNEL_SECRET_POLICY=strict`
- `FRIDAY_TOKEN_SECRET` 已设置（缺失时自动生成）
- `FRIDAY_BROWSER_USE_HOST_CHROME=false`
- `FRIDAY_BROWSER_HEADLESS=true`
- `FRIDAY_DESKTOP_ENABLED=true`
- `FRIDAY_MCP_SERVERS` 已配置
- `FRIDAY_CHANNELS_JSON` 使用 `$DISCORD_BOT_TOKEN` 引用

### 1) Enablement gate 检查

命令：

```bash
npm run check:enablement-gaps
```

结果：`PASS`（0 warning）

证据：

- `reports/enablement/check-enablement-gaps.log`

### 2) Desktop 运行时依赖检查

命令：

```bash
set -a; source .env; set +a; npm run check:desktop-runtime
```

结果：`PASS`（1 warning，TCC 权限提示）

证据：

- `reports/enablement/desktop-check.log`

### 3) Enablement 相关单元测试

命令：

```bash
npm test -- test/unit/hub/bootstrap/friday-capability-gates.test.ts test/unit/agent/runtime/friday-agent-runtime.test.ts test/unit/agent/runtime/friday-agent-system-prompt-builder.test.ts
```

结果：`PASS`（52/52）

证据：

- `reports/enablement/unit-enablement-vitest.log`

### 4) 6 条关键 E2E 闭环测试

命令：

```bash
npm test -- test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts -t "C/G route closure: browser screenshot produces user-visible artifact path and on-disk file|desktop enabled route closure: desktop tool executes session_info and returns user-visible response|desktop disabled failure path: model receives explicit enablement hint and tool_end logs error code|mcp enabled route closure: mcp tool lists configured servers and returns user-visible response|G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file|G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence"
```

结果：`PASS`（6 passed, 0 failed）

证据：

- 日志：`reports/enablement/e2e-enablement-vitest.log`
- 产物：
  - `reports/enablement/artifacts/browser-screenshot-1772675092003.png`
  - `reports/enablement/artifacts/desktop-session-info-1772675092202.json`
  - `reports/enablement/artifacts/desktop-disabled-tool-result-1772675092265.txt`
  - `reports/enablement/artifacts/mcp-list-servers-1772675092324.json`
  - `reports/enablement/artifacts/discord-attachment-1772675093181-1772675092857-tab-1.png`

### 5) 运行时重启后快照与日志

命令：

```bash
launchctl kickstart -k gui/$(id -u)/com.friday.hub
```

结果：`PASS`

证据：

- 运行时 env 快照：`reports/enablement/runtime-env-snapshot.log`
- 新鲜启动日志：
  - `reports/enablement/launchd-stdout-fresh.log`
  - `reports/enablement/launchd-stderr-fresh.log`

关键日志信号（fresh）：

- `Desktop runtime enabled (...)`
- `MCP adapter enabled with 1 server(s)`
- `Started 1 channel(s): discord`
- 未出现 `Plaintext secret accepted in compat mode` 与 `Chrome CDP did not become available` 告警

## 用例结果明细（必须闭环）

| 用例 | 结果 | 用户可见闭环证据 | 错误链路证据 |
|---|---|---|---|
| Browser screenshot route | PASS | 截图文件生成且 `size>0` | `agent.run.tool_end` 链路在 e2e 日志中可追踪 |
| Desktop enabled route | PASS | 返回文本 + session_info 结果写入 artifact | `tool_end: toolName=desktop, isError=false, routeId=agent.execute.tool` |
| Desktop disabled route | PASS | 返回“未启用 + 如何启用”明确提示 | `errorCode=AGENT_TOOL_ERROR` 且带 correlation id |
| MCP enabled route | PASS | 返回 MCP server 列表并写入 artifact | `tool_end: toolName=mcp, isError=false` |
| Discord inbound/outbound route | PASS | outbound 消息 + 附件文件写盘 | Discord terminal 日志 `status=completed` |
| Discord delivery fallback route | PASS | 主发送失败后 fallback 仍可见输出 | `E-CH-OUTBOUND-001` 结构化错误日志 + correlation id |

## 结论

- 本轮“gaps 处理完成”结论由真实验证支撑：enablement hardening + unit 52/52 + E2E 6/6 + 产物证据。
- 仍未 fully enabled 的项目已在 `REMAINING_ENABLEMENT_GAPS.md` 单列，当前主要是 OS 权限与部署策略项。
