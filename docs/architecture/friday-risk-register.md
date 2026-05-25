# Friday Phase 1 风险登记表

生成时间：2026-05-03

## P0/P1 风险

### Release workflow 测试隔离曾阻塞完整门禁

- 文件：`/Users/example/Desktop/Friday/test/integration/system/friday-system-companion-release.integration.test.ts`
- 问题：初次 Phase 1 全量 `npm test` 中，3 个 macOS companion release workflow 测试失败；首个用例 180s 超时，后续并发 release 等待 `.friday/locks/macos-release.lock` 超时。
- 当前状态：已修复并验证，完整 `npm test` 当前通过。
- 风险：release workflow 仍是 slow/packaging gate，如果后续移除隔离锁、隔离输出或进程组超时清理，完整质量门禁可能再次不稳定。
- 建议：保留当前隔离策略；不要把 release 测试改成 mock 或静默跳过。

### Hub composition root 过大

- 文件：`/Users/example/Desktop/Friday/src/hub/friday-hub-bootstrap.ts`
- 问题：hub 同时装配 provider、skills、memory、workflow、agent、channels、plugins、scheduler、observability、system、uix。
- 风险：任何 feature 改造都容易牵动启动流程。
- 建议：先引入 feature installer/registration 文档和边界检查，再小步拆装配逻辑。

### Agent runtime 过大

- 文件：`/Users/example/Desktop/Friday/src/agent/runtime/friday-agent-runtime.ts`
- 问题：同一文件混合 LLM loop、tool execution、memory policy、safety guard、artifact truth、输出修复。
- 风险：重构 agent 时最容易破坏行为。
- 建议：先补 characterization tests，再拆纯策略模块。

### Memory/state 是硬约束

- 路径：`/Users/example/Library/Application Support/Friday/state/friday.db`、`/Users/example/Desktop/Friday/.friday`、`/Users/example/Desktop/Friday/context`
- 问题：Phase 1 已备份，但尚未做恢复演练。
- 风险：任何 schema/memory policy 改造都可能破坏长期记忆。
- 建议：Phase 2 不改 memory schema；先做 restore rehearsal 文档和只读校验。

## P2 风险

### API runtime 注册器过大

- 文件：`/Users/example/Desktop/Friday/src/api/runtime/friday-api-runtime.ts`
- 问题：大量 routes 和 feature dependencies 在一个 runtime 中拼装。
- 风险：API surface 增长后 route ownership 难追踪。
- 建议：按 feature route installer 分组，但保持 URL contracts 不变。

### Provider service 职责过多

- 文件：`/Users/example/Desktop/Friday/src/providers/services/friday-provider-service.ts`
- 问题：secret、OAuth、doctor、routing、usage、cost、validation 交织。
- 风险：setup/provider 修复容易影响 runtime routing。
- 建议：优先拆 doctor、secrets/OAuth、routing、usage accounting。

### UI/API type drift

- 文件：`/Users/example/Desktop/Friday/ui/src/lib/api/types.ts`
- 文件：`/Users/example/Desktop/Friday/packages/friday-operator-client/src/system-types.ts`
- 问题：UI/operator client types 与 backend API model 手工同步。
- 风险：接口变更时 UI 能编译但运行时错。
- 建议：引入 API contract 生成或共享 schema。

### Config/env 分散

- 文件：`/Users/example/Desktop/Friday/.env.example`
- 文件：`/Users/example/Desktop/Friday/src/cli/friday-cli.ts`
- 文件：`/Users/example/Desktop/Friday/src/hub/friday-hub-bootstrap.ts`
- 问题：大量 `FRIDAY_*` env 不由统一 runtime config 管理。
- 风险：本机、私服、云服务行为难比较。
- 建议：集中解析为 `FridayRuntimeConfig`，模块只接收解析后的配置。

## Readiness 风险

### Integrations readiness 不一致

- 路径：`/Users/example/Desktop/Friday/src/channels`
- 问题：部分 channel 是 live adapter，部分是 stub/partial/compat。
- 风险：用户和维护者容易误判“支持”等于“生产可用”。
- 建议：建立 live/stub/experimental/compat readiness matrix，并在 UI/API 文档中展示。

### Release artifacts 和测试输出较重

- 路径：`/Users/example/Desktop/Friday/dist/releases`
- 问题：`npm test` 中 release workflow 会生成/打包 source 和 macOS artifacts，耗时高；本机 `dist/ui/assets` 还存在大量 `* 2.*` 重复 ignored 构建产物，会拖慢 source pack。
- 风险：完整质量门禁耗时偏高，后续容易被开发者绕过。
- 建议：release 测试继续隔离输出目录；后续如需清理 `dist/`，应单独确认，因为 Phase 1 不删除运行产物。
