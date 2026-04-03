import { describe, expect, it, vi } from "vitest";

import { createFridayEngineRunExecutor } from "../../../src/engine/friday-engine-run-executor.js";

describe("FridayEngineRunExecutor", () => {
  it("persists deterministic control-plane results as real runs", async () => {
    const persistImmediateRunResult = vi.fn();
    const agentRuntime = {
      executeRun: vi.fn(async () => {
        throw new Error("agent runtime should not run for deterministic control-plane turns");
      }),
    };

    const executor = createFridayEngineRunExecutor({
      agentRuntime,
      nowIso: () => "2026-04-03T18:40:00.000Z",
      persistImmediateRunResult,
      dispatchDeterministic: vi.fn(async () => ({
        handled: true,
        response: "Friday can help with workflows, skills, and diagnostics.",
      })),
      dispatchManagedAsync: vi.fn(async () => ({ handled: false })),
      finalizeFocus: vi.fn(() => ({
        currentTask: null,
        lastAssistantSummary: null,
        pendingPlanRunId: null,
        updatedAt: "2026-04-03T18:40:00.000Z",
      })),
      deterministicDispatchDeps: {},
      managedAsyncDispatchDeps: {},
      resolveIdempotencyKey: ({ runId, kind }) => `${runId}:${kind}`,
    });

    const result = await executor.execute(
      {
        runId: "run-det-001",
        task: "What can you do?",
        sessionKey: "chat:default:chat-det-001",
      },
      {
        executionClassification: { category: "sync_immediate", handler: "capabilities" },
        conversationContext: { turnKind: "new_topic" } as never,
        historyMessages: [],
        focusState: null,
        currentUserSequence: 1,
      } as never,
    );

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Friday can help");
    expect(persistImmediateRunResult).toHaveBeenCalledWith({
      runId: "run-det-001",
      task: "What can you do?",
      sessionKey: "chat:default:chat-det-001",
      providerId: undefined,
      model: undefined,
      constraints: undefined,
      responseText: "Friday can help with workflows, skills, and diagnostics.",
    });
    expect(agentRuntime.executeRun).not.toHaveBeenCalled();
  });
});
