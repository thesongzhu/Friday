import { describe, expect, it, vi } from "vitest";

import { createFridayOrchestrationEngine } from "../../../src/engine/friday-orchestration-engine.js";
import type { FridayEngineRunExecutorAgentRuntime } from "../../../src/engine/friday-engine-run-executor.js";
import type { FridayPreparedConversationTurn } from "../../../src/engine/friday-engine-turn-preparer.js";

describe("createFridayOrchestrationEngine", () => {
  it("sanitizes private session side effects for public-isolated runs", async () => {
    const agentRuntime: FridayEngineRunExecutorAgentRuntime = {
      executeRun: vi.fn(async () => ({
        runId: "run-public-engine",
        status: "completed",
        response: "ok",
        toolCallCount: 0,
        durationMs: 1,
        usageInput: 1,
        usageOutput: 1,
      })),
    };
    const getMessages = vi.fn(async () => {
      throw new Error("private session history must not be read");
    });
    const addMessage = vi.fn(async () => {
      throw new Error("private session must not be mutated");
    });
    const getConversationFocus = vi.fn(async () => {
      throw new Error("private focus must not be read");
    });
    const setConversationFocus = vi.fn(async () => {
      throw new Error("private focus must not be mutated");
    });
    const persistImmediateRunResult = vi.fn();
    const prepareTurn = vi.fn((): FridayPreparedConversationTurn => {
      throw new Error("private session turn preparation must be skipped");
    });

    const engine = createFridayOrchestrationEngine({
      turnPreparerDeps: {
        sessionDeps: {
          getMessages,
          addMessage,
          getConversationFocus,
          setConversationFocus,
        },
        historyLimit: 24,
        nowIso: () => "2026-04-16T00:00:00.000Z",
        prepareTurn,
        buildEvidenceBlocks: () => [],
        classifyExecution: () => ({ category: "agent_exception_path" }),
      },
      runExecutorDeps: {
        agentRuntime,
        sessionDeps: {
          getMessages,
          addMessage,
          getConversationFocus,
          setConversationFocus,
        },
        nowIso: () => "2026-04-16T00:00:00.000Z",
        persistImmediateRunResult,
        dispatchDeterministic: vi.fn(async () => ({ handled: false })),
        dispatchManagedAsync: vi.fn(async () => ({ handled: false })),
        finalizeFocus: vi.fn(() => ({
          currentTask: "Read public docs only",
          updatedAt: "2026-04-16T00:00:00.000Z",
        })),
        deterministicDispatchDeps: {},
        managedAsyncDispatchDeps: {},
        resolveIdempotencyKey: ({ runId, kind }) => `${runId}:${kind}`,
      },
    });

    await engine.executeRun({
      runId: "run-public-engine",
      task: "Read public docs only",
      sessionKey: "discord:private-hub:user1",
      constraints: {
        readOnly: true,
        operationalMode: "restricted",
        dataSensitivity: "public",
      },
    });

    expect(agentRuntime.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: undefined,
      historyMessages: [],
      conversationContext: expect.objectContaining({
        selectedBlocks: [],
        selectionReasons: [],
      }),
    }));
    expect(getMessages).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
    expect(getConversationFocus).not.toHaveBeenCalled();
    expect(setConversationFocus).not.toHaveBeenCalled();
    expect(persistImmediateRunResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "discord:private-hub:user1" }),
    );
    expect(prepareTurn).not.toHaveBeenCalled();
  });
});
