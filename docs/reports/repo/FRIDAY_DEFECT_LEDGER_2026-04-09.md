> Status: Current audit ledger. Date: 2026-04-09 (America/Los_Angeles)

# Friday 缺陷总表

| ID | 严重级别 | 当前状态 | 阻断发布 | 缺陷 | 复现方式 / 发现方式 | 根因判断 | 为什么现有门禁没挡住 | 建议补哪层回归 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FRI-REL-001 | P1 | 已修复 | 否 | 本地 real-world validation 用错 token secret，导致 `/v1/auth/me` 返回 `INVALID_SIGNATURE` | 运行 `run-real-world-validation.mjs --mint-local-admin-token` 时大面积失败；手工比对 `.env` secret 后复现 | `validation/real-world/lib/local-auth.mjs` 之前只看 env/默认 secret 文件，不读 repo `.env` 覆盖 | 这是验证基础设施问题，不在业务运行时门禁里 | `test/unit/validation` 已补；保留 smoke 作为发布前必跑 |
| FRI-REL-002 | P1 | 已修复 | 否 | `browser-qa-report` 遇到页面重定向时仍可能报 “no blocking issues” | 代码审计发现只校验状态/console/request failure，不比较请求 URL 与最终 URL | 质检技能缺少 route identity 校验 | starter skill 单测之前没有覆盖 misroute 场景 | `test/unit/skills/runtime` 已补 redirect false-green 用例 |
| FRI-REL-003 | P1 | 打开 | 条件阻断 | 插件生命周期没有独立 UI，但活跃文档和 capability 文案容易让人理解为完整用户功能 | 审计 `/v1/plugins*`、`/v1/marketplace/plugins*` 返回 200；UI 仅在 Settings 显示 capability pill，router/nav 无 plugins page | API/runtime 先行，web IA 未补齐 | `release:verify` 只证明 API/测试，不证明独立 UI 存在 | 文档 truth alignment；若要公开宣传“插件可用”，需补 UI 或明确 de-scope |
| FRI-REL-004 | P2 | 已修复 | 否 | `MCP` 页面原本渲染可交互开关，但没有动作处理 | 代码审计 `ui/src/routes/mcp-page.tsx` 发现 toggle button 无 `onClick` 且无 API | UI 组件样式借用了开关形态，但后端动作不存在 | 浏览器 E2E 没覆盖 MCP 交互；构建和类型检查无法识别 UX 假能力 | 后续补一条 MCP surface UX smoke；本次已改为只读提示 |
| FRI-REL-005 | P2 | 已修复 | 否 | `Usage` 页面把 placeholder token/cost 假设呈现成像真实账单 | `ui/src/routes/usage-page.tsx` 硬编码 `$0.01 / 1K tokens` 与 `800 tokens/request` | 早期占位实现未在文案层明确估算属性 | 没有专门的 UI truth gate 检查 placeholder 文案 | 后续补文案真相 lint 或 route-level UX review；本次已改文案 |
| FRI-REL-006 | P2 | 已修复 | 否 | README 仍把本地桌面浏览器行为绑定到 `/agent`，与真实路由不一致 | 审查 README 与 router；router 仅存在 `/command-center` | 历史命名迁移后 README 未同步 | `release:verify` 不校验 README 与 router 一致性 | 加入 docs truth gate 或 route/doc diff check |
| FRI-REL-007 | P2 | 部分修复 | 否 | 多份 active docs 存在坏链或错误相对路径 | `rg` 扫描 `docs/` 的相对链接；命中 ops/current-source-of-truth/VISION/RFC/CODE_INDEX | 文档重组后相对路径未批量收口 | 主门禁不校验文档链接有效性 | 对 active docs 增加 link-check；archive/task 文档做后续批量清理 |
| FRI-REL-008 | P2 | 打开 | 否 | `Automations` 页面自己声明部分 `workflow / memory / session` 工具被 deferred，但页面仍是公开功能面的一部分 | 页面文案审计 | 产品边界与页面名称之间存在期待差 | 当前测试更关注页面是否加载，不检查“名字与能力是否匹配” | 若明天发布面向普通用户，建议在文案/入口上更明确降级 |
| FRI-REL-009 | P2 | 打开 | 否 | `src/routing/*` reply-routing 模块目前看起来没有运行时接线，接近 test-only | `rg` 仅命中 `src/routing/*` 自身与 `test/unit/routing/*` | 历史模块残留或未来接线未完成 | 无 unused-surface gate | 后续决定：接线、归档或从对外叙事中删除 |
| FRI-REL-010 | P1 | 打开 | 是 | `weekly` real-world validation soak 仍未结束，发布证据链未闭合 | `2026-04-09T20-20-22-145Z-h4cj3j` 目录已生成，但尚无 `summary.json` | 长跑验证尚未收口 | 这是本次审计新增的流程门禁，不在 repo 默认脚本里 | 等待 weekly 套件完成并审阅产物，再给最终 go/no-go |

## 当前建议

1. 立即接受已修复项：`FRI-REL-001`、`002`、`004`、`005`、`006`、大部分 `007`。
2. 把 `FRI-REL-003`、`008`、`009` 作为发布说明中的明确边界，不要再按“全部用户功能都已完整 UI 化”去讲。
3. 把 `FRI-REL-010` 视为当前唯一真正的流程阻断项。
