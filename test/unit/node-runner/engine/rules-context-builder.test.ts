import { describe, it, expect } from "vitest";

import {
  mapNodeTypeToResource,
  buildPreRulesContext,
  buildPostRulesContext,
} from "../../../../src/node-runner/engine/rules-context-builder.js";

import type { FridayNodeExecutionContext } from "../../../../src/node-runner/model/friday-node-runner.types.js";
import type { FridayWorkflowNode } from "../../../../src/workflows/model/friday-workflow-graph.types.js";

function createTestContext(overrides?: Partial<FridayNodeExecutionContext>): FridayNodeExecutionContext {
  const node: FridayWorkflowNode = {
    id: "node-1",
    type: "action",
    label: "Test Node",
    config: {},
  };

  return {
    executionId: "exec-1",
    runId: "run-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    attemptNumber: 1,
    node,
    inputData: { url: "https://example.com", method: "GET" },
    startedAt: "2026-02-24T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("mapNodeTypeToResource", () => {
  it("maps action to tool", () => {
    expect(mapNodeTypeToResource("action")).toBe("tool");
  });

  it("maps ai to agent", () => {
    expect(mapNodeTypeToResource("ai")).toBe("agent");
  });

  it("maps condition to workflow", () => {
    expect(mapNodeTypeToResource("condition")).toBe("workflow");
  });

  it("maps data to workflow", () => {
    expect(mapNodeTypeToResource("data")).toBe("workflow");
  });

  it("maps trigger to workflow", () => {
    expect(mapNodeTypeToResource("trigger")).toBe("workflow");
  });

  it("maps approval to workflow", () => {
    expect(mapNodeTypeToResource("approval")).toBe("workflow");
  });

  it("throws for unknown node type (fail-closed)", () => {
    expect(() => mapNodeTypeToResource("custom-unknown")).toThrow(
      'No rules resource mapping defined for node type "custom-unknown"',
    );
  });
});

describe("buildPreRulesContext", () => {
  it("builds context with correct resource and action", () => {
    const ctx = createTestContext();
    const result = buildPreRulesContext(ctx, "action:tool");

    expect(result.resource).toBe("tool");
    expect(result.action).toBe("execute");
    expect(result.source).toBe("workflow");
  });

  it("uses validatedInput when available", () => {
    const ctx = createTestContext({ validatedInput: { url: "validated" } });
    const result = buildPreRulesContext(ctx, "action:tool");

    expect(result.args).toEqual({ url: "validated" });
  });

  it("falls back to inputData when validatedInput is absent", () => {
    const ctx = createTestContext();
    const result = buildPreRulesContext(ctx, "action:tool");

    expect(result.args).toEqual({ url: "https://example.com", method: "GET" });
  });

  it("includes workflow context fields", () => {
    const ctx = createTestContext();
    const result = buildPreRulesContext(ctx, "action:tool");

    expect(result.workflowId).toBe("wf-1");
    expect(result.workflowRunId).toBe("run-1");
    expect(result.nodeId).toBe("node-1");
  });

  it("includes adapter metadata", () => {
    const ctx = createTestContext();
    const result = buildPreRulesContext(ctx, "action:tool");

    expect(result.metadata).toEqual({
      nodeType: "action",
      adapterId: "action:tool",
    });
  });
});

describe("buildPostRulesContext", () => {
  it("includes output in args under _output", () => {
    const ctx = createTestContext();
    ctx.validatedOutput = { result: "success" };
    const result = buildPostRulesContext(ctx, "action:tool", 150);

    expect(result.args._output).toEqual({ result: "success" });
  });

  it("includes execution duration in metadata", () => {
    const ctx = createTestContext();
    ctx.output = { data: "test" };
    const result = buildPostRulesContext(ctx, "action:tool", 250);

    expect(result.metadata?.durationMs).toBe(250);
    expect(result.metadata?.phase).toBe("post");
  });

  it("uses validatedOutput over raw output when available", () => {
    const ctx = createTestContext();
    ctx.output = { raw: true };
    ctx.validatedOutput = { validated: true };
    const result = buildPostRulesContext(ctx, "action:tool", 100);

    expect(result.args._output).toEqual({ validated: true });
  });

  it("sets _output to null when no output exists", () => {
    const ctx = createTestContext();
    const result = buildPostRulesContext(ctx, "action:tool", 0);

    expect(result.args._output).toBeNull();
  });
});
