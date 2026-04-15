> Status: Current coverage matrix. Date: 2026-04-09 (America/Los_Angeles)

# Friday 能力覆盖矩阵

状态词汇只使用：

- `live`
- `hidden-but-reachable`
- `doc-only`
- `test-only`
- `wired-no-UI`
- `UI-no-runtime`
- `blocked-by-env`

## 路由覆盖

带本地管理员 token 的浏览器逐路由巡检结果：**全部目标路由返回 200 并落在预期 surface 或预期重定向路径**。

| 路由 | 状态 | 真实入口 / 落点 | 用户可见性 | 证据 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `/login` | `live` | 登录页 | 公开 | 匿名浏览器巡检 | 匿名访问正常，登录页可见 |
| `/setup` | `live` | 在已完成 setup 的环境会重定向到 `/home` | 受 setup 状态控制 | 带 token 浏览器巡检 | 路由存在，当前环境下按设计跳过 |
| `/onboarding` | `live` | 首次引导页 | 已接线 | 带 token 浏览器巡检 | 文案相对 beginner-friendly |
| `/home` | `live` | 首页 | 主入口 | 带 token 浏览器巡检 + smoke L1 | 当前最接近小白友好的任务首页 |
| `/chat` | `live` | 聊天页 | 主入口 | 带 token 浏览器巡检 + smoke L1 | 主新任务入口可用 |
| `/packs` | `live` | 行业与任务页 | 主入口 | 带 token 浏览器巡检 | 可从任务包进入流程 |
| `/packs/cross-border/setup` | `live` | 跨境包设置页 | 子入口 | 带 token 浏览器巡检 + browser e2e | `ea0d7b6` 相关 handoff 路径已通过专项回归 |
| `/assistant` | `live` | 助手收件箱 | 主入口 | 带 token 浏览器巡检 + smoke L1 | 适合审批/恢复/引导，不是新任务首入口 |
| `/command-center` | `live` | 操作控制台 | 高阶入口 | 带 token 浏览器巡检 + weekly partial screenshots | 访问时会带入 `runId`；术语仍偏 operator |
| `/fleet` | `live` | Fleet 控制面 | 高阶入口 | 带 token 浏览器巡检 | 当前环境能打开；是否真能管理外部节点受环境影响 |
| `/marketplace` | `live` | Marketplace | 主/次入口 | 带 token 浏览器巡检 + weekly partial screenshots | 公开资产、request board、creator support 均可见 |
| `/automations` | `live` | 任务队列 | 高阶入口 | 带 token 浏览器巡检 | 页面自述仍是 lightweight queue，不是完整自动化工作台 |
| `/observability` | `live` | 可观测性 | 高阶入口 | 带 token 浏览器巡检 + smoke L1 | 运营面可用，非 beginner-first |
| `/skills` | `live` | Skills 生命周期页 | 高阶入口 | 带 token 浏览器巡检 | 会自动追加 `skillId`/`focus` 查询参数 |
| `/skills/generator` | `live` | Skill 生成页 | 高阶入口 | 带 token 浏览器巡检 | 生成流可进入 |
| `/workflows` | `live` | Workflow 控制页 | 高阶入口 | 带 token 浏览器巡检 | 会自动追加 `workflowId`/`focus` 查询参数 |
| `/workflows/builder` | `live` | Workflow Builder | 高阶入口 | 带 token 浏览器巡检 + browser e2e performance baseline | 当前更偏模板优先与 operator authoring |
| `/mcp` | `live` | MCP 状态页 | 高阶入口 | 带 token 浏览器巡检 | 本次已改为只读状态页，不再伪装可切换 |
| `/usage` | `live` | Usage 页 | 高阶入口 | 带 token 浏览器巡检 | 本次已标明是 heuristic estimate，不是账单真相 |
| `/settings` | `live` | 设置页 | 高阶入口 | 带 token 浏览器巡检 + smoke L1 | 运行时状态/提供方/能力状态可见 |
| `/sessions` | `live` | 会话浏览器 | 高阶入口 | 带 token 浏览器巡检 | 可访问；与 operator console 语义接近 |
| `/memory` | `live` | 记忆页 | 高阶入口 | 带 token 浏览器巡检 + weekly partial screenshots | 增删搜查均有 UI |

## 非路由能力覆盖

| 能力 | 状态 | 真实链路 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| `/v1/diagnosis/*` | `live` | API + `/assistant` / observability side evidence | 手工 API 200；current-source-of-truth；自愈相关 e2e | active public surface |
| `/v1/auto-fix/*` | `live` | API + assistant/self-healing loop | 手工 API 200；current-source-of-truth | 高风险动作仍需审批 |
| `/v1/uix/*` | `live` | profile / learned facts / onboarding truth | 手工 API 200 | beginner-facing 辅助层已接线 |
| `/v1/plugins*` | `live` | API | 手工 API 200 | 当前无独立插件管理页 |
| `/v1/marketplace/plugins*` | `live` | API | 手工 API 200 | 当前无独立插件管理页 |
| 插件生命周期 UI | `wired-no-UI` | Settings capability pill 仅显示状态 | router/nav/route scan | 这是本次 truth alignment 的关键边界 |
| reply-routing (`src/routing/*`) | `test-only` | 仅模块自身与测试消费 | `rg` 搜索 | 看起来未进入当前运行时主链 |
| MCP enable/disable 控制 | `hidden-but-reachable` | 通过配置或 deep link 导入，不是网页开关 | `ui/src/routes/mcp-page.tsx` + 页面配置文案 | 本次已把误导性 toggle 去掉 |
| 外部渠道（Telegram/Slack/Discord 等） | `blocked-by-env` | 需要真实凭据与 supervisor 环境 | 当前本地 `channelCount` 很低且外部环境关闭 | 本次审计不主观放行 |
| desktop actions / recording | `blocked-by-env` | 需要桌面权限与 companion 条件 | weekly soak 仍在跑；current-source-of-truth + runtime health | 明天发布前需看 weekly/desktop 证据 |

## 小白友好度判断

| 用户类型 | 当前判断 | 依据 |
| --- | --- | --- |
| 首次上手小白 | 部分达标 | `/home`、`/chat`、`/packs`、`/onboarding` 相对清晰，但高级页面术语仍重 |
| 回访运营者 | 达标 | `/assistant`、`/observability`、`/settings`、`/workflows` 已有较完整操作面 |
| 高阶用户 / operator | 基本达标 | `/command-center`、`/fleet`、`/sessions`、`/memory` 等可用，但需要理解系统术语 |

## 结论

Friday 现在不是“只有一个大框，里面很多不能点”的状态。  
主路由面基本都能打开并落在真实页面上，但仍存在三类必须诚实表达的边界：

1. 一些能力是 **API 有、独立 UI 没有**，尤其是插件生命周期。
2. 一些页面是 **可用但偏 operator**，并不等于“小白友好”。
3. 一些能力是 **环境驱动**，没有真实凭据或桌面权限就只能标 `blocked-by-env`。
