> Status: Current test triage. Date: 2026-04-09 (America/Los_Angeles)

# Friday 测试资产处置表

## 当前测试盘点

### Confirmed Facts

- 当前测试总量约 `757` 个文件（含 `*.test.ts` 与 `*.test-d.ts`）。
- `test/**/*.test.ts` 中约有：
  - `unit`: `636`
  - `integration`: `51`
  - `e2e`: `42`
  - `contracts`: `8`
  - `adversarial`: `13`
  - `performance`: `2`
  - `property`: `4`
- `npm test` 运行 `default + typecheck + llm-e2e`，**不包含** `browser-e2e`。
- `release:verify` 才会补跑 `npm run test:e2e:ui`、OpenClaw overlap、install smoke、release check。

## 分类结果

| 资产 / 套件 | 当前分类 | 是否真在发布脚本里跑 | 备注 | 处置建议 |
| --- | --- | --- | --- | --- |
| `npm run typecheck` | `release gate` | 是 | 主类型安全门禁 | 保留 |
| `npm run lint` | `release gate` | 是 | 但当前 warnings 不会 fail 发布 | 保留，并区分 warning 与 blocker |
| `npm run build` | `release gate` | 是 | 构建完整性门禁 | 保留 |
| `npm test` 的 `default` project | `release gate` | 是 | 覆盖绝大多数 unit/integration/e2e(api) | 保留 |
| `browser-e2e` (`test/e2e/ui/**/*.test.ts`) | `release gate` | 仅在 `release:verify` 中跑 | 这是 UI 真验证，不在 `npm test` | 保留，并继续单独标识 |
| `test/integration/agent/friday-openclaw-overlap-acceptance.test.ts` | `release gate` | 是 | 当前明确要求的 overlap 证明 | 保留 |
| `check:migrations` / `check:adversarial` / `check:ssd` / `check:alignment` | `release gate` | 是 | 结构与边界完整性门禁 | 保留 |
| `test:install:smoke` | `release gate` | 是 | 安装包与启动链路门禁 | 保留 |
| `release:check` | `release gate` | 是 | 打包内容与禁止项门禁 | 保留 |
| `check:architecture-boundaries` | `release gate` | 否，但在 current-source-of-truth 中定义为 canonical guard | 当前不在 `release:verify` 主链 | 建议在明天发布前单独再跑一次 |
| `check:security-doctor` | `release gate` | 否，但在 current-source-of-truth 中定义为 canonical guard | 当前不在 `release:verify` 主链 | 建议在明天发布前单独再跑一次 |
| `check:desktop-release-pipeline` | `release gate` | 否，但在 current-source-of-truth 中定义为 canonical guard | 桌面发布相关 | 如果明天含 macOS/desktop 叙事，必须单独跑 |
| real-world validation `smoke` | `regression guard` | 否 | 这次审计手动跑了，且非常有价值 | 建议提升为发布前必跑 gate |
| real-world validation `weekly` | `regression guard` | 否 | 这次作为 soak 运行中 | 建议保留为 ship/no-ship 辅助 gate |
| `test/e2e/live/*` | `developer convenience` | 否 | 真实环境/云环境依赖高，不是稳定 CI gate | 不删除；明确不要拿它们当默认绿色证明 |
| `llm-e2e` project (`friday-llm-e2e.test.ts`, `friday-real-scenarios-e2e.test.ts`) | `developer convenience` | `npm test` 会触发，但是否真执行取决于 env gate | 容易制造“好像跑了”的错觉 | 明确从发布认知里降级，不算默认 ship 证明 |
| benchmark / performance | `regression guard` | 否 | 有价值，但不是今天发布 blocker | 保留 |
| property tests | `regression guard` | 通过 `default` 间接运行 | 边界约束价值高 | 保留 |

## 哪些 test 不需要

### Confirmed Facts

- 本轮没有找到足够高置信、可以立即删除且不会损失价值的单个测试文件。
- 当前更大的问题不是“测试太多”，而是**团队很容易误把 env-gated 套件或未默认运行的套件当成发布证明**。

### Inference

- 立刻删测试不会带来发布收益，反而可能削弱回归面。
- 现在更应该做的是 **重新分级**，把“会跑”和“会在真实发布里提供信心”区分开。

### Recommendation

1. 把 `llm-e2e` 明确标成 `developer convenience`，不要再把它计入默认 ship confidence。
2. 把 real-world validation `smoke` 提升成发布前显式门禁。
3. 如果明天发布包含 desktop/agent OS 叙事，再补跑：
   - `npm run check:architecture-boundaries`
   - `npm run check:security-doctor`
   - `npm run check:desktop-release-pipeline`
4. 真正的 `delete/merge candidate` 标准先固定下来：
   - 重复同义
   - 只断言占位文案
   - 永远不在任何发布脚本里跑且团队误以为会跑
   - 与更高层 E2E 完全重复且没有额外定位价值

## 结论

明天发布前，**不建议做大规模删测**。  
更高回报的动作是：把测试资产的“信心等级”说清楚，并把 real-world smoke 纳入显式发布门禁。
