# Friday Phase 1 模块地图

生成时间：2026-05-03

## 项目形态

Friday 是一个本地优先、可自托管的全栈 Agent OS：

- CLI / runtime：`/Users/example/Desktop/Friday/src/cli/friday-cli.ts`
- Hub composition root：`/Users/example/Desktop/Friday/src/hub/friday-hub-bootstrap.ts`
- HTTP/API：`/Users/example/Desktop/Friday/src/api`
- UI：`/Users/example/Desktop/Friday/ui/src`
- State/SQLite：`/Users/example/Desktop/Friday/src/state`
- Agent runtime/tools：`/Users/example/Desktop/Friday/src/agent`
- Skills：`/Users/example/Desktop/Friday/src/skills`、`/Users/example/Desktop/Friday/skills`、`/Users/example/Desktop/Friday/managed-skills`
- Workflows：`/Users/example/Desktop/Friday/src/workflows`
- Memory：`/Users/example/Desktop/Friday/src/memory`
- Providers：`/Users/example/Desktop/Friday/src/providers`
- Channels：`/Users/example/Desktop/Friday/src/channels`

## 当前执行流

1. `friday-cli.ts` 解析命令、端口、host、skills dir、部分 env。
2. `createFridayHub` 初始化 state、providers、skills、memory、workflows、agent、channels、scheduler、plugins、observability。
3. `createFridayApiRuntime` 注册 `/v1/*` API route。
4. `createFridayHttpServer` 提供 HTTP、middleware、static UI、WebSocket gateway。
5. UI 通过 `ui/src/lib/api/client.ts` 调 API。
6. Agent run 通过 API 或 channel 进入 agent runtime，再调用 tools/providers/memory/workflows。

## 模块清单

| 模块 | 主要路径 | 当前边界评价 | Phase 1 判断 |
| --- | --- | --- | --- |
| Hub | `/Users/example/Desktop/Friday/src/hub/friday-hub-bootstrap.ts` | 过大，承担总装配和大量业务判断 | Phase 2/3 应优先收敛为模块注册器 |
| Agent | `/Users/example/Desktop/Friday/src/agent/runtime/friday-agent-runtime.ts` | 过大，混合 prompt、tool loop、memory、guard、输出校验 | 先补 characterization，再拆内部策略 |
| API | `/Users/example/Desktop/Friday/src/api/runtime/friday-api-runtime.ts` | route 文件较模块化，runtime 注册器过大 | 引入 feature route installer |
| State | `/Users/example/Desktop/Friday/src/state` | 边界较清晰，migration 纪律好 | 保持为 core platform |
| Memory | `/Users/example/Desktop/Friday/src/memory` | core service 较清楚，session/orchestrator 耦合较深 | 保护数据优先，后续拆 policy |
| Skills | `/Users/example/Desktop/Friday/src/skills` | 已接近插件/乐高式 | 可作为未来模块化模板 |
| Workflows | `/Users/example/Desktop/Friday/src/workflows` | 领域边界清楚但 runtime/execution 较大 | 适合拆 node executor/run lifecycle |
| Providers | `/Users/example/Desktop/Friday/src/providers/services/friday-provider-service.ts` | 过大，混合 secret/OAuth/doctor/routing/usage | 优先拆分 |
| Channels | `/Users/example/Desktop/Friday/src/channels` | adapter 模式不错，但 readiness 不均 | 增加 live/stub/experimental 标记 |
| UI | `/Users/example/Desktop/Friday/ui/src` | API client 较集中，但 types/setup page 偏大 | 拆页面 panels，建立 contract 生成 |
| Config | `/Users/example/Desktop/Friday/src/config` + scattered env | schema 很小，env 读取分散 | 建议统一 `FridayRuntimeConfig` |

## 依赖方向现状

健康方向：

- `state` 基本只依赖 config/errors。
- `channels` 通过 adapter 接入。
- `skills` 有 registry/lifecycle/executor 概念。
- API route 文件分散在 `src/api/http/routes`。

高风险方向：

- hub 直接知道太多 feature 内部细节。
- agent runtime 直接承载大量跨模块策略。
- API runtime 直接注册和拼接大量 feature services。
- UI API types 手写维护，容易与后端 contracts 漂移。

## 建议目标边界

- `core/platform`：config、state、errors、logging、auth、scheduler、events。
- `features/agent`：agent public facade、tool loop、agent policies。
- `features/memory`：memory service、guard、file sync、namespace policy。
- `features/skills`：registry、lifecycle、executor、trust。
- `features/workflows`：workflow CRUD、compiler、execution、node runners。
- `features/providers`：provider catalog、secrets/OAuth、doctor、routing、usage。
- `features/channels`：channel adapters、webhooks、delivery policies。
- `integrations/*`：browser、desktop、MCP、external API adapters。
- `api/contracts`：shared schemas/types for UI/operator client.

## 允许的依赖规则

- feature 可以依赖 core/shared/contracts。
- API 只能依赖 feature public facade。
- UI 只能依赖 API contracts/client，不直接依赖 backend internals。
- Hub 只负责装配 feature installers。
- feature 之间不直接 import 对方 internal；跨 feature 通过 contract/event/job/tool facade。
