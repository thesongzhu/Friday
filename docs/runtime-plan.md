> Superseded: this plan predates the current runtime composition. Use `docs/current-source-of-truth.md` for the current steady-state architecture reference.

# Friday Runtime Plan — Make It Actually Run

> Goal: `friday start` boots the system, loads 51 existing SKILL.md skills, user can invoke them.
> Designed based on CX's source analysis + existing codebase patterns.

## Phase A: Skill Runtime Executor

### New files

#### `src/skills/executor/friday-skill-executor.types.ts`
```typescript
export interface FridaySkillExecutor {
  execute(request: FridaySkillExecuteRequest): Promise<FridaySkillExecuteResult>;
  cancel(runId: string): void;
}

export interface FridaySkillExecuteRequest {
  skillId: string;
  input: Record<string, unknown>;
  sessionId: string;
  userId: string;
  channel: string;
  timeoutMs?: number;
}

export interface FridaySkillExecuteResult {
  runId: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  output: Record<string, unknown>;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CreateFridaySkillExecutorDeps {
  db: FridaySqliteLayer;
  registry: FridaySkillRegistry;
  idGenerator: () => string;
  nowIso: () => string;
}
```

#### `src/skills/executor/friday-shell-executor.ts`
- Implements skill execution for `SkillRuntimeKind = "shell"`
- Spawns child process via `child_process.spawn`
- Captures stdout/stderr
- Handles timeouts (kill on timeout)
- Sets env vars from skill manifest `requirements.env`
- Returns structured result

```typescript
export interface FridayShellExecutor {
  run(options: FridayShellRunOptions): Promise<FridayShellRunResult>;
}

export interface FridayShellRunOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface FridayShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function createFridayShellExecutor(): FridayShellExecutor
```

#### `src/skills/executor/friday-node-executor.ts`
- For `SkillRuntimeKind = "node"` — dynamic imports of JS modules
- Calls the module's exported `execute` function
- Same timeout/error pattern

#### `src/skills/executor/friday-skill-executor.ts`
- Main executor factory — routes to shell/node/python based on `manifest.runtime.kind`
- Wraps execution with run state tracking (SQLite)
- Emits events via event bus

#### `src/skills/executor/index.ts`
- Barrel exports

### Integration
- `FridaySkillExecutor` takes a `FridaySkillRegistry` (to look up skills) + `FridaySqliteLayer` (to persist run state)
- Uses existing `FridaySkillRunState` types from `friday-skill-runtime.types.ts`
- Uses existing ledger for run logging (`src/ledger/runs/friday-skill-run-store.ts`)

---

## Phase B: Legacy SKILL.md Bridge

### New files

#### `src/skills/bridge/friday-legacy-skill-bridge.ts`
- Takes an `AdaptedFridayLegacySkill` (from existing `friday-skill-legacy-adapter.ts`)
- Creates a concrete `FridaySkill<unknown, unknown, unknown>` implementation
- The SKILL.md contains bash code blocks — this bridge:
  1. Extracts the bash commands from markdown code blocks
  2. Maps them to shell executor calls
  3. Implements the `FridaySkill` interface: `init` → set up context, `execute` → run bash commands, `teardown` → cleanup

```typescript
export interface FridayLegacySkillBridge {
  wrap(adapted: AdaptedFridayLegacySkill): FridaySkill<unknown, unknown, unknown>;
}

export function createFridayLegacySkillBridge(deps: {
  shellExecutor: FridayShellExecutor;
}): FridayLegacySkillBridge
```

#### `src/skills/bridge/friday-markdown-command-extractor.ts`
- Parses markdown content, extracts fenced code blocks tagged as `bash`, `sh`, or `shell`
- Returns array of `{ label: string; command: string; lang: string }`
- Handles multi-line commands, heredocs

### Integration
- Plugs into `friday-skill-package-loader.ts` — when a skill loads in `legacy-skill-md` mode, the bridge wraps it
- The registry stores the wrapped `FridaySkill` like any other skill

---

## Phase C: CLI + Hub Bootstrap

### New files

#### `src/cli/friday-cli.ts`
- Entry point: `#!/usr/bin/env node`
- Uses lightweight arg parsing (no heavy CLI framework — just `process.argv`)
- Commands:
  - `friday start` — boot hub
  - `friday list` — list loaded skills
  - `friday run <skill-id> [--input key=value]` — run a skill directly
  - `friday install <path-or-url>` — install skill from path/github
  - `friday status` — show hub status

#### `src/hub/friday-hub-bootstrap.ts`
- The "main" composition root — wires ALL modules:
  1. `initializeFridayState()` — SQLite + config
  2. `createFridaySkillRegistry()` — load skills from disk
  3. `createFridaySkillExecutor()` — executor with shell/node support
  4. `createFridayLegacySkillBridge()` — wrap legacy skills
  5. `createFridayWorkflowRuntime()` — workflow engine
  6. `createFridayApiRuntime()` — API layer
  7. `createFridaySatelliteRuntime()` — satellite support
  8. `createFridaySelfLearningRuntime()` — learning system
- Returns a `FridayHub` handle with `start()`, `stop()`, `status()`

```typescript
export interface FridayHub {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): FridayHubStatus;
  skills: FridaySkillRegistry;
  executor: FridaySkillExecutor;
  workflows: FridayWorkflowRuntime;
  api: FridayApiRuntime;
}

export interface FridayHubConfig {
  stateDir?: string;
  skillDirs: string[];
  port?: number;
  tokenSecret: string;
}

export function createFridayHub(config: FridayHubConfig): Promise<FridayHub>
```

#### `package.json` updates
- Add `"bin": { "friday": "./dist/cli/friday-cli.js" }`
- Add `"start": "node dist/cli/friday-cli.js start"`

### Integration
- Hub bootstrap imports from all module barrels (`#state`, `#skills`, `#workflows`, `#api`, `#satellites`, `#learning`)
- CLI is thin — just parses args and calls hub methods

---

## Execution Order

1. **Phase A first** — Skill executor is the foundation
2. **Phase B second** — Legacy bridge depends on shell executor from Phase A
3. **Phase C last** — Hub bootstrap wires everything together

Each phase: CC implements → `tsc --noEmit` + `vitest run` must pass → commit.

## Test Strategy
- Phase A: Unit test shell executor (mock child_process), test executor routing
- Phase B: Unit test markdown extractor, integration test with a sample SKILL.md
- Phase C: Integration test that boots hub with test skills, verifies skill list + execution
