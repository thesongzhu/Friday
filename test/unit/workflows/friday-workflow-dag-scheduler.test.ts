import { describe, it, expect } from "vitest";
import { createFridayWorkflowDagScheduler } from "#workflows";
import { createFridayExpressionEvaluator } from "#workflows";
import type { FridayCompiledWorkflowGraphV2 } from "#workflows";
import type { NodeAttemptStatus } from "#workflows";
import type { FridayExpressionContext } from "#workflows";

describe("FridayWorkflowDagScheduler", () => {
  const scheduler = createFridayWorkflowDagScheduler();
  const exprEval = createFridayExpressionEvaluator();

  function makeGraph(
    nodes: Array<{ id: string; type?: string }>,
    edges: Array<{ id: string; source: string; target: string; condition?: string }>,
  ): FridayCompiledWorkflowGraphV2 {
    return {
      schemaVersion: "2.0",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      sourceSpecSchemaVersion: "1.0",
      graph: {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.type ?? "action") as "action",
          label: n.id,
          config: { skillId: "test" },
        })),
        edges: edges.map((e) => ({
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          condition: e.condition,
        })),
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "abc",
    };
  }

  const emptyCtx: FridayExpressionContext = { inputs: {}, steps: {} };

  it("produces correct topoOrder for linear DAG A→B→C", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "B", target: "C" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    expect(adj.topoOrder).toEqual(["A", "B", "C"]);
    expect(adj.entryNodes).toEqual(["A"]);
  });

  it("handles diamond DAG correctly", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "B", target: "D" },
        { id: "e4", source: "C", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    expect(adj.entryNodes).toEqual(["A"]);
    // D must come after B and C
    expect(adj.topoOrder.indexOf("D")).toBeGreaterThan(adj.topoOrder.indexOf("B"));
    expect(adj.topoOrder.indexOf("D")).toBeGreaterThan(adj.topoOrder.indexOf("C"));

    // D only ready when both B and C are done
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "completed"],
    ]);
    expect(
      scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval),
    ).toEqual(["C"]);

    statuses.set("C", "completed");
    expect(
      scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval),
    ).toEqual(["D"]);
  });

  it("computes fan-out: all successors ready after single predecessor", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "A", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
    ]);

    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toEqual(expect.arrayContaining(["B", "C", "D"]));
  });

  it("fan-in (barrier): D ready only when both B and C are terminal", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      [
        { id: "e1", source: "A", target: "B" },
        { id: "e2", source: "A", target: "C" },
        { id: "e3", source: "B", target: "D" },
        { id: "e4", source: "C", target: "D" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // Only B done
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
      ["B", "completed"],
    ]);
    let ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toContain("C");
    expect(ready).not.toContain("D");

    // Both done
    statuses.set("C", "completed");
    ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).toContain("D");
  });

  it("condition edge filtering: false condition does not enable successor", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [
        {
          id: "e1",
          source: "A",
          target: "B",
          condition: '$inputs.go == "yes"',
        },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    // Condition evaluates to false
    const ctx: FridayExpressionContext = {
      inputs: { go: "no" },
      steps: {},
    };
    const statuses = new Map<string, NodeAttemptStatus>([
      ["A", "completed"],
    ]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      ctx,
      exprEval,
    );
    expect(ready).not.toContain("B");
  });

  it("entry nodes computation", () => {
    const graph = makeGraph(
      [{ id: "X" }, { id: "Y" }, { id: "Z" }],
      [{ id: "e1", source: "X", target: "Z" }],
    );
    const adj = scheduler.buildAdjacency(graph);
    expect(adj.entryNodes).toEqual(expect.arrayContaining(["X", "Y"]));
  });

  it("complex graph: correct progression of ready sets", () => {
    // 10 nodes: entry → A,B,C → D (join) → E,F → G (join) → H → I,J → K (join, terminal)
    const graph = makeGraph(
      [
        { id: "entry" },
        { id: "A" }, { id: "B" }, { id: "C" },
        { id: "D" }, { id: "E" }, { id: "F" },
        { id: "G" }, { id: "H" }, { id: "K" },
      ],
      [
        { id: "e1", source: "entry", target: "A" },
        { id: "e2", source: "entry", target: "B" },
        { id: "e3", source: "entry", target: "C" },
        { id: "e4", source: "A", target: "D" },
        { id: "e5", source: "B", target: "D" },
        { id: "e6", source: "C", target: "D" },
        { id: "e7", source: "D", target: "E" },
        { id: "e8", source: "D", target: "F" },
        { id: "e9", source: "E", target: "G" },
        { id: "e10", source: "F", target: "G" },
        { id: "e11", source: "G", target: "H" },
        { id: "e12", source: "H", target: "K" },
      ],
    );
    const adj = scheduler.buildAdjacency(graph);

    const statuses = new Map<string, NodeAttemptStatus>();
    let ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(["entry"]);

    statuses.set("entry", "completed");
    ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(expect.arrayContaining(["A", "B", "C"]));

    statuses.set("A", "completed");
    statuses.set("B", "completed");
    statuses.set("C", "completed");
    ready = scheduler.computeReadyNodes(adj, statuses, graph, emptyCtx, exprEval);
    expect(ready).toEqual(["D"]);
  });

  it("already-started nodes are skipped", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A already has an attempt (running)
    const statuses = new Map<string, NodeAttemptStatus>([["A", "running"]]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    expect(ready).not.toContain("A");
  });

  it("continue-on-error: failed predecessor still enables successors", () => {
    const graph = makeGraph(
      [{ id: "A" }, { id: "B" }],
      [{ id: "e1", source: "A", target: "B" }],
    );
    const adj = scheduler.buildAdjacency(graph);

    // A failed (still terminal)
    const statuses = new Map<string, NodeAttemptStatus>([["A", "failed"]]);
    const ready = scheduler.computeReadyNodes(
      adj,
      statuses,
      graph,
      emptyCtx,
      exprEval,
    );
    // B should be ready since A is terminal (failed counts as terminal for scheduling)
    expect(ready).toContain("B");
  });
});
