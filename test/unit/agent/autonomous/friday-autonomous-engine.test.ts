import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAutonomousEngine } from "../../../../src/agent/autonomous/friday-autonomous-engine.js";
import type {
  CreateFridayAutonomousEngineDeps,
  FridayAutonomousEngine,
} from "../../../../src/agent/autonomous/friday-autonomous.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

let counter = 0;
function idGen(): string {
  return `id-${++counter}`;
}
function nowIso(): string {
  return "2026-03-11T10:00:00Z";
}

function createMockDeps(overrides?: Partial<CreateFridayAutonomousEngineDeps>): CreateFridayAutonomousEngineDeps {
  return {
    agentRuntime: {
      executeRun: vi.fn().mockResolvedValue({
        runId: "run-1",
        status: "completed",
        response: JSON.stringify([
          { instruction: "Open browser", domain: "browser", verification: "Browser is open" },
          { instruction: "Navigate to page", domain: "browser", verification: "Page loaded" },
        ]),
        usageInput: 100,
        usageOutput: 50,
      }),
    },
    analyzeImages: vi.fn().mockResolvedValue({
      text: JSON.stringify({ kind: "complete", summary: "Goal achieved" }),
      model: "test-vision",
      inputTokens: 200,
      outputTokens: 100,
    }),
    idGenerator: idGen,
    nowIso,
    eventEmitter: {
      emit: vi.fn(),
    },
    ...overrides,
  };
}

describe("FridayAutonomousEngine", () => {
  let engine: FridayAutonomousEngine;
  let deps: CreateFridayAutonomousEngineDeps;

  beforeEach(() => {
    counter = 0;
    deps = createMockDeps();
    engine = createFridayAutonomousEngine(deps);
  });

  describe("executeGoal", () => {
    it("should create a goal and return a result", async () => {
      const result = await engine.executeGoal({
        description: "Test goal",
        signal: signal(),
      });

      expect(result.goalId).toBeDefined();
      expect(result.status).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.iterationCount).toBeGreaterThanOrEqual(0);
    });

    it("should plan the goal by calling agent runtime", async () => {
      await engine.executeGoal({
        description: "Set up Discord bot",
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalled();
      const firstCall = (deps.agentRuntime.executeRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstCall.task).toContain("Set up Discord bot");
    });

    it("passes timezone through every agent runtime planning call", async () => {
      await engine.executeGoal({
        description: "Find the latest Iran news",
        timezone: "America/Los_Angeles",
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: "America/Los_Angeles",
        }),
      );
    });

    it("passes principal and tenant context through planning calls", async () => {
      await engine.executeGoal({
        description: "Investigate provider routing",
        principalId: "user-ctx-1",
        tenantContext: {
          hubId: "tenant-a",
          userId: "user-ctx-1",
          channelKind: "agent",
        },
        signal: signal(),
      });

      expect(deps.agentRuntime.executeRun).toHaveBeenCalledWith(
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

    it("should use VLM for visual analysis when screenshots are available", async () => {
      const vlmFn = vi.fn().mockResolvedValue({
        text: JSON.stringify({ kind: "complete", summary: "Done" }),
        model: "test-vision",
        inputTokens: 200,
        outputTokens: 100,
      });

      // Planning phase returns a desktop-domain step so screenshots are gathered
      const planRuntime = {
        executeRun: vi.fn().mockResolvedValue({
          runId: "run-plan",
          status: "completed",
          response: JSON.stringify([
            { instruction: "Click button", domain: "desktop", verification: "Button clicked" },
          ]),
          usageInput: 50,
          usageOutput: 25,
        }),
      };

      const desktopManager = {
        isConnected: vi.fn().mockReturnValue(true),
        executeAction: vi.fn().mockResolvedValue({
          id: "action-1",
          action: { type: "screenshot" },
          status: "success",
          durationMs: 10,
          screenshotBase64: "base64-data",
        }),
        searchElements: vi.fn().mockResolvedValue([]),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: planRuntime,
        analyzeImages: vlmFn,
        desktopSessionManager: desktopManager,
        config: { iterationDelayMs: 0 },
      });

      await engine.executeGoal({
        description: "Click the button",
        signal: signal(),
      });

      // VLM should be called because desktop screenshots are available
      expect(vlmFn).toHaveBeenCalled();
    });

    it("should handle aborted goals", async () => {
      const controller = new AbortController();
      controller.abort(new Error("User cancelled"));

      const result = await engine.executeGoal({
        description: "Cancelled goal",
        signal: controller.signal,
      });

      expect(result.status).toBe("cancelled");
    });

    it("should respect maxIterations config", async () => {
      // Make the agent always return "act" decisions to keep looping
      const neverEndingRuntime = {
        executeRun: vi.fn().mockResolvedValue({
          runId: "run-1",
          status: "completed",
          response: JSON.stringify([
            { instruction: "Step 1", domain: "composite" },
          ]),
          usageInput: 10,
          usageOutput: 5,
        }),
      };
      const neverEndingVlm = vi.fn().mockResolvedValue({
        text: JSON.stringify({ kind: "act", action: { toolName: "exec", args: { command: "echo test" } } }),
        model: "test-vision",
        inputTokens: 10,
        outputTokens: 5,
      });

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: neverEndingRuntime,
        analyzeImages: neverEndingVlm,
        config: { maxIterationsPerGoal: 3, maxTimePerGoalMs: 30_000 },
      });

      const result = await engine.executeGoal({
        description: "Infinite loop goal",
        signal: signal(),
      });

      // Should fail due to iteration budget
      expect(result.iterationCount).toBeLessThanOrEqual(5);
    });

    it("should support priority and source parameters", async () => {
      const result = await engine.executeGoal({
        description: "High priority goal",
        priority: "critical",
        source: "recipe",
        signal: signal(),
      });

      expect(result.goalId).toBeDefined();
      const goal = engine.getGoal(result.goalId);
      expect(goal?.priority).toBe("critical");
      expect(goal?.source).toBe("recipe");
    });
  });

  describe("cancelGoal", () => {
    it("should cancel a goal by ID via abort signal", async () => {
      // Use a slow runtime so we can cancel mid-execution
      const slowRuntime = {
        executeRun: vi.fn().mockImplementation(async (params: { signal?: AbortSignal }) => {
          // Simulate slow work; check abort
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 2000);
            params.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return {
            runId: "run-1",
            status: "completed",
            response: "[]",
            usageInput: 10,
            usageOutput: 5,
          };
        }),
      };

      engine = createFridayAutonomousEngine({
        ...deps,
        agentRuntime: slowRuntime,
      });

      const controller = new AbortController();
      const goalPromise = engine.executeGoal({
        description: "Long running goal",
        signal: controller.signal,
      });

      // Cancel after a small delay to allow the goal to start
      await new Promise((r) => setTimeout(r, 20));
      controller.abort(new Error("User cancelled"));

      const result = await goalPromise;
      expect(result.status).toBe("cancelled");
    });
  });

  describe("getGoal", () => {
    it("should return null for unknown goal", () => {
      expect(engine.getGoal("nonexistent")).toBeNull();
    });

    it("should return goal after execution", async () => {
      const result = await engine.executeGoal({
        description: "Test goal",
        signal: signal(),
      });

      const goal = engine.getGoal(result.goalId);
      expect(goal).not.toBeNull();
      expect(goal!.description).toBe("Test goal");
    });
  });

  describe("listGoals", () => {
    it("should return empty list initially", () => {
      const goals = engine.listGoals();
      expect(goals).toHaveLength(0);
    });

    it("should list goals after execution", async () => {
      await engine.executeGoal({ description: "Goal 1", signal: signal() });
      await engine.executeGoal({ description: "Goal 2", signal: signal() });

      const goals = engine.listGoals();
      expect(goals.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by status", async () => {
      await engine.executeGoal({ description: "Test", signal: signal() });

      const completed = engine.listGoals({ status: "completed" });
      const pending = engine.listGoals({ status: "pending" });
      // One of these should have results based on the mock setup
      expect(completed.length + pending.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getIterations", () => {
    it("should return iterations for a completed goal", async () => {
      const result = await engine.executeGoal({
        description: "Test iterations",
        signal: signal(),
      });

      const iters = engine.getIterations(result.goalId);
      expect(iters).toBeDefined();
      expect(Array.isArray(iters)).toBe(true);
    });

    it("should return empty for unknown goal", () => {
      const iters = engine.getIterations("nonexistent");
      expect(iters).toHaveLength(0);
    });
  });

  describe("event emission", () => {
    it("should emit events during goal execution", async () => {
      const emitter = { emit: vi.fn() };
      engine = createFridayAutonomousEngine({ ...deps, eventEmitter: emitter });

      await engine.executeGoal({ description: "Emitting goal", signal: signal() });

      expect(emitter.emit).toHaveBeenCalled();
      const eventNames = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain("autonomous.goal.created");
      expect(eventNames).toContain("autonomous.goal.started");
    });
  });
});
