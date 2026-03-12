> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# TEST_PLAN_ENABLEMENT

## 一键执行命令（本次 enablement 验证）

```bash
npm test -- test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts -t "C/G route closure: browser screenshot produces user-visible artifact path and on-disk file|desktop enabled route closure: desktop tool executes session_info and returns user-visible response|desktop disabled failure path: model receives explicit enablement hint and tool_end logs error code|mcp enabled route closure: mcp tool lists configured servers and returns user-visible response|G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file|G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence"
```

## 测试映射

| Promise / 场景 | 测试文件 | 测试名称 | 运行命令 | 关键断言 | 产物路径 |
|---|---|---|---|---|---|
| Browser 工具执行并产出用户可见文件 | `test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts` | `C/G route closure: browser screenshot produces user-visible artifact path and on-disk file` | 同上总命令 | `toolCallCount > 0`、截图文件存在且 `size>0` | `reports/enablement/artifacts/browser-screenshot-*.png` |
| Desktop 启用后可执行并回传结果 | 同上 | `desktop enabled route closure: desktop tool executes session_info and returns user-visible response` | 同上总命令 | `desktop` tool 被调用；响应含完成文本；`tool_end.isError=false`；含 `routeId/correlationId` | `reports/enablement/artifacts/desktop-session-info-*.json` |
| Desktop 禁用时给出明确启用提示（失败路径） | 同上 | `desktop disabled failure path: model receives explicit enablement hint and tool_end logs error code` | 同上总命令 | 返回文案含 `FRIDAY_DESKTOP_ENABLED=true`；`tool_end.errorCode=AGENT_TOOL_ERROR` | `reports/enablement/artifacts/desktop-disabled-tool-result-*.txt` |
| MCP 启用后可列出 server 并回传结果 | 同上 | `mcp enabled route closure: mcp tool lists configured servers and returns user-visible response` | 同上总命令 | `mcp` tool 调用成功；tool result 含 server id/command；`tool_end.isError=false` | `reports/enablement/artifacts/mcp-list-servers-*.json` |
| Discord 入站到出站闭环（含附件） | 同上 | `G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file` | 同上总命令 | outbound message 存在；附件 byteLength > 0 | `reports/enablement/artifacts/discord-attachment-*.png` |
| Discord 主发送失败后回退重试 | 同上 | `G2 delivery failure closure: primary discord send failure retries with fallback text and traceable evidence` | 同上总命令 | 首次发送失败后 fallback 成功；用户仍收到最终可见输出；日志可追踪 | `reports/enablement/e2e-enablement-vitest.log` |

## 补充校验（enablement 必要检查）

| 检查项 | 命令 | 通过标准 | 证据 |
|---|---|---|---|
| 本机运行时 hardening | `npm run ops:harden-local-enablement` | `.env` 完成 strict + token secret + MCP + desktop 配置 | 命令输出 + `.env` |
| Desktop 依赖/权限预检 | `set -a; source .env; set +a; npm run check:desktop-runtime` | 退出码 0；平台依赖可用 | `reports/enablement/desktop-check.log` |
| Enablement gate 检查 | `npm run check:enablement-gaps` | 退出码 0；无失败项 | `reports/enablement/check-enablement-gaps.log` |
| Capability gate 单元测试 | `npm test -- test/unit/hub/bootstrap/friday-capability-gates.test.ts` | 默认值/覆盖值断言通过 | `reports/enablement/unit-enablement-vitest.log` |

## 通过门槛

- 上述 6 条 E2E 必须全部通过，且每条至少一个“用户可见闭环”证据（消息/文件/附件）。
- 任一失败均视为“未验证”，禁止下“没问题”结论。
