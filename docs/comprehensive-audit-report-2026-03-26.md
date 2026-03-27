# Friday v0.4.2 — 全面代码审计报告

> **审计日期**: 2026-03-26
> **分支**: `serene-chaum`
> **范围**: 全部 src/ 源码（954个TS文件）、677个测试文件、63个迁移文件
> **方法**: 逐行代码审查 + 静态分析 + 全量测试执行

---

## 审计总结

| 严重度 | 数量 | 描述 |
|--------|------|------|
| **P0 (Critical)** | **1** | Hub Bootstrap 部分失败无资源清理 |
| **P1 (High)** | **14** | 安全漏洞、运行时闭环缺陷、关闭序列缺失 |
| **P2 (Medium)** | **39** | 类型安全、静默错误、性能、配置问题 |
| **P3 (Low)** | **23** | 代码风格、文档、低风险边缘情况 |

### 历史审计修复状态

| 历史问题 | 状态 |
|----------|------|
| FRI-SEC-001 (认证绕过) | **已修复** |
| FRI-SEC-002 (默认 token secret) | **已修复** (随机生成+持久化) |
| FRI-SEC-004 (SHA-256 弱哈希) | **已修复** (Scrypt+自动迁移) |
| FRI-SEC-005 (token 撤销) | **已修复** (内存撤销表) |
| FRI-SEC-006 (PKCE state=verifier) | **已修复** (独立随机+TTL) |
| CX-001 (batchSize=0 死循环) | **已修复** (MIN_BATCH_SIZE=1) |
| CX-002 (approval before resume) | **已修复** |
| CX-003 (expired approval 阻塞) | **已修复** (双重回退) |
| CX-005 (when:"success" 条件边) | **已修复** |
| CX-006 (transform config 形状) | **已修复** |
| audit-fix #1 (shell 注入) | **已修复** (execFileSync) |
| audit-fix #2 (路径穿越 12处) | **已修复** (resolveSafePath) |
| API-ROUTE-001 (路由遮蔽) | **已修复** (specificity 算法) |
| cx-api-audit 全部 P1/P2 | **已修复** |

---

## 基线检查结果

| 检查项 | 结果 |
|--------|------|
| TypeScript 严格类型检查 (`tsc --noEmit`) | **通过** — 零错误 |
| ESLint + Security 插件 | **2 错误** (import 排序，非阻塞) |
| `@ts-ignore` / `@ts-nocheck` / `eslint-disable` | **零** |
| `TODO` / `FIXME` / `HACK` 注释 | **零** (src/内) |
| `as any` 类型转换 | **14 处** (5个文件) |
| 空 `catch {}` 块 | **357 处** (139个文件) — 最大风险 |
| `throw new Error()` (非 FridayDomainError) | **225 处** (81个文件) |

---

## P0 — Critical

### P0-001: Hub Bootstrap 部分初始化失败无资源清理
**文件**: `src/hub/friday-hub-bootstrap.ts:416-4896`

`createFridayHub()` 无顶层 try/finally。如果 SQLite 初始化成功(L427)但后续服务初始化失败，SQLite 连接将永远不会关闭。

**修复**: 添加 `finally` 块，在部分失败时关闭 `stateRuntime`。

---

## P1 — High (14 个)

### 安全类

#### P1-SEC-001: `web_fetch` SSRF guard 是可选依赖
**文件**: `src/agent/tools/friday-agent-web-fetch-tool.ts:67,135-137`

当 `ssrfGuard` 未注入时，工具直接使用 `fetch()` 而无任何 SSRF 防护。云元数据端点可被访问。

#### P1-SEC-002: `browser:evaluate` 执行任意 JavaScript
**文件**: `src/agent/tools/friday-agent-browser-tool.ts:867-868`

LLM 提供的文本直接传入 `page.evaluate(text)`, 无沙箱、CSP 限制或作用域约束。

#### P1-SEC-003: `desktop:file_operation` 无路径边界检查
**文件**: `src/agent/tools/friday-agent-desktop-tool.ts:469-502`

`file_operation` 动作（read/write/delete/move）的 `path` 参数直接来自 LLM，无工作空间边界验证。

#### P1-SEC-004: Token 签名密钥无最小熵要求
**文件**: `src/api/auth/friday-auth-service.types.ts:34`

`tokenSecret` 接受任意字符串包括空字符串。无最小长度/熵检查。

#### P1-SEC-005: Rate Limiter 为可选依赖
**文件**: `src/api/auth/friday-auth-service.ts:181,198`

`rateLimiter` 为可选参数。未注入时所有限流被静默跳过，允许无限暴力破解。

#### P1-SEC-006: `safeEvaluateRules` 失败时 fail-open
**文件**: `src/agent/runtime/friday-agent-runtime.ts:1984-2003`

规则引擎崩溃时返回 `null`（无策略限制），所有运行和工具调用将绕过策略执行。

### 运行时闭环类

#### P1-RT-001: Workflow `resumeRun` 异步失败未标记 run 为 failed
**文件**: `src/workflows/services/friday-workflow-execution-service.ts:1342-1347`

`.catch()` 仅记录日志，不将 run 标记为 failed。Run 将永久停留在 `running` 状态。

#### P1-RT-002: Workflow `retryRun` 同样问题
**文件**: `src/workflows/services/friday-workflow-execution-service.ts:1469-1474`

#### P1-RT-003: Workflow `recoverActiveRuns` 同样问题
**文件**: `src/workflows/services/friday-workflow-execution-service.ts:1531-1536`

#### P1-RT-004: `paused` runs 不在 `listActiveRuns` 结果中
**文件**: `src/workflows/persistence/friday-workflow-run-repository.ts:183`

重启后 paused runs 对恢复/超时扫描不可见，将成为孤儿。

### 关闭序列类

#### P1-SHUT-001: `observabilityService.scheduler` 未在 stop() 中停止
**文件**: `src/hub/friday-hub-bootstrap.ts:3354, 4838-4872`

#### P1-SHUT-002: `agentLearningBridge` 未在 stop() 中停止
**文件**: `src/hub/friday-hub-bootstrap.ts:3381`

#### P1-SHUT-003: `mcpAdapter` 未在 stop() 中关闭 — 子进程泄漏
**文件**: `src/hub/friday-hub-bootstrap.ts:1274`

### 通道类

#### P1-CH-001: QQ 和 Lark 无 Zod 配置验证 schema
**文件**: `src/channels/qq/friday-qq-channel.ts:347`, `src/channels/lark/friday-lark-channel.ts:332`

手动 `as string` 类型转换，无运行时验证。

---

## P2 — Medium (39 个，按类别)

### DAG/Workflow 引擎 (9)
- DAG 边条件求值异常静默禁用边 (`friday-workflow-dag-scheduler.ts:108-121`)
- Node machine: `failed` 同时是终态和有出站转换 (`friday-workflow-node-machine.ts:36,45`)
- `updateRunStatus` 不执行状态机校验 (`friday-workflow-run-repository.ts:130-141`)
- Approval 暂停绕过状态机 (running→paused 直接) (`friday-workflow-execution-service.ts:696`)
- Retry delay 阻塞执行批次 (`friday-workflow-execution-service.ts:463-468`)
- `String.replace` 只替换第一个出现 (`friday-workflow-node-executor.ts:186-189`)
- 节点超时计时器未在成功完成时取消 (`friday-workflow-execution-service.ts:800-820`)
- 租约 TTL 使用 `Date.now()` 而非注入时钟 (`friday-workflow-execution-service.ts:646`)
- Trigger service 触发失败静默吞没 (5个 catch 块)

### 安全 (5)
- Master key 缓存无 TTL/失效机制 (`friday-secret-crypto.ts:76`)
- `validateWithDns()` 有 TOCTOU 窗口 (`friday-agent-ssrf-guard.ts:543`)
- `allowLocalBypassLogin` 允许 localhost 无凭证发 token (`friday-auth-service.ts:436`)
- ReDoS 启发式检测不全面 (`condition-evaluator.ts:37-44`)
- Master key 文件权限读取时不验证 (`friday-secret-crypto.ts:111-121`)

### Agent 工具 (5)
- `desktop:launch_app` 无应用白名单 (`friday-agent-desktop-tool.ts:447`)
- `xhs:post` 图片路径无工作空间边界检查 (`friday-agent-xhs-tool.ts:160`)
- `browser:upload` 路径验证不解析符号链接 (`friday-agent-browser-tool.ts:1176`)
- Risk 分类仅覆盖 exec/write/edit (`friday-agent-tool-risk.ts:61-83`)
- `sessions:send` 可触发递归无界代理执行 (`friday-agent-sessions-tool.ts:244`)

### Hub Bootstrap (5)
- `configManager` 永久为 stub (`friday-hub-bootstrap.ts:479`)
- `memoryState` 永久为 stub (`friday-hub-bootstrap.ts:481`)
- 规则引擎加载失败被静默吞没 (`friday-hub-bootstrap.ts:584-608`)
- `hubState` 在清理前即设为 "stopped" (`friday-hub-bootstrap.ts:4840`)
- 默认管理员用户在非生产环境可无密码 (`friday-hub-bootstrap.ts:441-448`)

### 通道 (5)
- Slack Socket Mode 无重连 (`slack-service.ts`)
- Signal SSE 无重连 (`signal-service.ts:176-189`)
- IRC socket 断连无重连 (`irc-service.ts:188-192`)
- QQ 重连无指数退避 (`friday-qq-channel.ts:190`)
- WhatsApp `appSecret` 可选导致签名验证可跳过 (`whatsapp-config.schema.ts:25`)

### Agent Runtime (3)
- Planning gate `seqCounters` Map 永不清理 (`friday-agent-planning-gate.ts:247`)
- Tool call 限制是后循环检查 (`friday-agent-runtime.ts:1548`)
- 无子代理深度限制在此层 (`friday-agent-runtime.ts`)

### 数据层 (3)
- `SQLiteLayer.close()` 非幂等 (`friday-sqlite-layer.ts:50-53`)
- 42 处 `JSON.parse(row.x) as Type` 无运行时验证
- 4 处 P1 级复杂类型转换在 agent run repository

### API 层 (2)
- Agent/session/memory/webhook 变更端点缺少限流
- 5 个通道缺少 capability contract

### 可观测性 (2)
- 审计轨迹仅内存存储 (`audit-trail.ts`)
- Alert/dashboard 数据无界增长 (`alert-engine.ts`, `dashboard-data-provider.ts`)

---

## 关键闭环验证结果

### Agent Runtime `executeRun()` — **通过**
- 6 项资源（abortTimer, externalAbort listener, progressTimer, 2 subagent listeners, seqCounters entry）全部在 `finally` 块中清理
- 工具级 `executeToolCall()` 也通过 `finally` 清理
- 状态机覆盖所有状态转换路径
- 超时/最大迭代/最大工具调用限制全部强制执行

### Workflow Engine — **有条件通过**
- 状态机转换基本完整
- CX-002/003/005/006 全部已修复
- **但**: resumeRun/retryRun/recoverActiveRuns 的 catch 块不标记 failed (P1)
- **但**: paused runs 对恢复扫描不可见 (P1)

### Hub Bootstrap — **有条件通过**
- 所有服务成功布线
- CORS 默认禁用（非通配符）
- **但**: 关闭序列缺 3 项 (P1)
- **但**: 部分失败无清理 (P0)

### 10 通道闭环 — **5/10 完整**
- **完整**: Discord, Telegram, WhatsApp, Webchat, Lark (带重连)
- **缺失重连**: Slack Socket Mode, Signal SSE, IRC
- **缺 schema**: QQ, Lark

### API 层 — **通过**
- 45 个路由文件全部注册
- Auth middleware 通过类型系统强制执行 (fail-closed)
- 安全头全路径覆盖
- UI-Backend 100% 对齐（6 个 UI 客户端全部匹配）

---

## 代码质量热点

### 最高风险文件 (silent catch 数量)
1. `agent/runtime/friday-agent-runtime.ts` — 16 处
2. `system/companion/friday-system-named-pipe-bridge.ts` — 11 处
3. `system/companion/friday-system-unix-socket-bridge.ts` — 11 处
4. `workflows/runtime/friday-workflow-runtime.ts` — 9 处
5. `api/runtime/friday-deterministic-pipeline-runtime.ts` — 9 处

### `as any` 安全分析
- **高风险** (5处): `friday-satellite-pairing-routes.ts` — RBAC scope 声明绕过类型联合
- **中风险** (4处): `friday-provider-fallback.ts` — 错误对象属性提取
- **低风险** (5处): `friday-desktop-adapters.ts`, `friday-billing-reconciliation-job.ts`

---

## 建议修复优先级

### 立即修复 (P0 + 关键 P1)
1. Hub bootstrap 添加 `finally` 清理块
2. SSRF guard 设为必选依赖
3. Workflow resumeRun/retryRun/recoverActiveRuns catch 块添加 failed 标记
4. Hub stop() 添加 observability/learning/mcp 清理
5. `paused` 加入 `listActiveRuns` 查询

### 短期修复 (其余 P1)
6. Browser evaluate 添加沙箱/限制
7. Desktop file_operation 添加路径边界检查
8. Token secret 添加最小熵要求
9. Rate limiter 设为必选或添加显著警告
10. QQ/Lark 添加 Zod config schema
11. safeEvaluateRules 改为 fail-closed 或添加日志

### 中期改进 (P2)
12. Signal/Slack/IRC 添加重连逻辑
13. Agent/session/webhook 端点添加限流
14. JSON parse 关键路径添加运行时验证
15. SQLite close() 添加幂等性
16. 清理 357 个 silent catch（至少添加日志）
