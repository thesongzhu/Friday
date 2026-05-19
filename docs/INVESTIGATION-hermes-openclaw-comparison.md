# Friday vs Hermes vs OpenClaw 竞品对比调研报告

> Status: historical/internal research note. This document is not current
> Friday product truth, public release proof, or an external factual benchmark.
> Use the current README, ROADMAP, and release evidence policy for shipped
> claims; use this note only as dated research context.
>
> 调研日期: 2026-04-14
> 来源: 抖音 @VA7 视频 + 评论区用户反馈
> 分支: claude/keen-blackburn

---

## 一、信息来源摘要

### 视频核心观点 (@VA7, 1741赞, 157评论)

**结论**: Hermes（爱马仕）比 OpenClaw（龙虾）有明显更完善的 harness，在人机系统中的体验更接近**数字员工**。

**四个对比维度** (视频顶部标签):
1. 记忆机制对比
2. 更稳定的多 agent 架构
3. 主动沉淀 skill
4. 消息队列

**视频字幕关键信息**:
- OpenClaw 的记忆文档 vs Hermes 的记忆机制
- 每一次做错题集搜索时，留出空间给更重要的事情
- 每一个 agent 独享一个 Gateway
- agents 架构更稳定
- 每一个进程有什么权限（进程级权限隔离）
- 有一个独立的 agent 会出来审计
- 作者团队正在从 OpenClaw 迁移到 Hermes

### 评论区核心痛点

| 用户 | 反馈 |
|------|------|
| 轩窗临 | 给 Hermes 下复杂任务，执行几步就卡住，需手动催促才继续 |
| 听雨御风 | 跟它说不要停也没用 |
| Archive | 说后台在运行但基本就结束了 |
| 喵肥的熊 | OpenClaw 迭代快，能连续更新5个版本，Hermes 生态做不到 |
| 一周说 | OpenClaw 优势是多智能体逻辑，AutoGPT 也牛 |

---

## 二、Friday 对标分析

### 2.1 记忆机制

**结论: Friday 的记忆系统在架构上全面超越两者**

| 特性 | Friday | Hermes | OpenClaw |
|------|--------|--------|----------|
| **搜索方式** | FTS5 + 语义向量混合 (45:55权重) | 语义搜索为主 | 文档型记忆 |
| **记忆类型** | 5种语义类型 (fact/preference/procedure/episode/correction) | 分类记忆 | 通用键值 |
| **错题集** | 明确的 correction 类型 + PatternExtractor 自动分析 | 有 | 依赖底层代码修改 |
| **去重** | 自动语义去重 (阈值0.92) + 置信度boost | 未知 | 未知 |
| **过期管理** | TTL + 手动过期 + 自动裁剪 | 未知 | 无 |
| **World State** | 实体追踪 + 关系图 + 情景记忆 (500条/用户) | 有 | 无 |
| **降级容错** | FTS → 语义 → 子串匹配 三级降级 | 未知 | 未知 |

**关键代码路径**:
- `src/memory/search/friday-memory-hybrid.ts` — 混合搜索引擎
- `src/memory/services/friday-memory-dedup.ts` — 自动去重
- `src/memory/services/friday-pattern-extractor.ts` — 模式学习
- `src/agent/runtime/friday-agent-world-state-manager.ts` — 世界状态建模
- `src/learning/services/friday-learning-feedback-loop-service.ts` — 反馈闭环

**Friday 的差异化优势**:
- 混合搜索比纯语义搜索更鲁棒（关键词精确匹配 + 语义泛化）
- 错题集不只是存储，还通过 PatternExtractor 自动发现 failure_mode / tool_sequence / temporal / preference 四种模式
- 置信度机制让高频确认的记忆权重更高

---

### 2.2 多 Agent 架构 & Gateway & 权限隔离

**结论: Friday 有多 agent 架构但进程隔离不如 Hermes**

| 特性 | Friday | Hermes | OpenClaw |
|------|--------|--------|----------|
| **多 Agent** | SubagentRegistry, 5种profile (explore/plan/debug/review/execute) | 多 agent + 独立 Gateway | 多智能体逻辑 |
| **Gateway** | 单一中心化 Gateway (状态/重启/配置) | 每个 agent 独享 Gateway | 未知 |
| **进程隔离** | 内存隔离 (同一 Node.js 进程) | OS 级进程隔离 | 未知 |
| **审计** | SHA-256 哈希链审计日志 + JSONL 文件 | 独立审计 agent | 未知 |
| **权限模型** | 3层: PolicyEngine + PermissionGuard + DelegationPolicy | 进程级权限 | 未知 |

**关键代码路径**:
- `src/agent/subagent/friday-subagent-registry.ts` — 子 agent 生命周期 (512行)
- `src/hub/services/friday-gateway-service.ts` — 中心化 Gateway
- `src/security/multi-tenant/engine/policy-engine.ts` — 策略引擎
- `src/observability/engine/audit-trail.ts` — 防篡改审计链

**Friday vs Hermes 的差距**:
- **Gateway 不是 per-agent 的**: Friday 所有 agent 共享一个 Gateway，而 Hermes 每个 agent 有独立 Gateway。这意味着 Hermes 的 agent 自治性更强。
- **进程隔离缺失**: Friday 所有 agent 运行在同一个 Node.js 进程中，通过 SQLite 事务实现数据隔离。Hermes 使用 OS 级进程隔离，安全性更高。
- **没有独立审计 agent**: Friday 的审计是中心化的日志记录，而 Hermes 有专门的 agent 来做审计（更接近"数字员工"互相监督的模式）。

**Friday 的现有优势**:
- 子 agent 有明确的 profile 分工和资源约束 (深度限制3层, 并发限制5个, 超时3分钟)
- 审计链使用密码学哈希防篡改，比简单日志更安全
- DelegationPolicy 的启发式分类 (status/query/action/synthesis) 使任务路由更智能

---

### 2.3 任务卡住 / 自主执行 / 进度报告

**结论: Friday 已有完善的防卡机制，评论区用户痛点在 Friday 中已解决**

| 特性 | Friday | Hermes (用户反馈) | OpenClaw |
|------|--------|------------------|----------|
| **防卡机制** | 5分钟 LLM 超时 + 5分钟全局超时 + 100次迭代上限 | 复杂任务执行几步就卡 | 未知 |
| **进度通知** | 30秒首次通知 + 60秒心跳 + 阶段变化即时通知 | 设了每小时报告也只报一次 | 未知 |
| **自主续行** | Expert Autonomy Loop + checkpoint + resume | 需要人工催促 | 多智能体自动 |
| **上下文压缩** | 40条消息阈值压缩，保留最近8条 | 未知 | 未知 |
| **崩溃恢复** | 启动时标记 stale runs 为 failed | 未知 | 未知 |

**关键代码路径**:
- `src/agent/runtime/friday-agent-runtime.ts` — 主执行循环 (1800+行)
  - L1439: `while (iterations < 100)` 有界循环
  - L1516: 5分钟 LLM watchdog
- `src/channels/friday-channel-slow-task-notifier.ts` — 心跳通知
  - L118: 30秒首次通知
  - L109: 60秒心跳间隔
  - L131: 阶段变化即时推送
- `src/learning/services/friday-agent-loop-service.ts` — 专家自主循环
- `src/agent/runtime/friday-agent-run-checkpoint.ts` — 检查点与回滚
- `src/agent/autonomous/friday-autonomous-engine.ts` — 感知-行动自主循环

**评论区用户痛点 vs Friday 的解决方案**:

1. **"执行几步就卡住"** → Friday 的 100 次迭代硬限制 + 5分钟 watchdog 确保不会静默卡死
2. **"需要手动催"** → Friday 的 Expert Autonomy Loop 支持有界自主执行 (最多20分钟, 4步探测预算)
3. **"进度报告不主动"** → Friday 的 SlowTaskNotifier 30秒后自动开始推送，60秒心跳
4. **"说不要停也没用"** → Friday 的执行循环是硬编码的 while 循环，不依赖 LLM "决定"是否继续

---

### 2.4 主动沉淀 Skill

**结论: Friday 采用"快学慢推"策略，比 Hermes 更安全但沉淀速度慢**

| 特性 | Friday | Hermes | OpenClaw |
|------|--------|--------|----------|
| **自动学习** | Preference 自动提取 + 模式识别 | 主动沉淀到 skill | 可修改底层代码 |
| **skill 生成** | 仅限显式请求或 playbook 晋升 | 自动从交互中创建 | 快速迭代 |
| **安全机制** | KPI 门槛 (35%复用率, 20%成功提升, <1%回滚率) | 未知 | 无 |
| **晋升流程** | candidate → KPI评估 → active → 版本管理 → 可回滚 | 直接沉淀 | 直接修改 |

**关键代码路径**:
- `src/playbook/engine/playbook-learning-loop.ts` — Playbook 学习闭环
- `src/playbook/engine/promoter-job.ts` — KPI 门控晋升
- `src/learning/services/friday-auto-fix-lesson-extraction-service.ts` — 自动修复经验提取
- `src/agent/services/friday-agent-automation-service.ts` — 自动化晋升 (private→team→public)

**Friday 的设计哲学**: "Learn fast, promote slow" (快学慢推)
- 学习阶段快: 每次交互自动提取偏好、模式、错误签名
- 晋升阶段慢: 必须通过 KPI 门槛才能从 candidate 变成 active playbook
- 优势: 防止低质量 skill 污染系统
- 劣势: 用户感知不到"主动沉淀"的即时反馈

---

### 2.5 消息队列

**结论: Friday 的事件系统远超简单消息队列，但分布式场景未完全覆盖**

| 特性 | Friday | Hermes | OpenClaw |
|------|--------|--------|----------|
| **事件总线** | 流式事件总线 + WebSocket 网关 | 消息队列 | 未知 |
| **持久化** | SQLite 事件持久化 + 序列号 | 未知 | 未知 |
| **Dead Letter** | 有 DLQ (最多1000条, FIFO淘汰) | 未知 | 未知 |
| **卫星协调** | Outbox Queue + 租约 + 指数退避重试 | 未知 | 未知 |
| **订阅模型** | Topic-based + RBAC + stream 过滤 | 未知 | 未知 |

**关键代码路径**:
- `src/api/realtime/friday-realtime-event-bus.ts` — 中心事件总线
- `src/satellites/services/friday-outbox-queue-service.ts` — 卫星 Outbox
- `src/retry/engine/dead-letter-queue.ts` — 死信队列
- `src/api/realtime/friday-realtime-ws-gateway.ts` — WebSocket 网关

---

## 三、整体对比矩阵

| 维度 | Friday | Hermes | OpenClaw |
|------|--------|--------|----------|
| **记忆** | ★★★★★ 混合搜索+5类型+去重+降级 | ★★★★ 好的记忆机制 | ★★★ 文档型记忆 |
| **多 Agent** | ★★★★ 完整但单进程 | ★★★★★ 进程隔离+独立Gateway | ★★★★ 多智能体逻辑 |
| **防卡/自主** | ★★★★★ 多层超时+心跳+自主循环 | ★★★ 用户反馈会卡 | ★★★★ 多agent自驱 |
| **Skill 沉淀** | ★★★★ 安全但慢 | ★★★★★ 主动沉淀 | ★★★★ 快速迭代 |
| **消息/事件** | ★★★★★ 流式+DLQ+Outbox | ★★★★ 消息队列 | ★★★ 未知 |
| **迭代速度** | ★★★ 正常 | ★★★ 生态慢 | ★★★★★ 极快 |
| **开放性** | ★★★ 自有架构 | ★★★ 闭源倾向 | ★★★★★ 可改底层代码 |

---

## 四、建议改进方向

### 高优先级 (竞品优势 + 用户痛点)

1. **Per-Agent Gateway 隔离** — 让每个子 agent 有独立的 Gateway 实例，提升自治性和容错性
   - 当前: `src/hub/services/friday-gateway-service.ts` 单一实例
   - 建议: 实现 `FridayPerAgentGateway` wrapper，每个 SubagentRegistry spawn 时创建

2. **独立审计 Agent** — 创建专门的审计 agent profile，定期检查其他 agent 行为
   - 当前: `src/observability/engine/audit-trail.ts` 被动记录
   - 建议: 新增 `audit` profile 到 SubagentProfile，定时触发

3. **主动 Skill 沉淀的用户感知** — 在学习阶段给用户可见的反馈
   - 当前: 学习在后台静默进行
   - 建议: 学习事件通过 SlowTaskNotifier 推送给用户（"我注意到你经常...，已保存为偏好"）

### 中优先级 (架构增强)

4. **OS 级进程隔离 (可选)** — 对高风险 `execute` profile 的 agent 使用 `worker_threads`
   - 不需要全部改，只对 `execute` 模式的子 agent 增加隔离选项

5. **Playbook 快速通道** — 对高置信度模式 (confidence > 0.9, occurrences > 5) 提供自动晋升
   - 降低 KPI 门槛对高频成功模式的限制

### 低优先级 (差异化)

6. **学习进度可视化** — 在 UI 展示 learning lifecycle 进度 (cold_start → warmup → steady_state)
7. **对比模式** — 提供与竞品的功能对比页面作为营销材料

---

## 五、结论

**Friday 在大部分维度上已经超越或持平竞品**，特别是在记忆系统、防卡机制、消息队列方面。

**核心差距**在于:
1. 多 agent 的进程隔离和独立 Gateway（Hermes 的优势）
2. Skill 沉淀的即时感知（Hermes 的优势）
3. 底层代码可修改性和迭代速度（OpenClaw 的优势）

**Friday 的哲学差异**: Friday 采用"安全优先"的设计，宁可慢一步也要确保质量（KPI 门控、哈希链审计、三级降级搜索）。这与 Hermes 的"体验优先"和 OpenClaw 的"速度优先"形成差异化定位。
