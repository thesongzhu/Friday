import { describe, it, expect, vi } from "vitest";
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
    userRulesContextProvider?: Parameters<typeof createFridayWorkflowNodeExecutor>[0]["userRulesContextProvider"];
  } = {}) {
    return createFridayWorkflowNodeExecutor({
      expressionEvaluator,
      resolveSkill: overrides.resolveSkill ?? (() => ({ manifest: {} })),
      invokeSkill:
        overrides.invokeSkill ??
        (async (_id, _runId, _nodeId, payload) => payload),
      userRulesContextProvider: overrides.userRulesContextProvider,
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

  it("evaluates NESTED mapping expressions (resolveArgs recursion) and arithmetic", async () => {
    // Fail-before: resolveArgs only evaluated top-level "$"-strings, so a nested
    // mapping value came back as the literal expression string. Pass-after: it
    // recurses, and the (newly supported) arithmetic evaluates.
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-nested",
      type: "data",
      label: "Data",
      config: {
        mapping: {
          outputs: { net: "$inputs.gross - $inputs.discount" },
          total: "$inputs.a + $inputs.b",
        },
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { gross: 100, discount: 30, a: 7, b: 5 },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    const out = result.output as Record<string, unknown>;
    expect((out.outputs as Record<string, unknown>).net).toBe(70); // nested expr evaluated, not literal string
    expect(out.total).toBe(12); // arithmetic evaluated
  });

  it("drops prototype-polluting mapping keys (resolveArgs safety)", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-proto",
      type: "data",
      label: "Data",
      config: {
        mapping: { ["__proto__"]: { polluted: true }, safe: "$inputs.name" },
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = { inputs: { name: "ok" }, steps: {} };
    const result = await executor.executeNode(makeInput(node, ctx));
    const out = result.output as Record<string, unknown>;
    expect(out.safe).toBe("ok");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global pollution
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

  it("injects user project rules into AI node prompts only", async () => {
    const invoked: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const userRulesContextProvider = vi.fn().mockResolvedValue("<friday-user-project-rules>Ask before generating files.</friday-user-project-rules>");
    const executor = createExecutor({
      userRulesContextProvider,
      invokeSkill: async (id, _runId, _nodeId, payload) => {
        invoked.push({ id, payload });
        return { text: "ok" };
      },
    });

    const node: FridayWorkflowNode = {
      id: "ai-1",
      type: "ai",
      label: "AI",
      config: {
        prompt: "Summarize $inputs.topic",
        model: "test-model",
      } as Record<string, JsonValue>,
    };

    await executor.executeNode(makeInput(node, {
      inputs: { topic: "Friday rules" },
      steps: {},
    }));

    expect(invoked[0].id).toBe("ai-inference");
    expect(invoked[0].payload.prompt).toContain("Ask before generating files.");
    expect(invoked[0].payload.prompt).toContain("Workflow AI node prompt:");
    expect(invoked[0].payload.prompt).toContain("Summarize Friday rules");

    const actionNode: FridayWorkflowNode = {
      id: "action-1",
      type: "action",
      label: "Action",
      config: {
        skillId: "my-skill",
        args: { prompt: "Plain action payload" },
      } as Record<string, JsonValue>,
    };
    await executor.executeNode(makeInput(actionNode));

    expect(userRulesContextProvider).toHaveBeenCalledTimes(1);
    expect(invoked[1].id).toBe("my-skill");
    expect(invoked[1].payload).toEqual({ prompt: "Plain action payload" });
  });
});
