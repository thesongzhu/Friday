> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Review: Agent Runtime Batch 1

**Reviewer:** CX Agent  
**Date:** 2026-02-19  
**Verdict:** **NEEDS_FIX** (7 issues, 5 observations)

---

## Summary

Batch 1 delivers a solid, well-structured agent loop skeleton. The code is clean, TypeScript compiles with zero errors, there are zero `as any` casts, and the overall architecture faithfully follows the design document. The agent loop, LLM client, tool dispatch, abort/timeout, and persistence are all implemented correctly. However, there are several issues ranging from style violations to functional gaps that should be addressed before merge.

---

## Issue 1: Duplicate result type — `FridayAgentExecuteRunResult` vs `FridayAgentRuntimeResult` [MUST_FIX]

**Files:**
- `src/agent/model/friday-agent.types.ts:210-218` — `FridayAgentExecuteRunResult`
- `src/agent/runtime/friday-agent-runtime.types.ts:19-27` — `FridayAgentRuntimeResult`

**Problem:** Two nearly identical result types exist. They differ in one field: `FridayAgentExecuteRunResult` has `toolCalls: FridayAgentToolCallRecord[]` while `FridayAgentRuntimeResult` has `toolCallCount: number`. The runtime returns `FridayAgentRuntimeResult`; `FridayAgentExecuteRunResult` is exported from the barrel but never used anywhere.

`FridayAgentExecuteRunResult` also uses `status: FridayAgentRunStatus` (9 variants) while `FridayAgentRuntimeResult` uses `status: "completed" | "failed" | "cancelled"` (3 variants). The runtime only ever returns those 3, so `FridayAgentRuntimeResult` is more accurate.

**Fix:** Remove `FridayAgentExecuteRunResult` from `friday-agent.types.ts` and the barrel export. Or unify them — pick one canonical type. If the full `toolCalls` array is needed by callers (e.g., Batch 4 routes), add it to `FridayAgentRuntimeResult` instead of maintaining a dead type.

---

## Issue 2: Duplicate params type — `FridayAgentExecuteRunParams` vs inline params [SHOULD_FIX]

**Files:**
- `src/agent/model/friday-agent.types.ts:201-208` — `FridayAgentExecuteRunParams`
- `src/agent/runtime/friday-agent-runtime.types.ts:10-16` — inline `{ task, sessionKey?, ... }`

**Problem:** `FridayAgentExecuteRunParams` is defined in model types and exported, but the runtime's `executeRun()` signature uses an inline type in `friday-agent-runtime.types.ts:10-16`. The model type has `requestedModel?: string` which the inline type lacks. Neither references the other.

**Fix:** Have the runtime reference `FridayAgentExecuteRunParams` from the model types (and remove `requestedModel` since model selection is a factory-level concern per the design — it's injected via `CreateFridayAgentRuntimeDeps.model`). Or remove the unused model type.

---

## Issue 3: `throw new Error()` in LLM client — should be `FridayDomainError` [MUST_FIX]

**Files:**
- `src/agent/runtime/friday-agent-llm-client.ts:61` — `throw new Error(\`LLM request failed...\`)`
- `src/agent/runtime/friday-agent-llm-client.ts:67` — `throw new Error("LLM response has no body")`
- `src/agent/persistence/friday-agent-run-repository.ts:137` — `throw new Error("Agent run insert failed...")`

**Problem:** Per the style guide (Section F): "boundary errors must be `FridayDomainError` with code/status/details." The LLM client is a service boundary — its errors propagate to the runtime's catch block which checks `error instanceof FridayDomainError` to extract the error code. Raw `Error` throws fall through to the generic `AGENT_LLM_ERROR` code, losing semantic information.

**Fix:**
- LLM client errors → `new FridayDomainError(FRIDAY_AGENT_ERROR_CODES.LLM_ERROR, message, { httpStatus: 502 })`
- Repository insert failure → `new FridayDomainError(FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR, message, { httpStatus: 500 })`

---

## Issue 4: SSE parser silently swallows malformed tool JSON [SHOULD_FIX]

**File:** `src/agent/runtime/friday-agent-llm-client.ts:148-151`

```typescript
try {
  input = JSON.parse(toolInputJson) as Record<string, unknown>;
} catch {
  // Malformed JSON from LLM
}
```

**Problem:** If the LLM emits malformed JSON for tool input, the tool_use event is still yielded with an empty `{}` input object. The tool will then execute with missing parameters. The exec tool specifically requires `command` and will throw `FridayAgentToolInputError`, which becomes a tool error result — acceptable but not ideal. However, other tools may silently misbehave with empty input.

**Fix:** When JSON parsing fails, yield the tool_use event with `input: {}` but also log a warning (or yield a diagnostic event). Alternatively, include a sentinel field like `_parseError: true` so the runtime can produce a more helpful tool_result error message. This is a robustness improvement, not a blocker.

---

## Issue 5: `readRecordParam` returns `Record<string, string>` but input may have non-string values [SHOULD_FIX]

**File:** `src/agent/tools/friday-agent-tool-helpers.ts:94-100`

```typescript
export function readRecordParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = params[key];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;  // ← unsafe: values may not be strings
  }
  return undefined;
}
```

**Problem:** The return type claims `Record<string, string>` but the cast is unchecked. LLM-provided `env` objects could contain number values (e.g., `{"PORT": 3000}`). The exec tool passes this directly to `process.env` merge, which coerces to string anyway, but it's a type lie that violates the style guide's spirit of "no unchecked casts."

**Fix:** Either validate that all values are strings (coercing numbers via `String()`), or change return type to `Record<string, unknown>` and let callers handle coercion.

---

## Issue 6: Event emitter listener cast [NICE_TO_FIX]

**File:** `src/agent/runtime/friday-agent-event-emitter.ts:32,38`

```typescript
set.add(listener as FridayAgentEventListener<FridayAgentEventName>);
```

**Problem:** The `as` cast is technically type-safe because the Map is keyed by event name, but it defeats the generic constraint. This is a common pattern for typed event emitters and the alternative (separate Map per event type) is worse. Not a real bug, but flagging since the style guide says "as unknown as requires explicit justification."

**Fix:** Add a brief comment explaining why the cast is safe: `// Safe: Map is keyed by event name, so listeners are only called with matching payloads`.

---

## Issue 7: Missing `planning`/`testing`/`fixing` status transitions [SHOULD_FIX]

**File:** `src/agent/runtime/friday-agent-runtime.ts`

**Problem:** The design document (Section C.1) specifies status transitions: `pending → planning → executing → testing → fixing → completed/failed`. The `FridayAgentRunStatus` type includes all these statuses. However, the runtime only transitions through `pending → executing → completed/failed/cancelled`. The `planning`, `testing`, and `fixing` statuses are never set.

This is expected for Batch 1 (self-test/self-fix is Batch 3), but the `planning` phase should arguably be emitted before the first LLM call since the design shows it as part of Batch 1's flow. The `agent.run.planning` event type exists but is never emitted.

**Fix:** Either:
1. Emit `planning` status + event before the first LLM iteration (even if brief)
2. Or document in a TODO that `planning`/`testing`/`fixing` transitions will be added in Batch 3

---

## Observations (Non-blocking)

### Observation 1: `max_tokens` hardcoded to 8192

**File:** `src/agent/runtime/friday-agent-llm-client.ts:35`

The `max_tokens: 8192` is hardcoded in the LLM client. For Claude models, this is conservative (Claude supports up to 8192 output tokens by default, but newer models support 64K+ with extended thinking). This should eventually be configurable via `CreateFridayAgentLlmClientDeps` or per-request, but is fine for MVP.

### Observation 2: Background exec doesn't track child process lifecycle

**File:** `src/agent/tools/friday-agent-exec-tool.ts:115-121`

When `background: true`, the function immediately resolves with the PID and stops tracking the process. There's no `process` tool equivalent (ClawdBot's process registry) to check on backgrounded processes. This means backgrounded commands are fire-and-forget. Fine for Batch 1 — the agent can always use `exec` to check `ps` — but worth noting for future process management.

### Observation 3: Batch 2 integration surface looks clean

The tool registry (`friday-agent-tool-registry.ts`) returns a flat `FridayAgentToolDefinition[]` array. Adding skill/workflow/memory tools in Batch 2 is straightforward: create the tool factories, add them to the array in `createFridayAgentToolRegistry`, add new deps to `CreateFridayAgentToolRegistryOptions`. No structural changes needed.

### Observation 4: No path safety enforcement on file tools

**File:** `src/agent/tools/friday-agent-file-tools.ts`

The design mentions "path safety via `friday-path-safety.ts`" but the file tools don't import or use it. They accept any absolute or relative path. This is consistent with ClawdBot's approach (the agent is trusted), but worth documenting the decision — especially since the style guide audit notes that `friday-path-safety.ts` uses raw `Error` throws.

### Observation 5: `toolCallCount` vs `toolCalls` in result — information loss

**File:** `src/agent/runtime/friday-agent-runtime.ts:243`

The runtime tracks `allToolCalls: FridayAgentToolCallRecord[]` with full details (args, results, durations) but returns only `toolCallCount: number` in the result. All that debugging data is lost. The run record in SQLite also doesn't persist tool calls — only `artifacts` and `test_results`. Consider either:
- Persisting tool calls in the run record (new column or separate table)
- Returning the full array in the result for the routes layer (Batch 4) to expose

---

## Checklist

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Implementation matches design | ✅ PASS | Faithful port of the design's Batch 1 scope |
| 2 | Types correct, zero `as any` | ✅ PASS | Zero `as any`, zero `as unknown as`. Two `as` casts are justified (emitter + readRecordParam) |
| 3 | Agent loop: tool dispatch, abort/timeout, error recovery | ✅ PASS | Loop limit, abort signal propagation, timeout timers, cleanup in `finally` — all correct |
| 4 | LLM client: SSE parsing with tool_use blocks | ✅ PASS | Correctly accumulates `input_json_delta`, emits on `content_block_stop`, handles `message_start`/`message_delta` usage |
| 5 | Tools isolated (no shared mutable state) | ✅ PASS | Each tool factory returns a fresh closure. No module-level mutable state. |
| 6 | Exec tool safety | ✅ PASS | Timeout → SIGTERM → SIGKILL (5s grace), output truncation, abort signal wiring |
| 7 | Migration schema matches design | ✅ PASS | Exact match — both tables, all columns, all indexes |
| 8 | Missing edge cases | ⚠️ WARN | Issues 1-7 above |
| 9 | Batch 2 integration readiness | ✅ PASS | Clean extension points |

---

## Verdict

**NEEDS_FIX** — 2 must-fix issues (duplicate types, raw Error throws), 4 should-fix issues, 1 nice-to-fix. No architectural problems. After addressing the must-fixes, this is ready for merge.
