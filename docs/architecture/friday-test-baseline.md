# Friday Phase 1 测试基线

生成时间：2026-05-03

## 不可降低标准

以下命令是 Phase 1 固定基线。后续重构不得为了通过而删除、跳过或降低这些标准；如果失败，应记录失败并先修复或由维护者明确接受风险。

```bash
git status --short
npm run typecheck
npm run check:architecture-boundaries
npm run check:migrations
npm test
npm run build:api
npm run build:ui
```

## 当前结果

| 类别 | 命令 | 当前结果 |
| --- | --- | --- |
| Git 状态 | `git status --short` | 通过，当前 tracked 变更仅为 release workflow 集成测试修复；另有 Phase 1 文档文件。 |
| 类型 | `npm run typecheck` | 通过。 |
| 架构边界 | `npm run check:architecture-boundaries` | 通过，5/5 checks。 |
| DB migrations | `npm run check:migrations` | 通过，76 migrations 连续。 |
| 全量测试 | `npm test` | 通过，776 files passed，10315 tests passed，251 skipped，Type Errors 无。 |
| API build | `npm run build:api` | 通过。 |
| UI build | `npm run build:ui` | 通过。 |

## 全量测试结果

```text
Test Files  776 passed | 21 skipped (797)
Tests       10315 passed | 251 skipped (10566)
Type Errors no errors
Duration    167.23s
```

## 已修复的历史失败

历史失败文件：

- `/Users/wenxindou/Desktop/Friday/test/integration/system/friday-system-companion-release.integration.test.ts`

历史失败类型：

- 180s test timeout。
- 并发 release workflow 等待 `.friday/locks/macos-release.lock` 超时。

修复验证：

```text
npx vitest run --project default test/integration/system/friday-system-companion-release.integration.test.ts
Test Files 1 passed
Tests      8 passed

npm test
Test Files  776 passed | 21 skipped (797)
Tests       10315 passed | 251 skipped (10566)
```

## 固定 Smoke 子集

核心 smoke 子集：

```bash
npx vitest run --project default \
  test/e2e/mock/friday-mock-bootstrap.e2e.test.ts \
  test/e2e/api/friday-api-sessions-memory-routes.test.ts \
  test/e2e/api/friday-api-workflows-routes.test.ts \
  test/e2e/setup-wizard.e2e.test.ts
```

当前结果：

```text
Test Files 4 passed
Tests      63 passed | 6 skipped
Duration   11.42s
```

覆盖说明：

- Startup/health：mock hub 启动并返回 `/v1/health`。
- Agent：mock provider agent run end-to-end completed。
- Memory：store/search 路径通过；无 embedding provider 时 graceful fallback。
- Workflow：workflow create/list/publish/run route 通过。
- Provider setup：setup wizard API、fake OpenAI 401、channel secret persistence、full wizard API flow 通过。

UI/browser smoke：

```bash
npm run test:e2e:ui:file -- test/e2e/ui/friday-real-browser-onboarding.e2e.test.ts
```

当前结果：

```text
Test Files 1 passed
Tests      1 passed
```

覆盖说明：

- 真实浏览器从 fresh runtime 进入 `/setup`。
- 页面正文加载，未出现 `Something went wrong`。
- local storage 未提前写入 onboarding profile。

## Phase 2 测试门槛

进入 Phase 2 前至少需要满足：

- 当前 smoke 子集保持通过。
- `typecheck`、architecture boundaries、migrations、API/UI build、完整 `npm test` 保持通过。
- release workflow 集成测试继续使用隔离锁、隔离输出和进程组超时清理；不能为了提速静默跳过。
- 对要拆的模块先补 characterization tests，尤其是 agent runtime、provider service、memory/session policy、workflow execution。
