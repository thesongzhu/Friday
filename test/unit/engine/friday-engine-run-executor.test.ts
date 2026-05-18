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

  it("passes disabledToolNames through to the agent runtime", async () => {
    const agentRuntime = {
      executeRun: vi.fn(async () => ({
        runId: "run-disabled-tools",
        status: "completed",
        response: "Done",
        toolCallCount: 0,
        durationMs: 1,
        usageInput: 1,
        usageOutput: 1,
      })),
    };

    const executor = createFridayEngineRunExecutor({
      agentRuntime,
      nowIso: () => "2026-04-03T18:40:00.000Z",
      persistImmediateRunResult: vi.fn(),
      dispatchDeterministic: vi.fn(async () => ({ handled: false })),
      dispatchManagedAsync: vi.fn(async () => ({ handled: false })),
      finalizeFocus: vi.fn(() => ({
        currentTask: "Read the repo",
        lastAssistantSummary: null,
        pendingPlanRunId: null,
        updatedAt: "2026-04-03T18:40:00.000Z",
      })),
      deterministicDispatchDeps: {},
      managedAsyncDispatchDeps: {},
      resolveIdempotencyKey: ({ runId, kind }) => `${runId}:${kind}`,
    });

    await executor.execute(
      {
        runId: "run-disabled-tools",
        task: "Read the repo",
        sessionKey: "agent:run:disabled-tools",
        disabledToolNames: ["read", "write", "edit", "exec", "pdf_parse", "image_analysis"],
      },
      {
        executionClassification: { category: "full_agent", reason: "requires agent runtime" },
        conversationContext: { turnKind: "new_topic" } as never,
        historyMessages: [],
        focusState: null,
        currentUserSequence: 1,
      } as never,
    );

    expect(agentRuntime.executeRun).toHaveBeenCalledWith(expect.objectContaining({
      disabledToolNames: ["read", "write", "edit", "exec", "pdf_parse", "image_analysis"],
    }));
  });

  it("passes disabledToolNames through approved plan resumes", async () => {
    const agentRuntime = {
      executeRun: vi.fn(async () => {
        throw new Error("approved plan should resume through planning gate");
      }),
    };
    const approvePlan = vi.fn(async () => ({
      runId: "run-plan-disabled-tools",
      status: "completed",
      response: "Approved plan executed",
      toolCallCount: 0,
      durationMs: 1,
      usageInput: 1,
      usageOutput: 1,
    }));
    const handleTurn = vi.fn(() => ({
      action: "approve" as const,
      runId: "run-plan-disabled-tools",
      pendingPlanRunId: null,
    }));
    const executor = createFridayEngineRunExecutor({
      agentRuntime,
      planningGate: {
        handleTurn,
        approvePlan,
        rejectPlan: vi.fn(),
      },
      nowIso: () => "2026-04-03T18:40:00.000Z",
      persistImmediateRunResult: vi.fn(),
      dispatchDeterministic: vi.fn(async () => ({ handled: false })),
      dispatchManagedAsync: vi.fn(async () => ({ handled: false })),
      finalizeFocus: vi.fn(() => ({
        currentTask: "approve",
        lastAssistantSummary: "Approved plan executed",
        pendingPlanRunId: null,
        updatedAt: "2026-04-03T18:40:00.000Z",
      })),
      deterministicDispatchDeps: {},
      managedAsyncDispatchDeps: {},
      resolveIdempotencyKey: ({ runId, kind }) => `${runId}:${kind}`,
    });

    await executor.execute(
      {
        runId: "run-plan-disabled-tools",
        task: "approve",
        sessionKey: "agent:run:plan-disabled-tools",
        disabledToolNames: ["read", "write", "edit", "exec", "pdf_parse", "image_analysis"],
      },
      {
        executionClassification: { category: "full_agent", reason: "requires agent runtime" },
        conversationContext: { turnKind: "approval" } as never,
        historyMessages: [],
        focusState: { pendingPlanRunId: "run-plan-disabled-tools" },
        currentUserSequence: 2,
      } as never,
    );

    expect(handleTurn).toHaveBeenCalledWith(expect.objectContaining({
      disabledToolNames: ["read", "write", "edit", "exec", "pdf_parse", "image_analysis"],
    }));
    expect(approvePlan).toHaveBeenCalledWith(expect.objectContaining({
      disabledToolNames: ["read", "write", "edit", "exec", "pdf_parse", "image_analysis"],
    }));
    expect(agentRuntime.executeRun).not.toHaveBeenCalled();
  });
});
