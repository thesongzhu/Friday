import { describe, it, expect } from "vitest";
import { createFridayWorkflowNodeExecutor } from "#workflows";
import { createFridayExpressionEvaluator } from "#workflows";
import type { FridayNodeExecutionInput } from "#workflows";
import type { FridayWorkflowNode } from "#workflows";
import type { FridayExpressionContext } from "#workflows";
import type { JsonValue } from "#learning";

describe("FridayWorkflowNodeExecutor", () => {
  const expressionEvaluator = createFridayExpressionEvaluator();
  const NOW = "2025-01-15T10:00:00.000Z";

  function createExecutor(overrides: {
    resolveSkill?: (id: string) => unknown | null;
    invokeSkill?: (
      id: string,
      runId: string,
      nodeId: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
  } = {}) {
    return createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: overrides.resolveSkill ?? (() => ({ manifest: {} })),
      invokeSkill:
        overrides.invokeSkill ??
        (async (_id, _runId, _nodeId, payload) => payload),
      nowIso: () => NOW,
    });
  }

  function makeInput(
    node: FridayWorkflowNode,
    ctx: FridayExpressionContext = { inputs: {}, steps: {} },
  ): FridayNodeExecutionInput {
    return {
      runId: "run-1",
      nodeId: node.id,
      attemptId: "att-1",
      node,
      inputData: {},
      expressionContext: ctx,
    };
  }

  it("executes trigger node — returns trigger payload", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "trigger-1",
      type: "trigger",
      label: "Trigger",
      config: {},
    };
    const ctx: FridayExpressionContext = {
      inputs: { foo: "bar" },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect(result.output).toEqual({ foo: "bar" });
  });

  it("executes action node — resolves skill and invokes", async () => {
    const invokedWith: Record<string, unknown>[] = [];
    const executor = createExecutor({
      resolveSkill: () => ({ manifest: {} }),
      invokeSkill: async (_id, _runId, _nodeId, payload) => {
        invokedWith.push(payload);
        return { result: "ok" };
      },
    });

    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "my-skill", args: { x: 1 } } as Record<string, JsonValue>,
    };
    const result = await executor.executeNode(makeInput(node));
    expect(result.output).toEqual({ result: "ok" });
    expect(invokedWith[0]).toEqual({ x: 1 });
  });

  it("executes condition node — evaluates expression", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "cond-1",
      type: "condition",
      label: "Condition",
      config: { condition: "$inputs.x == 1" } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { x: 1 },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect((result.output as Record<string, unknown>).result).toBe(true);
  });

  it("executes data node — evaluates mapping", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-1",
      type: "data",
      label: "Data",
      config: {
        mapping: { name: "$inputs.name" },
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { name: "Alice" },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect((result.output as Record<string, unknown>).name).toBe("Alice");
  });

  it("executes data node with empty config as a null-output no-op", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-empty",
      type: "data",
      label: "Blank Data",
      config: {},
    };

    const result = await executor.executeNode(makeInput(node));
    expect(result.output).toBeNull();
  });

  it("executes approval node — returns pending indicator", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "approval-1",
      type: "approval",
      label: "Approval",
      config: {},
    };
    const result = await executor.executeNode(makeInput(node));
    const output = result.output as Record<string, unknown>;
    expect(output.approved).toBe(false);
    expect(output.pending).toBe(true);
  });

  it("throws when skill not found", async () => {
    const executor = createExecutor({
      resolveSkill: () => null,
    });
    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: { skillId: "missing-skill" } as Record<string, JsonValue>,
    };

    await expect(executor.executeNode(makeInput(node))).rejects.toThrow(
      "skill 'missing-skill' not found",
    );
  });

  it("resolves expression args before skill invocation", async () => {
    const invokedArgs: Record<string, unknown>[] = [];
    const executor = createExecutor({
      invokeSkill: async (_id, _runId, _nodeId, payload) => {
        invokedArgs.push(payload);
        return {};
      },
    });

    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: {
        skillId: "my-skill",
        args: { name: "$inputs.name", count: "$steps.fetch.output.count" },
      } as Record<string, JsonValue>,
    };

    const ctx: FridayExpressionContext = {
      inputs: { name: "Bob" },
      steps: { fetch: { output: { count: 5 } } },
    };

    await executor.executeNode(makeInput(node, ctx));
    expect(invokedArgs[0]).toEqual({ name: "Bob", count: 5 });
  });

  it("throws for action node without skillId/ref", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: {},
    };

    await expect(executor.executeNode(makeInput(node))).rejects.toThrow(
      "action node missing skillId or ref",
    );
  });
});
