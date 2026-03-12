> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# ENABLEMENT_MAP

## 扫描范围与方法

已执行全仓扫描（`src/`, `scripts/`, `README.md`, `docs/`, `test/`）并建立开关索引，使用命令：

```bash
rg -n "ENABLE|ENABLED|DISABLE|DISABLED|FEATURE_FLAG|FLAG|capability|gate|guard|allowlist|permission|desktop|browser|playwright|puppeteer|discord|webhook|upload|attachment|tool registry|tool router|executor" src scripts docs README.md test
rg -n "process\.env\.(FRIDAY_[A-Z0-9_]+|NODE_ENV)|process\.env\[['\"](FRIDAY_[A-Z0-9_]+|NODE_ENV)['\"]\]" src scripts
rg -n "FRIDAY_[A-Z0-9_]+" src
```

运行时快照（本机 `com.friday.hub` 重启后）：见 `reports/enablement/runtime-env-snapshot.log`。

## 开关索引

| 名称 | 类型 | 默认值（未设置时） | 影响范围 | 入口触发点 | 当前状态 | 证据 |
|---|---|---|---|---|---|---|
| `FRIDAY_DESKTOP_ENABLED` | env/feature-flag | `false`（仅 `"true"` 启用） | Desktop runtime + `desktop` tool 是否注册 | hub 启动时解析 capability gates | `true`（已启用） | `src/hub/bootstrap/friday-capability-gates.ts:23`, `src/hub/friday-hub-bootstrap.ts:738`, `reports/enablement/runtime-env-snapshot.log` |
| `FRIDAY_DESKTOP_PRINCIPAL_ID` | env/config | `friday-desktop` | Desktop 权限/审计主体标识 | 创建 desktop session manager | 未设置（走默认） | `src/hub/friday-hub-bootstrap.ts:744` |
| `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS` | env/config | workspace root | Desktop `file_operation` 沙箱根目录 | `parseDesktopSandboxAllowedRoots` | `.` | `src/hub/bootstrap/hub-helpers.ts:209`, `src/hub/friday-hub-bootstrap.ts:746`, `reports/enablement/runtime-env-snapshot.log` |
| `FRIDAY_BROWSER_HEADLESS` | env/feature-flag | `true`（仅 `"false"` 关闭） | Browser tool 运行模式（有/无头） | 创建 browser manager | `true`（当前显式启用） | `src/hub/friday-hub-bootstrap.ts:724`, `reports/enablement/runtime-env-snapshot.log` |
| `FRIDAY_BROWSER_USE_HOST_CHROME` | env/feature-flag | `false` | 是否连接/拉起宿主 Chrome CDP | browser host config 解析 | `false`（稳定模式） | `src/hub/bootstrap/hub-helpers.ts:165`, `reports/enablement/runtime-env-snapshot.log` |
| `FRIDAY_BROWSER_WS_ENDPOINT` | env/config | 未启用 | 指定 CDP WS endpoint | browser host config 解析 | 未设置 | `src/hub/bootstrap/hub-helpers.ts:163` |
| `FRIDAY_BROWSER_LAUNCH_ARGS` | env/config | 未启用 | 浏览器额外启动参数 | browser host config 解析 | 未设置 | `src/hub/bootstrap/hub-helpers.ts:164-188` |
| `FRIDAY_BROWSER_CDP_PORT` | env/config | `9222`（host chrome 路径） | host Chrome CDP 端口 | browser host config 解析 | 未设置（默认） | `src/hub/bootstrap/hub-helpers.ts:166-168`, `src/browser/friday-browser-manager.ts:170` |
| `FRIDAY_BROWSER_CHROME_PATH` | env/config | 自动探测（macOS） | host Chrome 可执行路径 | browser host config + browser manager | 未设置（自动探测） | `src/hub/bootstrap/hub-helpers.ts:169`, `src/browser/friday-browser-manager.ts:178-198` |
| `FRIDAY_MCP_SERVERS` | env/feature-flag | 空数组（禁用） | `mcp` tool 是否注册 | MCP env 解析 + registry 条件注册 | 已启用（1 server） | `src/agent/mcp/friday-mcp-adapter.ts:79-94`, `src/hub/friday-hub-bootstrap.ts:796-801`, `reports/enablement/runtime-env-snapshot.log`, `reports/enablement/launchd-stdout-fresh.log` |
| `FRIDAY_CHANNELS_JSON` | env/config | 从 setup state/legacy 配置读取 | Channel transport 是否加载及实例清单 | CLI 启动配置解析 | 已显式设置（Discord + env ref） | `src/cli/friday-cli.ts:557-606`, `.env`, `reports/enablement/check-enablement-gaps.log` |
| `FRIDAY_CHANNEL_SECRET_POLICY` | env/feature-flag | `strict` | 明文渠道 secret 是否允许 | channel secret policy 解析 | `strict`（已启用） | `src/channels/friday-channel-security.ts:125-132`, `reports/enablement/runtime-env-snapshot.log`, `reports/enablement/check-enablement-gaps.log` |
| `FRIDAY_CHANNEL_DEBOUNCE_MS` | env/config | `0` | 入站消息去抖窗口 | channel handler 包装 | 未设置（关闭） | `src/hub/friday-hub-bootstrap.ts:2251` |
| `FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED` | env/feature-flag | `false` | 跨渠道身份映射是否启用 | hub 启动时读取 | 未设置（关闭） | `src/hub/friday-hub-bootstrap.ts:392` |
| `FRIDAY_CHANNEL_IDENTITY_MAP` | env/config | 空映射 | 跨渠道 user 映射关系 | hub 启动时解析 | 未设置 | `src/hub/friday-hub-bootstrap.ts:393` |
| `FRIDAY_PIPELINE_ENABLE` | env/feature-flag | `true` | workflow deterministic pipeline 总开关 | pipeline runtime config 解析 | 未设置（启用） | `src/workflows/engine/friday-workflow-pipeline-mode.ts:30-39,63` |
| `FRIDAY_PIPELINE_MODE` | env/config | `enforce` | pipeline 模式（`shadow`/`warn`/`enforce`） | pipeline runtime config 解析 | 未设置（`enforce`） | `src/workflows/engine/friday-workflow-pipeline-mode.ts:41-56,64` |
| `FRIDAY_USE_NODE_RUNNER` | env/feature-flag | `true`（在 pipeline enabled 下） | workflow node runner 是否替代 legacy executor | workflow runtime 构建 | 未设置（启用） | `src/workflows/runtime/friday-workflow-runtime.ts:586` |
| `FRIDAY_PLAYBOOK_AUTO_LEARN` | env/feature-flag | `true` | playbook learning/promotion 是否启用 | workflow runtime 构建 | 未设置（启用） | `src/workflows/runtime/friday-workflow-runtime.ts:705` |
| `FRIDAY_MARKETPLACE_COMMERCE_ENABLED` | env/feature-flag | `true` | Marketplace commerce persistence 是否启用 | hub capability gates | 未设置（启用） | `src/hub/bootstrap/friday-capability-gates.ts:24`, `src/hub/friday-hub-bootstrap.ts:1187` |
| `FRIDAY_MARKETPLACE_INSTALL_REQUIRED` | env/feature-flag | `true` | Marketplace 执行是否要求 installation | hub capability gates | 未设置（启用） | `src/hub/bootstrap/friday-capability-gates.ts:25`, `src/hub/friday-hub-bootstrap.ts:1188,1215` |
| `FRIDAY_MARKETPLACE_INSTALL_MATERIALIZE` | env/feature-flag | `true` | 安装后 materialize 逻辑是否执行 | hub capability gates + materializer | 未设置（启用） | `src/hub/bootstrap/friday-capability-gates.ts:26`, `src/hub/friday-hub-bootstrap.ts:1256` |
| `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED` | env/feature-flag | `true` | `agent` 资产是否允许安装 | marketplace install dispatch | 未设置（启用） | `src/api/http/routes/friday-marketplace-commerce-routes.ts:1035` |
| `FRIDAY_HEARTBEAT_ENABLED` | env/feature-flag | `false` | 主动 heartbeat job 是否注册 | hub capability gates | 未设置（禁用） | `src/hub/bootstrap/friday-capability-gates.ts:27`, `src/hub/friday-hub-bootstrap.ts:1447` |
| `FRIDAY_HEARTBEAT_ACTIVE_HOURS_ENABLED` | env/feature-flag | `true` | heartbeat active-hours 限制是否生效 | heartbeat runner config | 未设置（启用） | `src/hub/bootstrap/friday-capability-gates.ts:28`, `src/hub/friday-hub-bootstrap.ts:1480` |
| `FRIDAY_AUTOFIX_DISPATCHER_ENABLED` | env/feature-flag | `true` | auto-fix dispatcher job 是否注册 | hub capability gates | 未设置（启用） | `src/hub/bootstrap/friday-capability-gates.ts:29`, `src/hub/friday-hub-bootstrap.ts:1659` |
| `FRIDAY_RATE_LIMIT_LOOPBACK_EXEMPT` | env/feature-flag | `false` | loopback 是否跳过 auth lockout | rate limit service 默认配置 | 未设置（不豁免） | `src/api/auth/friday-rate-limit-service.ts:82` |
| `FRIDAY_ENABLE_HSTS` | env/feature-flag | `true` | HTTP 响应是否附加 HSTS | HTTP server security headers | 未设置（启用） | `src/api/http/friday-http-server.ts:70-76` |
| `FRIDAY_TOKEN_SECRET` | env/config/security-gate | 未设置时自动生成并持久化 | 登录策略（是否允许 dev passwordless）与 JWT 签名 | token secret resolve + auth policy | 已在 env 显式设置 | `src/hub/bootstrap/hub-helpers.ts:489-536`, `src/hub/friday-hub-bootstrap.ts:386-389`, `reports/enablement/runtime-env-snapshot.log` |
| `FRIDAY_MASTER_KEY` | env/config/security-gate | 未设置时自动生成 `~/.friday/master.key` | provider secret at-rest 加密可用性 | master key resolve | 未在 env 显式设置（自动文件） | `src/providers/security/friday-secret-crypto.ts:82-142` |
| `FRIDAY_SEARCH_PROVIDER` | env/config | `duckduckgo` | `web_search` provider 路由 | tool registry -> web_search tool | 未设置（duckduckgo） | `src/hub/friday-hub-bootstrap.ts:817`, `src/agent/tools/friday-agent-web-search-tool.ts:38-39` |
| `FRIDAY_SERPER_API_KEY` / `FRIDAY_TAVILY_API_KEY` | env/config | 未设置（对应 provider 不可用） | `web_search` 使用 Serper/Tavily 时鉴权 | tool registry -> web_search tool | 未设置 | `src/hub/friday-hub-bootstrap.ts:818`, `src/agent/tools/friday-agent-web-search-tool.ts:84-90` |
| `FRIDAY_PLUGIN_RUNTIME_MODE` | env/feature-flag | `full` | plugin runtime `full`/`stub` | hub config resolve + createHub | 未设置（`full`） | `src/hub/friday-hub-bootstrap.ts:286-287,395-399` |
| `FRIDAY_PORT` / `FRIDAY_STATE_DIR` / `FRIDAY_SKILLS_DIR` / `FRIDAY_CORS_ORIGINS` / `FRIDAY_LOG_REQUESTS` | env/config | `3141` / 平台默认 state dir / `skills,managed-skills` / `[]` / `true` | 基础运行参数（端口、状态目录、技能目录、CORS、请求日志） | hub config resolve | 当前主服务端口 3141；其余未显式设置走默认 | `src/hub/friday-hub-bootstrap.ts:238-303` |

## 备注

- 本次增加了统一 gate 解析模块：`src/hub/bootstrap/friday-capability-gates.ts`，用于减少 Desktop/Marketplace/Heartbeat/AutoFix gate 漂移。
- 本次修正了 Browser headless 默认行为，使其与文档一致：未设置时默认 headless 启用（`FRIDAY_BROWSER_HEADLESS !== "false"`）。
