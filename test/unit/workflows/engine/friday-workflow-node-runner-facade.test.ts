/**
 * A-003 NodeRunner Workflow Integration Tests
 *
 * Validates the NodeRunner facade routes workflow nodes through the 6-step
 * pipeline, routes standard workflow node types through the deterministic
 * authority path, and uses legacy execution only when explicitly disabled,
 * and properly handles timeout/cancel/failure states.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFridayWorkflowNodeRunnerFacade,
  type FridayNodeRunnerFacadeConfig,
  type FridayNodeRunnerFacadeDeps,
} from "../../../../src/workflows/engine/friday-workflow-node-runner-facade.js";
import type { FridayNodeExecutionInput } from "../../../../src/workflows/engine/friday-workflow-node-executor.js";
import type { FridayNodeRunnerPipeline, FridayNodeExecutionResult, FridayNodeExecutionStatus } from "../../../../src/node-runner/model/friday-node-runner.types.js";

// ─── Helpers ───

function makeMockPipeline(result?: Partial<FridayNodeExecutionResult>): FridayNodeRunnerPipeline {
  return {
    execute: vi.fn().mockResolvedValue({
      executionId: "exec-1",
      status: "completed" as FridayNodeExecutionStatus,
      stepResults: [],
      output: { result: "pipeline-output" },
      artifacts: [],
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      ...result,
    } as FridayNodeExecutionResult),
  } as unknown as FridayNodeRunnerPipeline;
}

function makeMockLegacyExecutor() {
  return {
    executeNode: vi.fn().mockResolvedValue({ output: { result: "legacy-output" } }),
  };
}

function makeInput(overrides: Partial<FridayNodeExecutionInput> = {}): FridayNodeExecutionInput {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    nodeId: "node-1",
    attemptId: "attempt-1",
    node: {
      id: "node-1",
      type: "action",
      name: "Test Action",
      config: { skillId: "test-skill", args: {} },
      position: { x: 0, y: 0 },
    },
    inputData: { key: "value" },
    expressionContext: { inputs: {}, outputs: {}, variables: {} },
    ...overrides,
  };
}

function makeFacade(overrides: {
  config?: Partial<FridayNodeRunnerFacadeConfig>;
  pipelineResult?: Partial<FridayNodeExecutionResult>;
} = {}) {
  const pipeline = makeMockPipeline(overrides.pipelineResult);
  const legacyExecutor = makeMockLegacyExecutor();
  const config: FridayNodeRunnerFacadeConfig = { useNodeRunner: true, ...overrides.config };

  const facade = createFridayWorkflowNodeRunnerFacade({
    pipeline,
    legacyExecutor,
    config,
    nowIso: () => "2026-01-01T00:00:00Z",
  });

  return { facade, pipeline, legacyExecutor };
}

// ─── Tests ───

describe("A-003 FridayWorkflowNodeRunnerFacade", () => {
  describe("feature flag routing", () => {
    it("routes action nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade();
      const result = await facade.executeNode(makeInput());

      expect(pipeline.execute).toHaveBeenCalledOnce();
      expect(legacyExecutor.executeNode).not.toHaveBeenCalled();
      expect(result.output).toEqual({ result: "pipeline-output" });
    });

    it("routes ai nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline } = makeFacade();
      const result = await facade.executeNode(makeInput({
        node: { id: "ai-1", type: "ai", name: "AI Node", config: { prompt: "hello", model: "claude" }, position: { x: 0, y: 0 } },
      }));

      expect(pipeline.execute).toHaveBeenCalledOnce();
      expect(result.output).toEqual({ result: "pipeline-output" });
    });

    it("routes data nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "d-1", type: "data", name: "Data Node", config: { mapping: {} }, position: { x: 0, y: 0 } },
      }));

      expect(pipeline.execute).toHaveBeenCalledOnce();
    });

    it("routes trigger nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "t-1", type: "trigger", name: "Trigger", config: {}, position: { x: 0, y: 0 } },
      }));

      expect(pipeline.execute).toHaveBeenCalledOnce();
      expect(legacyExecutor.executeNode).not.toHaveBeenCalled();
    });

    it("routes condition nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "c-1", type: "condition", name: "Cond", config: { condition: "$x > 5" }, position: { x: 0, y: 0 } },
      }));

      expect(pipeline.execute).toHaveBeenCalledOnce();
      expect(legacyExecutor.executeNode).not.toHaveBeenCalled();
    });

    it("routes approval nodes through NodeRunner pipeline when enabled", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "a-1", type: "approval", name: "Approval", config: {}, position: { x: 0, y: 0 } },
      }));

      expect(pipeline.execute).toHaveBeenCalledOnce();
      expect(legacyExecutor.executeNode).not.toHaveBeenCalled();
    });

    it("fails closed for unknown node types when NodeRunner is enabled", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade();

      await expect(facade.executeNode(makeInput({
        node: { id: "u-1", type: "custom-unknown" as string, name: "Unknown", config: {}, position: { x: 0, y: 0 } },
      }))).rejects.toThrow("NODE_RUNNER_UNSUPPORTED_NODE_TYPE");

      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(legacyExecutor.executeNode).not.toHaveBeenCalled();
    });

    it("uses legacy for ALL node types when useNodeRunner=false", async () => {
      const { facade, pipeline, legacyExecutor } = makeFacade({ config: { useNodeRunner: false } });
      await facade.executeNode(makeInput());

      expect(pipeline.execute).not.toHaveBeenCalled();
      expect(legacyExecutor.executeNode).toHaveBeenCalledOnce();
    });
  });

  describe("isNodeRunnerEnabled", () => {
    it("returns true when enabled", () => {
      const { facade } = makeFacade({ config: { useNodeRunner: true } });
      expect(facade.isNodeRunnerEnabled()).toBe(true);
    });

    it("returns false when disabled", () => {
      const { facade } = makeFacade({ config: { useNodeRunner: false } });
      expect(facade.isNodeRunnerEnabled()).toBe(false);
    });
  });

  describe("node type passed to pipeline", () => {
    it("passes action node through to pipeline context", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput());

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.node.type).toBe("action");
    });

    it("passes ai node through to pipeline context", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "ai-1", type: "ai", name: "AI", config: { prompt: "test" }, position: { x: 0, y: 0 } },
      }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.node.type).toBe("ai");
    });

    it("passes data node through to pipeline context", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput({
        node: { id: "d-1", type: "data", name: "Data", config: {}, position: { x: 0, y: 0 } },
      }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.node.type).toBe("data");
    });
  });

  describe("execution context construction", () => {
    it("passes runId, nodeId, and attemptId through", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput({
        runId: "r-42",
        workflowId: "w-42",
        nodeId: "n-7",
        attemptId: "att-99",
      }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.runId).toBe("r-42");
      expect(ctx.workflowId).toBe("w-42");
      expect(ctx.nodeId).toBe("n-7");
      expect(ctx.executionId).toBe("att-99");
    });

    it("passes inputData to pipeline context", async () => {
      const { facade, pipeline } = makeFacade();
      await facade.executeNode(makeInput({ inputData: { foo: "bar" } }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.inputData).toEqual({ foo: "bar" });
    });

    it("includes node definition in pipeline context", async () => {
      const { facade, pipeline } = makeFacade();
      const testNode = { id: "n-1", type: "action" as const, name: "Act", config: { skillId: "s-1", args: { x: 1 } }, position: { x: 0, y: 0 } };
      await facade.executeNode(makeInput({ node: testNode }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.node.config).toEqual({ skillId: "s-1", args: { x: 1 } });
    });

    it("passes abort signal through", async () => {
      const { facade, pipeline } = makeFacade();
      const controller = new AbortController();
      await facade.executeNode(makeInput({ signal: controller.signal }));

      const ctx = (pipeline.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(ctx.signal).toBe(controller.signal);
    });
  });

  describe("failure handling", () => {
    it("throws on pipeline failure status", async () => {
      const { facade } = makeFacade({
        pipelineResult: { status: "failed", errorCode: "NODE_EXECUTION_FAILED", errorMessage: "skill crashed" },
      });

      await expect(facade.executeNode(makeInput())).rejects.toThrow("NODE_EXECUTION_FAILED");
    });

    it("throws on pipeline timeout status", async () => {
      const { facade } = makeFacade({
        pipelineResult: { status: "timed-out", errorCode: "NODE_EXECUTION_TIMEOUT", errorMessage: "30s exceeded" },
      });

      await expect(facade.executeNode(makeInput())).rejects.toThrow("NODE_EXECUTION_TIMEOUT");
    });

    it("throws on pipeline cancelled status", async () => {
      const { facade } = makeFacade({
        pipelineResult: { status: "cancelled", errorCode: "NODE_CANCELLED", errorMessage: "user abort" },
      });

      await expect(facade.executeNode(makeInput())).rejects.toThrow("NODE_CANCELLED");
    });
  });

  describe("result mapping", () => {
    it("maps pipeline output to workflow output format", async () => {
      const { facade } = makeFacade({
        pipelineResult: { status: "completed", output: { answer: 42 } },
      });

      const result = await facade.executeNode(makeInput());
      expect(result.output).toEqual({ answer: 42 });
    });

    it("handles null output gracefully", async () => {
      const { facade } = makeFacade({
        pipelineResult: { status: "completed", output: undefined },
      });

      const result = await facade.executeNode(makeInput());
      expect(result.output).toBeNull();
    });
  });
});
