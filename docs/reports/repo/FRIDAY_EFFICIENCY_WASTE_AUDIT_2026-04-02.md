# Friday 效率与浪费专项审查

日期：2026-04-02  
环境：本地仓库 `/Users/jarvis/Projects/Friday`，时区 `America/Los_Angeles`  
范围：只审查 `token / 算力 / 时间 / 不必要功能调动` 的浪费；不做通用 UX、美术或安全评审

## 审查方法

- 真实 OpenAI live 复现：
  `FRIDAY_E2E_LIVE_OPENAI=1 FRIDAY_E2E_TARGET=local npx vitest run test/e2e/live/friday-real-journeys.e2e.test.ts`
  结果：`10/10 passed`，总时长约 `75.03s`
- 核心 E2E 复现：
  `FRIDAY_E2E_CORE=1 npx vitest run test/e2e/friday-full-e2e.test.ts test/e2e/friday-real-scenarios-e2e.test.ts`
  结果：`159 passed / 32 skipped`，总时长约 `4.66s`
- Browser E2E 复现：
  `npm run test:e2e:ui`
  结果：`5/5 passed`，总时长约 `21.36s`
- 本地 UI 空转巡检：
  逐页打开 `/chat`、`/home`、`/assistant`、`/command-center`、`/fleet`、`/marketplace`、`/automations`、`/observability`、`/skills`、`/skills/generator`、`/workflows`、`/workflows/builder`、`/settings`、`/memory`、`/setup`、`/onboarding`
- 最小真实样本：
  注册本地 OpenAI provider 后执行真实 agent run，任务仅为 `Reply with exactly OK.`

## 覆盖与阻塞

已覆盖：

- 本地可达主要 UI 路由
- 本地 agent、workflow、skills、automations、marketplace、fleet、observability、settings、memory 路径
- 真实 OpenAI 模型路径

未覆盖且记为阻塞项：

- Anthropic OAuth / token 链路：本机未配置可用凭据
- 外部消息 channel：当前环境 `Channels: 0`
- 外部 MCP server：当前环境 `MCP server count: 0`
- 云端目标：本轮按本地可复现范围审查

## 重点结论

### P0. 极小任务仍承受极高固定 prompt 开销，且 Friday 自己低估了这部分成本

确认事实：

- 真实最小样本任务 `Reply with exactly OK.` 的一次 agent run，实际 `usageInput=8460`、`usageOutput=4`、`durationMs=2438`、返回仅为 `OK.`
- 同一条 run 持久化的 `contextCostSummary` 只有：
  - `starter_skills = 2055 chars`
  - `subagents = 96 chars`
  - `totalEstimatedChars = 2151`
- `src/agent/runtime/friday-agent-runtime.ts:557-576` 的 `estimateRoutingContext()` 只按 `task + messages` 估算 `estimatedInputTokens`，完全不计入 system prompt
- `src/agent/runtime/friday-agent-runtime.ts:1138-1187` 先生成 `contextCostSummary`，随后再把 learned preferences、communication persona、disabled tools 追加到 `effectiveSystemPrompt`
- 用当前代码构造的常见 system prompt 样本，实测 `promptChars=12717`，约 `3180 tokens`；这还不包含工具 schema
- `src/agent/runtime/friday-agent-llm-client.ts:404-412` 与 `:423-458` 显示 OpenAI 请求每轮都会发送完整 `systemPrompt` 和完整 `tools` schema
- `ui/src/lib/api/types.ts:104-114` 的 `AgentContextCostSummary` 只暴露 `workspace_context / starter_skills / mcp / subagents` 四类，无法承载 system prompt、persona、learned preferences、tool schema 等固定成本

建议/推断：

- Friday 当前的“成本展示”和“路由预算”都没有覆盖真实请求的固定大头，结果是：
  - UI 上看到的 context cost 明显偏低
  - 路由器会在错误成本前提下做 provider/model 选择
  - 极小任务也被迫带上整包 prompt 与整套工具定义
- 真正需要削减的不是用户任务本身，而是固定系统上下文与工具 schema 的无差别全量注入

预估节省收益：

- 仅从已测最小样本看，真实输入 `8460 tokens` 与当前 UI 汇总 `2151 chars` 存在数量级差距；如果后续按任务剥离不必要的 system fragment 和 tools，单轮可回收的固定输入成本是“数千 tokens”级别

涉及代码：

- `src/agent/runtime/friday-agent-runtime.ts:557-576`
- `src/agent/runtime/friday-agent-runtime.ts:1138-1297`
- `src/agent/runtime/friday-agent-llm-client.ts:404-458`
- `src/hub/friday-hub-bootstrap.ts:2536-2587`
- `ui/src/lib/api/types.ts:104-114`

### P1. `/assistant` 首屏空转过重，页面一打开就拉取大量无关域数据并持续轮询

确认事实：

- 本地空转巡检中，`/assistant` 首屏未执行任何业务动作即触发 `31` 条 API 请求
- 同轮请求覆盖的域包括：
  `system`、`observability`、`uix`、`diagnosis`、`auto-fix`、`agent-loop`、`agent-runs`、`workflows`、`skills`、`automations`、`skills catalog`、`marketplace sources/assets/creators/requests`、`fleet overview/satellites/pairing`
- `ui/src/routes/assistant-page.tsx:473-635` 在组件挂载时直接注册了大量 `useQuery/useQueries`
- 其中多个查询默认持续轮询：
  - `5s`：agent runs
  - `10s`：session、state、diagnostics
  - `15s`：automations、fleet、alerts
  - `20s`：issues、incidents、learning overview、loop policy、expert mode、loop runs、workflows、skills
  - `30s`：metrics、catalog、sources、marketplace
- 空转巡检里，`/assistant` 还伴随两个 `500` console 错误；后续定位为 `diagnosis/learning/overview` 失败

建议/推断：

- `/assistant` 现在像一个“所有控制面数据一次性预热”的聚合页，而不是“按当前可见卡片和用户操作逐步取数”的 assistant-first 页面
- 当前实现更像把多个 operator 页面压到一个入口，而不是为新手或普通任务做按需装载

预估节省收益：

- 首屏可直接减少 `20+` 条无必要请求
- 后台轮询可按页面可见区与卡片展开状态进一步削减，持续降低网络、序列化、React 查询和服务端查询成本

涉及代码：

- `ui/src/routes/assistant-page.tsx:473-635`

### P1. Skill converter 检测阶段会无差别调用所有 converter，并把正常“未命中”路径打成告警

确认事实：

- `src/skills/converter/services/friday-skill-converter-registry.ts:37-45` 与 `:79-103` 在无 `formatHint` 时会遍历全部 converter 做 `detect()`
- `src/skills/converter/converters/friday-openai-gpt-action-converter.ts:244-309` 在 detect 前就会：
  - 直接尝试把 `source.uri` 当文件读
  - 目录下枚举多个 OpenAPI 常见文件名
  - JSON 解析失败告警
  - YAML 解析失败告警
- `src/skills/converter/converters/friday-n8n-node-converter.ts:65-77` 与 `:202-245` 在 detect 前也会：
  - 直接读文件
  - 目录下尝试多个候选文件
  - JSON parse 失败告警
  - `EISDIR` 告警
- 真实 OpenAI live suite 中，converter 的 `EISDIR` 告警共复现 `6` 次
- 核心 E2E 中，converter 相关告警共复现 `14` 次
- 这些告警出现时，测试整体依然通过，说明大量日志属于“负路径噪声”，不是用户真的失败

建议/推断：

- detect 阶段缺少廉价预筛选，导致 Friday 在明知源格式概率不高时仍去触发不相关 converter 的文件读取和解析
- 把“普通未命中”直接用 `console.warn` 打出来，会让真实异常被噪声淹没，并让一次导入看起来像多个模块都出错

预估节省收益：

- 每次 skill convert / import / dry-run 可减少多次无意义磁盘读取和解析尝试
- 可明显降低导入链路的 stderr 噪声与排查成本

涉及代码：

- `src/skills/converter/services/friday-skill-converter-registry.ts:37-45`
- `src/skills/converter/services/friday-skill-converter-registry.ts:79-103`
- `src/skills/converter/converters/friday-openai-gpt-action-converter.ts:244-309`
- `src/skills/converter/converters/friday-n8n-node-converter.ts:65-77`
- `src/skills/converter/converters/friday-n8n-node-converter.ts:202-245`

### P1. `diagnosis/learning/overview` 使用了错误表名，导致三个核心页面空转 500

确认事实：

- 直接请求 `GET /v1/diagnosis/learning/overview` 返回 `500 INTERNAL_ERROR`
- Browser E2E 中，`no such table: friday_error_incidents` 告警复现 `4` 次
- 本地路由空转巡检里，`/assistant`、`/observability`、`/settings` 都出现了 `500` 资源错误
- `src/learning/services/friday-self-healing-api-service.ts:857-859` 查询的是 `friday_error_incidents`
- 但 schema 与 repository 使用的是 `error_incidents`
  - `src/state/sqlite/migrations/v001-initial.ts:510-533`
  - `src/learning/persistence/friday-error-incident-repository.ts`
- `src/api/http/routes/friday-diagnosis-routes.ts:160-169` 直接把 `/v1/diagnosis/learning/overview` 暴露给页面消费

建议/推断：

- 这是明确 bug，不是“可接受的告警噪声”
- 因为该接口被 assistant、observability、settings 等页面首屏调用，所以错表名会持续放大成 UI console error 和后台查询噪声

预估节省收益：

- 去掉三类高频页面上的稳定 500
- 消除重复失败查询、浏览器 console error 和 SQLite 错误日志

涉及代码：

- `src/learning/services/friday-self-healing-api-service.ts:857-859`
- `src/api/http/routes/friday-diagnosis-routes.ts:160-169`
- `src/state/sqlite/migrations/v001-initial.ts:510-533`

### P2. 全局 `AppShell` 在多数页面上都会带来固定的 session / approvals / event-stream 成本

确认事实：

- 本地空转巡检里，多数 AppShell 页面共享同一组基础请求：
  - `GET /v1/auth/me`
  - `GET /v1/setup/status`
  - `GET /v1/uix/user-profile`
  - `GET /v1/health`
  - `GET /v1/system/session`
  - `GET /v1/auto-fix/actions`
  - `GET /v1/system/events`
- `ui/src/components/layout/app-shell.tsx:25-48` 明确在壳层执行：
  - health 轮询，`30s`
  - system session 轮询，`10s`
  - pending approvals 轮询，`15s`
  - system event stream 常驻连接
- `ui/src/hooks/use-system-events.ts:24-76` 默认启用系统事件流并自动重连
- `src/system/engine/friday-system-service.ts:1005-1019` 的 `getSession()` 每次都会调用 `companionBridge.getStatus()`
- Browser E2E 中，`system companion unavailable; continuing in degraded mode` 告警复现 `2` 次

建议/推断：

- 这些查询/流连接对深度 operator 页面是合理的，但对 `marketplace / skills / memory / workflows` 这类不依赖 companion 状态的页面，属于跨页面固定成本
- 它们还会把“companion 不可用”的降级噪声带到普通页面

预估节省收益：

- 每个壳层页面至少可减少一组固定 baseline 请求
- 可以避免在无关页面触发 companion 状态探测与对应降级日志

涉及代码：

- `ui/src/components/layout/app-shell.tsx:25-48`
- `ui/src/hooks/use-system-events.ts:24-76`
- `src/system/engine/friday-system-service.ts:1005-1019`

### P2. `observability` 页面即使只看单个 focus，也会把几乎所有分区数据全量拉取

确认事实：

- `ui/src/routes/observability-page.tsx:176-180` 解析了 `focus`
- 但同文件 `:184-294` 的主查询几乎全部无条件挂载，没有按 `focus` 做 `enabled` gating
- 本地巡检访问 `/observability?focus=alerts` 时，仍然发起了以下无关请求：
  - `GET /v1/observability/traces`
  - `GET /v1/observability/audit`
  - `GET /v1/observability/time-series`
  - `GET /v1/observability/slos`
  - `GET /v1/acceptance/tests`
  - `GET /v1/acceptance/results`
  - `GET /v1/retry/escalations`
  - `GET /v1/retry/circuit-breakers`
  - `GET /v1/retry/costs`
  - `GET /v1/rules/audit-log`
  - `GET /v1/agent-loop/runs`
  - `GET /v1/agent-loop/expert-runs`
- 同一页面还会把失败的 `GET /v1/diagnosis/learning/overview` 打两次

建议/推断：

- 这不是普通的“首屏较重”，而是明显忽略了页面自身已经定义的 `focus` 分区模型
- 结果是：即便用户只想看 alerts，也要为 traces、audit、retry、rules、acceptance、loop 等全部子域买单

预估节省收益：

- 对 `observability` 这类 operator 重页面，按 `focus` 懒加载可以直接砍掉一大半首屏请求与轮询

涉及代码：

- `ui/src/routes/observability-page.tsx:176-180`
- `ui/src/routes/observability-page.tsx:184-294`

### P2. Query key 和取数入口不统一，导致同一页面对同一接口重复请求且无法共享缓存

确认事实：

- `AppShell` 用 `systemKeys.session()` 请求 `/v1/system/session`：`ui/src/components/layout/app-shell.tsx:33-36`
- `/assistant` 又单独用 `["assistant-shell", "session"]` 请求同一路由：`ui/src/routes/assistant-page.tsx:473-476`
- 实测 `/assistant` 打开一次会产生：
  - `GET /v1/system/session = 2 次`
  - `GET /v1/auto-fix/actions = 2 次`
- `/settings` 页面也有类似问题：
  - `GET /v1/auth/me = 2 次`
  - `GET /v1/health = 2 次`
- 相关代码分别位于：
  - `ui/src/components/layout/app-shell.tsx:25-48`
  - `ui/src/routes/settings-page.tsx:63-80`
  - `ui/src/providers/auth-provider.tsx:24-44`
- `ui/src/providers/query-provider.tsx:4-10` 的全局 QueryClient 会缓存同一个 key，但这里因为 key 不统一，缓存收益被直接绕开

建议/推断：

- 当前 UI 在多个页面里把“全局状态”“页面状态”“认证自举状态”分散拉取，但没有统一 query key 或统一上游 store
- 这会让 React Query 无法去重，造成纯粹的重复网络请求与重复序列化开销

预估节省收益：

- 修正 key 与上游共享后，`/assistant`、`/settings` 这类复合页面能立刻减少重复请求
- 同时能减少后续 invalidation 范围和状态不同步问题

涉及代码：

- `ui/src/components/layout/app-shell.tsx:25-48`
- `ui/src/routes/assistant-page.tsx:473-476`
- `ui/src/routes/settings-page.tsx:63-80`
- `ui/src/providers/auth-provider.tsx:24-44`
- `ui/src/providers/query-provider.tsx:4-10`

### P2. `/assistant` 为了展示桌面应用数和窗口数，每 10 秒轮询一次高成本 `system/state` 快照

确认事实：

- `/assistant` 上 `stateQuery` 直接调用 `systemApi.getState()`，`refetchInterval = 10_000`：
  `ui/src/routes/assistant-page.tsx:479-483`
- 这个 `snapshot` 最终在 `SystemActionCard` 里只被用于显示：
  - `Desktop apps`
  - `Open windows`
  见 `ui/src/routes/assistant-page.tsx:2636-2637`
- 但 `getState()` 背后的 `buildSnapshot()` 会做的事情明显更重：
  - `companionBridge.getStatus()`
  - `captureSnapshot()`（connected 时）
  - 读取 approval rules
  - 读取 remote devices
  - 读取 remote sessions
  - 汇总 health / browser / lease
  见 `src/system/engine/friday-system-service.ts:636-703`

建议/推断：

- 这是典型的“为了两个数字拉整张大表/整块快照”
- `/assistant` 作为 beginner-first 页面，不应默认承担 operator 级的系统快照刷新成本

预估节省收益：

- 可减少 companion 状态探测、快照构建、远端会话汇总与相关 DB 读取
- 还能降低 assistant 页面上的伴生降级噪声

涉及代码：

- `ui/src/routes/assistant-page.tsx:479-483`
- `ui/src/routes/assistant-page.tsx:2636-2637`
- `src/system/engine/friday-system-service.ts:636-703`

### P3. 前端默认重试会放大失败型高成本查询

确认事实：

- 全局 QueryClient 默认 `retry: 1`：`ui/src/providers/query-provider.tsx:4-10`
- `/assistant`、`/observability` 等页面对 `learningApi.getOverview(...)` 没有显式 `retry: 0`
- 由于 `/v1/diagnosis/learning/overview` 当前稳定 500，页面实测中该请求会被打两次

建议/推断：

- 默认重试对偶发网络故障有价值，但对当前这种“确定性后端 bug”只会把失败放大成额外 CPU/IO/日志噪声
- 对高成本接口或已知稳定失败接口，应该显式关闭自动重试

预估节省收益：

- 可以减少失败接口的重复请求、重复错误日志、重复渲染和无意义等待

涉及代码：

- `ui/src/providers/query-provider.tsx:4-10`
- `ui/src/routes/assistant-page.tsx:520-523`
- `ui/src/routes/observability-page.tsx:288-291`
- `ui/src/routes/settings-page.tsx:138-141`

### P2. World model 在低价值回合上也会执行 after-turn 提取与快照更新

确认事实：

- 真实 OpenAI live suite 中，共出现 `10` 条 `world_model_*` marker
- 最小真实样本 `Reply with exactly OK.` 也触发了：
  - `world_model_episode_extracted`
  - `world_model_snapshot_saved`
  - 且 `steps=0`
- `src/hub/friday-hub-bootstrap.ts:2337-2360` 的 `agentContextEngine.afterTurn()` 在拿到 `userId` 后就尝试做 episode extract 与 world state update

建议/推断：

- 当本轮没有 tool steps、没有错误、没有纠正、没有 artifact、没有新增偏好时，这类 after-turn 学习的边际收益很低
- 当前实现对 trivial turn 没有明显门槛，导致低价值回合也在写入 world model 路径

预估节省收益：

- 可以减少 trivial run 的 DB 读写、日志 marker 和学习链路 CPU 成本
- 在高频短问短答场景中，累计收益会明显放大

涉及代码：

- `src/hub/friday-hub-bootstrap.ts:2337-2360`

## 页面空转取数摘要

本地空转巡检中，首屏 API 请求量最高的页面：

| 页面 | 首屏 API 请求数 | 备注 |
| --- | ---: | --- |
| `/assistant` | 31 | 聚合了 workflow/skills/fleet/marketplace/diagnosis/observability 等多域数据 |
| `/observability` | 25 | 首屏即拉 traces、audit、slos、retry、rules、acceptance 等 |
| `/settings` | 18 | 含 provider、persona、routing、learning 等多域请求 |
| `/home` | 11 | 对首页而言仍偏重 |

## 建议修复顺序

1. 先修 `diagnosis/learning/overview` 错表名，去掉稳定 500 与噪声
2. 让 route budget 与 UI cost summary 能覆盖真实固定成本：至少纳入 effective system prompt、工具 schema、learned preferences、persona 片段
3. 统一前端 query key 与共享状态入口，先去掉 `/assistant`、`/settings` 上的重复请求
4. 把 `/assistant` 与 `/observability` 改为按卡片/焦点分区按需加载，不要首屏全量预热所有子域
5. 把 `system/state` 这类重快照从 beginner-first 页面剥离，至少改成按需刷新
6. 给 converter detect 增加廉价预判与静默未命中路径，不要把正常格式探测失败打成告警
7. 把 AppShell 的 companion / approvals / SSE 订阅范围收缩到真正需要的页面
8. 对高成本失败接口关闭默认自动重试
9. 给 world model after-turn 增加“低价值回合跳过”门槛

## 附注

- 本报告只记录“效率与浪费”问题；未把本轮发现的通用安全、文案、视觉问题混入结论
- 本报告中的“建议/推断”都建立在本地 2026-04-02 实测和当前代码路径之上；外部 channel、Anthropic OAuth、云端部署行为不在本轮已确认事实范围内
