# Sub-Agent System — ClawdBot Reference for Friday

## Overview
ClawdBot implements a sub-agent system where a parent agent can spawn isolated child agent runs. 
The child executes a task, and when done, its output is announced back to the parent session.

## Key Components in ClawdBot

### 1. sessions-spawn-tool.ts (307 lines)
- Tool definition for `sessions_spawn`
- Parameters: task, label, agentId, model, thinking, runTimeoutSeconds, cleanup
- Validates permissions (no spawning from sub-agents, allowlist check)
- Creates child session key: `agent:{agentId}:subagent:{uuid}`
- Calls `callGateway({ method: "agent" })` to start the child run
- Registers with `registerSubagentRun()` for lifecycle tracking
- Returns `{ status: "accepted", childSessionKey, runId }`

### 2. subagent-registry.ts (440 lines)
- In-memory `Map<string, SubagentRunRecord>` tracking all sub-agent runs
- SubagentRunRecord: runId, childSessionKey, requesterSessionKey, task, cleanup, label, createdAt, startedAt, endedAt, outcome
- Listens to lifecycle events (start/end/error) via `onAgentEvent()`
- On completion → triggers announce flow
- Sweeper interval cleans up archived runs
- Persistence to disk via subagent-registry.store.ts
- Resume logic on restart (re-waits for pending runs)

### 3. subagent-announce.ts (584 lines)
- `buildSubagentSystemPrompt()` — creates focused system prompt for child
- `runSubagentAnnounceFlow()` — reads child's latest reply, builds stats, sends summary to parent
- Builds trigger message: "A subagent task X just completed/failed. Findings: {reply}. Stats: {runtime, tokens, cost}."
- Sends to parent via `callGateway({ method: "agent" })` or queue

### 4. subagent-announce-queue.ts (230 lines)
- Queue for announce messages when parent is busy
- Debounce, cap, drop policies
- Modes: steer, followup, collect, interrupt

### 5. subagent-registry.store.ts (118 lines)
- JSON file persistence at `{stateDir}/subagents/runs.json`
- Version migration (v1 → v2)

## Friday's Existing Architecture

### Agent Runtime
- `FridayAgentRuntime.executeRun(task, sessionKey, maxAttempts, timeoutMs, signal)` → `FridayAgentRuntimeResult`
- Result: `{ runId, status, response, toolCallCount, durationMs, usageInput, usageOutput }`
- Tools registered via `createFridayAgentToolRegistry()`: exec, read, write, edit, web_fetch, skill, workflow, memory
- Event emitter for SSE streaming
- Self-test + self-fix loop built in

### Agent API
- `POST /v1/agent/runs` — start a run
- `GET /v1/agent/runs` — list runs
- `GET /v1/agent/runs/:runId` — get run
- `POST /v1/agent/runs/:runId/cancel` — cancel run
- `GET /v1/agent/runs/:runId/events` — SSE stream
- Full automation CRUD + run endpoints

### Storage
- SQLite via better-sqlite3
- `FridaySqliteLayer` with read/write transactions
- Existing run repository: `friday-agent-run-repository.ts`

## Design Constraints for Friday

1. **No gateway RPC** — Friday is self-contained, no `callGateway()`. Agent runs happen in-process.
2. **SQLite storage** — persist sub-agent records in SQLite (not JSON files)
3. **Simpler model** — no multi-agent IDs, no channel routing, no delivery contexts
4. **Keep the core pattern** — parent spawns child → child runs in isolation → result announced back
5. **Reuse existing infra** — event emitter, run repository, tool registry, SSE streaming
6. **New tool** — `spawn_subagent` tool for the agent to create child runs
7. **Max depth** — prevent infinite recursion (configurable, default 3)
8. **Concurrency limit** — max simultaneous sub-agents per parent (configurable, default 5)
9. **Parent context** — child gets a focused system prompt (task-specific, no user context)
10. **Result delivery** — when child completes, parent gets the result injected as a tool result

## Expected Deliverables

### Source Files
1. `src/agent/subagent/friday-subagent-registry.ts` — track active/completed sub-agent runs (in-memory + SQLite)
2. `src/agent/subagent/friday-subagent-registry.types.ts` — SubagentRunRecord, SubagentSpawnInput, SubagentOutcome
3. `src/agent/tools/friday-agent-subagent-tool.ts` — `spawn_subagent` tool + `list_subagents` tool
4. `src/agent/subagent/friday-subagent-system-prompt.ts` — build focused child system prompt
5. Update `friday-agent-tool-registry.ts` — register new tools
6. Update `friday-agent-runtime.ts` — wire sub-agent spawning into the run loop
7. `src/api/http/routes/friday-subagent-routes.ts` — REST endpoints for sub-agent management
8. Migration `V012__subagent_runs.ts` — SQLite table for sub-agent run records

### Test Files
- Unit tests for each new module
- Integration test: parent spawns child → child completes → parent receives result
