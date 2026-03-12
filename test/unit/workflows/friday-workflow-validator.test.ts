import { describe, it, expect } from "vitest";
import { createFridayWorkflowValidator } from "#workflows";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";

describe("FridayWorkflowValidator", () => {
  const validator = createFridayWorkflowValidator();

  function makeGraph(
    overrides: Partial<FridayCompiledWorkflowGraphV2> = {},
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "test" } },
          { id: "C", type: "action", label: "C", config: { skillId: "test" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "B", targetNodeId: "C" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "abc123",
      ...overrides,
    };
  }

  it("accepts a valid linear DAG (A→B→C)", () => {
    const result = validator.validate(makeGraph());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid diamond graph", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
          { id: "D", type: "action", label: "D", config: { skillId: "s" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "A", targetNodeId: "C" },
          { id: "e3", sourceNodeId: "B", targetNodeId: "D" },
          { id: "e4", sourceNodeId: "C", targetNodeId: "D" },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(true);
  });

  it("rejects graph with cycle A→B→C→A", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
        ],
        edges: [
          { id: "e1", sourceNodeId: "A", targetNodeId: "B" },
          { id: "e2", sourceNodeId: "B", targetNodeId: "C" },
          { id: "e3", sourceNodeId: "C", targetNodeId: "A" },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "WORKFLOW_CYCLE_DETECTED")).toBe(true);
  });

  it("rejects self-loop", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "action", label: "A", config: { skillId: "s" } },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "A" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "WORKFLOW_CYCLE_DETECTED")).toBe(true);
  });

  it("rejects disconnected graph", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
          { id: "C", type: "action", label: "C", config: { skillId: "s" } },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_GRAPH_DISCONNECTED"),
    ).toBe(true);
  });

  it("rejects empty graph", () => {
    const graph = makeGraph({
      graph: { nodes: [], edges: [] },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_EMPTY_GRAPH"),
    ).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "A", type: "action", label: "A2", config: { skillId: "s" } },
        ],
        edges: [],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_DUPLICATE_NODE_ID"),
    ).toBe(true);
  });

  it("rejects edge referencing missing node", () => {
    const graph = makeGraph({
      graph: {
        nodes: [{ id: "A", type: "trigger", label: "A", config: {} }],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "Z" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "WORKFLOW_EDGE_REFERENCES_MISSING_NODE",
      ),
    ).toBe(true);
  });

  it("rejects condition node without outbound edges", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          {
            id: "B",
            type: "condition",
            label: "B",
            config: { condition: "$inputs.x == 1" },
          },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_CONDITION_NO_OUTBOUND"),
    ).toBe(true);
  });

  it("rejects action node without skillId/ref", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: {} },
        ],
        edges: [{ id: "e1", sourceNodeId: "A", targetNodeId: "B" }],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_ACTION_MISSING_REF"),
    ).toBe(true);
  });

  it("rejects invalid expression in edge condition", () => {
    const graph = makeGraph({
      graph: {
        nodes: [
          { id: "A", type: "trigger", label: "A", config: {} },
          { id: "B", type: "action", label: "B", config: { skillId: "s" } },
        ],
        edges: [
          {
            id: "e1",
            sourceNodeId: "A",
            targetNodeId: "B",
            condition: "$inputs.x ==",
          },
        ],
      },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "WORKFLOW_EXPRESSION_INVALID"),
    ).toBe(true);
  });

  it("accepts a complex graph with 20+ nodes", () => {
    const nodes = [
      { id: "trigger", type: "trigger" as const, label: "trigger", config: {} },
    ];
    const edges: Array<{
      id: string;
      sourceNodeId: string;
      targetNodeId: string;
    }> = [];

    // Create 20 action nodes in a chain with branches
    for (let i = 1; i <= 20; i++) {
      nodes.push({
        id: `n${i}`,
        type: "action" as const,
        label: `Node ${i}`,
        config: { skillId: "test" } as Record<string, unknown>,
      });
    }

    // Linear chain with some branches
    edges.push({ id: "e0", sourceNodeId: "trigger", targetNodeId: "n1" });
    for (let i = 1; i < 20; i++) {
      edges.push({
        id: `e${i}`,
        sourceNodeId: `n${i}`,
        targetNodeId: `n${i + 1}`,
      });
    }
    // Add a branch: n5 → n15
    edges.push({ id: "ebranch", sourceNodeId: "n5", targetNodeId: "n15" });

    const graph = makeGraph({
      graph: { nodes, edges },
    });
    const result = validator.validate(graph);
    expect(result.valid).toBe(true);
  });
});
