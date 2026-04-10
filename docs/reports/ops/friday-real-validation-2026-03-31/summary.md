# Friday 真实 3 小时验证总结

测试日期基线: `2026-03-31`  
主目标实例: `http://127.0.0.1:3141`  
排除实例: `http://127.0.0.1:51800`（空白实例，不纳入主测）  
证据目录: `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/`  
真实文件写入目录: `/Users/dev/Desktop/friday-real-test-2026-03-31/`

## 已确认事实

- `3141` 当前运行版本为 `0.4.2`。
- `/v1/health` 返回 `ok`，但 system health 为 `safe_mode`，原因是 `permission_pending:screen_recording`、`permission_pending:input_monitoring`、`permission_pending:automation`。
- `npm run check:desktop-runtime` 通过，但明确警告 macOS 仍需要 `Accessibility`、`Screen Recording`、`Input Monitoring`、`Automation` 授权。
- `3141` 上共有 `8` 个 provider，其中 `4` 个启用的 Anthropic OAuth provider；默认路由指向 `Claude OAuth`，默认模型为 `claude-sonnet-4-20250514`。
- Claude provider 校验接口成功，说明当前 Friday 确实连上了配置好的 Claude provider。

## 最终判定

| 能力链路 | 结果 | 结论 |
|---|---|---|
| Claude 基础客观题 | `PARTIAL` | 5 个客观题中 4 个直接通过；长摘要题连续两次误入 `generate workflow` 澄清路径，不稳定。 |
| `/assistant` 真实 UI | `PASS` | 本地 bypass 登录成功；`/assistant` 可加载并接受自然语言目标；`/settings/persona` 可正常展示。 |
| 浏览器真实操作 | `PASS` | Friday 真实打开 `https://example.com` 并保存截图。 |
| 真实保存与读取 | `PASS` | Friday 在桌面测试目录创建、移动、读取并校验了真实文件内容。 |
| Sessions 路径 | `PASS` | `create -> message -> fork -> merge` 在 canonical `sessionKey/chatId` 合同下真实可用。 |
| Memory 路径 | `PASS` | `store -> get -> search -> list -> delete -> prune` 在合法 dot-namespace 下真实可用。 |
| Approval workflow | `PASS` | 最小合法 `trigger -> approval` workflow 真实完成了 `create -> publish -> run -> approve -> completed`。 |
| Skill generator | `FAIL` | `/v1/skills/generator/sessions` 在真实 Claude 路径上直接返回 `502 PROVIDER_ERROR`。 |
| Workflow generator | `FAIL` | `/v1/workflows/generator/sessions` 在真实 Claude 路径上直接返回 `502 PROVIDER_ERROR`。 |
| Desktop 真操作 | `BLOCKED` | 权限未齐；显式 desktop 检查 run 在批准后又触发 Anthropic `tool_use/tool_result` 协议错误，未能完成真实桌面动作链。 |
| Self-healing 表面能力 | `PARTIAL` | incident/diagnosis/action/evidence 面真实存在；但本轮未拿到一个从 `action -> execute -> verify -> rollback` 完整成功闭环。 |
| 学习与自适配 | `PARTIAL` | 显式偏好和 persona 预览真实生效；自然语言纠正返回 `Preference recorded.`；`learned-facts` 仍为空，无法证明“真正学到了新事实”。 |

## 不计入产品失败的项

- `sessions-memory-approval` 初次失败是因为测试请求体错误地用了 `sessionKey`，而该接口创建 session 时要求 `chatId`。按 canonical 合同复测后通过。
- `approval-workflow` 初次失败是因为测试 graph 非法：先缺 `name`，后又缺 `ref/skillId`。改为最小合法 `trigger -> approval` graph 后，真实审批链通过。
- memory 初次失败是因为 namespace 用了连字符；该 API 合同要求 `lowercase alphanumeric segments separated by dots`。按合法 namespace 复测后通过。

## 关键失败与阻塞

### 1. Claude 普通摘要请求会误入 workflow 生成澄清路径

- 失败用例: `claude-quiz-summary` 与 `claude-summary-rerun`
- 真实现象: Friday 没有直接总结给定上下文，而是返回 “Before I execute this generate workflow...” 并要求澄清 workflow 触发条件。
- 影响: 普通聊天/总结类任务在当前 Claude 路由下并不稳定，存在明显 intent routing / planning gate 误判。

### 2. Skill generator 与 workflow generator 在真实 Claude 路径上不可用

- `POST /v1/skills/generator/sessions` 返回 `502 PROVIDER_ERROR`
- `POST /v1/workflows/generator/sessions` 返回 `502 PROVIDER_ERROR`
- 影响: README 和 `/assistant` 所承诺的“自然语言生成 skill / workflow”在当前实例上不能作为真实可用能力来判定。

### 3. Desktop 能力目前不能判定为“真实可操作电脑”

- Runtime 本身已明确处于 `safe_mode`，权限缺口是 `screen_recording`、`input_monitoring`、`automation`。
- 第一轮 desktop status 检查给出了误导性结果: 它把 headless browser session 当成了 “desktop usable”。
- 第二轮显式审批后，run 最终失败于 Anthropic 协议错误: `tool_use ids were found without tool_result blocks immediately after ...`
- 结论: 当前不能把 Friday 的 desktop 真操作判为 `PASS`。

### 4. “真正学习”和“真正自我修复”都只能判 `PARTIAL`

- 学习:
  - `/v1/uix/preferences` 写入成功；
  - `/v1/uix/persona` 真实反映了显式偏好；
  - 自然语言纠正得到 `Preference recorded.`；
  - 但 `/v1/uix/learned-facts` 为空。
- 自我修复:
  - `/v1/diagnosis/*`、`/v1/auto-fix/*` 路由真实存在；
  - 现有 action 快照里能看到审批、证据、回滚字段；
  - 但本轮新制造的 desktop 失败 incident 被标记为 `autoFixEligible: false`，没有产出可执行 action；
  - 因此本轮没有拿到一个可证明的 “生成 action -> 执行 -> 验证 -> 回滚/停止” 成功闭环。

## 建议

以下是建议，不是已确认事实。

- 修正普通总结/问答和 `generate workflow` 规划门之间的 intent routing，避免正常聊天被错误送进 workflow 澄清流。
- 修复 Claude-backed skill/workflow generator 的 provider 错误，至少先恢复 session 创建与 draft 生成。
- 在 desktop 能力上同时处理两类问题:
  - 权限前置检查和 UI 提示要更硬，避免 safe_mode 下误报 “desktop usable”；
  - Anthropic tool 调用链要保证 `tool_use -> tool_result` 严格成对。
- 如果要继续宣称“learning-adaptive communication”，需要给出可观察证据，至少让 learned facts 可读、可核对。
- 如果要继续宣称“self-healing”闭环，最好补一条真实成功的 `approval -> execute -> verify -> rollback/acceptance` 证据链，而不只是表面路由存在。

## 主要证据文件

- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/snapshots/baseline-runtime.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/logs/desktop-runtime-check.txt`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/raw/http-validation-results.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/responses/ui-validation.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/responses/targeted-reruns.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/responses/approval-workflow-only-rerun.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/responses/session-memory-rerun.json`
- `/path/to/friday/artifacts/manual/friday-real-validation-2026-03-31/responses/auto-fix-actions-snapshot.json`

