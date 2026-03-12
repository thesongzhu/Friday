> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# OpenClaw Feature Parity Matrix（Friday 对标矩阵）

审计日期：2026-03-04（America/Los_Angeles）

状态标记：
- ✅ 可用：有代码链路 + 本次可跑测试证据
- ⚠️ 部分可用：有实现但覆盖不完整/默认未启用/缺少关键 E2E
- ❌ 不可用：未发现可执行实现

本次已执行并通过的关键验证命令：
- `npm run test -- test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts`（10/10）
- `npm run test -- test/e2e/mock/friday-mock-tool-invocations.e2e.test.ts -t "web_search tool round-trip with mock DuckDuckGo"`（1 passed）
- `npm run test -- test/e2e/mock/friday-mock-security.e2e.test.ts -t "blocks localhost in web_fetch"`（1 passed）
- `npm run test -- test/e2e/mock/friday-mock-sessions.e2e.test.ts -t "session created by agent run is visible via sessions API"`（1 passed）
- `npm run test -- test/e2e/mock/friday-mock-journeys.e2e.test.ts -t "Setup wizard journey"`（1 passed）
- `npm run test -- test/e2e/api/friday-api-workflows-routes.test.ts -t "workflow_run_timeline"`（1 passed）
- `npm run test -- test/e2e/api/friday-api-workflows-routes.test.ts -t "workflow_run_evidence_export_download"`（1 passed）
- `npm run test -- test/integration/hub/friday-hub-bootstrap-integration.test.ts -t "loads setup wizard channel config when explicit channels are not provided"`（1 passed）

## A. Skill 注册/发现/加载
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构（input/output schema） | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Skill 目录根解析 | `src/skills/registry/friday-skill-discovery.ts` | `resolveFridaySkillDiscoveryRoots(settings)` | `FridaySkillRegistrySettings -> FridaySkillDiscoveryRoot[]` | fs, homedir, workspace dir | ✅ | 解析 root 优先级与来源：`friday-skill-discovery.ts:19-75` |
| Skill 候选扫描 | `src/skills/registry/friday-skill-discovery.ts` | `discoverFridaySkillCandidates(roots)` | `FridaySkillDiscoveryRoot[] -> FridayDiscoveredSkillCandidate[]` | fs/readdir/stat | ✅ | 目录/子目录检测：`friday-skill-discovery.ts:86-123` |
| Manifest 优先 + SKILL.md fallback 加载 | `src/skills/manifest/friday-skill-package-loader.ts` | `loadFridaySkillPackage(options)` | `LoadFridaySkillPackageOptions -> LoadFridaySkillPackageResult` | fs/path | ✅ | 加载策略与 fallback：`friday-skill-package-loader.ts:29-93` |
| 注册表刷新、查询、热重载 | `src/skills/registry/friday-skill-registry.ts` | `initialize() / refresh() / list() / reload()` | `FridayRegisteredSkill`, `SkillManifestV2` | fs + config/memory state | ✅ | 注册表主流程：`friday-skill-registry.ts:27-233` |
| 用户可见技能列表 API | `src/api/http/routes/friday-skill-routes.ts` | `GET /v1/skills` (`createFridaySkillRoutes`) | 输出 `items[{id,name,version,status,tags}]` | auth scope `hub.admin` | ✅ | 路由定义：`friday-skill-routes.ts:18-40`；E2E：`friday-openclaw-parity-closure.e2e.test.ts:491-523` |
| Watch 模式文件监听 | `src/skills/registry/friday-skill-registry.ts` | `startWatching()` | watch targets derived from declared files | fs watcher | ⚠️ | 有实现：`friday-skill-registry.ts:248-260`；本次未跑独立热重载 E2E |

## B. Workflow 编排/解析/运行
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Workflow run API（start/get/nodes/timeline/cancel/retry/resume） | `src/api/http/routes/friday-workflow-run-routes.ts` | `/v1/workflow-runs*` | `FridayStartRunRequest`, `FridayGetRunTimelineResponse` 等 | DB, auth scopes | ✅ | 路由集合：`friday-workflow-run-routes.ts:94-240`；E2E timeline：`friday-api-workflows-routes.test.ts` |
| Graph 解析与执行计划构建 | `src/workflows/services/friday-workflow-execution-service.ts` | `createFridayWorkflowExecutionService()` -> `startRun()` | `parseGraphJson`, `FridayWorkflowExecutionPlan` | DB, DAG scheduler, node executor | ✅ | 解析/执行依赖：`friday-workflow-execution-service.ts:13-17,151-159,926-934` |
| 运行态恢复/取消/重试/超时清扫 | `src/workflows/services/friday-workflow-execution-service.ts` | `resumeRun/cancelRun/retryRun/sweepTimedOutRuns/sweepTimedOutNodes` | `FridayWorkflowRunEntity`, `FridayWorkflowRunNodeEntity` | DB, abort controller | ✅ | 核心函数：`friday-workflow-execution-service.ts:961-1364` |
| 异步执行异常可定位（不再吞异常） | `src/workflows/services/friday-workflow-execution-service.ts` | `executeRun(plan).catch(...)` 分支 | 结构化日志 error code | console logs | ✅ | 新增 `E-WF-RUN-ASYNC-001..004`：`friday-workflow-execution-service.ts:934-944,1056-1061,1183-1188,1238-1242` |
| Evidence 导出/下载 | `src/workflows/runtime/friday-workflow-runtime.ts` | `exportRunEvidence/getRunEvidenceExport/downloadRunEvidenceExport` | `FridayWorkflowRunEvidenceExportRecord` | fs artifact dir + DB tables | ✅ | 实现：`friday-workflow-runtime.ts:1606-1763`；API E2E：`test/e2e/api/friday-api-workflows-routes.test.ts` 用例 `workflow_run_evidence_export_download` |

## C. Tool 调用路由（LLM -> executor）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Agent run API 入口 | `src/api/http/routes/friday-agent-routes.ts` | `POST /v1/agent/runs` | `task/providerId/model/timeoutMs/constraints` | auth, provider runtime | ✅ | 校验与转发：`friday-agent-routes.ts:79-161` |
| Tool registry 装配 | `src/agent/tools/friday-agent-tool-registry.ts` | `createFridayAgentToolRegistry(options)` | `FridayAgentToolDefinition[]` | exec/fs/web/browser/skills/workflows/memory/channels | ✅ | 工具集合：`friday-agent-tool-registry.ts:97-239` |
| Runtime tool loop 与边界执行 | `src/agent/runtime/friday-agent-runtime.ts` | `executeRun()` -> `executeToolCall()` | `FridayAgentToolUseBlock`, `FridayAgentToolCallRecord` | provider API, tool executors | ✅ | 调用链：`friday-agent-runtime.ts:148-186,626-645,1393-1495` |
| 工具产物提取为用户可见 images | `src/agent/runtime/friday-agent-runtime.ts` | `extractImagePathsFromToolCalls()` | `tool result JSON -> images[]` | browser/canvas artifacts | ✅ | 图像提取：`friday-agent-runtime.ts:1047-1067`；E2E：`friday-openclaw-parity-closure.e2e.test.ts:526-567` |
| SSE 运行态事件 | `src/api/http/routes/friday-agent-routes.ts` | `GET /v1/agent/runs/:runId/events` | SSE frames `agent.run.*` | event emitter | ⚠️ | 实现存在：`friday-agent-routes.ts:241-339`；本次未跑 SSE 专项 E2E |

## D. 权限/安全（allowlist、sandbox、env、文件/网络访问）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Channel allowlist | `src/channels/friday-channel-registry.ts` | `checkAllowlist(msg, allowlist)` | `allowedUsers/allowedChats` | channel inbound events | ✅ | 过滤逻辑：`friday-channel-registry.ts:106-121,131-163` |
| Channel secrets/ref policy | `src/channels/friday-channel-security.ts` | `parseFridayEnvSecretRef/buildFridayChannelSecretRef` | secret ref、field descriptors | env/config | ✅ | secret policy + capability matrix：`friday-channel-security.ts:25-242` |
| SSRF 防护（每跳 redirect 校验） | `src/agent/security/friday-agent-fetch-guard.ts` | `fetchWithFridayAgentSsrfGuard()` | `FridayGuardedFetchParams` | DNS/fetch | ✅ | 重定向 hop 校验：`friday-agent-fetch-guard.ts:41-109`；E2E：`friday-mock-security.e2e.test.ts` |
| SSRF IP/host 拦截 + DNS pinning | `src/agent/security/friday-agent-ssrf-guard.ts` | `createFridayAgentSsrfGuard()` | `FridaySsrfPolicy` | dns.lookup/resolve | ✅ | 校验逻辑：`friday-agent-ssrf-guard.ts:492-568` |
| Exec tool sandbox + metachar 限制 | `src/agent/tools/friday-agent-exec-tool.ts` | `createFridayAgentExecTool().execute()` | `command/workdir/env/timeoutMs` | spawn/fs/path | ✅ | 工作目录约束 + shell 字符拦截：`friday-agent-exec-tool.ts:77-113,118-139` |
| ReadOnly 约束拦截 mutating tool | `src/agent/runtime/friday-agent-runtime.ts` | `isReadOnly && isMutatingToolCall` | runtime constraints | tool routing | ✅ | 拦截分支：`friday-agent-runtime.ts:585-624` |

## E. 运行时（state、queue、并发、重试、超时、取消）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| SQLite 状态层（读写事务） | `src/state/sqlite/friday-sqlite-layer.ts` | `createFridaySqliteLayer()` | `withWriteTransaction/withReadConnection` | better-sqlite3 | ✅ | 事务层：`friday-sqlite-layer.ts:12-55` |
| Job scheduler（超时/回补/退避） | `src/jobs/scheduler/friday-job-scheduler-service.ts`, `src/hub/friday-hub-bootstrap.ts` | `createFridayJobSchedulerService()` + automation scheduler bridge | `FridayScheduledJobDefinition`, schedule kinds | timers + repository + agent runtime | ✅ | run loop/catch-up/backoff：`friday-job-scheduler-service.ts:51-308`；bridge + failed-status throw：`friday-hub-bootstrap.ts:1691-1746`；E2E：`friday-openclaw-parity-closure.e2e.test.ts:641-756` |
| Session 生命周期 + message append | `src/sessions/services/friday-session-service.ts` | `createSession/getOrCreateSession/addMessage` | `FridaySessionRecord`, `FridaySessionMessageRecord` | DB | ✅ | 核心流程：`friday-session-service.ts:40-320`；E2E：`friday-mock-sessions.e2e.test.ts` |
| Workflow 运行态取消/重试/清扫 | `src/workflows/services/friday-workflow-execution-service.ts` | `cancelRun/retryRun/sweepTimedOut*` | run/node status machine | DB + abort | ✅ | `friday-workflow-execution-service.ts:1059-1364` |

## F. 观测与日志（structured logs、trace、evidence、错误分类）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Instrumentation bridge | `src/observability/engine/friday-observability-instrumentation-bridge.ts` | `createObservabilityInstrumentationBridge()` | `InstrumentationEvent`, metric map | metrics/span backend | ✅ | 事件采样+计量：`friday-observability-instrumentation-bridge.ts:230-363` |
| Observability HTTP routes | `src/api/http/routes/friday-observability-routes.ts` | `/v1/observability/*` | traces/audit/slo/alerts schema | observability deps | ⚠️ | 路由实现：`friday-observability-routes.ts:68-247` |
| 默认 hub 注册行为 | `src/api/runtime/friday-api-runtime.ts`, `src/hub/friday-hub-bootstrap.ts` | `createFridayApiRuntime(...)` | `deps.observability` optional | runtime wiring | ⚠️ | 仅在 deps.observability 存在时注册：`friday-api-runtime.ts:1021-1026`；hub 未传入：`friday-hub-bootstrap.ts:1300-1350` |
| 未启用 observability 的用户提示 | `src/api/http/friday-http-server.ts` | 404 fallback message | `NOT_FOUND` + readable message | HTTP server | ✅ | 新增提示：`friday-http-server.ts:397-399,458-467`；E2E：`friday-openclaw-parity-closure.e2e.test.ts:770-782` |
| 关键执行链错误码日志 | `src/hub/friday-hub-bootstrap.ts`, `src/agent/runtime/friday-agent-runtime.ts`, `src/workflows/services/friday-workflow-execution-service.ts` | channel/agent/workflow catch 分支 | error code strings | console logs | ✅ | `E-CH-*`,`W-CH-*`,`W-AG-*`,`E-WF-*`：见相应文件行号 |

## G. 输出交付（Discord/CLI/Web）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Webchat WS 升级与消息处理 | `src/api/http/friday-http-server.ts`, `src/channels/webchat/webchat-service.ts` | `server.on("upgrade")` -> `handleUpgrade` | WS frame JSON | raw socket/WebSocket protocol | ✅ | 升级路由：`friday-http-server.ts:847-865`; 服务：`webchat-service.ts:201-367` |
| Webchat channel 适配器 | `src/channels/webchat/friday-webchat-channel.ts` | `normalizeWebchatMessage`, outbound `sendToClient` | `FridayChannelMessage` / `WebchatOutboundMessage` | ws service | ✅ | inbound/outbound：`friday-webchat-channel.ts:31-47,82-97` |
| Channel 到 agent 再回传用户 | `src/hub/friday-hub-bootstrap.ts` | `channelMessageHandler` | `FridayChannelMessage -> executeRun -> send` | session service, channel registry | ✅ | 终态必回传、失败回传、图像回传：`friday-hub-bootstrap.ts:1984-2125` |
| Discord outbound 文件/图片交付 | `src/channels/discord/friday-discord-channel.ts`, `src/hub/friday-hub-bootstrap.ts` | inbound `MESSAGE_CREATE` -> `channelMessageHandler` -> outbound adapter `send(options)` | text + embeds + file attachments | Discord Gateway/REST（mock transport） | ✅ | outbound 实现：`friday-discord-channel.ts:194-240`；hub 回传链路：`friday-hub-bootstrap.ts:1984-2125`；E2E：`friday-openclaw-parity-closure.e2e.test.ts:905-1010` |
| CLI 交付边界（HTTP server + shutdown） | `src/cli/friday-cli-run-loop.ts` | `runFridayCliLoop()` | CLI args -> HTTP listener | Node process/signals | ✅ | 启停链路：`friday-cli-run-loop.ts:28-80` |

## H. 配置与部署（本地/服务器/容器、headless browser、依赖检查）
| 能力点 | Friday 模块/文件 | 入口函数/命令 | 关键数据结构 | 外部依赖 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| Setup 状态与 provider detect | `src/api/http/routes/friday-setup-routes.ts` | `GET /v1/setup/status`, `POST /v1/providers/detect` | `SetupStatusResponse`, `DetectProviderResponse` | provider endpoints/network | ✅ | 路由与校验：`friday-setup-routes.ts:380-437,440-598`；E2E失败场景：`friday-openclaw-parity-closure.e2e.test.ts:752-767` |
| Health/能力探针 | `src/api/http/routes/friday-health-routes.ts` | `GET /v1/health` | `status/version/uptime/capabilities` | none | ✅ | `friday-health-routes.ts:34-75` |
| Hub 引导配置注入 | `src/hub/friday-hub-bootstrap.ts` | `createFridayHub(...)` bootstrap | apiRuntime deps + enabled channels | DB/provider/channels/browser | ✅ | 关键注入：`friday-hub-bootstrap.ts:1300-1350`；集成验证：`friday-hub-bootstrap-integration.test.ts` |
| Browser manager（Playwright/headless/CDP） | `src/browser/friday-browser-manager.ts` | `createFridayBrowserManager()` | `CreateFridayBrowserManagerOptions` | Playwright Chromium/Chrome CDP | ✅ | 依赖与连接逻辑：`friday-browser-manager.ts:1,16-43,276-294,404-430`；artifact E2E：`friday-openclaw-parity-closure.e2e.test.ts:436-477` |
| 默认 observability 依赖注入 | `src/hub/friday-hub-bootstrap.ts` | `createFridayApiRuntime` deps | `observability?: FridayObservabilityRoutesDeps` | observability runtime | ⚠️ | 默认未注入，需显式 wiring：`friday-hub-bootstrap.ts:1300-1350` |
