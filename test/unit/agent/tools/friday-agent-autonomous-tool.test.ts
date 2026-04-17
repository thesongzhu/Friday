import { describe, it, expect, vi } from "vitest";
import { createFridayAgentAutonomousTool } from "../../../../src/agent/tools/friday-agent-autonomous-tool.js";
import type { FridayAutonomousEngine } from "../../../../src/agent/autonomous/friday-autonomous.types.js";
import { attachFridayAgentToolExecutionContext } from "../../../../src/agent/runtime/friday-agent-tool-execution-context.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function signalWithContext(
  timezone: string,
  overrides?: Partial<{
    principalId: string;
    tenantContext: {
      hubId: string;
      userId?: string;
      channelKind?: string;
    };
  }>,
): AbortSignal {
  const controller = new AbortController();
  return attachFridayAgentToolExecutionContext(controller.signal, {
    runId: "run-ctx-1",
    sessionKey: "agent:run:ctx-1",
    readOnly: false,
    timezone,
    principalId: overrides?.principalId,
    tenantContext: overrides?.tenantContext,
  });
}

function createMockEngine(overrides?: Partial<FridayAutonomousEngine>): FridayAutonomousEngine {
  return {
    executeGoal: vi.fn().mockResolvedValue({
      goalId: "goal-001",
      status: "completed",
      summary: "Goal completed successfully",
      iterationCount: 3,
      durationMs: 5000,
      usageInput: 500,
      usageOutput: 200,
    }),
    resumeGoal: vi.fn().mockResolvedValue({
      goalId: "goal-001",
      status: "completed",
      summary: "Goal resumed successfully",
      iterationCount: 2,
      durationMs: 2500,
      usageInput: 250,
      usageOutput: 120,
    }),
    cancelGoal: vi.fn(),
    getGoal: vi.fn().mockReturnValue({
      id: "goal-001",
      status: "completed",
      description: "Test goal",
      iterationCount: 3,
      currentStepIndex: 2,
      stepIds: ["s1", "s2", "s3"],
      createdAt: "2026-03-11T10:00:00Z",
    }),
    listGoals: vi.fn().mockReturnValue([]),
    getIterations: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("FridayAgentAutonomousTool", () => {
  describe("metadata", () => {
    it("should have correct name and description", () => {
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: createMockEngine() });
      expect(tool.name).toBe("autonomous");
      expect(tool.description).toContain("Goal-driven");
    });
  });

  describe("execute_goal", () => {
    it("should execute a goal and return result", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "execute_goal", description: "Set up Discord" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.goalId).toBe("goal-001");
      expect(parsed.status).toBe("completed");
    });

    it("should pass priority and config overrides", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      await tool.execute(
        { action: "execute_goal", description: "Test", priority: "critical", maxIterations: 10 },
        signal(),
      );

      expect(engine.executeGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Test",
          priority: "critical",
          config: expect.objectContaining({ maxIterationsPerGoal: 10 }),
        }),
      );
    });

    it("passes timezone from the parent execution context", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      await tool.execute(
        { action: "execute_goal", description: "Check the latest news" },
        signalWithContext("America/Los_Angeles"),
      );

      expect(engine.executeGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Check the latest news",
          timezone: "America/Los_Angeles",
        }),
      );
    });

    it("passes principal and tenant context from the parent execution context", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      await tool.execute(
        { action: "execute_goal", description: "Repair the system" },
        signalWithContext("America/Los_Angeles", {
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );

      expect(engine.executeGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );
    });
  });

  describe("cancel_goal", () => {
    it("should cancel a goal", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "cancel_goal", goalId: "goal-001" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      expect(engine.cancelGoal).toHaveBeenCalledWith("goal-001");
    });
  });

  describe("resume_goal", () => {
    it("should resume a goal", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "resume_goal", goalId: "goal-001" },
        signalWithContext("America/Los_Angeles", {
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );

      expect(result.isError).toBeFalsy();
      expect(engine.resumeGoal).toHaveBeenCalledWith(
        expect.objectContaining({
          goalId: "goal-001",
          timezone: "America/Los_Angeles",
          principalId: "user-ctx-1",
          tenantContext: {
            hubId: "tenant-a",
            userId: "user-ctx-1",
            channelKind: "agent",
          },
        }),
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.status).toBe("completed");
    });
  });

  describe("get_goal", () => {
    it("should return goal details", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "get_goal", goalId: "goal-001" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.id).toBe("goal-001");
      expect(parsed.totalSteps).toBe(3);
    });

    it("should return error for unknown goal", async () => {
      const engine = createMockEngine({ getGoal: vi.fn().mockReturnValue(null) });
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "get_goal", goalId: "unknown" },
        signal(),
      );

      expect(result.isError).toBe(true);
    });
  });

  describe("list_goals", () => {
    it("should list goals", async () => {
      const engine = createMockEngine();
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: engine });

      const result = await tool.execute(
        { action: "list_goals" },
        signal(),
      );

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBeDefined();
      expect(Array.isArray(parsed.goals)).toBe(true);
    });
  });

  describe("invalid action", () => {
    it("should return error for invalid action", async () => {
      const tool = createFridayAgentAutonomousTool({ autonomousEngine: createMockEngine() });

      const result = await tool.execute(
        { action: "invalid_action" },
        signal(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid action");
    });
  });
});
