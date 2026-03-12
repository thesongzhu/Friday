> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Phase C Review — NOT APPROVED

## Findings (by severity)

### 1. HIGH: Shell injection in legacy bridge
**Files:** `src/skills/bridge/friday-legacy-skill-bridge.ts:111,119,246`
User input is directly substituted into a command string and executed via `sh -c`. Inputs like `"; rm -rf ..."` or `$(...)` can execute arbitrary commands.

### 2. MEDIUM: `commandIndex` accepts non-integer numbers
**Files:** `src/skills/bridge/friday-legacy-skill-bridge.ts:193,108`
`1.5` passes numeric bounds check, then `commands[1.5]` is `undefined`, causing access on `selected.command`.

### 3. MEDIUM: Legacy bridge execution does not set skill working directory
**File:** `src/skills/bridge/friday-legacy-skill-bridge.ts:117`
`shellExecutor.run(...)` has no `cwd`, so relative paths in SKILL.md commands run from process cwd, not skill folder.

### 4. LOW: Lint is failing on changed source files (sort-imports)
**Files:** `src/skills/bridge/friday-legacy-skill-bridge.ts:17,24`, `src/skills/executor/friday-skill-executor.ts:5`

### 5. LOW: New tests include `any` casts (violates "no as any" rule)
**Files:** `test/unit/skills/bridge/friday-legacy-skill-bridge.test.ts:166,291,324,358`
