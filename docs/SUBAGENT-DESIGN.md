# Sub-Agent System — Design Document

**Author:** CX (Codex)  
**Date:** 2026-02-19  
**Status:** Ready for implementation  
**Target implementer:** CC (Claude Code)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Type Definitions](#2-type-definitions)
3. [File-by-File Specification](#3-file-by-file-specification)
4. [Tool Specification](#4-tool-specification)
5. [Runtime Integration](#5-runtime-integration)
6. [Database Schema](#6-database-schema)
7. [API Routes](#7-api-routes)
8. [Event Flow](#8-event-flow)
9. [Constraints](#9-constraints)
10. [Test Plan](#10-test-plan)

---

## 1. Architecture Overview

### How Sub-Agents Fit Into the Existing Runtime

The sub-agent system allows a running agent (the **parent**) to spawn isolated child agent runs via the `spawn_subagent` tool. Each child run executes independently using `FridayAgentRuntime.executeRun()` — the same entry point used for top-level runs. When a child completes, its result is delivered back to the parent as the tool_result of the `spawn_subagent` call.

```
Parent executeRun loop
  → LLM returns tool_use: spawn_subagent
  → spawn_subagent.execute() called
    → Validates depth/concurrency limits
    → Creates SubagentRunRecord in SQLite
    → Calls childRuntime.executeRun() (in-process, awaited)
    → Returns child's response as tool_result
  → Parent LLM loop continues with child's findings
```

### Key Design Decisions

1. **Synchronous tool model.** The `spawn_subagent` tool call blocks (from the parent LLM loop's perspective) until the child completes. This is the simplest correct model — the parent's tool_result message contains the child's output. No announce queue, no deferred delivery.

2. **In-process execution.** No gateway RPC. Child runs use a dedicated `FridayAgentRuntime` instance constructed with a focused system prompt and the same tool set (minus `spawn_subagent` at max depth).

3. **Depth tracking via session key.** Session keys encode depth: `agent:run:{parentRunId}` for depth 0, `agent:run:{parentRunId}:sub:{childRunId}` for depth 1, etc. The registry parses session keys to determine current depth.

4. **Shared event emitter.** Parent and child emit events on the same `FridayAgentEventEmitter`. SSE consumers filter by `runId`. New event types are added for sub-agent lifecycle.

5. **Abort cascading.** When a parent is cancelled, all active children are cancelled via linked `AbortSignal`. When a child times out, only the child fails — the parent gets an error tool_result and decides what to do.

### Component Map

```
src/agent/
├── subagent/
│   ├── friday-subagent.types.ts          # Type definitions
│   ├── friday-subagent-registry.ts       # In-memory + SQLite tracking
│   ├── friday-subagent-system-prompt.ts  # Child system prompt builder
│   └── friday-subagent-constants.ts      # Limits, defaults
├── tools/
│   ├── friday-agent-subagent-tools.ts    # spawn_subagent + list_subagents tools
│   └── friday-agent-tool-registry.ts     # (modified) registers subagent tools
├── persistence/
│   └── friday-subagent-run-repository.ts # SQLite CRUD for subagent_runs
├── runtime/
│   └── friday-agent-runtime.ts           # (modified) passes subagent context to tools
│   └── friday-agent-runtime.types.ts     # (modified) adds subagentContext to executeRun params
├── model/
│   └── friday-agent.types.ts             # (modified) adds subagent events to event map
└── index.ts                              # (modified) re-exports new modules

src/state/sqlite/migrations/
└── v013-subagent-runs.ts                 # New migration

src/api/http/routes/
└── friday-subagent-routes.ts             # REST endpoints
```

---

## 2. Type Definitions

### File: `src/agent/subagent/friday-subagent.types.ts`

```typescript
import type { FridayAgentRuntimeResult } from "../runtime/friday-agent-runtime.types.js";

// ─── Sub-agent run status ───

export type FridaySubagentRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Sub-agent outcome (result summary) ───

export interface FridaySubagentOutcome {
  status: "completed" | "failed" | "cancelled";
  response: string;
  toolCallCount: number;
  durationMs: number;
  usageInput: number;
  usageOutput: number;
}

// ─── Sub-agent spawn input (from tool) ───

export interface FridaySubagentSpawnInput {
  task: string;
  label?: string;
  model?: string;
  timeoutMs?: number;
}

// ─── Sub-agent run record (persisted in SQLite) ───

export interface FridaySubagentRunRecord {
  id: string;
  parentRunId: string;
  parentSessionKey: string;
  childRunId: string;
  childSessionKey: string;
  task: string;
  label?: string;
  model?: string;
  depth: number;
  status: FridaySubagentRunStatus;
  outcome?: FridaySubagentOutcome;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

// ─── Sub-agent context (passed through executeRun) ───

export interface FridaySubagentContext {
  /** Current nesting depth (0 = top-level run, 1 = first sub-agent, etc.) */
  depth: number;
  /** Run ID of the immediate parent */
  parentRunId: string;
  /** Session key of the immediate parent */
  parentSessionKey: string;
  /** Root-level run ID (the original top-level run) */
  rootRunId: string;
}

// ─── Registry interface ───

export interface FridaySubagentRegistry {
  /** Spawn a child run. Blocks until child completes. Returns outcome. */
  spawn(input: FridaySubagentRegistrySpawnInput): Promise<FridaySubagentOutcome>;
  /** List sub-agent runs for a given parent run. */
  listByParentRunId(parentRunId: string): FridaySubagentRunRecord[];
  /** Get a sub-agent run record by its ID. */
  getById(id: string): FridaySubagentRunRecord | null;
  /** List all sub-agent runs (with optional filters). */
  list(filters?: FridaySubagentListFilters): FridaySubagentRunRecord[];
  /** Get count of currently running sub-agents for a parent. */
  activeCountForParent(parentRunId: string): number;
}

export interface FridaySubagentRegistrySpawnInput {
  task: string;
  label?: string;
  model?: string;
  timeoutMs?: number;
  parentRunId: string;
  parentSessionKey: string;
  depth: number;
  rootRunId: string;
  signal: AbortSignal;
}

export interface FridaySubagentListFilters {
  parentRunId?: string;
  status?: FridaySubagentRunStatus;
  limit?: number;
  cursor?: string;
}

// ─── Factory deps ───

export interface CreateFridaySubagentRegistryDeps {
  db: import("#state").FridaySqliteLayer;
  createChildRuntime: (params: CreateChildRuntimeParams) => {
    executeRun: (params: {
      task: string;
      sessionKey: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }) => Promise<FridayAgentRuntimeResult>;
  };
  eventEmitter: import("../runtime/friday-agent-event-emitter.js").FridayAgentEventEmitter;
  idGenerator: () => string;
  nowIso: () => string;
}

export interface CreateChildRuntimeParams {
  model?: string;
  systemPrompt: string;
  depth: number;
}
```

---

## 3. File-by-File Specification

### 3.1 `src/agent/subagent/friday-subagent-constants.ts` (NEW)

```typescript
// Exports:
//   FRIDAY_SUBAGENT_MAX_DEPTH
//   FRIDAY_SUBAGENT_MAX_CONCURRENT
//   FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS
//   FRIDAY_SUBAGENT_ERROR_CODES
//   FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR

/** Maximum nesting depth for sub-agents. Depth 0 = top-level run. */
export const FRIDAY_SUBAGENT_MAX_DEPTH = 3;

/** Maximum concurrent sub-agents per parent run. */
export const FRIDAY_SUBAGENT_MAX_CONCURRENT = 5;

/** Default timeout for a sub-agent run (3 minutes). */
export const FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS = 180_000;

/** Session key separator for sub-agent nesting. */
export const FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR = ":sub:";

export const FRIDAY_SUBAGENT_ERROR_CODES = {
  MAX_DEPTH_EXCEEDED: "SUBAGENT_MAX_DEPTH_EXCEEDED",
  MAX_CONCURRENT_EXCEEDED: "SUBAGENT_MAX_CONCURRENT_EXCEEDED",
  SPAWN_FAILED: "SUBAGENT_SPAWN_FAILED",
  NOT_FOUND: "SUBAGENT_NOT_FOUND",
} as const;
```

### 3.2 `src/agent/subagent/friday-subagent.types.ts` (NEW)

Exact contents shown in [Section 2](#2-type-definitions) above.

### 3.3 `src/agent/subagent/friday-subagent-system-prompt.ts` (NEW)

```typescript
// Exports:
//   buildFridaySubagentSystemPrompt(params: BuildSubagentSystemPromptParams): string

export interface BuildSubagentSystemPromptParams {
  task: string;
  label?: string;
  parentSessionKey: string;
  depth: number;
}

export function buildFridaySubagentSystemPrompt(
  params: BuildSubagentSystemPromptParams,
): string;
```

**Implementation logic:**

1. Build a focused system prompt string with the following sections:
   - **Role declaration:** `"You are a sub-agent spawned to complete a specific task. Stay focused on your assigned task and nothing else."`
   - **Task section:** `"## Task\n{task}"`
   - **If `label` is provided:** `"## Label\n{label}"`
   - **Context section:** `"## Context\n- You are a sub-agent at depth {depth}\n- Parent session: {parentSessionKey}\n- Complete your task and provide a clear, concise summary of your findings/results."`
   - **Rules section:**
     ```
     ## Rules
     1. Stay focused — do your assigned task, nothing else.
     2. Be concise — your output will be delivered back to the parent agent.
     3. If you cannot complete the task, explain why clearly.
     4. Do not spawn sub-agents unless absolutely necessary for your task.
     ```
2. Join all sections with `"\n\n"`.
3. Return the joined string.

### 3.4 `src/agent/persistence/friday-subagent-run-repository.ts` (NEW)

```typescript
// Exports:
//   FridaySubagentRunRepository (interface)
//   createFridaySubagentRunRepository(): FridaySubagentRunRepository

import type Database from "better-sqlite3";
import type {
  FridaySubagentRunRecord,
  FridaySubagentRunStatus,
  FridaySubagentOutcome,
  FridaySubagentListFilters,
} from "../subagent/friday-subagent.types.js";

// ─── Row shape from SQLite ───

interface FridaySubagentRunRow {
  id: string;
  parent_run_id: string;
  parent_session_key: string;
  child_run_id: string;
  child_session_key: string;
  task: string;
  label: string | null;
  model: string | null;
  depth: number;
  status: string;
  outcome: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

// ─── Repository interface ───

export interface FridaySubagentRunRepository {
  create(
    db: Database.Database,
    input: {
      id: string;
      parentRunId: string;
      parentSessionKey: string;
      childRunId: string;
      childSessionKey: string;
      task: string;
      label?: string;
      model?: string;
      depth: number;
      nowIso: string;
    },
  ): FridaySubagentRunRecord;

  getById(
    db: Database.Database,
    id: string,
  ): FridaySubagentRunRecord | null;

  update(
    db: Database.Database,
    input: {
      id: string;
      status?: FridaySubagentRunStatus;
      outcome?: FridaySubagentOutcome;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
    },
  ): FridaySubagentRunRecord | null;

  listByParentRunId(
    db: Database.Database,
    parentRunId: string,
  ): FridaySubagentRunRecord[];

  list(
    db: Database.Database,
    filters?: FridaySubagentListFilters,
  ): FridaySubagentRunRecord[];

  countActiveByParentRunId(
    db: Database.Database,
    parentRunId: string,
  ): number;
}

export function createFridaySubagentRunRepository(): FridaySubagentRunRepository;
```

**Implementation logic for each method:**

#### `rowToRecord(row: FridaySubagentRunRow): FridaySubagentRunRecord`
Private helper. Maps snake_case SQLite row to camelCase record. Parses `outcome` from JSON string if non-null. Converts nulls to undefined.

#### `create(db, input)`
1. Execute INSERT: `INSERT INTO friday_subagent_runs (id, parent_run_id, parent_session_key, child_run_id, child_session_key, task, label, model, depth, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
2. SELECT the inserted row by `id`.
3. If row not found, throw `FridayDomainError` with code `SUBAGENT_SPAWN_FAILED`.
4. Return `rowToRecord(row)`.

#### `getById(db, id)`
1. `SELECT * FROM friday_subagent_runs WHERE id = ?`
2. Return `rowToRecord(row)` or `null`.

#### `update(db, input)`
1. Build dynamic SET clauses (same pattern as `FridayAgentRunRepository.update`).
2. For `outcome`: `JSON.stringify(input.outcome)`.
3. Execute UPDATE.
4. Return `this.getById(db, input.id)`.

#### `listByParentRunId(db, parentRunId)`
1. `SELECT * FROM friday_subagent_runs WHERE parent_run_id = ? ORDER BY created_at ASC`
2. Map rows with `rowToRecord`.

#### `list(db, filters?)`
1. Build WHERE conditions from filters: `parent_run_id`, `status`, `cursor` (created_at < ?).
2. Limit: `Math.min(filters?.limit ?? 50, 500)`.
3. `ORDER BY created_at DESC LIMIT ?`.
4. Map rows with `rowToRecord`.

#### `countActiveByParentRunId(db, parentRunId)`
1. `SELECT COUNT(*) as count FROM friday_subagent_runs WHERE parent_run_id = ? AND status IN ('pending', 'running')`
2. Return `count` as number.

### 3.5 `src/agent/subagent/friday-subagent-registry.ts` (NEW)

```typescript
// Exports:
//   createFridaySubagentRegistry(deps: CreateFridaySubagentRegistryDeps): FridaySubagentRegistry

import type {
  CreateFridaySubagentRegistryDeps,
  FridaySubagentListFilters,
  FridaySubagentOutcome,
  FridaySubagentRegistry,
  FridaySubagentRegistrySpawnInput,
  FridaySubagentRunRecord,
} from "./friday-subagent.types.js";
import {
  FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS,
  FRIDAY_SUBAGENT_ERROR_CODES,
  FRIDAY_SUBAGENT_MAX_CONCURRENT,
  FRIDAY_SUBAGENT_MAX_DEPTH,
  FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR,
} from "./friday-subagent-constants.js";
import { buildFridaySubagentSystemPrompt } from "./friday-subagent-system-prompt.js";
import { createFridaySubagentRunRepository } from "../persistence/friday-subagent-run-repository.js";
import { FridayDomainError } from "#errors";

export function createFridaySubagentRegistry(
  deps: CreateFridaySubagentRegistryDeps,
): FridaySubagentRegistry;
```

**Implementation logic for `spawn(input)`:**

1. **Validate depth:** If `input.depth >= FRIDAY_SUBAGENT_MAX_DEPTH`, throw `FridayDomainError` with code `SUBAGENT_MAX_DEPTH_EXCEEDED` and httpStatus 400. Message: `"Sub-agent max depth (${FRIDAY_SUBAGENT_MAX_DEPTH}) exceeded at depth ${input.depth}"`.

2. **Validate concurrency:** Call `repo.countActiveByParentRunId(reader, input.parentRunId)` via `db.withReadConnection`. If count >= `FRIDAY_SUBAGENT_MAX_CONCURRENT`, throw `FridayDomainError` with code `SUBAGENT_MAX_CONCURRENT_EXCEEDED` and httpStatus 429. Message: `"Max concurrent sub-agents (${FRIDAY_SUBAGENT_MAX_CONCURRENT}) for parent run ${input.parentRunId}"`.

3. **Generate IDs:**
   - `subagentId = idGenerator()` (the subagent_runs record ID)
   - `childRunId = idGenerator()` (the child's agent_runs record ID — but note: the child runtime will generate its own; we use this as a correlation key)
   - Actually, the child runtime generates its own runId internally. So: `subagentRecordId = idGenerator()`.

4. **Build child session key:** `${input.parentSessionKey}${FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR}${subagentRecordId}`

5. **Create subagent record** in SQLite via `db.withWriteTransaction`:
   ```
   repo.create(writer, {
     id: subagentRecordId,
     parentRunId: input.parentRunId,
     parentSessionKey: input.parentSessionKey,
     childRunId: "",  // Will be updated after child starts
     childSessionKey,
     task: input.task,
     label: input.label,
     model: input.model,
     depth: input.depth + 1,
     nowIso: nowIso(),
   })
   ```

6. **Emit `agent.subagent.spawned` event:**
   ```
   eventEmitter.emit("agent.subagent.spawned", {
     subagentId: subagentRecordId,
     parentRunId: input.parentRunId,
     task: input.task,
     label: input.label,
     depth: input.depth + 1,
   })
   ```

7. **Build child system prompt:**
   ```
   const systemPrompt = buildFridaySubagentSystemPrompt({
     task: input.task,
     label: input.label,
     parentSessionKey: input.parentSessionKey,
     depth: input.depth + 1,
   })
   ```

8. **Create child runtime:**
   ```
   const childRuntime = deps.createChildRuntime({
     model: input.model,
     systemPrompt,
     depth: input.depth + 1,
   })
   ```

9. **Transition to running:**
   ```
   db.withWriteTransaction(writer =>
     repo.update(writer, {
       id: subagentRecordId,
       status: "running",
       startedAt: nowIso(),
     })
   )
   ```

10. **Execute child run:**
    ```
    const timeoutMs = input.timeoutMs ?? FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS;
    const result = await childRuntime.executeRun({
      task: input.task,
      sessionKey: childSessionKey,
      timeoutMs,
      signal: input.signal,
    })
    ```

11. **Update subagent record with child's runId:**
    ```
    db.withWriteTransaction(writer =>
      repo.update(writer, {
        id: subagentRecordId,
        childRunId: result.runId,
      })
    )
    ```

12. **Build outcome:**
    ```
    const outcome: FridaySubagentOutcome = {
      status: result.status,
      response: result.response,
      toolCallCount: result.toolCallCount,
      durationMs: result.durationMs,
      usageInput: result.usageInput,
      usageOutput: result.usageOutput,
    }
    ```

13. **Finalize record:**
    ```
    db.withWriteTransaction(writer =>
      repo.update(writer, {
        id: subagentRecordId,
        status: result.status === "completed" ? "completed"
              : result.status === "cancelled" ? "cancelled"
              : "failed",
        outcome,
        completedAt: nowIso(),
        durationMs: result.durationMs,
      })
    )
    ```

14. **Emit `agent.subagent.completed` event:**
    ```
    eventEmitter.emit("agent.subagent.completed", {
      subagentId: subagentRecordId,
      parentRunId: input.parentRunId,
      childRunId: result.runId,
      outcome,
    })
    ```

15. **Return outcome.**

**Error handling:** If step 10 throws (not a FridayAgentRuntimeResult but an actual exception):
- Build a failed outcome with the error message.
- Update the subagent record to `"failed"` status.
- Emit `agent.subagent.completed` with the failed outcome.
- Return the failed outcome (do NOT rethrow — the parent should get a tool_result, not crash).

**Implementation logic for `listByParentRunId(parentRunId)`:**
1. `db.withReadConnection(reader => repo.listByParentRunId(reader, parentRunId))`

**Implementation logic for `getById(id)`:**
1. `db.withReadConnection(reader => repo.getById(reader, id))`

**Implementation logic for `list(filters?)`:**
1. `db.withReadConnection(reader => repo.list(reader, filters))`

**Implementation logic for `activeCountForParent(parentRunId)`:**
1. `db.withReadConnection(reader => repo.countActiveByParentRunId(reader, parentRunId))`

### 3.6 `src/agent/tools/friday-agent-subagent-tools.ts` (NEW)

```typescript
// Exports:
//   CreateFridayAgentSubagentToolsDeps (interface)
//   createFridayAgentSubagentTools(deps: CreateFridayAgentSubagentToolsDeps): FridayAgentToolDefinition[]

import type { FridayAgentToolDefinition } from "../model/friday-agent.types.js";
import type { FridaySubagentRegistry, FridaySubagentContext } from "../subagent/friday-subagent.types.js";

export interface CreateFridayAgentSubagentToolsDeps {
  registry: FridaySubagentRegistry;
  subagentContext: FridaySubagentContext;
}

export function createFridayAgentSubagentTools(
  deps: CreateFridayAgentSubagentToolsDeps,
): FridayAgentToolDefinition[];
```

**Implementation logic:** Returns an array of two tools: `spawn_subagent` and `list_subagents`. Detailed tool specs in [Section 4](#4-tool-specification).

### 3.7 `src/agent/tools/friday-agent-tool-registry.ts` (MODIFIED)

**Changes:**

1. Add import:
   ```typescript
   import type { FridaySubagentRegistry, FridaySubagentContext } from "../subagent/friday-subagent.types.js";
   import { createFridayAgentSubagentTools } from "./friday-agent-subagent-tools.js";
   ```

2. Add to `CreateFridayAgentToolRegistryOptions`:
   ```typescript
   subagentRegistry?: FridaySubagentRegistry;
   subagentContext?: FridaySubagentContext;
   ```

3. Add to `createFridayAgentToolRegistry` body, after the memory tools block:
   ```typescript
   if (options?.subagentRegistry && options?.subagentContext) {
     tools.push(
       ...createFridayAgentSubagentTools({
         registry: options.subagentRegistry,
         subagentContext: options.subagentContext,
       }),
     );
   }
   ```

### 3.8 `src/agent/runtime/friday-agent-runtime.types.ts` (MODIFIED)

**Changes:**

1. Add import:
   ```typescript
   import type { FridaySubagentContext } from "../subagent/friday-subagent.types.js";
   ```

2. Add optional `subagentContext` to the `executeRun` params:
   ```typescript
   export interface FridayAgentRuntime {
     executeRun(params: {
       task: string;
       sessionKey?: string;
       maxAttempts?: number;
       timeoutMs?: number;
       signal?: AbortSignal;
       subagentContext?: FridaySubagentContext;
     }): Promise<FridayAgentRuntimeResult>;
   }
   ```

   **Note:** The `subagentContext` is passed through from the registry to the child runtime, but `executeRun` itself doesn't use it directly. It's available for the tool registry factory to set up the subagent tools with the correct depth context. The **runtime itself doesn't change** its loop logic — the subagent tools handle everything.

   **Actually, on reflection:** the runtime doesn't need `subagentContext` in its params at all. The context is baked into the tools at construction time via `createFridayAgentToolRegistry`. The child runtime is constructed with tools that already have the correct depth. So **no changes to runtime types or runtime are needed** beyond what's already wired through the tool registry options.

   **Revised:** No changes to `friday-agent-runtime.types.ts`. No changes to `friday-agent-runtime.ts`. The sub-agent system is entirely encapsulated in the tool layer and registry.

### 3.9 `src/agent/model/friday-agent.types.ts` (MODIFIED)

**Changes:** Add sub-agent event types to the event map.

Add these interfaces:

```typescript
// ─── Sub-agent event payloads ───

export interface FridaySubagentSpawnedPayload {
  subagentId: string;
  parentRunId: string;
  task: string;
  label?: string;
  depth: number;
}

export interface FridaySubagentCompletedPayload {
  subagentId: string;
  parentRunId: string;
  childRunId: string;
  outcome: {
    status: "completed" | "failed" | "cancelled";
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
  };
}
```

Add to `FridayAgentEventMap`:

```typescript
"agent.subagent.spawned": FridaySubagentSpawnedPayload;
"agent.subagent.completed": FridaySubagentCompletedPayload;
```

Add to `FridayAgentEventName` (it's derived from `keyof FridayAgentEventMap`, so this happens automatically).

### 3.10 `src/agent/index.ts` (MODIFIED)

Add these exports:

```typescript
// ─── Sub-agent ───

export type {
  FridaySubagentRunStatus,
  FridaySubagentOutcome,
  FridaySubagentSpawnInput,
  FridaySubagentRunRecord,
  FridaySubagentContext,
  FridaySubagentRegistry,
  FridaySubagentRegistrySpawnInput,
  FridaySubagentListFilters,
  CreateFridaySubagentRegistryDeps,
  CreateChildRuntimeParams,
} from "./subagent/friday-subagent.types.js";

export {
  FRIDAY_SUBAGENT_MAX_DEPTH,
  FRIDAY_SUBAGENT_MAX_CONCURRENT,
  FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS,
  FRIDAY_SUBAGENT_SESSION_KEY_SEPARATOR,
  FRIDAY_SUBAGENT_ERROR_CODES,
} from "./subagent/friday-subagent-constants.js";

export { buildFridaySubagentSystemPrompt } from "./subagent/friday-subagent-system-prompt.js";
export type { BuildSubagentSystemPromptParams } from "./subagent/friday-subagent-system-prompt.js";

export { createFridaySubagentRegistry } from "./subagent/friday-subagent-registry.js";

export type { FridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";
export { createFridaySubagentRunRepository } from "./persistence/friday-subagent-run-repository.js";

export type { CreateFridayAgentSubagentToolsDeps } from "./tools/friday-agent-subagent-tools.js";
export { createFridayAgentSubagentTools } from "./tools/friday-agent-subagent-tools.js";

// Add to existing event type exports:
export type {
  // ... existing exports ...
  FridaySubagentSpawnedPayload,
  FridaySubagentCompletedPayload,
} from "./model/friday-agent.types.js";
```

### 3.11 `src/state/sqlite/migrations/v013-subagent-runs.ts` (NEW)

Full contents in [Section 6](#6-database-schema).

### 3.12 `src/state/sqlite/migrations/index.ts` (MODIFIED)

Add import and registration:

```typescript
import { V013_SUBAGENT_RUNS_MIGRATION } from "./v013-subagent-runs.js";

// Add to FRIDAY_SQLITE_MIGRATIONS array:
export const FRIDAY_SQLITE_MIGRATIONS: readonly FridaySqliteMigration[] = [
  // ... existing migrations ...
  V012_AGENT_RUNTIME_MIGRATION,
  V013_SUBAGENT_RUNS_MIGRATION,
];

// Add named export:
export { V013_SUBAGENT_RUNS_MIGRATION };
```

### 3.13 `src/api/http/routes/friday-subagent-routes.ts` (NEW)

Full contents in [Section 7](#7-api-routes).

---

## 4. Tool Specification

### 4.1 `spawn_subagent`

```typescript
{
  name: "spawn_subagent",
  description:
    "Spawn an isolated sub-agent to handle a focused task. " +
    "The sub-agent runs independently with its own context and returns its findings. " +
    "Use this for tasks that can be parallelized or require isolated execution. " +
    "The call blocks until the sub-agent completes.",
  parameters: {
    properties: {
      task: {
        type: "string",
        description: "The task for the sub-agent to complete. Be specific and self-contained.",
      },
      label: {
        type: "string",
        description: "Optional human-readable label for tracking (e.g., 'Research API docs').",
      },
      model: {
        type: "string",
        description: "Optional model override for the sub-agent (defaults to parent's model).",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds (default: 180000 = 3 minutes).",
      },
    },
    required: ["task"],
  },
}
```

**`execute` implementation logic:**

1. Read parameters:
   ```typescript
   const task = readStringParam(args, "task", { required: true });
   const label = readStringParam(args, "label");
   const model = readStringParam(args, "model");
   const timeoutMs = readNumberParam(args, "timeoutMs", { integer: true });
   ```

2. Call `registry.spawn()`:
   ```typescript
   const outcome = await deps.registry.spawn({
     task,
     label,
     model,
     timeoutMs,
     parentRunId: deps.subagentContext.parentRunId,
     parentSessionKey: deps.subagentContext.parentSessionKey,
     depth: deps.subagentContext.depth,
     rootRunId: deps.subagentContext.rootRunId,
     signal,
   });
   ```

3. If `outcome.status === "completed"`:
   ```typescript
   return jsonResult({
     status: "completed",
     response: outcome.response,
     stats: {
       toolCallCount: outcome.toolCallCount,
       durationMs: outcome.durationMs,
       usageInput: outcome.usageInput,
       usageOutput: outcome.usageOutput,
     },
   });
   ```

4. If `outcome.status === "failed"` or `"cancelled"`:
   ```typescript
   return errorResult(
     `Sub-agent ${outcome.status}: ${outcome.response}\n` +
     `(duration: ${outcome.durationMs}ms, tools: ${outcome.toolCallCount})`
   );
   ```

5. **Error handling:** Wrap the entire `registry.spawn()` call in try/catch. If a `FridayDomainError` is thrown (depth exceeded, concurrency exceeded), return `errorResult(error.message)`. For unexpected errors, return `errorResult("Sub-agent spawn failed: " + error.message)`.

### 4.2 `list_subagents`

```typescript
{
  name: "list_subagents",
  description:
    "List sub-agents spawned by the current run. " +
    "Shows status, task, and outcome for each sub-agent.",
  parameters: {
    properties: {
      status: {
        type: "string",
        description: "Filter by status: pending, running, completed, failed, cancelled.",
      },
    },
  },
}
```

**`execute` implementation logic:**

1. Read parameters:
   ```typescript
   const status = readStringParam(args, "status") as FridaySubagentRunStatus | undefined;
   ```

2. Fetch records:
   ```typescript
   const records = deps.registry.listByParentRunId(deps.subagentContext.parentRunId);
   ```

3. Filter by status if provided:
   ```typescript
   const filtered = status ? records.filter(r => r.status === status) : records;
   ```

4. Return:
   ```typescript
   return jsonResult({
     count: filtered.length,
     subagents: filtered.map(r => ({
       id: r.id,
       task: r.task,
       label: r.label,
       status: r.status,
       depth: r.depth,
       durationMs: r.durationMs,
       outcome: r.outcome ? {
         status: r.outcome.status,
         response: r.outcome.response.slice(0, 500),
         toolCallCount: r.outcome.toolCallCount,
       } : undefined,
       createdAt: r.createdAt,
     })),
   });
   ```

---

## 5. Runtime Integration

### Key Insight: No Changes to `friday-agent-runtime.ts`

The runtime's `executeRun` method does NOT need modification. The sub-agent system is wired entirely through the **tool registry**:

1. **At the composition root** (wherever `createFridayAgentRuntime` is called — likely in the HTTP server setup or a factory module), the caller creates a `FridaySubagentRegistry` and passes it to `createFridayAgentToolRegistry`.

2. **For top-level runs**, the caller provides:
   ```typescript
   const subagentContext: FridaySubagentContext = {
     depth: 0,
     parentRunId: runId,  // The run's own ID (will be set once known)
     parentSessionKey: sessionKey,
     rootRunId: runId,
   };
   ```

   **Problem:** `runId` isn't known until `executeRun` is called (it's generated inside the runtime). 
   
   **Solution:** The composition root uses a **deferred context pattern**:
   
   Actually, looking at this more carefully: the tools are passed as a constructor parameter to `createFridayAgentRuntime`, before `executeRun` is called. But `runId` is generated inside `executeRun`. This means we can't put the correct `parentRunId` into the tools at construction time.

   **Revised approach — `FridaySubagentContext` as a mutable holder:**

   ```typescript
   // The context is a mutable object — parentRunId is set after the run starts
   const subagentContext: FridaySubagentContext = {
     depth: 0,
     parentRunId: "",  // Set by the runtime after generating runId
     parentSessionKey: "",
     rootRunId: "",
   };
   ```

   This is messy. Let's reconsider.

   **Better approach — make `createChildRuntime` a function that the registry calls:**

   The `CreateFridaySubagentRegistryDeps.createChildRuntime` callback is the composition seam. The **registry** creates a child runtime when spawning, with the correct context already baked in. The registry knows the parent's runId (it's in the spawn input). So for child runs, the context is always correct.

   For **top-level runs**, the subagent tools need to know the current run's ID. Since tools are constructed before `executeRun` runs, we need a way to inject the runId.

   **Final approach — lazy context via closure:**

   The tool registry accepts a `getSubagentContext` function instead of a static context:

   ```typescript
   export interface CreateFridayAgentToolRegistryOptions {
     // ... existing fields ...
     subagentRegistry?: FridaySubagentRegistry;
     getSubagentContext?: () => FridaySubagentContext;
   }
   ```

   At the composition root:
   ```typescript
   let currentRunId = "";
   let currentSessionKey = "";

   const tools = createFridayAgentToolRegistry({
     // ... existing options ...
     subagentRegistry,
     getSubagentContext: () => ({
       depth: 0,
       parentRunId: currentRunId,
       parentSessionKey: currentSessionKey,
       rootRunId: currentRunId,
     }),
   });
   ```

   Then before calling `runtime.executeRun`, set `currentRunId` and `currentSessionKey`. But wait — `runId` is generated *inside* `executeRun`.

   **Simplest correct approach: modify `executeRun` to accept a pre-generated runId:**

   No — that changes the runtime contract.

   **Actually simplest approach: the subagent tools capture a context holder object that gets mutated.**

   Let's go with this. It's a well-understood pattern (similar to React refs).

### Revised: `CreateFridayAgentSubagentToolsDeps`

```typescript
export interface CreateFridayAgentSubagentToolsDeps {
  registry: FridaySubagentRegistry;
  /** Mutable context ref — parentRunId is set by the runtime after runId is generated. */
  contextRef: { current: FridaySubagentContext };
}
```

### Revised: `CreateFridayAgentToolRegistryOptions`

```typescript
export interface CreateFridayAgentToolRegistryOptions {
  // ... existing fields ...
  subagentRegistry?: FridaySubagentRegistry;
  subagentContextRef?: { current: FridaySubagentContext };
}
```

### `friday-agent-runtime.ts` Changes (MINIMAL)

Add after `const runId = idGenerator();` and `const sessionKey = ...`:

```typescript
// Update subagent context ref with this run's identity
const subagentContextRef = findSubagentContextRef(tools);
if (subagentContextRef) {
  subagentContextRef.current = {
    ...subagentContextRef.current,
    parentRunId: runId,
    parentSessionKey: sessionKey,
    rootRunId: subagentContextRef.current.rootRunId || runId,
  };
}
```

**Wait — this is getting convoluted.** The runtime shouldn't be aware of subagent internals.

### FINAL Approach: Two-phase Construction

The runtime does NOT change. Instead, the **composition root** is responsible for wiring everything:

```typescript
// Composition root pseudocode:

function startAgentRun(task: string, providerId?: string, model?: string, timeoutMs?: number) {
  // 1. Pre-generate runId
  const runId = idGenerator();
  const sessionKey = `agent:run:${runId}`;

  // 2. Build subagent context for this specific run
  const subagentContext: FridaySubagentContext = {
    depth: 0,
    parentRunId: runId,
    parentSessionKey: sessionKey,
    rootRunId: runId,
  };

  // 3. Build tools with subagent support
  const tools = createFridayAgentToolRegistry({
    workdir,
    skillExecutor,
    workflowExecutionService,
    memoryService,
    subagentRegistry,
    subagentContext,
  });

  // 4. Build runtime for this specific run
  const runtime = createFridayAgentRuntime({
    db, llmClient, model: model ?? defaultModel, providerId: providerId ?? defaultProviderId,
    systemPrompt, tools, eventEmitter, idGenerator, nowIso,
  });

  // 5. Execute — but we need the runtime to use OUR pre-generated runId!
  return runtime.executeRun({
    task,
    sessionKey,
    timeoutMs,
  });
}
```

**Problem:** The runtime generates its own `runId` inside `executeRun`. We need the runtime to accept an externally-provided `runId`.

**Solution: Add optional `runId` to `executeRun` params.**

This is a minimal, clean change to the runtime:

### `friday-agent-runtime.types.ts` — Final Changes

```typescript
export interface FridayAgentRuntime {
  executeRun(params: {
    task: string;
    sessionKey?: string;
    runId?: string;          // NEW: optional pre-generated run ID
    maxAttempts?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<FridayAgentRuntimeResult>;
}
```

### `friday-agent-runtime.ts` — Final Changes

Change:
```typescript
const runId = idGenerator();
```
To:
```typescript
const runId = params.runId ?? idGenerator();
```

That's the **only** change to the runtime. One line.

### Composition Root Wiring (for top-level runs)

```typescript
async function startRun(input: {
  task: string;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<FridayAgentRuntimeResult> {
  const runId = idGenerator();
  const sessionKey = `${FRIDAY_AGENT_SESSION_KEY_PREFIX}${runId}`;

  const subagentContext: FridaySubagentContext = {
    depth: 0,
    parentRunId: runId,
    parentSessionKey: sessionKey,
    rootRunId: runId,
  };

  const tools = createFridayAgentToolRegistry({
    workdir,
    skillExecutor,
    workflowExecutionService,
    memoryService,
    subagentRegistry,
    subagentContext,
  });

  const runtime = createFridayAgentRuntime({
    db, llmClient,
    model: input.model ?? defaultModel,
    providerId: input.providerId ?? defaultProviderId,
    systemPrompt, tools, eventEmitter, idGenerator, nowIso,
  });

  return runtime.executeRun({
    task: input.task,
    runId,
    sessionKey,
    timeoutMs: input.timeoutMs,
  });
}
```

### Composition Root Wiring (for child runs — inside `createChildRuntime`)

The `CreateFridaySubagentRegistryDeps.createChildRuntime` callback builds a child runtime with sub-agent tools at `depth + 1`:

```typescript
const subagentRegistry = createFridaySubagentRegistry({
  db,
  eventEmitter,
  idGenerator,
  nowIso,
  createChildRuntime(childParams) {
    // childParams: { model?, systemPrompt, depth }
    return {
      async executeRun(runParams) {
        const childRunId = idGenerator();
        const childSessionKey = runParams.sessionKey;

        // Only add subagent tools if not at max depth
        const childSubagentContext: FridaySubagentContext = {
          depth: childParams.depth,
          parentRunId: childRunId,
          parentSessionKey: childSessionKey,
          rootRunId: "", // Will be set by whoever spawns
        };

        const childTools = createFridayAgentToolRegistry({
          workdir,
          // Children get the same tools as parent
          skillExecutor,
          workflowExecutionService,
          memoryService,
          // Only provide subagent tools if below max depth
          subagentRegistry: childParams.depth < FRIDAY_SUBAGENT_MAX_DEPTH
            ? subagentRegistry
            : undefined,
          subagentContext: childParams.depth < FRIDAY_SUBAGENT_MAX_DEPTH
            ? childSubagentContext
            : undefined,
        });

        const childRuntime = createFridayAgentRuntime({
          db,
          llmClient,
          model: childParams.model ?? defaultModel,
          providerId: defaultProviderId,
          systemPrompt: childParams.systemPrompt,
          tools: childTools,
          eventEmitter,
          idGenerator,
          nowIso,
        });

        return childRuntime.executeRun({
          task: runParams.task,
          runId: childRunId,
          sessionKey: runParams.sessionKey,
          timeoutMs: runParams.timeoutMs,
          signal: runParams.signal,
        });
      },
    };
  },
});
```

**Note about `rootRunId`:** The registry sets `rootRunId` on the child context when spawning. In `spawn()`, the `rootRunId` from the spawn input is passed through.

### Summary of Runtime Changes

| File | Change | Lines affected |
|------|--------|---------------|
| `friday-agent-runtime.types.ts` | Add `runId?: string` to `executeRun` params | 1 line |
| `friday-agent-runtime.ts` | Use `params.runId ?? idGenerator()` | 1 line |

Everything else is encapsulated in the new subagent modules and the tool registry wiring.

---

## 6. Database Schema

### File: `src/state/sqlite/migrations/v013-subagent-runs.ts`

```typescript
import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V013_SUBAGENT_RUNS_SQL = `
-- V013: Sub-agent runs

CREATE TABLE IF NOT EXISTS friday_subagent_runs (
  id                  TEXT PRIMARY KEY,
  parent_run_id       TEXT NOT NULL,
  parent_session_key  TEXT NOT NULL,
  child_run_id        TEXT NOT NULL DEFAULT '',
  child_session_key   TEXT NOT NULL,
  task                TEXT NOT NULL,
  label               TEXT,
  model               TEXT,
  depth               INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  outcome             TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  duration_ms         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_parent
  ON friday_subagent_runs (parent_run_id);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_status
  ON friday_subagent_runs (status);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_created
  ON friday_subagent_runs (created_at);

CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_child
  ON friday_subagent_runs (child_run_id);
`;

const V013_CHECKSUM = computeFridayMigrationChecksum(V013_SUBAGENT_RUNS_SQL);

export const V013_SUBAGENT_RUNS_MIGRATION: FridaySqliteMigration = {
  version: 13,
  name: "v013-subagent-runs",
  sql: V013_SUBAGENT_RUNS_SQL,
  checksum: V013_CHECKSUM,
};
```

### Column Specification

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | TEXT PK | No | Subagent record ID |
| `parent_run_id` | TEXT | No | ID of the parent agent run |
| `parent_session_key` | TEXT | No | Session key of the parent |
| `child_run_id` | TEXT | No | ID of the child agent run (set after child starts, default empty) |
| `child_session_key` | TEXT | No | Session key of the child |
| `task` | TEXT | No | Task description given to the child |
| `label` | TEXT | Yes | Human-readable label |
| `model` | TEXT | Yes | Model override (null = parent's model) |
| `depth` | INTEGER | No | Nesting depth (1 = direct child of top-level) |
| `status` | TEXT | No | pending / running / completed / failed / cancelled |
| `outcome` | TEXT | Yes | JSON blob: `FridaySubagentOutcome` |
| `created_at` | TEXT | No | ISO timestamp |
| `started_at` | TEXT | Yes | ISO timestamp |
| `completed_at` | TEXT | Yes | ISO timestamp |
| `duration_ms` | INTEGER | Yes | Total duration |

**Note:** No foreign key to `friday_agent_runs` — the parent/child run IDs are logical references. This avoids ordering issues during concurrent inserts and keeps the subagent table self-contained.

---

## 7. API Routes

### File: `src/api/http/routes/friday-subagent-routes.ts`

```typescript
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridaySubagentRegistry,
  FridaySubagentRunRecord,
  FridaySubagentRunStatus,
} from "#agent";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const SUBAGENT_MAX_LIST_LIMIT = 100;

// ─── Deps ───

export interface FridaySubagentRoutesDeps {
  subagentRegistry: FridaySubagentRegistry;
}

// ─── Factory ───

export function createFridaySubagentRoutes(
  deps: FridaySubagentRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
```

### Endpoints

#### `GET /v1/agent/subagents`

**operationId:** `agent.subagents.list`  
**auth:** `{ public: false, anyOfScopes: ["workflow.run"] }`

**Query params:**
- `parentRunId?: string` — filter by parent run
- `status?: string` — filter by status
- `limit?: number` — max results (capped at 100)
- `cursor?: string` — pagination cursor (created_at)

**Handler logic:**
1. Parse and validate query params.
2. Call `deps.subagentRegistry.list({ parentRunId, status, limit, cursor })`.
3. Return `{ items }`.

#### `GET /v1/agent/subagents/:subagentId`

**operationId:** `agent.subagents.get`  
**auth:** `{ public: false, anyOfScopes: ["workflow.run"] }`

**Handler logic:**
1. Extract `subagentId` from params.
2. Call `deps.subagentRegistry.getById(subagentId)`.
3. If null, throw `FridayDomainError` with code `SUBAGENT_NOT_FOUND`, httpStatus 404.
4. Return `{ subagent }`.

#### `GET /v1/agent/runs/:runId/subagents`

**operationId:** `agent.runs.subagents.list`  
**auth:** `{ public: false, anyOfScopes: ["workflow.run"] }`

**Handler logic:**
1. Extract `runId` from params.
2. Call `deps.subagentRegistry.listByParentRunId(runId)`.
3. Return `{ items }`.

---

## 8. Event Flow

### New Events

| Event Name | Payload Type | Emitted When |
|------------|-------------|--------------|
| `agent.subagent.spawned` | `FridaySubagentSpawnedPayload` | Sub-agent record created, before child execution starts |
| `agent.subagent.completed` | `FridaySubagentCompletedPayload` | Child execution finished (any terminal status) |

### SSE Integration

The existing SSE endpoint at `GET /v1/agent/runs/:runId/events` should subscribe to the two new event names. Modify the `eventNames` array in `friday-agent-routes.ts`:

```typescript
const eventNames: FridayAgentEventName[] = [
  // ... existing names ...
  "agent.subagent.spawned",
  "agent.subagent.completed",
];
```

These events include `parentRunId` in their payload. The SSE handler should filter by checking if the payload's `parentRunId` matches the requested `runId` (in addition to the existing `runId` check for standard events).

**Modified filter logic in SSE handler:**

```typescript
const listener = ((payload: FridayAgentEventMap[typeof eventName]) => {
  const p = payload as unknown as Record<string, unknown>;
  // Standard events use runId, subagent events use parentRunId
  const payloadRunId = p.runId ?? p.parentRunId;
  if (payloadRunId !== runId) return;
  // ... rest of handler
}) as AnyListener;
```

### Event Sequence for a Successful Sub-Agent Run

```
1. agent.run.started        (parent)
2. agent.run.planning       (parent)
3. agent.run.tool_start     (parent, toolName: "spawn_subagent")
4. agent.subagent.spawned   (subagentId, parentRunId, task, depth)
5. agent.run.started        (child — different runId)
6. agent.run.planning       (child)
7. ... child tool calls ...
8. agent.run.completed      (child)
9. agent.subagent.completed (subagentId, parentRunId, childRunId, outcome)
10. agent.run.tool_end      (parent, toolName: "spawn_subagent")
11. ... parent continues ...
12. agent.run.completed     (parent)
```

---

## 9. Constraints

### 9.1 Max Depth

- **Default:** 3 (configurable via `FRIDAY_SUBAGENT_MAX_DEPTH`)
- **Meaning:** Depth 0 is the top-level run. A sub-agent spawned by it is depth 1. Its child is depth 2. Depth 3 is the maximum, so a run at depth 3 cannot spawn children.
- **Enforcement:** In `registry.spawn()`, check `input.depth >= FRIDAY_SUBAGENT_MAX_DEPTH`. Also, at `depth >= FRIDAY_SUBAGENT_MAX_DEPTH`, the `spawn_subagent` tool is not included in the child's tool set (belt-and-suspenders).

### 9.2 Max Concurrent

- **Default:** 5 (configurable via `FRIDAY_SUBAGENT_MAX_CONCURRENT`)
- **Meaning:** Per parent run, no more than 5 sub-agents in `pending` or `running` status.
- **Enforcement:** In `registry.spawn()`, count active sub-agents for the parent and reject if at limit.
- **Note:** Since `spawn_subagent` is a blocking tool call, the LLM cannot request multiple tool calls that each spawn a sub-agent in parallel — the tool calls execute sequentially in the runtime's for-loop. So in practice, a parent can only have 1 active sub-agent at a time with the current runtime architecture. The limit of 5 is a safeguard for future parallel tool execution.

### 9.3 Timeout Propagation

- **Child timeout:** Defaults to `FRIDAY_SUBAGENT_DEFAULT_TIMEOUT_MS` (3 minutes). Can be overridden per spawn via the `timeoutMs` parameter.
- **Parent timeout:** The parent's timeout clock keeps ticking while a child runs. If the parent times out, its `AbortSignal` fires, which cascades to the child (because the child receives the parent's signal).
- **Child timeout does not kill parent:** If a child times out, the child runtime returns `{ status: "failed", response: "Agent run timed out" }`. The registry wraps this in a failed outcome. The parent gets an error tool_result and can decide to retry or proceed.

### 9.4 Abort Cascading

- **Parent abort → children abort:** The `signal` passed to `registry.spawn()` is the parent's abort signal. This signal is forwarded to `childRuntime.executeRun({ signal })`. When the parent's signal fires, the child's execution is interrupted.
- **Child abort does not affect parent:** A child's internal abort (timeout) only affects the child. The parent receives a tool_result and continues.
- **Cancellation via API:** Cancelling a parent run (via `POST /v1/agent/runs/:runId/cancel`) fires the parent's abort controller, which cascades to all active children.

### 9.5 Resource Limits

- **Child tools:** Children get the same tool set as the parent (exec, read, write, edit, web_fetch, skill, workflow, memory) plus `spawn_subagent`/`list_subagents` if below max depth.
- **No model downgrade requirement:** Children can use any model. The `model` parameter in `spawn_subagent` allows the parent to choose a cheaper/faster model for simple tasks.
- **Token accounting:** Child token usage is tracked independently in `friday_agent_runs` and in the subagent outcome. The parent's total token count does NOT include child tokens (they are separate LLM calls).

---

## 10. Test Plan

### Test File Locations

```
test/unit/agent/subagent/friday-subagent-registry.test.ts
test/unit/agent/subagent/friday-subagent-system-prompt.test.ts
test/unit/agent/persistence/friday-subagent-run-repository.test.ts
test/unit/agent/tools/friday-agent-subagent-tools.test.ts
test/integration/agent/friday-subagent-integration.test.ts
```

### 10.1 `friday-subagent-system-prompt.test.ts`

| Test | Description |
|------|-------------|
| builds prompt with task only | Verify output contains task, role declaration, rules |
| includes label when provided | Verify label appears in output |
| includes depth in context | Verify depth number appears |
| includes parent session key | Verify session key appears |

### 10.2 `friday-subagent-run-repository.test.ts`

| Test | Description |
|------|-------------|
| create inserts row | Insert and verify all fields |
| getById returns record | Insert then fetch by ID |
| getById returns null for missing | Query non-existent ID |
| update changes status | Create, update status, verify |
| update stores outcome as JSON | Create, update with outcome, verify parsing |
| listByParentRunId returns children | Create 3 records with same parent, verify list |
| listByParentRunId empty for wrong parent | Query with non-matching parent ID |
| list with status filter | Create records with different statuses, filter |
| list with limit | Create 5 records, limit to 3 |
| countActiveByParentRunId counts pending+running | Create mix of statuses, verify count |

### 10.3 `friday-subagent-registry.test.ts`

| Test | Description |
|------|-------------|
| spawn completes successfully | Mock child runtime returning completed, verify outcome |
| spawn records start and completion in DB | Verify SQLite records after spawn |
| spawn emits spawned and completed events | Track events, verify both fire |
| spawn rejects at max depth | Set depth = MAX_DEPTH, expect error |
| spawn rejects at max concurrent | Pre-fill active records to MAX_CONCURRENT, expect error |
| spawn handles child failure | Mock child runtime returning failed, verify failed outcome |
| spawn handles child cancellation | Abort signal during spawn, verify cancelled outcome |
| spawn handles child runtime exception | Mock child runtime throwing, verify failed outcome (no rethrow) |
| listByParentRunId returns correct records | Spawn 2, verify list |
| getById returns correct record | Spawn 1, fetch by ID |
| activeCountForParent returns correct count | Verify count during and after spawn |

### 10.4 `friday-agent-subagent-tools.test.ts`

| Test | Description |
|------|-------------|
| spawn_subagent returns completed result | Mock registry.spawn returning completed outcome |
| spawn_subagent returns error for failed sub-agent | Mock registry.spawn returning failed outcome |
| spawn_subagent handles depth exceeded error | Mock registry.spawn throwing SUBAGENT_MAX_DEPTH_EXCEEDED |
| spawn_subagent handles concurrency exceeded error | Mock registry.spawn throwing SUBAGENT_MAX_CONCURRENT_EXCEEDED |
| spawn_subagent requires task param | Call with empty args, expect error |
| spawn_subagent passes optional params | Call with label, model, timeoutMs, verify forwarded |
| list_subagents returns records | Mock registry.listByParentRunId returning records |
| list_subagents filters by status | Pass status param, verify filter applied |
| list_subagents returns empty array | Mock returning empty list |

### 10.5 `friday-subagent-integration.test.ts`

| Test | Description |
|------|-------------|
| parent spawns child, gets result | Full flow: parent LLM returns spawn_subagent tool_use, child LLM responds with text, parent gets tool_result, parent produces final response |
| nested sub-agents (depth 2) | Parent spawns child, child spawns grandchild, result propagates back |
| sub-agent at max depth cannot spawn | Parent at depth MAX_DEPTH-1 spawns child at MAX_DEPTH, child tries to spawn and gets error tool_result |
| parent timeout cascades to child | Parent timeout is short, child is slow, both end up cancelled/failed |
| parent cancellation cascades to child | Cancel parent while child is running, child gets aborted |
| child failure doesn't crash parent | Child throws, parent gets error tool_result, parent continues |
| multiple sequential sub-agents | Parent spawns 3 sub-agents sequentially, all complete |
| database records are consistent | After full flow, verify both friday_agent_runs and friday_subagent_runs have correct statuses |
| SSE events include subagent lifecycle | Subscribe to parent's SSE stream, verify subagent.spawned and subagent.completed events arrive |

### Edge Cases to Cover

1. **Empty task string** → `spawn_subagent` returns error (validation in readStringParam)
2. **Very long task string** → no truncation needed (LLM handles it)
3. **Child exceeds loop iterations** → child fails with AGENT_LOOP_LIMIT, parent gets error tool_result
4. **Parent has 0 remaining timeout when child starts** → child immediately times out
5. **Concurrent access to SQLite** → write transactions serialize correctly (WAL mode)
6. **Registry methods called after DB close** → handled by better-sqlite3 error propagation
7. **Sub-agent spawns with model override** → child runtime uses specified model
8. **Sub-agent outcome JSON parsing** → repository correctly round-trips FridaySubagentOutcome through JSON

---

## Appendix A: File Change Summary

### New Files (8)

| File | Purpose |
|------|---------|
| `src/agent/subagent/friday-subagent.types.ts` | All sub-agent type definitions |
| `src/agent/subagent/friday-subagent-constants.ts` | Limits, defaults, error codes |
| `src/agent/subagent/friday-subagent-system-prompt.ts` | Child system prompt builder |
| `src/agent/subagent/friday-subagent-registry.ts` | Core registry: spawn, track, query |
| `src/agent/persistence/friday-subagent-run-repository.ts` | SQLite CRUD for subagent_runs |
| `src/agent/tools/friday-agent-subagent-tools.ts` | spawn_subagent + list_subagents tools |
| `src/state/sqlite/migrations/v013-subagent-runs.ts` | SQLite migration DDL |
| `src/api/http/routes/friday-subagent-routes.ts` | REST endpoints |

### Modified Files (5)

| File | Change |
|------|--------|
| `src/agent/model/friday-agent.types.ts` | Add `FridaySubagentSpawnedPayload`, `FridaySubagentCompletedPayload`, extend `FridayAgentEventMap` |
| `src/agent/tools/friday-agent-tool-registry.ts` | Add `subagentRegistry`/`subagentContext` options, register subagent tools |
| `src/agent/runtime/friday-agent-runtime.types.ts` | Add `runId?: string` to `executeRun` params |
| `src/agent/runtime/friday-agent-runtime.ts` | Use `params.runId ?? idGenerator()` (1 line) |
| `src/agent/index.ts` | Re-export all new types and factories |
| `src/state/sqlite/migrations/index.ts` | Import and register V013 migration |
| `src/api/http/routes/friday-agent-routes.ts` | Add subagent event names to SSE subscription, update filter logic |

### New Test Files (5)

| File |
|------|
| `test/unit/agent/subagent/friday-subagent-registry.test.ts` |
| `test/unit/agent/subagent/friday-subagent-system-prompt.test.ts` |
| `test/unit/agent/persistence/friday-subagent-run-repository.test.ts` |
| `test/unit/agent/tools/friday-agent-subagent-tools.test.ts` |
| `test/integration/agent/friday-subagent-integration.test.ts` |

---

## Appendix B: Implementation Order

1. **V013 migration** — schema must exist before anything else
2. **Types** — `friday-subagent.types.ts` + `friday-subagent-constants.ts`
3. **System prompt** — `friday-subagent-system-prompt.ts` (standalone, no deps)
4. **Repository** — `friday-subagent-run-repository.ts` (depends on types + DB)
5. **Registry** — `friday-subagent-registry.ts` (depends on types, repo, system prompt)
6. **Tools** — `friday-agent-subagent-tools.ts` (depends on registry + types)
7. **Tool registry** — modify `friday-agent-tool-registry.ts`
8. **Runtime** — modify `friday-agent-runtime.ts` + types (1 line each)
9. **Events** — modify `friday-agent.types.ts` event map
10. **Index** — modify `src/agent/index.ts` exports
11. **Migrations index** — register V013
12. **API routes** — `friday-subagent-routes.ts`
13. **SSE integration** — modify `friday-agent-routes.ts`
14. **Tests** — all test files
