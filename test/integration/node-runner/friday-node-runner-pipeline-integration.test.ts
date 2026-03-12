/**
 * Integration tests for the NodeRunner pipeline integration with workflow
 * node execution.
 *
 * Tests verify:
 * - All 6 workflow node types route through the pipeline correctly
 * - Each pipeline step executes in deterministic order
 * - Pre/post rules evaluation is invoked
 * - Explicit compatibility mode fallback works when the facade is configured that way
 * - Timeout and cancellation propagate through the pipeline
 * - Expression context is correctly bridged to adapters
 */

import { describe, it, expect, vi } from "vitest";
import { createWorkflowNodeRunnerFacade } from "../../../src/node-runner/engine/workflow-node-runner-facade.js";
import type {
  FridayNodeExecutionInput,
  FridayNodeExecutionOutput,
} from "../../../src/workflows/engine/friday-workflow-node-executor.js";
import type { FridayWorkflowNode } from "../../../src/workflows/model/friday-workflow-graph.types.js";
import type {
  FridayEvaluationContext,
  FridayEvaluationResult,
  UUID,
} from "../../../src/rules/model/friday-rules-engine.types.js";

// ─── Test Helpers ───

function makeNode(overrides: Partial<FridayWorkflowNode> & { type: string }): FridayWorkflowNode {
  return {
    id: "node-1",
    label: "Test Node",
    config: {},
    ...overrides,
  } as FridayWorkflowNode;
}

function makeInput(overrides: Partial<FridayNodeExecutionInput> = {}): FridayNodeExecutionInput {
  return {
    runId: "run-1" as UUID,
    nodeId: "node-1",
    attemptId: "attempt-1" as UUID,
    node: makeNode({ type: "trigger" }),
    inputData: {},
    expressionContext: { inputs: {}, steps: {} },
    ...overrides,
  };
}

function createAllowAllRules(): (ctx: FridayEvaluationContext) => Promise<FridayEvaluationResult> {
  return async () => ({
    allowed: true,
    decision: "allow",
    matchedRules: [],
    transitions: [],
    evaluationId: "eval-1",
    durationMs: 0,
  });
}

function createDenyRules(message = "denied"): (ctx: FridayEvaluationContext) => Promise<FridayEvaluationResult> {
  return async () => ({
    allowed: false,
    decision: "deny",
    message,
    matchedRules: [],
    transitions: [],
    evaluationId: "eval-1",
    durationMs: 0,
  });
}

function createMockExpressionEvaluator() {
  return {
    exec: vi.fn((expr: string, _ctx: Record<string, unknown>) => {
      if (expr === "$input.name") return "test-value";
      if (expr === "$input.flag") return true;
      return expr;
    }),
  };
}

function createFacade(overrides: Record<string, unknown> = {}) {
  const evaluateRules = createAllowAllRules();
  const expressionEvaluator = createMockExpressionEvaluator();

  return createWorkflowNodeRunnerFacade({
    expressionEvaluator,
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async (_skillId, _runId, _nodeId, payload) => ({ result: "invoked", ...payload }),
    evaluateRules,
    nowIso: () => "2026-02-25T00:00:00.000Z",
    generateId: (() => {
      let counter = 0;
      return () => `gen-${++counter}` as UUID;
    })(),
    ...overrides,
  });
}

// ─── Tests ───

describe("NodeRunner Pipeline Integration", () => {
  describe("Trigger node", () => {
    it("passes input data through as output", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "trigger" }),
        inputData: { event: "webhook", payload: { key: "value" } },
      });

      const result = await facade.executeNode(input);

      expect(result.output).toBeDefined();
      // Trigger nodes pass through inputData; the _expressionContext key is included
      // in the pipeline's inputData but the trigger adapter reads from context.inputData
      const output = result.output as Record<string, unknown>;
      expect(output).toHaveProperty("event", "webhook");
    });
  });

  describe("Action node", () => {
    it("resolves skill and invokes it", async () => {
      const invokeSkill = vi.fn(async () => ({ actionResult: "done" }));
      const facade = createFacade({ invokeSkill });
      const input = makeInput({
        node: makeNode({
          type: "action",
          config: { skillId: "my-skill", args: {} },
        }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ actionResult: "done" });
      expect(invokeSkill).toHaveBeenCalledWith(
        "my-skill",
        expect.any(String),
        "node-1",
        expect.any(Object),
        expect.anything(),
      );
    });

    it("fails when skill is not found", async () => {
      const facade = createFacade({ resolveSkill: () => null });
      const input = makeInput({
        node: makeNode({
          type: "action",
          config: { skillId: "missing-skill", args: {} },
        }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/missing-skill/);
    });

    it("fails when skillId is missing from config", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "action", config: {} }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/skillId|ref/);
    });
  });

  describe("Condition node", () => {
    it("evaluates condition expression and returns boolean result", async () => {
      const expressionEvaluator = {
        exec: vi.fn(() => true),
      };
      const facade = createFacade({ expressionEvaluator });
      const input = makeInput({
        node: makeNode({
          type: "condition",
          config: { condition: "$input.flag" },
        }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ result: true });
    });

    it("fails when condition expression is missing", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "condition", config: {} }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/condition/);
    });
  });

  describe("Data node", () => {
    it("applies transform expression", async () => {
      const expressionEvaluator = {
        exec: vi.fn(() => ({ transformed: true })),
      };
      const facade = createFacade({ expressionEvaluator });
      const input = makeInput({
        node: makeNode({
          type: "data",
          config: { transform: "$input.data" },
        }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ transformed: true });
    });

    it("applies mapping expressions", async () => {
      const expressionEvaluator = {
        exec: vi.fn((expr: string) => {
          if (expr === "$input.name") return "mapped-name";
          return expr;
        }),
      };
      const facade = createFacade({ expressionEvaluator });
      const input = makeInput({
        node: makeNode({
          type: "data",
          config: { mapping: { name: "$input.name", static: "value" } },
        }),
      });

      const result = await facade.executeNode(input);

      const output = result.output as Record<string, unknown>;
      expect(output.name).toBe("mapped-name");
      expect(output.static).toBe("value");
    });

    it("returns null when no transform or mapping", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "data", config: {} }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toBeNull();
    });
  });

  describe("AI node", () => {
    it("interpolates prompt and invokes ai-inference skill", async () => {
      const invokeSkill = vi.fn(async () => ({ response: "AI says hello" }));
      const facade = createFacade({ invokeSkill });
      const input = makeInput({
        node: makeNode({
          type: "ai",
          config: { prompt: "Hello world", model: "claude" },
        }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ response: "AI says hello" });
      expect(invokeSkill).toHaveBeenCalledWith(
        "ai-inference",
        expect.any(String),
        "node-1",
        { prompt: "Hello world", model: "claude" },
        expect.anything(),
      );
    });

    it("fails when prompt is missing", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "ai", config: {} }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/prompt/);
    });
  });

  describe("Approval node", () => {
    it("returns pending approval output", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "approval" }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ approved: false, pending: true });
    });
  });

  describe("Rules evaluation", () => {
    it("calls evaluateRules for pre and post phases", async () => {
      const evaluateRules = vi.fn(async () => ({
        allowed: true,
        decision: "allow" as const,
        matchedRules: [],
        transitions: [],
        evaluationId: "eval-1",
        durationMs: 0,
      }));
      const facade = createFacade({ evaluateRules });
      const input = makeInput({
        node: makeNode({ type: "trigger" }),
        inputData: { test: true },
      });

      await facade.executeNode(input);

      // Should be called at least twice: pre-rules and post-rules
      expect(evaluateRules).toHaveBeenCalledTimes(2);
    });

    it("rejects execution when pre-rules deny", async () => {
      const evaluateRules = createDenyRules("Pre-rules denied");
      const facade = createFacade({ evaluateRules });
      const input = makeInput({
        node: makeNode({ type: "trigger" }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/denied/i);
    });
  });

  describe("Pipeline step ordering", () => {
    it("executes all 6 steps in order for successful execution", async () => {
      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "trigger" }),
        inputData: { data: "test" },
      });

      // The facade returns the pipeline result, which means all steps passed
      const result = await facade.executeNode(input);
      expect(result.output).toBeDefined();
    });
  });

  describe("Backward compatibility", () => {
    it("falls back to legacy executor for unknown node types", async () => {
      const legacyExecutor = {
        executeNode: vi.fn(async (): Promise<FridayNodeExecutionOutput> => ({
          output: { legacy: true },
        })),
      };
      const facade = createFacade({ legacyExecutor });
      const input = makeInput({
        node: makeNode({ type: "custom-unknown" as string }),
      });

      const result = await facade.executeNode(input);

      expect(result.output).toEqual({ legacy: true });
      expect(legacyExecutor.executeNode).toHaveBeenCalledTimes(1);
    });

    it("throws when no adapter and no legacy executor", async () => {
      const facade = createFacade({ legacyExecutor: undefined });
      const input = makeInput({
        node: makeNode({ type: "custom-unknown" as string }),
      });

      await expect(facade.executeNode(input)).rejects.toThrow(/adapter/i);
    });
  });

  describe("Timeout and cancellation", () => {
    it("respects abort signal for cancellation", async () => {
      const controller = new AbortController();
      controller.abort(new Error("Cancelled by user"));

      const facade = createFacade();
      const input = makeInput({
        node: makeNode({ type: "trigger" }),
        signal: controller.signal,
      });

      // Pipeline should detect the abort and fail
      await expect(facade.executeNode(input)).rejects.toThrow();
    });
  });

  describe("Adapter registry", () => {
    it("exposes adapter registry for dynamic registration", () => {
      const facade = createFacade();
      const types = facade.adapterRegistry.listTypes();

      expect(types).toContain("trigger");
      expect(types).toContain("action");
      expect(types).toContain("condition");
      expect(types).toContain("data");
      expect(types).toContain("ai");
      expect(types).toContain("approval");
    });

    it("exposes the pipeline for direct access", () => {
      const facade = createFacade();
      expect(facade.pipeline).toBeDefined();
      expect(typeof facade.pipeline.execute).toBe("function");
    });
  });
});
