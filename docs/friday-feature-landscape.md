# Friday 功能地图与体验路线

这份文档描述 Friday 当前应该向用户呈现的能力地图。它不是承诺“万能”或“完全自动”，而是说明 Friday 如何把用户目标变成可执行、可验证、可复用的闭环。

## 一、核心认知

Friday 的目标不是把所有功能堆给用户看，而是让用户相信三件事：

1. **我知道 Friday 现在能做什么。**
2. **我知道 Friday 缺什么、去哪配、配完怎么验证。**
3. **我知道哪些事情 Friday 会自己做，哪些事情必须问我。**

用户不应该被迫理解文本模型、视觉模型、OCR、embedding、web search、PDF parser、MCP、workflow、skill、渠道、桌面权限这些内部概念。Friday 应该自己检查、路由、补齐能力，并在需要人类时说清楚。

## 二、四层能力地图

```text
用户目标
  |
  v
感知层: Home / Chat / Setup / Assistant / Settings / Channels
  |
  v
编排层: capability check / planning / approval / workflow / skill routing
  |
  v
能力层: models / web / OCR / PDF / files / browser / desktop / MCP / channels
  |
  v
成长层: memory / recipes / routing lessons / evals / failure lessons / rollback
```

## 三、用户能直接感受到的能力

| 能力 | 用户应该看到什么 | 体验要求 |
| --- | --- | --- |
| 对话与执行 | Friday 能回答、执行、汇报进展、失败时说明原因 | 语气直接、有人味、不像模板机器人 |
| Setup | 配 provider、渠道、权限、能力矩阵 | setup 完成后直接进 Home |
| Provider truth | 当前实际路由、模型、状态、备用 provider | 不显示误导性的旧 provider 名 |
| 能力检查 | 文本、视觉、OCR、web、PDF、file、browser、skills、workflow 等状态 | 缺什么说清楚 |
| 渠道控制 | Discord/Telegram/飞书等渠道可以给 Friday 发任务 | 高风险动作仍要确认 |
| 记忆 | Friday 记住偏好、规则、失败教训 | 用户能看到、纠正、暂停 |
| 自我修复 | 失败后诊断、提出修复、验证、回滚 | 不隐藏失败，不无限重试 |
| 能力自获取 | 缺能力时找候选、生成 skill、沙箱验证、注册 | 未验证前不能标 available |
| 长期目标 | 用户授权 standing goal 后生成 agenda 并执行低风险步骤 | 可暂停、可删除、可审计 |

## 四、关键闭环

### 1. 目标闭环

```text
用户说目标 -> Friday 拆能力 -> 找工具/skill/workflow -> 执行 -> 验证 -> 汇报
```

### 2. 缺能力闭环

```text
缺口 -> 候选来源 -> 沙箱/测试 -> 审批 -> 安装/注册 -> doctor 验证 -> 可用
```

### 3. 失败修复闭环

```text
失败 -> 诊断 -> 修复计划 -> 低风险执行或审批 -> 验证 -> 回滚/沉淀教训
```

### 4. 成长闭环

```text
成功/失败 -> memory -> routing/recipe/skill/eval 更新 -> 下次更稳
```

## 五、必须清楚展示的边界

Friday 必须停下来问用户的情况：

- API key
- OAuth / 登录
- 付款 / 账单
- 验证码
- 外部账号开通
- macOS 权限
- 敏感文件或桌面权限
- 生产写操作
- 不可信代码安装
- 高风险 shell / browser / desktop 动作

Friday 不能把这些算作“已完成”。它应该说：

```text
我缺 X。原因是 Y。你需要去 Z 配置。配完我会跑 A 来验证。
```

## 六、当前体验优先级

### Phase 1: 让 setup 不挡路

- setup 完成后直接进 Home
- 本地 session 失败给出可恢复页面
- Provider truth 显示真实路由
- 沟通风格不再作为 first-run 阻塞步骤

### Phase 2: 让能力可见

- 能力矩阵清楚展示 available / missing / human blocker / needs review
- 每个缺能力项都有配置入口和验证动作
- provider/channel/skill/workflow 都有 doctor 或代表性任务

### Phase 3: 让执行透明

- 进展汇报短、直接、有人味
- 失败话术说原因，不甩锅
- 工具调用和 workflow 结果有 evidence
- 高风险审批理由可读

### Phase 4: 让成长可控

- 用户能看到 learned facts
- 用户能改偏好和记忆
- 失败沉淀成 eval 或 recipe
- 自我修复有回滚和审计
- standing goals 可以暂停和删除

## 七、设计原则

- 首屏展示真实产品，不做空泛宣传页。
- 普通用户不需要懂内部术语。
- 技术用户可以看到真实证据。
- 不用“万能”“完全自动”这类承诺。
- 不把缺 key、缺账号、缺权限的任务伪装成成功。
- 渠道可以控制 Friday，但不能绕过系统安全边界。
- 记忆和自我成长必须用户可见、可审计、可撤销。

## 八、相关文档

- [README 中文版](../README.zh-CN.md)
- [能力矩阵](ops/friday-capability-matrix.md)
- [闭环蓝图](BLUEPRINT-CLOSED-LOOP.md)
- [愿景](VISION.md)
- [故障排查](TROUBLESHOOTING.md)
