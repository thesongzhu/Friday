> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# DESKTOP_ENABLEMENT

## 目标

以最小改动启用 Friday Desktop Runtime，并提供可复现的依赖检查、权限检查与闭环验证步骤。

## 开关与代码入口

- 开关：`FRIDAY_DESKTOP_ENABLED`
- 类型：env / feature gate
- 解析入口：`src/hub/bootstrap/friday-capability-gates.ts`
- 生效入口：`src/hub/friday-hub-bootstrap.ts`（desktop session manager 注册）

## 启用步骤（最小改动）

1. 配置环境变量：

```bash
FRIDAY_DESKTOP_ENABLED=true
FRIDAY_DESKTOP_PRINCIPAL_ID=friday-desktop
FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS=.
```

2. 重启 Friday 进程（launchd 示例）：

```bash
launchctl kickstart -k gui/$(id -u)/com.friday.hub
```

3. 验证进程环境已生效：

```bash
PID=$(pgrep -f "dist/cli/friday-cli.js start" | head -n1)
ps eww -p "$PID" | tr ' ' '\n' | rg '^FRIDAY_(DESKTOP|BROWSER)'
```

## 依赖与权限检查

运行：

```bash
npm run check:desktop-runtime
```

当前检查结果（见 `reports/enablement/desktop-check.log`）：

- 平台：Darwin
- 命令依赖：`osascript` / `screencapture` / `base64` 均通过
- 权限提示：需要 TCC 授权（Accessibility / Screen Recording / Input Monitoring / Automation）

补充运行时 gate 检查：

```bash
npm run check:enablement-gaps
```

结果：`PASSED with 0 warning(s)`（见 `reports/enablement/check-enablement-gaps.log`）。

## 验证标准

Desktop Runtime 视为“已启用”需同时满足：

1. 运行时开关为 true（`reports/enablement/runtime-env-snapshot.log`）。
2. Hub 启动日志出现 desktop enabled 提示（`reports/enablement/launchd-stdout-fresh.log`）。
3. E2E 桌面路由测试通过并产生用户可见结果（`test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts`）。
4. 产物存在且 `size > 0`（`reports/enablement/artifacts/desktop-session-info-*.json`）。

## 安全护栏（启用后仍保留）

- Desktop 默认不开启，必须显式 `FRIDAY_DESKTOP_ENABLED=true`。
- 文件操作受 `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS` 限制。
- 工具调用失败会返回明确提示与错误码（`AGENT_TOOL_ERROR`）。
- 工具执行仍在统一超时/事件链路下，日志包含 `routeId/toolName/correlationId`。

## 故障排查

- 若回复“desktop 不可用”：检查 `FRIDAY_DESKTOP_ENABLED` 是否在实际进程中为 `true`。
- 若仅能部分动作：优先检查 macOS TCC 权限是否完整授予。
- 若浏览器联动异常：查看 `reports/enablement/launchd-stderr-tail.log` 中 CDP fallback 告警。
