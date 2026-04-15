> Status: Current audit. Date: 2026-04-09 (America/Los_Angeles)

# Friday 发布前全仓库深度审计

## 当前发布结论

**当前结论：`not-ready`。**

这不是因为主链路已经坏掉，而是因为你要求的完整发布门禁里，`weekly` real-world validation soak 仍在运行，证据链还没有闭合。  
如果该套件在 **2026-04-09** 晚些时候绿色收口，并且发布说明明确降级以下边界：

1. 插件生命周期当前是 **API-first / Settings 状态可见**，不是完整独立 UI。
2. `Automations` 页仍然明确保留了部分 `workflow / memory / session` 工具的延后边界。
3. `Usage` 页只能展示启发式估算，不是账单真相。

则结论可提升为 **`ready-with-explicit-de-scope`**。

## 审计范围

- 提交基线：`ea0d7b6`
- 代码层：layer、cross、hub/bootstrap、registry、route family、skills/workflows/plugins、自学习/自修复/记忆
- UI 层：`/login`、`/setup`、`/onboarding`、`/home`、`/chat`、`/packs`、`/packs/cross-border/setup`、`/assistant`、`/command-center`、`/fleet`、`/marketplace`、`/automations`、`/observability`、`/skills`、`/skills/generator`、`/workflows`、`/workflows/builder`、`/mcp`、`/usage`、`/settings`、`/sessions`、`/memory`
- 测试层：`release:verify`、targeted unit tests、real-world validation smoke、真实带 token 浏览器逐路由巡检
- 文档层：`README.md`、`docs/current-source-of-truth.md`、`docs/VISION.md`、`docs/ops/*`、`docs/reference/*`
- 外部对标：Reddit 上 OpenClaw 公开问题主题，与 Friday 做 parity matrix

## 证据来源

- `npm run release:verify` 于 **2026-04-09** 通过，包含 `typecheck`、`lint`、`build`、`npm test`、`test:e2e:ui`、OpenClaw overlap、install smoke、release check。
- real-world validation smoke：[`docs/reports/ops/real-world-validation/2026-04-09T20-18-26-291Z-ui4kju/index.md`](../ops/real-world-validation/2026-04-09T20-18-26-291Z-ui4kju/index.md)
- real-world validation weekly soak：[`docs/reports/ops/real-world-validation/2026-04-09T20-20-22-145Z-h4cj3j`](../ops/real-world-validation/2026-04-09T20-20-22-145Z-h4cj3j)
- security review evidence：`.friday/skills/security-review/runs/2026-04-09T20-16-40-964Z.json`
- 本次审计中新增修复：
  - `validation/real-world/lib/local-auth.mjs`
  - `skills/browser-qa-report/index.mjs`
  - `ui/src/routes/mcp-page.tsx`
  - `ui/src/routes/usage-page.tsx`
  - 多份活跃文档真相修正

## Confirmed Facts

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| `ea0d7b6` 是当前审计基线，且本地运行成功 | 本地 Friday 运行在 `http://127.0.0.1:3141` | 代码审计与真实运行对齐 |
| `docs/current-source-of-truth.md` 仍是当前真相源 | 文档明确声明且与当前 router/API 契约基本一致 | 归档文档不能直接当现状 |
| `release:verify` 已在 **2026-04-09** 通过 | 构建、默认测试、browser e2e、install smoke、release check 全部通过 | 代码库已通过主发布脚本门禁 |
| 默认 `npm test` 不覆盖浏览器 E2E | `vitest.config.ts` 将 `test/e2e/ui/**/*.test.ts` 放在单独 `browser-e2e` project | 不能把 `npm test` 当成完整 UI 证明 |
| real-world validation smoke 已绿色 | smoke run `2026-04-09T20-18-26-291Z-ui4kju`，`28/28 passed`，`misrouteCount=0` | 本地核心链路、L0-L5 主路径可用 |
| 本地验证工具之前会生成错误签名 token | `local-auth.mjs` 原逻辑忽略 repo `.env` 的 `FRIDAY_TOKEN_SECRET` | 会制造大面积假性失败，已修复 |
| `browser-qa-report` 之前会把重定向错判成无问题 | 原实现只看状态/console/request failure，不比对 `requestedUrl` 和 `finalUrl` | 会制造假性绿色，已修复 |
| `/agent` 已不是当前 UI 路由 | router 仅有 `/command-center`，且 README 之前仍写 `/agent` | 文档漂移真实存在，已修复 README |
| 插件 API 是活的，但没有独立插件管理页 | `/v1/plugins*` 与 `/v1/marketplace/plugins*` 返回 200；UI 里只在 Settings 显示 capability pill | 用户看得到“插件可用”但没有完整 UI 生命周期 |
| `AutomationsPage` 自述仍有延后边界 | 页面文案明确写 `workflow / memory / session tooling` deferred | 这不是完整自动化中控台，需要发布时明确边界 |
| `UsagePage` 原本是 placeholder 估算 | 页面注释硬编码 `$0.01 per 1K tokens` 与 `800 tokens/request` | 会误导用户把估算当账单真相，已修复文案 |
| `McpPage` 原本有假开关 | 页面渲染 toggle 样式但无 `onClick`/API | UI-no-runtime，已改成只读状态提示 |
| `src/routing/*` reply-routing 模块目前看起来只被自己和测试消费 | 搜索结果没有外部运行时消费方 | 这是“test-only / 未接线”候选 |
| `FridayAgentSelfFixService` 目前仍只在导出和测试中出现 | `rg` 结果仅命中 `src/agent/testing/*`、`src/agent/index.ts`、对应单测 | 自修复里仍有边界，不应夸大成完全闭环自愈 |

## Inference

| 推断 | 依据 | 结论 |
| --- | --- | --- |
| Friday 主用户链路已经接近可发布 | `release:verify` 通过，smoke 通过，带 token 逐路由浏览器巡检全部 200/落在预期路径 | 产品主路径不是当前阻断点 |
| 当前更大的风险是“能力边界表达”而不是“系统完全跑不起来” | 发现的问题集中在文档漂移、假能力 UI、API/UI 不对称、延后能力仍可见 | 发布前更需要 truth alignment |
| 插件相关不能按“完整用户功能”对外表述 | API 有，UI 没有；Settings 只有 runtime 状态 | 只能按 operator/admin API 能力发布 |
| 自动化、记忆、会话等高级能力存在但并非全都 beginner-friendly | 页面和术语仍偏 operator 视角，且部分能力依赖跳转或外部理解 | 若以“小白友好”作标准，仍需后续打磨 |
| 当前 go/no-go 真正缺口是 soak 级证据闭环 | weekly real-world validation 尚未结束 | 现在给 `not-ready` 是流程严谨，不是产品已坏 |

## 本次已完成修复

1. 修复了本地 real-world validation 铸造 token 时忽略 repo `.env` secret 的问题，避免假性 `INVALID_SIGNATURE`。
2. 修复了 `browser-qa-report` 不校验最终落点路径的问题，避免重定向假绿。
3. 去掉了 `MCP` 页面上的假开关，改成只读状态提示。
4. 把 `Usage` 页面改成明确的启发式估算说明，避免误导为真实账单。
5. 修复了 `README.md` 的旧 `/agent` 描述和多处活跃文档坏链。
6. 把插件生命周期的真相写回 active docs，明确其当前是 API-first 而非完整 UI。

## 仍需发布前确认的点

1. 等 `weekly` real-world validation 完整收口，并审阅其 `summary.json` 与 `defect-ledger.md`。
2. 发布说明里必须明确：
   - 插件管理当前不是独立完整 UI。
   - `Usage` 是估算，不是账单。
   - `Automations` 当前是轻量任务队列，不是完整自动化工作台。
3. 若明天发布面向“小白用户”，应额外评估 `/command-center`、`/fleet`、`/observability`、`/mcp` 的术语和导引是否需要进一步收敛到 operator-only。

## 建议的发布门禁

| 优先级 | 动作 | 原因 |
| --- | --- | --- |
| P0 | 等待 weekly soak 完结 | 这是当前唯一未闭环的一级证据 |
| P0 | 使用本次修正后的 truth docs 作为对外说明基线 | 避免明天发布后“文档说有、用户点不开/找不到” |
| P1 | 保持插件能力为 de-scope/operator-only 描述 | API 有，完整 UI 没有 |
| P1 | 保持 `Usage` 为 estimate-only 文案 | 目前无逐 provider 实账结算面 |
| P1 | 保持 `Automations` 为 lightweight queue 描述 | 页面自己仍说明有 deferred tooling |
| P2 | 对 `src/routing/*` 做后续接线/归档决策 | 当前更像 test-only 遗留模块 |

## 审计结论摘要

- **代码与主链路：** 强，当前不是主要阻断。
- **UI/UX 完整性：** 主路径可用，但高级面仍偏 operator，不完全小白友好。
- **文档真相：** 已修复一批高置信漂移，但 archive/task 历史文档仍有遗留坏链。
- **外部对标：** Friday 已确认存在“控制台/文档与真实运行不一致”这一类与 OpenClaw 同类问题，但本次已修掉其中一批最直接项。
- **最终结论：** **先不要直接宣称 ready。等 weekly soak 收口后，再按 `ready-with-explicit-de-scope` 还是 `not-ready` 做最后一刀。**
