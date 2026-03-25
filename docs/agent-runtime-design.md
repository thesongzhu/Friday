# Friday Agent Runtime — Design Document

> **Phase 2 of the Friday roadmap.** This document specifies how to add an LLM agent loop to Friday that can receive a task, plan, execute, self-test, self-fix, stream live status, and save completed automations for one-click reuse.

---

## A. Architecture Overview

### A.1 How Friday Maps to ClawdBot

| ClawdBot Concept | ClawdBot Source | Friday Equivalent | Adaptation |
|---|---|---|---|
| `runEmbeddedAttempt` — outer orchestration | `attempt.ts` (full file) | `FridayAgentRuntime.executeRun()` | Strip all channel/messaging/sandbox/heartbeat/plugin-hook/session-file plumbing. Keep: system prompt assembly → LLM loop → tool dispatch → abort/timeout → snapshot capture. |
| `subscribeEmbeddedPiSession` — event subscription | `pi-embedded-subscribe.ts` | `FridayAgentEventEmitter` | Replace ClawdBot's block-chunker/messaging-dedup/compaction-retry with Friday's `FridayRealtimeEventBus`. |
| `createExecTool` — shell execution | `bash-tools-exec.ts` | `createFridayAgentExecTool` | Remove approval/allowlist/sandbox/node-host/elevated layers. Keep: spawn, yield/background, timeout, output capture. |
| `createSessionsSpawnTool` — sub-agents | `sessions-spawn-tool.ts` | *Deferred to Phase 3+* | Friday doesn't need sub-agents yet. |
| `SubagentRunRecord` / registry | `subagent-registry.ts` | *Deferred* | Same reason. |
| Tool result utilities | `tools-common.ts` | `friday-agent-tool-helpers.ts` | Port `readStringParam`, `jsonResult`, `ToolInputError`. Drop image/media helpers (not needed for agent MVP). |
| Workspace bootstrap files | `workspace.ts` | `loadFridayWorkspaceContext()` | Friday loads repo-scoped context files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, daily memory, exported memory) on each run instead of reusing ClawdBot's workspace bootstrap path. |
| Tool definitions for subscription | `pi-embedded-subscribe-tools.ts` | Inline in `FridayAgentEventEmitter` | Only port `extractToolResultText`, `isToolResultError`, `extractToolErrorMessage` for status reporting. |

### A.2 What We Port Directly

1. **Agent loop skeleton** — The prompt → stream → tool-call → tool-result → re-prompt cycle from `attempt.ts` lines 165–480 (session setup through `activeSession.prompt()`).
2. **Exec tool core** — The process spawning, yield/background, and output capture from `bash-tools-exec.ts` lines 82–160 (the `execute` function body minus approval/allowlist/node paths).
3. **Tool result parsing** — `extractToolResultText`, `isToolResultError`, `extractToolErrorMessage` from `pi-embedded-subscribe-tools.ts`.
4. **Parameter helpers** — `readStringParam`, `readNumberParam`, `jsonResult`, `ToolInputError` from `tools-common.ts`.

### A.3 What We Adapt

1. **Provider integration** — ClawdBot uses `streamSimple` from `pi-ai` + session/settings managers. Friday uses `FridayProviderService.runWithFallback()` for BYOK routing.
2. **Session management** — ClawdBot's `SessionManager.open()` file-based sessions → Friday's `FridaySessionService` (SQLite-backed).
3. **Event streaming** — ClawdBot's `subscribeEmbeddedPiSession` (in-process event handler) → Friday's `FridayRealtimeEventBus` + WebSocket gateway (already built).
4. **Abort/timeout** — ClawdBot's `runAbortController` + timer pattern ports cleanly but needs to integrate with Friday's `AbortController` per-run.

### A.4 New Components (No ClawdBot Equivalent)

| Component | Purpose |
|---|---|
| `FridayAgentSelfTestService` | Runs validation checks on agent output (code linting, HTTP probes, assertion checks). |
| `FridayAgentSelfFixService` | Feeds test failures back into the agent loop for retry (max 3 attempts). |
| `FridayAgentRunStore` | SQLite persistence for agent runs (status, artifacts, replay). |
| `FridayAgentAutomationService` | Saves completed agent work as reusable automations with triggers. |
| `FridayAgentAutomationRepository` | SQLite CRUD for saved automations. |

---

## B. Module Breakdown

### B.1 Core Types

**File:** `src/agent/model/friday-agent.types.ts`
**Responsibility:** All agent domain types — run records, tool definitions, event payloads, automation records.
**ClawdBot source:** `attempt.ts` types (`EmbeddedRunAttemptParams/Result`), `bash-tools-exec.ts` types (`ExecToolDetails`).
**Adaptations:** Replace ClawdBot's channel/messaging/sandbox types with Friday's session/provider types.

### B.2 Constants

**File:** `src/agent/friday-agent.constants.ts`
**Responsibility:** `FRIDAY_AGENT_*` constants — max attempts, timeouts, event names, error codes.
**ClawdBot source:** Scattered constants from `attempt.ts`, `bash-tools-exec.ts`.
**Adaptations:** Consolidate into one file following Friday convention.

### B.3 Agent Runtime (Core Loop)

**File:** `src/agent/runtime/friday-agent-runtime.ts`
**Types file:** `src/agent/runtime/friday-agent-runtime.types.ts`
**Responsibility:** The main `executeRun()` function — receives a task, builds system prompt, enters LLM loop, dispatches tools, handles abort/timeout.
**ClawdBot source:** `attempt.ts` lines 165–580 (from workspace setup through `activeSession.prompt()` and message snapshot).
**Adaptations:**
- Replace `SessionManager.open()` → `FridaySessionService.getOrCreateSession()`
- Replace `streamSimple` → `FridayProviderInferenceClient` (with streaming extension)
- Replace `createOpenClawCodingTools()` → `createFridayAgentToolRegistry()`
- Replace `subscribeEmbeddedPiSession()` → `FridayAgentEventEmitter`
- Strip: sandbox, skill env overrides, bootstrap files, hooks, compaction, channel capabilities, Ollama special-casing, anthropic payload logging, cache traces

### B.4 Agent Event Emitter

**File:** `src/agent/runtime/friday-agent-event-emitter.ts`
**Responsibility:** Bridges the LLM streaming loop to Friday's `FridayRealtimeEventBus`. Emits typed events as the agent progresses through phases (planning, executing, testing, fixing, complete, error).
**ClawdBot source:** `pi-embedded-subscribe.ts` lines 1–100 (subscription setup) + lines 280–400 (event handlers for tool_start/tool_end/text_delta/message_end).
**Adaptations:** Replace ClawdBot's block-chunker / messaging-dedup / compaction-retry with simple event publishing to `FridayRealtimeEventBus`.

### B.5 Tool Registry

**File:** `src/agent/tools/friday-agent-tool-registry.ts`
**Responsibility:** Creates and returns the full set of tools available to the agent. Acts as the single entry point for tool creation.
**ClawdBot source:** `pi-tools.ts` `createOpenClawCodingTools()` (not in reference but referenced by `attempt.ts`).
**Adaptations:** Friday-specific tools (skill_run, workflow_run, memory_search/store) have no ClawdBot equivalent — built from scratch against existing Friday services.

### B.6 Exec Tool

**File:** `src/agent/tools/friday-agent-exec-tool.ts`
**Responsibility:** Shell command execution with timeout, background yield, and output capture.
**ClawdBot source:** `bash-tools-exec.ts` lines 82–160 (the `execute` function body). Specifically: lines 82–95 (param parsing), lines 100–120 (environment setup), lines 430–530 (process spawning and yield logic).
**Adaptations:** Remove: approval system, allowlist, security levels, sandbox, node/gateway host routing, elevated mode, safe-bins. Keep: command execution, yield/background, timeout, PTY support, output truncation.

### B.7 File Tools (read/write/edit)

**File:** `src/agent/tools/friday-agent-file-tools.ts`
**Responsibility:** File system operations — read file, write file, edit file (find-and-replace).
**ClawdBot source:** These are Pi SDK built-in tools in ClawdBot. We write our own lightweight versions.
**Adaptations:** Built from scratch. Simple `fs.readFile`/`fs.writeFile` with path safety via `friday-path-safety.ts`.

### B.8 Skill Run Tool

**File:** `src/agent/tools/friday-agent-skill-tool.ts`
**Responsibility:** Execute a Friday skill by ID with given input. Wraps `FridaySkillExecutor.execute()`.
**ClawdBot source:** No direct equivalent (new).
**Adaptations:** N/A — new tool.

### B.9 Workflow Run Tool

**File:** `src/agent/tools/friday-agent-workflow-tool.ts`
**Responsibility:** Start a Friday workflow run with given input. Wraps `FridayWorkflowExecutionService.startRun()`.
**ClawdBot source:** No direct equivalent (new).
**Adaptations:** N/A — new tool.

### B.10 Web Fetch Tool

**File:** `src/agent/tools/friday-agent-web-fetch-tool.ts`
**Responsibility:** HTTP GET/POST with response body extraction. Lightweight web access for the agent.
**ClawdBot source:** ClawdBot's `web_fetch` tool (not in reference files but similar pattern).
**Adaptations:** Built from scratch using Node's built-in `fetch`.

### B.11 Memory Tools

**File:** `src/agent/tools/friday-agent-memory-tools.ts`
**Responsibility:** `memory_search` and `memory_store` tools wrapping `FridayMemoryService`.
**ClawdBot source:** No direct equivalent (new).
**Adaptations:** N/A — new tools using existing Friday memory system.

### B.12 Tool Helpers

**File:** `src/agent/tools/friday-agent-tool-helpers.ts`
**Responsibility:** Shared utilities for all agent tools — parameter readers, result formatters, error types.
**ClawdBot source:** `tools-common.ts` (full file).
**Adaptations:** Port `readStringParam`, `readNumberParam`, `readStringArrayParam`, `jsonResult`, `ToolInputError`. Drop image/media helpers.

### B.13 Self-Test Service

**File:** `src/agent/testing/friday-agent-self-test-service.ts`
**Types file:** `src/agent/testing/friday-agent-self-test-service.types.ts`
**Responsibility:** Validates agent output — runs generated code, checks exit codes, verifies HTTP endpoints, runs assertions.
**ClawdBot source:** No direct equivalent (new).
**Adaptations:** N/A.

### B.14 Self-Fix Service

**File:** `src/agent/testing/friday-agent-self-fix-service.ts`
**Responsibility:** Feeds test failures back into the agent with diagnostic context, manages retry budget.
**ClawdBot source:** No direct equivalent (new). Friday's existing `learning/services/friday-auto-fix-*` provides patterns but is for the self-learning system, not the agent loop.
**Adaptations:** N/A.

### B.15 Agent Run Store

**File:** `src/agent/persistence/friday-agent-run-repository.ts`
**Responsibility:** SQLite CRUD for agent run records (id, task, status, steps, artifacts, timestamps).
**ClawdBot source:** No direct equivalent. ClawdBot stores runs in-memory only.
**Adaptations:** N/A — follows Friday's repository pattern.

### B.16 Agent Automation Service

**File:** `src/agent/services/friday-agent-automation-service.ts`
**Types file:** `src/agent/services/friday-agent-automation-service.types.ts`
**Responsibility:** Saves completed agent work as reusable automations. CRUD + enable/disable toggle + trigger binding.
**ClawdBot source:** No equivalent.
**Adaptations:** N/A.

### B.17 Agent Automation Repository

**File:** `src/agent/persistence/friday-agent-automation-repository.ts`
**Responsibility:** SQLite CRUD for saved automations.
**ClawdBot source:** No equivalent.
**Adaptations:** N/A.

### B.18 Agent Routes

**File:** `src/api/http/routes/friday-agent-routes.ts`
**Responsibility:** HTTP API for starting runs, getting run status, listing runs, CRUD automations.
**ClawdBot source:** No equivalent (ClawdBot uses gateway RPC, not REST).
**Adaptations:** N/A — follows Friday's route pattern.

### B.19 Agent LLM Client

**File:** `src/agent/runtime/friday-agent-llm-client.ts`
**Types file:** `src/agent/runtime/friday-agent-llm-client.types.ts`
**Responsibility:** Wraps `FridayProviderService` to provide a streaming chat completion interface with tool-call support for the agent loop. This is the bridge between Friday's BYOK provider system and the agent's LLM ↔ tool cycle.
**ClawdBot source:** `attempt.ts` lines 280–320 (stream function setup), `pi-embedded-subscribe.ts` (stream event handling).
**Adaptations:** Replace `streamSimple` + `pi-ai` with direct Anthropic/OpenAI API calls routed through `FridayProviderService.runWithFallback()`.

### B.20 Barrel Export

**File:** `src/agent/index.ts`
**Responsibility:** Public API barrel for `#agent` subpath import.
**Package.json addition:** `"#agent": "./dist/agent/index.js"`

---

## C. Agent Loop Design

### C.1 LLM ↔ Tool Loop

The core loop follows ClawdBot's `attempt.ts` pattern, adapted for Friday:

```
┌─────────────────────────────────────────────────┐
│                 User sends task                  │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│  1. Create FridayAgentRun record (status: plan)  │
│  2. Build system prompt + tool definitions       │
│  3. Resolve provider via FridayProviderService   │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│  4. Send prompt to LLM (streaming)               │
│     ← text_delta events → emit to EventBus       │
│     ← tool_use events → dispatch to tool handler │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│  5. Tool dispatch:                               │
│     - Match tool name to registry                │
│     - Execute tool, capture result               │
│     - Append tool_result to conversation         │
│     - Re-prompt LLM (go to step 4)              │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│  6. LLM returns final text (no more tool calls)  │
│     → Run self-test (Section E)                  │
│     → If fail: self-fix loop (max 3 attempts)    │
│     → If pass or max attempts: finalize          │
└────────────────────┬────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│  7. Finalize:                                    │
│     - Save conversation to session               │
│     - Update run status (complete/failed)        │
│     - Emit completion event                      │
│     - Offer "Save as Automation" to user         │
└─────────────────────────────────────────────────┘
```

### C.2 Tool Registry

The tool registry is a simple map created at run start:

```typescript
interface FridayAgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<FridayAgentToolResult>;
}

interface FridayAgentToolResult {
  content: string;
  isError?: boolean;
}
```

Tools available to the agent (created by `createFridayAgentToolRegistry`):

| Tool | Description |
|---|---|
| `exec` | Run shell commands |
| `read` | Read file contents |
| `write` | Write/create files |
| `edit` | Find-and-replace in files |
| `skill_run` | Execute a Friday skill |
| `workflow_run` | Start a Friday workflow |
| `web_fetch` | HTTP requests |
| `memory_search` | Search Friday's memory |
| `memory_store` | Store to Friday's memory |

### C.3 Integration with Existing Friday Systems

**Providers (BYOK):**
- The agent uses `FridayProviderService.resolveRoute()` to pick the LLM provider+model.
- `FridayProviderService.runWithFallback()` handles provider rotation on failure.
- API keys come from the user's configured providers — the agent never stores keys.

**Sessions:**
- Each agent run creates a session via `FridaySessionService.getOrCreateSession()` with key `agent:run:{runId}`.
- All LLM messages (user prompt, assistant responses, tool calls/results) are persisted as `FridaySessionMessageRecord`.
- Sessions support replay and debugging.

**Skills:**
- The `skill_run` tool calls `FridaySkillExecutor.execute()` with the skill ID and input.
- The agent can discover available skills by listing the skill registry.

**Workflows:**
- The `workflow_run` tool calls `FridayWorkflowExecutionService.startRun()`.
- The agent can inspect workflow status via `getRun()`.

**Memory:**
- `memory_search` calls `FridayMemoryService.search()` for context retrieval.
- `memory_store` calls `FridayMemoryService.store()` to persist facts.
- Namespace: `agent:{runId}` for run-scoped memory, `agent:global` for cross-run memory.

### C.4 Session/State Management

Each agent run maintains:

```typescript
interface FridayAgentRunState {
  runId: string;
  sessionKey: string;
  status: FridayAgentRunStatus;
  task: string;
  messages: FridayAgentMessage[];       // Full conversation history
  toolCalls: FridayAgentToolCallRecord[]; // Tool call log for debugging
  testResults: FridayAgentTestResult[];   // Self-test outcomes
  attempt: number;                        // Current self-fix attempt (0-based)
  maxAttempts: number;                    // Default: 3
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  artifacts: FridayAgentArtifact[];       // Files created, skills generated, etc.
}
```

State is held in-memory during execution and checkpointed to SQLite via `FridayAgentRunRepository` at phase transitions (plan → execute → test → fix → complete/error).

### C.5 Timeout + Abort Handling

Ported from ClawdBot's `attempt.ts` lines 340–400:

```typescript
const runAbortController = new AbortController();
const abortTimer = setTimeout(() => {
  abortRun(true); // isTimeout = true
}, Math.max(1, timeoutMs));

// External abort signal (user cancellation)
if (externalSignal?.aborted) {
  abortRun(false);
} else {
  externalSignal?.addEventListener("abort", () => abortRun(false), { once: true });
}
```

**Timeout defaults:**
- `FRIDAY_AGENT_RUN_TIMEOUT_MS = 300_000` (5 minutes per run)
- `FRIDAY_AGENT_TOOL_TIMEOUT_MS = 60_000` (1 minute per tool call)
- `FRIDAY_AGENT_EXEC_TIMEOUT_MS = 30_000` (30 seconds per shell command)

The abort signal propagates to all tool executions via `signal` parameter.

---

## D. Tool Set

### D.1 `exec` — Shell Command Execution

**Ported from:** `bash-tools-exec.ts` lines 82–530 (stripped to essentials)

```typescript
interface FridayAgentExecParams {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
}

interface FridayAgentExecResult {
  content: string;          // stdout + stderr combined
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}
```

**Behavior:**
- Spawns child process via `node:child_process.spawn`.
- Captures stdout + stderr, truncates at 100KB.
- `background: true` returns immediately with a process handle.
- Respects `AbortSignal` from the run's abort controller.
- No approval system, no sandbox, no node host routing.

### D.2 `read` — Read File

```typescript
interface FridayAgentReadParams {
  path: string;
  offset?: number;  // Line number to start from (1-indexed)
  limit?: number;   // Max lines to read
}

// Returns: file contents as string, truncated to 50KB
```

### D.3 `write` — Write File

```typescript
interface FridayAgentWriteParams {
  path: string;
  content: string;
}

// Returns: confirmation message with bytes written
```

### D.4 `edit` — Edit File

```typescript
interface FridayAgentEditParams {
  path: string;
  oldText: string;  // Exact text to find
  newText: string;  // Replacement text
}

// Returns: confirmation or error if oldText not found
```

### D.5 `skill_run` — Execute a Friday Skill

```typescript
interface FridayAgentSkillRunParams {
  skillId: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

interface FridayAgentSkillRunResult {
  runId: string;
  status: "completed" | "failed" | "timeout";
  output: Record<string, unknown>;
  durationMs: number;
  error?: string;
}
```

**Integration:** Calls `FridaySkillExecutor.execute()` and awaits `result`.

### D.6 `workflow_run` — Start a Friday Workflow

```typescript
interface FridayAgentWorkflowRunParams {
  workflowId: string;
  versionId?: string;
  input?: Record<string, unknown>;
}

interface FridayAgentWorkflowRunResult {
  runId: string;
  status: string;
  output?: Record<string, unknown>;
}
```

**Integration:** Calls `FridayWorkflowExecutionService.startRun()`.

### D.7 `web_fetch` — HTTP Requests

```typescript
interface FridayAgentWebFetchParams {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FridayAgentWebFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;  // Truncated to 100KB
}
```

### D.8 `memory_search` — Search Memory

```typescript
interface FridayAgentMemorySearchParams {
  query: string;
  namespace?: string;
  limit?: number;
}

// Returns: array of { content, score, metadata }
```

**Integration:** Calls `FridayMemoryService.search()`.

### D.9 `memory_store` — Store to Memory

```typescript
interface FridayAgentMemoryStoreParams {
  content: string;
  namespace?: string;
  tags?: string[];
  expiresAt?: string;
}

// Returns: { itemId, stored: true }
```

**Integration:** Calls `FridayMemoryService.store()`.

---

## E. Self-Test + Self-Fix Loop

### E.1 How the Agent Tests Its Own Output

After the LLM produces a final response (no more tool calls), the agent enters the test phase:

```
Agent produces output
       ↓
┌─────────────────────┐
│  Classify output:    │
│  - Code generated?   │  → Run syntax check + execute
│  - Skill created?    │  → Validate manifest + dry-run
│  - Workflow created?  │  → Validate graph + compile check
│  - API endpoint?     │  → HTTP probe
│  - File created?     │  → Existence + content check
│  - Generic task?     │  → LLM self-evaluation
└─────────────────────┘
```

**Test strategies (applied in order, first match wins):**

1. **Code output detected** (files written with `.ts`/`.js`/`.py`/`.sh`):
   - Run `node --check` or `tsc --noEmit` for TypeScript
   - Run `python -c "compile(...)"` for Python
   - Run `bash -n` for shell scripts
   - Execute with test input if the agent defined test cases

2. **Skill created** (skill manifest detected):
   - Validate manifest against `FridaySkillManifestV2Schema`
   - Dry-run skill with mock input via `FridaySkillExecutor`

3. **Workflow created** (workflow graph detected):
   - Compile graph via `FridayWorkflowCompiler`
   - Validate via `FridayWorkflowValidator`

4. **Generic output** (no structured artifact):
   - Ask the LLM: "Does this output satisfy the original task? List any issues."
   - Parse response for pass/fail signal

### E.2 How It Detects Failures

```typescript
interface FridayAgentTestResult {
  strategy: "syntax" | "execute" | "manifest" | "compile" | "llm_eval";
  passed: boolean;
  errors: FridayAgentTestError[];
  durationMs: number;
}

interface FridayAgentTestError {
  message: string;
  file?: string;
  line?: number;
  severity: "error" | "warning";
}
```

A test **fails** if:
- Exit code ≠ 0 for syntax/execution checks
- Schema validation produces errors
- LLM self-evaluation says "fail" with specific issues
- Timeout during test execution

### E.3 Retry/Fix Strategy

```
Test fails
    ↓
attempt < maxAttempts (3)?
    ├── YES → Build fix prompt:
    │         "The test failed with these errors: {errors}
    │          Original task: {task}
    │          Fix the issues."
    │         → Re-enter LLM loop (Section C.1, step 4)
    │         → After LLM finishes → Re-test
    │         → attempt++
    │
    └── NO → Give up:
             - Set run status to "failed"
             - Emit error event with test results
             - Return partial output + error summary to user
```

**Backoff:** No time-based backoff (each retry is a fresh LLM call). The retry budget is purely count-based (default: 3 attempts total including the initial run).

### E.4 When to Give Up

The agent gives up when:
1. `attempt >= maxAttempts` (exhausted retry budget)
2. The test error is **identical** to the previous attempt's error (no progress detected)
3. The run's global timeout expires
4. The user sends an abort signal

On giving up, the agent:
- Saves all artifacts produced (even if tests failed)
- Includes the test failure summary in the response
- Sets run status to `"failed_tests"` (distinct from `"error"`)
- Emits `agent.run.failed_tests` event

---

## F. Live Status (WebSocket)

### F.1 Event Types

Extends Friday's existing `FridayRealtimeEventPayloadMap` with agent-specific events:

```typescript
// New topic
type FridayRealtimeTopic = ... | "agent" | "agent.run";

// New event names
type FridayRealtimeEventName = ...
  | "agent.run.started"
  | "agent.run.planning"
  | "agent.run.executing"
  | "agent.run.tool_start"
  | "agent.run.tool_end"
  | "agent.run.testing"
  | "agent.run.fixing"
  | "agent.run.completed"
  | "agent.run.failed"
  | "agent.run.failed_tests"
  | "agent.run.text_delta"
  | "agent.run.cancelled";

// New payloads
interface FridayRealtimeEventPayloadMap {
  ...
  "agent.run.started": {
    runId: string;
    task: string;
    model: string;
    providerId: string;
  };
  "agent.run.planning": {
    runId: string;
    message: string;  // e.g. "Breaking down task into steps..."
  };
  "agent.run.executing": {
    runId: string;
    step: number;
    totalSteps?: number;
    description: string;
  };
  "agent.run.tool_start": {
    runId: string;
    toolName: string;
    toolCallId: string;
    params: Record<string, unknown>;  // Sanitized (no secrets)
  };
  "agent.run.tool_end": {
    runId: string;
    toolName: string;
    toolCallId: string;
    durationMs: number;
    isError: boolean;
    summary?: string;  // First 200 chars of result
  };
  "agent.run.testing": {
    runId: string;
    attempt: number;
    strategy: string;
  };
  "agent.run.fixing": {
    runId: string;
    attempt: number;
    errors: Array<{ message: string }>;
  };
  "agent.run.completed": {
    runId: string;
    durationMs: number;
    toolCallCount: number;
    testsPassed: boolean;
    artifacts: Array<{ type: string; path?: string }>;
  };
  "agent.run.failed": {
    runId: string;
    error: { code: string; message: string };
    durationMs: number;
  };
  "agent.run.failed_tests": {
    runId: string;
    attempt: number;
    errors: Array<{ message: string; file?: string }>;
    durationMs: number;
  };
  "agent.run.text_delta": {
    runId: string;
    delta: string;  // Incremental text from LLM
  };
  "agent.run.cancelled": {
    runId: string;
    reason?: string;
  };
}
```

### F.2 API Design

**SSE endpoint (preferred over separate WebSocket for agent events):**

```
GET /v1/agent/runs/:runId/events
Accept: text/event-stream

→ SSE stream:
data: {"event":"agent.run.started","payload":{...}}
data: {"event":"agent.run.tool_start","payload":{"toolName":"exec",...}}
data: {"event":"agent.run.tool_end","payload":{"toolName":"exec","durationMs":1200,...}}
data: {"event":"agent.run.text_delta","payload":{"delta":"Here's what I did..."}}
data: {"event":"agent.run.completed","payload":{...}}
```

**Also available via existing WebSocket gateway:**
- Subscribe to topic `"agent.run"` with `runId` filter
- Uses existing `FridayRealtimeWsGateway` infrastructure

**REST endpoints (for non-streaming access):**

```
POST   /v1/agent/runs                    — Start a new agent run
GET    /v1/agent/runs/:runId             — Get run status + result
GET    /v1/agent/runs                    — List runs (paginated)
POST   /v1/agent/runs/:runId/cancel      — Cancel a running agent
GET    /v1/agent/runs/:runId/events      — SSE stream (above)
```

### F.3 How Frontend Consumes This

```typescript
// Frontend pseudocode
const eventSource = new EventSource(`/v1/agent/runs/${runId}/events`);

eventSource.onmessage = (event) => {
  const { event: eventName, payload } = JSON.parse(event.data);

  switch (eventName) {
    case "agent.run.planning":
      showSpinner("🔄 " + payload.message);
      break;
    case "agent.run.tool_start":
      addStepIndicator(payload.toolName, "running");
      break;
    case "agent.run.tool_end":
      updateStepIndicator(payload.toolCallId, payload.isError ? "error" : "done");
      break;
    case "agent.run.text_delta":
      appendToOutput(payload.delta);
      break;
    case "agent.run.testing":
      showSpinner("🧪 Testing...");
      break;
    case "agent.run.fixing":
      showSpinner(`🔧 Fixing (attempt ${payload.attempt})...`);
      break;
    case "agent.run.completed":
      showSuccess(payload);
      showButton("Save as Automation", () => saveAutomation(runId));
      break;
    case "agent.run.failed":
    case "agent.run.failed_tests":
      showError(payload);
      break;
  }
};
```

---

## G. One-Click Deploy (Saved Automations)

### G.1 How Completed Agent Work Becomes a Saved Automation

When a run completes successfully, the user can click **"Save as Automation"**. This:

1. Snapshots the run's artifacts (generated skills, workflows, files)
2. Creates a `FridayAgentAutomation` record with:
   - The original task description
   - References to generated skills/workflows
   - The system prompt used (for reproducibility)
   - Trigger configuration (optional)
3. Returns the automation to the user with an ON/OFF toggle

### G.2 Storage Schema (SQLite Migration)

New migration: `v012-agent-runtime.ts`

```sql
-- Agent runs (execution history)
CREATE TABLE friday_agent_runs (
  id           TEXT PRIMARY KEY,
  task         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|planning|executing|testing|fixing|completed|failed|failed_tests|cancelled
  session_key  TEXT NOT NULL,
  provider_id  TEXT,
  model        TEXT,
  attempt      INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  artifacts    TEXT,  -- JSON array of { type, path, skillId?, workflowId? }
  test_results TEXT,  -- JSON array of FridayAgentTestResult
  error_code   TEXT,
  error_message TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  completed_at TEXT,
  duration_ms  INTEGER,
  usage_input  INTEGER,
  usage_output INTEGER,
  cost_usd     REAL
);

CREATE INDEX idx_friday_agent_runs_status ON friday_agent_runs (status);
CREATE INDEX idx_friday_agent_runs_created ON friday_agent_runs (created_at);

-- Saved automations (one-click reuse)
CREATE TABLE friday_agent_automations (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  source_run_id   TEXT REFERENCES friday_agent_runs(id),
  task_template   TEXT NOT NULL,     -- Original task, may contain {{variables}}
  variables       TEXT,              -- JSON schema for template variables
  skill_ids       TEXT,              -- JSON array of skill IDs to execute
  workflow_ids    TEXT,              -- JSON array of workflow IDs to execute
  trigger_id      TEXT,              -- FK to friday_workflow_triggers (reuse existing)
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_id     TEXT,
  last_run_at     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_friday_agent_automations_enabled ON friday_agent_automations (enabled);
```

### G.3 API: CRUD for Saved Automations

```
POST   /v1/agent/automations                      — Create from a completed run
GET    /v1/agent/automations                       — List automations
GET    /v1/agent/automations/:automationId         — Get automation details
PATCH  /v1/agent/automations/:automationId         — Update (name, enabled, trigger)
DELETE /v1/agent/automations/:automationId         — Delete automation
POST   /v1/agent/automations/:automationId/run     — Execute automation (one-click)
```

**Create request:**
```typescript
interface FridayCreateAutomationRequest {
  sourceRunId: string;          // The successful agent run to save
  name: string;                 // User-friendly name
  description?: string;
  variables?: Record<string, { type: string; description?: string; default?: string }>;
  trigger?: {
    type: "cron" | "webhook" | "event";
    config: Record<string, unknown>;
  };
}
```

**Execute request:**
```typescript
interface FridayExecuteAutomationRequest {
  variables?: Record<string, string>;  // Fill template variables
}
```

### G.4 How Saved Automations Connect to Triggers

Friday already has a trigger system in `src/workflows/services/friday-workflow-trigger-service.ts`. Automations connect to it by:

1. **Cron triggers:** Create a `FridayWorkflowTrigger` with `type: "schedule"` and link its `triggerId` to the automation.
2. **Webhook triggers:** Create a trigger with `type: "webhook"`, returning a unique URL. When hit, it executes the automation.
3. **Event triggers:** Create a trigger with `type: "event"` that fires when a specific system event occurs (e.g., "new memory stored", "skill execution failed").

When a trigger fires:
1. Trigger service looks up the automation by `trigger_id`
2. If `enabled = 1`, calls `FridayAgentAutomationService.execute(automationId, variables)`
3. This creates a new agent run with the task template filled in
4. The run proceeds through the normal agent loop

---

## H. Phased Implementation Plan

### Batch 1: Core Agent Loop + Basic Tools

**Goal:** A working agent that can receive a task, call LLM, use exec/read/write tools, and return a result.

**Files to create:**
```
src/agent/index.ts                                    — Barrel export
src/agent/model/friday-agent.types.ts                 — All agent types
src/agent/friday-agent.constants.ts                   — Constants
src/agent/runtime/friday-agent-runtime.ts             — Core executeRun()
src/agent/runtime/friday-agent-runtime.types.ts       — Runtime deps/interface
src/agent/runtime/friday-agent-llm-client.ts          — LLM streaming client
src/agent/runtime/friday-agent-llm-client.types.ts    — Client interface
src/agent/runtime/friday-agent-event-emitter.ts       — Event emission
src/agent/tools/friday-agent-tool-registry.ts         — Tool registry factory
src/agent/tools/friday-agent-tool-helpers.ts          — Shared helpers
src/agent/tools/friday-agent-exec-tool.ts             — Shell execution
src/agent/tools/friday-agent-file-tools.ts            — read/write/edit
src/agent/tools/friday-agent-web-fetch-tool.ts        — HTTP requests
src/agent/persistence/friday-agent-run-repository.ts  — Run persistence
src/state/sqlite/migrations/v012-agent-runtime.ts     — DB migration
```

**Tests to write:**
```
test/unit/agent/runtime/friday-agent-runtime.test.ts
test/unit/agent/runtime/friday-agent-llm-client.test.ts
test/unit/agent/tools/friday-agent-exec-tool.test.ts
test/unit/agent/tools/friday-agent-file-tools.test.ts
test/unit/agent/tools/friday-agent-web-fetch-tool.test.ts
test/unit/agent/tools/friday-agent-tool-helpers.test.ts
test/unit/agent/persistence/friday-agent-run-repository.test.ts
```

**Dependencies:** `#providers`, `#sessions`, `#state`, `#errors`

**Package.json change:** Add `"#agent": "./dist/agent/index.js"` to imports.

**Validation:** `npx tsc --noEmit` passes. Agent can receive "create a hello world script" and produce a file.

---

### Batch 2: Skill/Workflow Integration Tools

**Goal:** Agent can discover and invoke existing Friday skills and workflows.

**Files to create:**
```
src/agent/tools/friday-agent-skill-tool.ts            — skill_run tool
src/agent/tools/friday-agent-workflow-tool.ts          — workflow_run tool
src/agent/tools/friday-agent-memory-tools.ts           — memory_search + memory_store
```

**Tests to write:**
```
test/unit/agent/tools/friday-agent-skill-tool.test.ts
test/unit/agent/tools/friday-agent-workflow-tool.test.ts
test/unit/agent/tools/friday-agent-memory-tools.test.ts
```

**Dependencies:** `#skills` (executor, registry), `#workflows` (execution service), `#memory`

**Validation:** Agent can be told "run the weather skill with city=Seattle" and it invokes the skill, gets the result, and summarizes it.

---

### Batch 3: Self-Test + Self-Fix Loop

**Goal:** Agent tests its own output and retries on failure.

**Files to create:**
```
src/agent/testing/friday-agent-self-test-service.ts
src/agent/testing/friday-agent-self-test-service.types.ts
src/agent/testing/friday-agent-self-fix-service.ts
```

**Tests to write:**
```
test/unit/agent/testing/friday-agent-self-test-service.test.ts
test/unit/agent/testing/friday-agent-self-fix-service.test.ts
```

**Dependencies:** Batch 1 (runtime), `#skills` (manifest validation), `#workflows` (compiler/validator)

**Validation:** Give agent a task with an intentional bug ("write a function that adds two numbers but spell 'return' wrong"). Agent should detect the syntax error, fix it, and produce working code.

---

### Batch 4: Live Status API

**Goal:** Frontend can subscribe to agent run events in real-time.

**Files to create:**
```
src/api/http/routes/friday-agent-routes.ts            — REST + SSE endpoints
```

**Files to modify:**
```
src/api/model/friday-api-realtime.types.ts            — Add agent event types
src/api/runtime/friday-api-runtime.ts                 — Register agent routes
src/state/sqlite/migrations/index.ts                  — Register v012 migration
```

**Tests to write:**
```
test/unit/api/http/routes/friday-agent-routes.test.ts
```

**Dependencies:** Batch 1 (runtime + event emitter), existing realtime infrastructure

**Validation:** Start an agent run via `POST /v1/agent/runs`, connect to `GET /v1/agent/runs/:runId/events`, see events stream in real-time.

---

### Batch 5: One-Click Deploy + Saved Automations

**Goal:** Users can save successful agent runs as reusable automations with triggers.

**Files to create:**
```
src/agent/services/friday-agent-automation-service.ts
src/agent/services/friday-agent-automation-service.types.ts
src/agent/persistence/friday-agent-automation-repository.ts
```

**Files to modify:**
```
src/api/http/routes/friday-agent-routes.ts            — Add automation CRUD endpoints
src/state/sqlite/migrations/v012-agent-runtime.ts     — Already includes automation table
```

**Tests to write:**
```
test/unit/agent/services/friday-agent-automation-service.test.ts
test/unit/agent/persistence/friday-agent-automation-repository.test.ts
```

**Dependencies:** Batch 4 (routes), `#workflows` (trigger service)

**Validation:** Complete a run, save as automation, trigger it with `POST /v1/agent/automations/:id/run`, verify it produces the same result.

---

## Appendix: Key Design Decisions

### Why SSE over WebSocket for Agent Events?

Friday already has a WebSocket gateway for workflow events, and agent events will also be available there. But for the agent-specific use case, SSE is simpler:
- One-directional (server → client only, which is all we need)
- Works with standard `EventSource` API
- No connection upgrade complexity
- Easier to debug (just curl the endpoint)
- Auto-reconnect built into the browser API

The WebSocket gateway remains the preferred option for clients that need multiple subscriptions or bidirectional communication.

### Why Not Use ClawdBot's SessionManager?

ClawdBot's `SessionManager` is file-based and tightly coupled to `pi-agent-core`. Friday already has a SQLite-backed `FridaySessionService` with fork/merge support. Porting ClawdBot's session management would create a parallel persistence layer. Instead, we wrap `FridaySessionService` to provide the conversation history the LLM client needs.

### Why Separate Self-Test from Self-Fix?

The test service is pure validation (no side effects). The fix service orchestrates retry logic (stateful). Separating them:
- Makes testing the test service trivial (input → pass/fail)
- Allows swapping test strategies without touching retry logic
- Enables users to run tests without triggering fixes (e.g., "just check my code")

### Why Store Automations Separately from Workflows?

Automations are higher-level than workflows. An automation might:
- Execute a single skill (no workflow needed)
- Execute a sequence of ad-hoc shell commands (no skill/workflow)
- Combine skills + workflows + API calls

Workflows are DAG-based with formal graph compilation. Automations are agent-replay-based — they re-run the agent with the same task. The two systems complement each other; automations can *reference* workflows but aren't constrained to them.
