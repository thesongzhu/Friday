# Friday Phase 1 稳定和文档化基线

生成时间：2026-05-03

## 结论

Phase 1 已按“先备份、再固定测试、再真实闭环、最后文档化”的顺序执行。业务源码、SQLite migration 历史、真实 memory/state 数据均未修改。

补充修复后结论：完整 `npm test` 已通过。唯一修改过的代码文件是 release workflow 集成测试，用于隔离测试锁、测试输出和超时清理；没有改业务源码、没有改 migration、没有改真实 memory/state 数据。

## 数据保护

执行前已创建备份副本：

- 备份目录：`/Users/example/Desktop/Friday/.phase1-backups/20260503-122916`
- 清单文件：`/Users/example/Desktop/Friday/.phase1-backups/20260503-122916/manifest.md`
- SQLite 在线备份 integrity check：`ok`
- 备份目录已加入本地 `.git/info/exclude`，避免 token、DB、runtime 备份被误提交；未修改仓库 `.gitignore`。

已备份范围：

- `/Users/example/Desktop/Friday/.friday`：1620 files，198M，含 SQLite 和 memory/context/state 指示文件
- `/Users/example/Desktop/Friday/memory`：1 file，4.0K
- `/Users/example/Desktop/Friday/context`：5 files，20K
- `/Users/example/Desktop/Friday/artifacts`：41 files，160K
- `/Users/example/.friday`：9 files，100K
- `/Users/example/Library/Application Support/Friday/state`：5 files，7.5M，含 `friday.db`

## 固定命令基线

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `git status --short` | 通过 | 初始状态干净；当前变更仅包含 Phase 1 文档和 release workflow 集成测试修复；备份目录通过本地 exclude 保护，不进入 git status。 |
| `npm run typecheck` | 通过 | API、operator client、UI typecheck 均无错误。 |
| `npm run check:architecture-boundaries` | 通过 | 5/5 checks passed。当前仅覆盖 state/security/channels/providers/immutable core。 |
| `npm run check:migrations` | 通过 | 76 migrations，v001-v076 连续，migration array 与文件完全匹配。 |
| `npm test` | 通过 | 776 test files passed，21 skipped；10315 tests passed，251 skipped；Type Errors 无。 |
| `npm run build:api` | 通过 | `tsc` 成功。 |
| `npm run build:ui` | 通过 | Vite production build 成功，2496 modules transformed。 |

## 已修复的 `npm test` 阻塞项

最初失败集中在：

- `/Users/example/Desktop/Friday/test/integration/system/friday-system-companion-release.integration.test.ts`

失败用例：

- `runs the local release workflow and verifies the packaged app`：180000ms 超时。
- `generates a Sparkle appcast when update credentials are configured`：release lock 等待超时。
- `serializes concurrent local release invocations with a shared lock`：release lock 等待超时。

直接错误：

```text
[friday-companion-release] timed out waiting for release lock at /Users/example/Desktop/Friday/.friday/locks/macos-release.lock
```

修复方式：只修改上述集成测试文件，为 release 用例提供隔离的 release lock、隔离的 macOS release 输出、隔离的 release record 输出，以及进程组级超时清理；release workflow 用例中的 source artifact 扫描也指向隔离 runtime，避免测试产物重新进入主仓库 manifest 扫描路径。独立 source distribution 用例仍验证默认真实输出行为。

修复后验证：

```text
npx vitest run --project default test/integration/system/friday-system-companion-release.integration.test.ts
Test Files 1 passed
Tests      8 passed

npm test
Test Files  776 passed | 21 skipped (797)
Tests       10315 passed | 251 skipped (10566)
Type Errors no errors
Duration    167.23s
```

残留观察：本机 `dist/ui/assets` 存在大量 `* 2.*` 重复构建产物，source pack 会明显变慢；未删除这些 ignored 构建产物，因为 Phase 1 不做数据/产物清理。

## 真实闭环 Smoke

单独 smoke 子集通过：

```text
npx vitest run --project default \
  test/e2e/mock/friday-mock-bootstrap.e2e.test.ts \
  test/e2e/api/friday-api-sessions-memory-routes.test.ts \
  test/e2e/api/friday-api-workflows-routes.test.ts \
  test/e2e/setup-wizard.e2e.test.ts
```

结果：4 files passed；63 tests passed；6 skipped。

覆盖：

- Friday hub startup、health endpoint、provider list。
- Mock provider agent run end-to-end。
- Memory store/search 路径；无 embedding provider 时 FTS fallback 可用。
- Workflow create/publish/run API。
- Setup wizard/provider setup/channel setup API。

UI 入口 smoke 通过：

```text
npm run test:e2e:ui:file -- test/e2e/ui/friday-real-browser-onboarding.e2e.test.ts
```

结果：1 browser-e2e test passed。真实浏览器从 fresh runtime 进入 `/setup`，页面无 crash。

## Phase 2 入口条件

Phase 2 前建议先处理或正式接受以下事实：

- 完整 `npm test` 当前通过，但 release workflow 是 slow/packaging gate，后续不能移除隔离锁和进程清理保护。
- 当前 architecture boundary check 没覆盖 hub、agent、api runtime、sessions、UI。
- Memory/state 已备份，但尚未建立自动化恢复演练。
- Mock smoke 证明核心闭环可跑，不等于真实 provider/channel/live-cloud 全部可用。
