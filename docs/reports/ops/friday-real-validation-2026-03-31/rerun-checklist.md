# Friday rerun checklist

测试日期基线: `2026-03-31`

## 修复后必须重跑

### 1. Claude 普通摘要 / 直接回答

- 问题: 普通总结请求被错误送进 `generate workflow` 澄清门。
- 先决条件: 修正 intent routing / planning gate。
- 重跑入口:
  - `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-http-validation.mjs`
  - `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-targeted-reruns.mjs`
- 重点 case:
  - `claude-quiz-summary`
  - `claude-summary-rerun`
- 通过条件: 两次都返回 `completed`，直接给出总结，不再出现 `Before I execute this generate workflow...`

### 2. Skill generator

- 问题: `/v1/skills/generator/sessions` 返回 `502 PROVIDER_ERROR`
- 先决条件: 修复 Claude-backed generator session 建立链路。
- 重跑入口:
  - `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-http-validation.mjs`
- 通过条件:
  - session 可创建
  - draft 可生成
  - self-test 可运行
  - evidence 可读取
  - approve/save 可落盘

### 3. Workflow generator

- 问题: `/v1/workflows/generator/sessions` 返回 `502 PROVIDER_ERROR`
- 先决条件: 修复 workflow generator 的 provider/runtime 错误。
- 重跑入口:
  - `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-http-validation.mjs`
- 通过条件:
  - session 可创建
  - draft 可生成
  - publish/run 可完成
  - evidence/export 可读取

### 4. Desktop 真操作

- 问题:
  - runtime 当前仍处于 `safe_mode`
  - 权限缺 `screen_recording`、`input_monitoring`、`automation`
  - 显式 desktop run 还暴露了 Anthropic `tool_use/tool_result` 协议错误
- 先决条件:
  - 给 Friday / Friday Companion 补齐 macOS TCC 授权
  - 修复 desktop tool 结果回传链路
- 重跑入口:
  - `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-targeted-reruns.mjs`
  - 真实手动动作链: 打开低风险应用、输入内容、截图、保存到测试目录、读回结果
- 通过条件:
  - `/v1/health` 不再报告上述 permission pending
  - desktop run 不再报 Anthropic tool 协议错
  - Friday 留下真实用户可见桌面成果

### 5. Self-healing 完整闭环

- 问题: 本轮只能证明 incident/diagnosis/action/evidence 表面存在，不能证明一条新的成功修复闭环。
- 先决条件: 找一个可控且 `autoFixEligible=true` 的低风险失败场景。
- 重跑入口:
  - `/v1/diagnosis/incidents`
  - `/v1/auto-fix/actions`
  - `/v1/auto-fix/actions/:actionId/approve`
  - `/v1/auto-fix/actions/:actionId/execute`
  - `/v1/auto-fix/actions/:actionId/rollback`
- 通过条件:
  - 有新 incident
  - 有新 action
  - 有审批/执行记录
  - 有 verify 结果
  - 验证失败时有 rollback 或 pause/cooldown 证据

### 6. 真正学习 / learned facts

- 问题: 纠正后 `learned-facts` 仍为空，只能证明显式偏好，不足以证明真实学习。
- 先决条件: 打通 learned fact 的可见证据，或至少确认该 API 应该在何时写入。
- 重跑入口:
  - `/v1/uix/preferences`
  - `/v1/uix/persona`
  - `/v1/uix/learned-facts`
- 通过条件:
  - 行为或 persona 有可观察变化
  - `learned-facts` 或等价证据能解释该变化不是硬编码假象

## 已经复测并通过的项

- Sessions canonical 路径:
  - 首轮失败原因是测试请求体错误；按 `chatId` + `sessionKey` 复测后通过。
- Memory canonical 路径:
  - 首轮失败原因是 namespace 非法；按 dot-separated namespace 复测后通过。
- Approval workflow:
  - 首轮失败原因是测试 graph 非法；改为最小合法 `trigger -> approval` graph 后通过。

## 可复用脚本

- `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-http-validation.mjs`
- `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-ui-validation.mjs`
- `/Users/jarvis/Projects/Friday/artifacts/manual/friday-real-validation-2026-03-31/raw/run-targeted-reruns.mjs`

