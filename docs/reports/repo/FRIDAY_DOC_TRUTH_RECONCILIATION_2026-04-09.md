> Status: Current doc reconciliation. Date: 2026-04-09 (America/Los_Angeles)

# Friday 文档真相收敛清单

## 处理原则

当文档与运行时冲突时，本次审计只允许四种动作：

1. 修运行
2. 修文档
3. 隐藏功能
4. 明确标 `experimental / blocked / bounded`

## 本次已完成

| 文件 | 问题 | 动作 | 当前状态 |
| --- | --- | --- | --- |
| `README.md` | 本地桌面浏览器行为仍写 `/agent` | 修文档到 `/command-center` | 已完成 |
| `README.md` | 插件段落容易让人误读成完整 web UI | 增加 “当前是 API-first + Settings 状态可见” 说明 | 已完成 |
| `docs/current-source-of-truth.md` | 插件能力没有明确 UI 边界 | 增加 “当前无 dedicated plugin lifecycle page” | 已完成 |
| `docs/current-source-of-truth.md` | creator-support closeout 链接路径不干净 | 修文档链接 | 已完成 |
| `docs/ops/friday-capability-matrix.md` | Plugin distribution 状态过度乐观 | 改为 `Validated but temporary`，补充 API-first 说明 | 已完成 |
| `docs/ops/friday-capability-matrix.md` | closeout 链接错误 | 修文档链接 | 已完成 |
| `docs/VISION.md` | closeout evidence 链接错误 | 修文档链接 | 已完成 |
| `docs/architecture/marketplace-commerce-rfc.md` | closeout evidence 链接错误 | 修文档链接 | 已完成 |
| `docs/reference/CODE_INDEX.md` | 多个入口文件相对路径错误 | 修文档链接 | 已完成 |
| `docs/ops/friday-cross-platform-downloads.md` | completion checklist 链接路径错误 | 修文档链接 | 已完成 |
| `docs/ops/friday-agent-os-beta-onboarding.md` | companion release guide 链接路径错误 | 修文档链接 | 已完成 |
| `docs/ops/friday-companion-release-macos.md` | beta onboarding / troubleshooting 链接路径错误 | 修文档链接 | 已完成 |
| `docs/ops/friday-autostart-macos.md` | beta onboarding / troubleshooting 链接路径错误 | 修文档链接 | 已完成 |

## 本次确认但未全部处理

| 文件 / 范围 | 问题 | 判断 | 建议 |
| --- | --- | --- | --- |
| `docs/task/marketplace-agent-mvp-blueprint-2026-03-01.md` | 多个 `./src/...` 相对链接显然不是当前正确路径 | 历史任务文档坏链 | 标记 archive/task-only，后续批量修复或冻结 |
| `docs/reports/closeout/non-platform-release-audit/*` | 仍有 `./docs/...` / `./README.md` 型坏链 | 历史 closeout 文档漂移 | 如果仍要给团队频繁引用，需补 link sweep |
| `docs/reports/benchmark/*` | 存在自指或错误相对路径 | 历史 benchmark 文档 | 不作为当前发布真相源 |
| `docs/distributed-architecture.md` | 包含许多 `[Implemented]/[Partial]/[Planned]` 历史状态，且不是 current source of truth | 不是主真相源，但仍可能被误读 | 保持 authority note，必要时再加 archive-style banner |

## 文档层面的真实边界

### Confirmed Facts

- 当前活跃真相源仍是 `docs/current-source-of-truth.md`。
- `README.md`、`docs/VISION.md`、`docs/ops/friday-capability-matrix.md` 是对外叙事的重要辅助层，必须跟运行时对齐。
- archive、closeout、task、benchmark 文档里仍有历史坏链和旧叙事残留。

### Inference

- 当前最大的文档风险不是“没有文档”，而是**老文档会被当成现状**。
- 如果明天发布前不把 active docs 与 archive docs 的角色说清楚，团队内部和外部用户都会被误导。

### Recommendation

1. 明天发布前对外只引用：
   - `README.md`
   - `docs/current-source-of-truth.md`
   - `docs/ops/friday-capability-matrix.md`
   - 本次审计报告集合
2. 对 archive/task/closeout/benchmark 文档做一次统一处理：
   - 保留但显著加 “historical / not current truth” 顶部提示
   - 或者做一次批量 link-check 修复
3. 后续新增发布说明时，优先写在 active docs，不要再把现状埋进 closeout 或 task 文档里。
