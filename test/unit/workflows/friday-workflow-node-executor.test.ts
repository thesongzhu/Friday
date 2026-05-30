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

  it("executes data node — runs an object-literal STRING transform (constant) to a correct value", async () => {
    // Regression: the generator emits object transforms as JSON-object strings
    // (closure hello-world used `transform: '{"text":"hello world"}'`). These
    // previously threw EXPRESSION_PARSE_ERROR at run; now they resolve via the
    // mapping path. Oracle asserts the OUTPUT VALUE, not just run-to-completion.
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-str-const",
      type: "data",
      label: "Data",
      config: {
        transform: '{ "text": "hello world" }',
      } as Record<string, JsonValue>,
    };
    const result = await executor.executeNode(makeInput(node));
    expect(result.output).toEqual({ text: "hello world" });
  });

  it("executes data node — resolves $-refs inside an object-literal STRING transform", async () => {
    // Proves real ref resolution (not a constant): the model retreating to
    // constants would NOT satisfy this oracle.
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-str-ref",
      type: "data",
      label: "Data",
      config: {
        transform: '{"greeting": "$inputs.name", "static": "x"}',
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: { name: "Ada" },
      steps: {},
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect(result.output).toEqual({ greeting: "Ada", static: "x" });
  });

  it("executes data node — preserves expression-string transform behavior (ref)", async () => {
    // A plain ref-expression transform must keep evaluating as before (the
    // JSON fast-path only intercepts object-literal strings).
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-expr-ref",
      type: "data",
      label: "Data",
      config: {
        transform: "$steps.prev.output.value",
      } as Record<string, JsonValue>,
    };
    const ctx: FridayExpressionContext = {
      inputs: {},
      steps: { prev: { output: { value: 42 } } },
    };
    const result = await executor.executeNode(makeInput(node, ctx));
    expect(result.output).toBe(42);
  });

  it("executes data node — preserves quoted-literal expression transform behavior", async () => {
    const executor = createExecutor();
    const node: FridayWorkflowNode = {
      id: "data-expr-lit",
      type: "data",
      label: "Data",
      config: {
        transform: "'just a string'",
      } as Record<string, JsonValue>,
    };
    const result = await executor.executeNode(makeInput(node));
    expect(result.output).toBe("just a string");
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
