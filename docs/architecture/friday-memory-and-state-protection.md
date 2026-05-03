# Friday Phase 1 Memory 和 State 保护说明

生成时间：2026-05-03

## 硬约束

- 保留所有记忆。
- 不修改真实 memory/state 数据。
- 不修改 SQLite migration 历史。
- 不做 schema 重写。
- 不为了测试通过而清空、迁移、删除或重建真实数据。

## 已识别的数据位置

仓库内：

- `/Users/wenxindou/Desktop/Friday/.friday`
- `/Users/wenxindou/Desktop/Friday/memory`
- `/Users/wenxindou/Desktop/Friday/context`
- `/Users/wenxindou/Desktop/Friday/artifacts`

用户级 runtime：

- `/Users/wenxindou/.friday`

平台 state：

- `/Users/wenxindou/Library/Application Support/Friday/state`
- SQLite DB：`/Users/wenxindou/Library/Application Support/Friday/state/friday.db`

State resolver 规则来自：

- `/Users/wenxindou/Desktop/Friday/src/state/paths/friday-state-dir-resolver.ts`

优先级：

1. `FRIDAY_STATE_DIR`
2. platform convention path
3. legacy `~/.friday/state`
4. fallback path

## 备份结果

备份目录：

- `/Users/wenxindou/Desktop/Friday/.phase1-backups/20260503-122916`

清单：

- `/Users/wenxindou/Desktop/Friday/.phase1-backups/20260503-122916/manifest.md`

SQLite 在线备份：

- `/Users/wenxindou/Desktop/Friday/.phase1-backups/20260503-122916/platform-state-sqlite-backup/friday.db`
- `PRAGMA integrity_check`：`ok`

安全处理：

- secret/token 文件只复制，不打印内容。
- socket 文件不复制。
- 备份目录加入本地 `.git/info/exclude`。

## 真实 memory 不参与破坏性测试

Phase 1 的 memory smoke 使用隔离测试环境或临时 state，不写入真实 memory。真实 memory/state 只做定位和备份。

## Phase 2 前置保护建议

1. 写一个只读 state inventory 脚本，输出 table count、migration version、memory namespace count，不打印内容。
2. 做一次 restore rehearsal：从 `.phase1-backups` 复制到临时目录启动 Friday，验证 health/memory search。
3. 给 memory store/search/namespace/session extraction 增加 characterization tests。
4. 在任何 memory schema 改造前，先定义 migration rollback/backup policy。
5. 对真实数据只做 append-safe 操作；禁止 Phase 2 修改已有 memory content。

## 不允许的 Phase 2 操作

- 不直接编辑 `friday.db`。
- 不删除 `.friday/exports/memory` 或 session exports。
- 不重写 `context/MEMORY.md`、`context/USER.md`、`context/SOUL.md`。
- 不修改已存在 migrations。
- 不用测试脚本清理真实 state。
