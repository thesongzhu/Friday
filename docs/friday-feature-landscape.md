# Friday 全景功能地图 & UX 路线规划

## 一、核心认知

Friday 不是一个"功能不够"的产品。它有 **172 个功能**，覆盖 agent 执行、技能生态、工作流引擎、自学习/自修复、多通道、分布式执行、市场/创作者经济、可观测性等完整栈。

**真正的问题是**：这些能力绝大多数藏在后端或高级页面里，用户感知不到。用户打开 Friday，看到的是一个"聊天框 + 几个卡片"，不知道背后有一整个操作系统在运行。

---

## 二、四层架构

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: 用户感知层 (What users see & feel)                  │
│                                                             │
│  23 个页面 · 4 主入口 · 12 高级页 · 7 特殊路由                │
│  Home / Chat / Packs / Assistant                            │
│  + Skills / Workflows / Automations / Memory / MCP / ...    │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: 交互编排层 (How intent becomes action)              │
│                                                             │
│  Agent Runtime · Guided Flows · Playbooks · Workflows       │
│  Sub-agent delegation · Approval gates · Plan review        │
│  → 用户说"我要..."，系统自动编排执行路径                      │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: 智能层 (How Friday learns & adapts)                 │
│                                                             │
│  Learning pipeline · Preference extraction · Persona        │
│  Memory (semantic + FTS) · Pattern recognition              │
│  Lessons · Diagnosis · Auto-fix · Utility calculator        │
│  → 用得越多越懂你，错误自动诊断修复                           │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: 基础设施层 (What keeps it running)                   │
│                                                             │
│  SQLite · 10+ Channels · Auth/RBAC · Observability          │
│  Retry/Circuit breaker · Fleet/Satellites · Providers       │
│  Rules engine · Acceptance testing · Realtime (WS/SSE)      │
│  → 用户不需要知道这些存在，但它们保证可靠性                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、功能分类与暴露状态

### A. 用户直接感知的核心功能 (Core User Surface)

| 功能 | 当前 UI | 问题 |
|------|---------|------|
| 聊天/对话 | ✅ Chat page | 缺少文件上传、语音输入 |
| 任务首页 | ✅ Home page | 好，但与 agent 执行断裂 |
| 行业包 | ✅ Packs page | 好，缺搜索/过滤 |
| 助手收件箱 | ✅ Assistant page | 好，缺 inline 审批按钮 |
| 引导流程 | ✅ Guided flow | 好，但入口不明显 |
| Onboarding | ✅ 4步引导 | 好 |
| 人格设置 | ✅ Settings page | 好，但用户不知道"学到的偏好"在哪 |

### B. 高级用户可发现的功能 (Power User Surface)

| 功能 | 当前 UI | 问题 |
|------|---------|------|
| 技能管理 | ✅ Skills page | 只读为主，缺 inline 编辑 |
| 技能生成器 | ✅ Generator page | 好 |
| 工作流编辑器 | ✅ Builder page | 好，但与主列表割裂 |
| 自动化任务 | ✅ Automations page | 缺编辑已有任务 |
| 记忆管理 | ⚠️ Memory page | 基础 CRUD，缺知识图谱 |
| 会话历史 | ⚠️ Sessions page | 无本地化，缺日期过滤 |
| MCP 服务器 | ⚠️ MCP page | 只读状态，缺添加/配置 |
| 用量仪表盘 | ⚠️ Usage page | 只读，缺历史趋势图 |
| 可观测性 | ⚠️ Observability page | 内容多但不直觉 |
| 设备集群 | ⚠️ Fleet page | 状态查看，缺控制操作 |
| 市场 | ⚠️ Marketplace page | 浏览 ≠ 创建不对称 |
| 操作控制台 | ⚠️ Agent page | 面向高级运维 |

### C. 后端有但用户完全看不到的能力 (Hidden Capabilities)

| 能力 | 用户价值 | 缺失的 UI |
|------|---------|-----------|
| **Playbook 学习引擎** | Friday 在学你的操作模式 | 无法看到/管理学到的 pattern |
| **规则/策略引擎** | 定义 agent 行为约束 | 无可视化规则编辑器 |
| **10+ 通道适配器** | 连接 Discord/Slack/微信/飞书 | 无一键连接向导 |
| **桌面自动化** | 录制回放桌面操作 | 无独立入口 |
| **浏览器自动化** | 自动填表、截图、抓取 | 无独立操作面 |
| **重试/熔断器** | 自动重试失败操作 | 无可视化重试策略 |
| **验收测试框架** | 测试 agent 输出质量 | 无测试定义 UI |
| **SLO/错误预算** | 服务质量承诺 | 未集成到主仪表盘 |
| **创作者分润** | 技能/工作流变现 | 无创作者工作台 |
| **PII 检测** | 自动脱敏 | 用户不知道已保护 |
| **心跳系统** | 后台定时维护 | 无状态面板 |
| **能力授权链** | 精细权限管理 | 无授权管理 UI |
| **Deep Link 协议** | 一键导入配置 | 入口隐蔽 |
| **语义搜索** | 跨记忆智能搜索 | 搜索能力未突出 |

---

## 四、功能互联地图 (Cross-Layer Connections)

```
用户说"我要..."
    │
    ▼
┌─Chat/Guided Flow─┐
│  意图理解         │──→ Pack 匹配 ──→ 快捷操作
│  上下文加载       │──→ Memory 语义搜索
│  Persona 注入     │◄── 偏好系统 ◄── 学习管道
└────────┬──────────┘
         │
         ▼
┌──Agent Runtime──┐
│  Planning       │──→ Playbook 模式匹配 (用户看不到)
│  Tool Selection │──→ Skills / Browser / Desktop / MCP
│  Sub-agent      │──→ 分发到 Satellite (用户看不到)
│  Streaming      │──→ WebSocket → Chat UI
└────────┬────────┘
         │
    成功? ──→ Lesson 提取 ──→ 下次更快更准
    失败? ──→ 诊断 ──→ 自动修复提案 ──→ 审批 ──→ 执行
         │
         ▼
┌──Observability──┐
│  Trace/Span     │──→ 可视化执行路径 (用户看不到全貌)
│  Audit Log      │──→ 不可篡改记录
│  Alerts         │──→ 通知 (Toast only, 缺持久通知)
└─────────────────┘
```

### 关键断裂点

1. **学习是隐形的** — Friday 在学习，但用户不知道它学了什么、怎么学的
2. **自修复是隐形的** — 错误自动诊断修复，但用户看不到过程
3. **Playbook 完全隐形** — 最智能的功能没有任何 UI
4. **通道连接是配置级的** — 10+ 通道需要环境变量配置，无向导
5. **执行路径是黑盒** — agent 为什么选这个工具、这个方案，用户不知道
6. **记忆是被动的** — 用户不能主动"教" Friday，只能被动提取

---

## 五、UX 路线图

### Phase 0: 当下必须修的 (Already Done ✅)
- [x] API 错误状态 (MCP/Sessions/Usage)
- [x] 路由本地化 (12 条)
- [x] 安全加固 (WebSocket Origin, 输入边界)

### Phase 1: "让用户感受到智能" (Intelligence Visibility)
**目标**: 让用户看到 Friday 在学习、在思考、在变聪明

| 改动 | 用户感受 | 复杂度 |
|------|---------|--------|
| 学习状态仪表盘 | "它知道我喜欢简洁" | 中 |
| 执行推理可视化 | "它选了这个方案因为..." | 中 |
| Playbook 透明面板 | "它记住了我上次怎么做" | 中 |
| 自修复通知 | "它自动修好了一个错误" | 低 |
| 偏好面板 | "我可以直接告诉它我想要什么" | 低 |

### Phase 2: "让操作更顺滑" (Interaction Flow)
**目标**: 减少页面跳转，让核心操作在 1-2 步内完成

| 改动 | 用户感受 | 复杂度 |
|------|---------|--------|
| 通道一键连接向导 | "3 步连上 Slack" | 中 |
| Inline 技能编辑 | 不用跳页面 | 低 |
| 自动化任务编辑 | 现在只能新建不能改 | 低 |
| 命令面板增强 | Cmd+K 搜索一切 | 中 |
| 全局搜索 | 跨记忆/技能/工作流搜索 | 高 |
| 拖拽排序 + 批量操作 | 记忆/技能/自动化 | 中 |

### Phase 3: "让它变漂亮" (Visual Polish)
**目标**: 从"能用"到"想用"

| 改动 | 效果 | 复杂度 |
|------|------|--------|
| Skeleton loading screens | 不再显示"Loading..." | 低 |
| 动画过渡 | 页面切换、卡片展开 | 中 |
| 知识图谱可视化 | 记忆变成可探索的图 | 高 |
| 工作流执行动画 | DAG 节点逐个亮起 | 中 |
| 深色模式完善 | 目前有变量但不完整 | 中 |
| 移动端精调 | 手势、小屏适配 | 中 |

### Phase 4: "让它超越时代" (Next-Gen UX)
**目标**: 没有人见过的交互方式

| 概念 | 描述 |
|------|------|
| 意图感知首页 | 根据时间/上下文自动显示最可能需要的操作 |
| 自然语言万物控制 | 在任何页面打字 → 自动路由到对应功能 |
| 执行时间线 | 类 Git graph 的 agent 决策树可视化 |
| 协作记忆 | 用户和 Friday 共同维护的知识库 |
| 自适应 UI | 根据用户习惯自动调整布局和快捷方式 |
| 离线就绪 | PWA + 离线 cache，网络断了还能用 |

---

## 六、本地化状态

| 区域 | 中文覆盖 |
|------|---------|
| 核心4页 (Home/Chat/Packs/Assistant) | ✅ 95%+ |
| Onboarding/Settings | ✅ 90%+ |
| Workflows/Automations | ✅ 85%+ |
| Router loading messages | ✅ 100% (刚修) |
| Skills/Fleet/Guided Flow | ⚠️ 60-80% |
| Sessions/Usage/MCP/Memory | ❌ 0-20% |
| Observability | ❌ 10-30% |

---

## 七、设计语言现状

| 组件 | 状态 |
|------|------|
| ShellCard (页面卡片) | ✅ 统一 |
| StatusPill (状态徽章) | ✅ 统一 |
| ActionButton (操作按钮) | ✅ 统一 |
| FieldLabel (表单标签) | ✅ 统一 |
| LiveIndicator (实时指示) | ✅ 统一 |
| CSS Variables (主题变量) | ✅ 15+ 变量 |
| Skeleton Loading | ❌ 不存在 |
| 动画系统 | ❌ 仅 bounce dots |
| Toast 通知 | ✅ Sonner |
| 持久通知中心 | ❌ 不存在 |
| 键盘快捷键 | ❌ 不存在 |
| ARIA 无障碍 | ❌ 仅 2 处 |
