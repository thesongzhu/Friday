# Friday x Anthropic Harness 深度诊断

日期: 2026-03-25  
外部基准: Anthropic Engineering 文章《Harness design for long-running application development》，发布于 2026-03-24  
结论类型: 架构级诊断，不是实施方案

## 1. 执行摘要

### 1.1 已确认事实

- Friday 当前不是“单一长时开发 harness”产品，而是一个持续运行的平台内核，核心叙事仍是 supervised / bounded automation，而不是 unrestricted long-running autonomous software engineering。
- Friday 已经具备多项比文章更平台化的基础能力：计划闸门、会话焦点与记忆、工作流与审批、acceptance gate、retry、observability、self-healing agent loop、assistant/template/generator 产品入口。
- Friday 还没有把这些能力收束成一条专门面向“长时应用开发”的主路径。也就是说，Friday 有很多可复用部件，但缺少 Anthropic 文中那种围绕 app-building 任务设计的专用 harness。

### 1.2 诊断结论

1. 整体能不能采纳  
   结论: `部分可采纳，不能整体照搬`

2. 哪些子系统能借  
   结论: 最值得借的是 `planner 扩 spec`、`QA/验收硬阈值`、`handoff artifact`、`模板化入口`；最不适合直接借的是“把 Friday 主产品叙事改写成 unrestricted long-running coding harness”。

3. 适合借模板/局部机制还是整体 harness  
   结论: `优先模板级借法`，不建议先做整体级 harness。

### 1.3 原因摘要

- Anthropic 文章解决的是“如何把一个长时间自主开发任务包进可控脚手架”。
- Friday 当前解决的是“如何把一个受监督的平台运行时做成有证据、有审批、有回滚、有可观测性的操作系统式产品”。
- 两者有交集，但目标函数不同。Friday 若直接照搬，会把当前产品边界从“受监督自动化平台”推向“长时自主工程代理”，这与当前 source of truth 冲突。

## 2. 证据范围

### 2.1 外部基准

- Anthropic 文章明确提出的核心结构包括:
  - `planner` 把 1-4 句需求扩成完整 spec
  - `generator` 分段或分轮实现
  - `evaluator/QA` 用可评分标准和硬阈值验收
  - `sprint contract` 在实现前先约定 done definition
  - 通过文件或结构化工件在 agent 之间交接上下文
  - 随模型能力提升而主动删减脚手架，而不是默认保留全部复杂度

### 2.2 Friday 真值基线

- 当前产品与运行边界以 `docs/current-source-of-truth.md` 为最高优先级。
- 核心实现证据主要来自:
  - `src/hub/friday-hub-bootstrap.ts`
  - `src/agent/runtime/friday-agent-runtime.ts`
  - `src/agent/runtime/friday-agent-planning-gate.ts`
  - `src/sessions/services/friday-session-conversation-orchestrator.ts`
  - `src/sessions/services/friday-session-service.ts` 及 session/fork/memory 相关实现
  - `src/acceptance/engine/acceptance-gate.ts`
  - `src/acceptance/engine/test-suite-runner.ts`
  - `src/workflows/generator/services/friday-workflow-generator-service.ts`
  - `src/skills/generator/services/friday-skill-generator-service.ts`
  - `src/workflows/builder/services/friday-workflow-builder-template-service.ts`
  - `src/uix/services/friday-uix-surface-service.ts`
  - `src/learning/services/friday-agent-loop-service.ts`

## 3. Anthropic 方案拆解为 8 个可比原语

| 原语 | 文章中的作用 | 对 Friday 的诊断意义 |
| --- | --- | --- |
| `planner 扩 spec` | 把短 prompt 扩成完整产品规格 | Friday 是仅做 planning gate，还是能形成产品级 spec |
| `generator 分段交付` | 按 feature / sprint / round 稳定推进 | Friday 是否有显式阶段工件与阶段状态 |
| `evaluator/QA 硬阈值验收` | 用 hard threshold 决定是否通过 | Friday 的 self-test / acceptance / browser QA 哪层是主验收面 |
| `sprint contract` | 先定义 done，再写代码 | Friday 是否有“生成前的可测试契约” |
| `handoff artifact` | 在上下文切换和 agent 间传递状态 | Friday 的 session/focus/fork/memory 是否足够承接 |
| `context reset / compaction` | 长时任务不失控 | Friday 有哪些显式上下文治理手段，是否用于主 agent path |
| `文件化 agent 间通信` | planner/generator/evaluator 通过文件交互 | Friday 是否需要保留这种显式工件，还是应该内建到平台状态里 |
| `随模型能力升级而减脚手架` | 只保留仍然 load-bearing 的结构 | Friday 哪些机制是优化脚手架，哪些已是产品契约 |

## 4. Friday 当前 6 个骨架

| 骨架 | 已确认事实 |
| --- | --- |
| `agent runtime + planning gate` | 已有 `run status`、`planReview`、`awaiting_clarification`、`awaiting_plan_approval`、`self-test`、`tool event`、`artifact persistence`，但没有 app-building 专用 spec/contract/QA 工件层 |
| `session / focus / memory / fork` | 已有 conversation focus、selectedBlocks、reply anchor、fork/merge、memory extraction，适合承载上下文与交接，但目前更偏会话治理而不是开发流程治理 |
| `workflow + NodeRunner` | 已有 deterministic pipeline、approval、cron、deploy/export/product flows；NodeRunner/Acceptance/Retry 更接近平台执行面，而不是 generator harness |
| `acceptance / retry / rules` | 已有 fail-closed acceptance gate、priority checks、rule-linked checks、retry taxonomy 方向；这些能力天然适合作为 evaluator 阈值化执行面 |
| `self-healing agent loop` | 已有 cooldown、approval、rollback、acceptance check requirement、expert mode evidence；更像受监督修复 loop，不是一般性 app-building harness |
| `skill/workflow generator + assistant/template surfaces` | 已有 requirements clarification、draft validation、approve-and-save、templates、wizard/assistant；最接近把 Anthropic 原语产品化为用户入口 |

## 5. 8 x 6 映射判定表

判定图例:

- `具` = 已具备
- `借` = 可直接借用
- `改` = 需重构后借用
- `冲` = 与 Friday 当前产品边界冲突

| Anthropic 原语 \\ Friday 骨架 | Agent Runtime + Planning | Session / Focus / Memory / Fork | Workflow + NodeRunner | Acceptance / Retry / Rules | Self-Healing Agent Loop | Generator + Assistant + Template |
| --- | --- | --- | --- | --- | --- | --- |
| `planner 扩 spec` | `改` | `借` | `改` | `借` | `冲` | `具` |
| `generator 分段交付` | `改` | `借` | `具` | `借` | `改` | `改` |
| `evaluator/QA 硬阈值验收` | `改` | `借` | `借` | `具` | `具` | `借` |
| `sprint contract` | `改` | `借` | `借` | `借` | `冲` | `改` |
| `handoff artifact` | `借` | `具` | `借` | `借` | `具` | `借` |
| `context reset/compaction` | `改` | `借` | `借` | `借` | `冲` | `改` |
| `文件化 agent 间通信` | `改` | `借` | `借` | `借` | `冲` | `改` |
| `随模型能力升级而减脚手架` | `借` | `借` | `改` | `改` | `冲` | `借` |

## 6. 逐项解释

### 6.1 `planner 扩 spec`

#### 已确认事实

- Friday 的 agent planning gate 确实会在某些任务上进入 `awaiting_clarification` / `awaiting_plan_approval`，并生成 plan markdown。
- Friday 的 skill generator 与 workflow generator 都已有 requirements / clarification / draft 生成链路，已经比主 agent runtime 更接近“从模糊需求生成结构化规格”。
- Friday 当前主 agent runtime 的 `planReview` 更像执行前闸门，不是完整产品规格对象。

#### 判断

- 这个原语最适合借到 `generator + assistant + template` 层，而不是直接压到所有 agent turn 上。
- 如果未来要引入 app-building harness，应该复用 generator 的 requirement/session/draft 机制，而不是把 `planReview` 硬扩成全平台 spec 存储。

### 6.2 `generator 分段交付`

#### 已确认事实

- Friday 的 workflow、scheduler、generator、agent-loop 都天然有阶段和状态。
- 但 Friday 主 agent runtime 目前没有文章里那种“一个长时开发任务被拆成 sprint contract -> implement -> QA -> iterate”的显式开发节奏。

#### 判断

- Friday 并不缺“阶段状态机”，缺的是“面向应用开发的阶段语义”。
- 因此这个能力不是从零开始做，而是把已有 workflow/runtime 状态重新包装成开发 harness 的 stage model。

### 6.3 `evaluator/QA 硬阈值验收`

#### 已确认事实

- Friday agent runtime 已有 self-test，但它更轻量，主要围绕 artifact syntax / manifest / graph / generic validation。
- Friday acceptance gate 是 fail-closed 的，并且 test suite runner 已经支持 priority、short-circuit、rule-linked checks、structured evidence。
- Friday self-healing loop 还把 acceptance check、rollback、approval、cooldown 做进了 canonical 产品路径。

#### 判断

- 这是 Friday 与文章最强的契合点。
- 文章里的 evaluator hard threshold，最适合落在 `acceptance / retry / rules`，而不是继续放在 agent runtime 内部当轻量 self-test。
- 如果未来做 app-building harness，QA agent 的“评价”应尽量编译成 acceptance checks、browser QA skills、workflow-level evidence，而不是只保留自然语言 critique。

### 6.4 `sprint contract`

#### 已确认事实

- Friday 有 planning gate，也有 generator clarification，但缺少一个显式的“实现前 contract artifact”，把范围、验收标准、完成定义固定下来。
- `planReview` 当前保存的是计划摘要与批准状态，不是测试契约。

#### 判断

- 这是需要重构后借用的点。
- 最合理的落点不是通用对话 turn，而是:
  - generator draft contract
  - workflow template contract
  - assistant wizard 的 explicit done definition

### 6.5 `handoff artifact`

#### 已确认事实

- Friday 已有 session focus、selectedBlocks、reply anchor、fork/merge、memory extraction、artifact dir、run events。
- 这些机制已经能承载“上一次做到哪、为什么停、下一步是什么、证据在哪里”这类交接信息。

#### 判断

- Friday 在这一项上不弱，甚至比文章更平台化。
- 但它当前承载的是“会话连续性”和“平台证据链”，还不是“开发 harness 的标准交接包”。
- 换句话说，Friday 缺的不是底层存储，而是交接工件 schema。

### 6.6 `context reset / compaction`

#### 已确认事实

- Friday 有 conversation orchestration、selected block 裁剪、workspace context 选择、provider context compactor。
- 但主 agent runtime 并没有一条显式的“长时开发任务 context reset harness”路径；它更依赖会话历史、selected blocks、planning gate、artifact persistence。
- provider context compactor 存在，但更多是通用上下文治理与其他生成路径的能力，不是文章那种围绕 app-building 设计的上下文重置机制。

#### 判断

- Friday 目前能借的是“上下文治理部件”，不能声称自己已经具备文章同等级的开发 harness reset 机制。
- 这项能力适合以后作为 app-building harness 的专门编排层，而不是直接宣称 Friday 主 agent path 已经等同于文章方案。

### 6.7 `文件化 agent 间通信`

#### 已确认事实

- 文章里文件是 agent 协调媒介，因为 harness 在外部编排器层。
- Friday 平台内部已经有更强的持久状态面: sessions、run repo、event repo、draft、acceptance evidence、approval state、observability。

#### 判断

- 这里不应照搬“靠文件沟通”本身。
- Friday 更合适的做法是“保留显式工件，但落到平台状态与 artifact schema 中”，而不是再造一套文件式 agent mailboxes。
- 只有在导出、handoff、debug trace、developer-facing artifact view 时，才需要文件化副本。

### 6.8 `随模型能力升级而减脚手架`

#### 已确认事实

- 文章反复强调 harness complexity 不是常量，要随模型能力演进删掉不再 load-bearing 的部分。
- Friday 当前不少机制已经不是“优化脚手架”，而是公开产品契约: approval、rollback、observability、audit、acceptance、cooldown。

#### 判断

- Friday 不能像文章那样把很多结构都视作可自由删减的实验脚手架。
- 可删减的应该是“开发 harness 专用组织形式”，不该删的是“对外承诺的产品边界与证据链”。

## 7. 对 6 个诊断场景的直接回答

### 场景 1: 单句模糊需求进入系统时，Friday 现在是“做计划闸门”还是“真正扩成产品 spec”？

#### 已确认事实

- 主 agent path 当前更接近“做计划闸门”。
- 真正接近“扩成产品 spec”的能力主要集中在 skill/workflow generator。

#### 判断

- Friday 今天不能把主 agent runtime 等同于文章里的 planner。
- 如果想借这个点，最合理的切入面是 generator session，而不是所有对话都先进入 heavyweight spec expansion。

### 场景 2: 任务持续数小时、上下文增长、阶段性失败时，Friday 现有机制是否能稳定承接？

#### 已确认事实

- Friday 有 selectedBlocks、focusState、fork、memory extraction、artifact persistence、event repository、agent-loop cooldown。
- Friday 缺少一个 app-building 专用的 context reset + handoff contract 编排层。

#### 判断

- Friday 能“部分承接”，但不应夸大为已经具备文章完整长时开发 harness。

### 场景 3: 产物看起来完成但核心功能是 stub 时，哪一层最能抓住问题？

#### 已确认事实

- 轻量 self-test 只能抓部分问题。
- acceptance gate、browser QA、workflow evidence、self-healing verification 才是更强的验收面。

#### 判断

- 未来若借文章 evaluator，主落点应是 acceptance/browser QA/evidence，不应主要押注 self-test。

### 场景 4: 高风险修复、回滚、审批、重复失败暂停时，文章式长时自治与 Friday 边界哪里冲突？

#### 已确认事实

- Friday source of truth 明确要求 supervised defaults、approval、rollback、evidence、repeated failure halt。
- self-healing agent loop 已把这些变成 steady-state contract。

#### 判断

- 文章里“长时自主开发”所允许的自治度，不能直接映射到 Friday 当前公开边界。
- 一旦触及高风险修复、生产敏感动作、不可逆操作，Friday 的产品契约优先级高于 harness 自主性。

### 场景 5: 模板入口与完整 harness 之间，Friday 更适合先借哪一级？

#### 已确认事实

- Friday 已有 assistant templates、wizard、skill/workflow generator、workflow templates。

#### 判断

- 明确建议先借 `模板级借法`:
  - planner spec -> generator draft contract
  - QA criteria -> acceptance/browser QA template
  - handoff artifact -> assistant / workflow draft evidence pack
- 不建议先上平台级“整体 harness”。

### 场景 6: 模型能力提升后，哪些脚手架可删，哪些不能删？

#### 已确认事实

- 文章中很多结构是实验性 harness scaffold。
- Friday 当前很多结构已经是产品承诺。

#### 判断

- 可以删减:
  - app-building harness 的阶段拆分细节
  - agent 之间人为文件往返
  - 对某些模型已不再必要的微型中间步骤
- 不能删减:
  - approval
  - rollback
  - acceptance evidence
  - observability / audit
  - repeated-failure halt

## 8. Candidate Interface Surfaces

这一轮不建议改 public API，但若未来采纳，最可能触及以下接口面:

1. `agent runtime`
   - 现状: `planReview + run status + self-test`
   - 潜在变化: 增加面向开发 harness 的 `spec / contract / verdict` 工件层

2. `sessions`
   - 现状: `focusState / selectedBlocks / fork / memory extraction`
   - 潜在变化: 增加标准化 handoff artifact，而不是只依赖 conversation continuity

3. `workflow / NodeRunner / acceptance`
   - 现状: 已适合承载 hard-threshold evaluator
   - 潜在变化: 将 QA verdict 正式编译为 acceptance + browser evidence + retry/rollback policy

4. `assistant / templates / generators`
   - 现状: 最接近产品化入口
   - 潜在变化: 把文章方法落成 starter skill、workflow template、assistant wizard、generator draft contract

## 9. 明确不建议照搬的部分

### 9.1 已确认事实

- Friday 当前 source of truth 明确把自己定义为 supervised, bounded automation system。
- Friday 的 self-healing、observability、approval、rollback、audit 都是产品契约，而不是可随意替换的实验脚手架。

### 9.2 不建议照搬

- 不建议把 Friday 主产品重新表述为“长时自主 app builder”
- 不建议把文件式 agent 通信当作主协调机制
- 不建议把自然语言 evaluator critique 直接当最终验收层
- 不建议为了模仿文章而削弱 approval、rollback、observability、halt 机制

## 10. 最终结论

### 10.1 已确认事实

- Friday 已有足够多的底层能力，可以吸收 Anthropic 文章中的若干核心思想。
- Friday 目前缺少的是“把这些能力组织成专门的 long-running app-development harness”的产品层。

### 10.2 最终判断

- `整体采纳`: 否
- `部分采纳`: 是
- `优先借用方向`: 模板级借法 > 整体级 harness
- `最适合借的部件`: planner spec、QA hard thresholds、handoff artifact schema、模型升级后的脚手架裁剪原则
- `最不适合借的部件`: 把 Friday 变成 unrestricted long-running autonomous coding product 的叙事与默认行为

## 11. 后续最关键的问题

以下是下一轮应优先回答的问题，但它们属于后续蓝图，不属于本诊断的结论本体:

1. Friday 若做 v1 app-building harness，它是 `assistant template / wizard`，还是 `workflow product`，还是 `generator family` 的一部分？
2. `spec / sprint contract / QA verdict / handoff artifact` 四类工件，哪些要进入统一 schema，哪些只做导出 artifact？
3. evaluator 的主要执行面应放在 `browser-qa + acceptance` 还是额外新增一个专用 QA agent？
4. 哪些 harness 结构是可裁剪的“优化层”，哪些属于 Friday 不能动的产品契约？

## 12. 一句话结论

Anthropic 这篇文章对 Friday 的启发，不是“把 Friday 变成那套 harness”，而是“把 Friday 现有的平台能力，收束成一条受监督、可验收、可交接、可模板化的开发型 product path”。
