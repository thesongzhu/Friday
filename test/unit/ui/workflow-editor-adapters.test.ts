import { describe, expect, it } from "vitest";

import { draftToEditorGraph, editorGraphToDraftBundle } from "../../../ui/src/lib/workflows/editor-adapters";
import type { FridayWorkflowDraftEntity } from "../../../ui/src/lib/api/types";

function buildDraft(): FridayWorkflowDraftEntity {
  return {
    draftId: "draft-1",
    workflowId: "workflow-1",
    ownerUserId: "user-1",
    title: "Workflow Draft",
    status: "active",
    revision: 3,
    spec: {
      schemaVersion: "1.0",
      workflowId: "workflow-1",
      name: "Workflow Draft",
      description: "Round-trip adapter coverage",
      startStepId: "step-a",
      trigger: { type: "manual" },
      inputs: [],
      steps: [
        {
          id: "step-a",
          type: "skill_call",
          ref: "browser-qa-report",
          args: {
            goal: "$inputs.url",
            taskProfile: "review",
            integrationMode: "stable_skill",
            nested: { keep: true },
          },
          retry: { maxAttempts: 2, backoffMs: 500 },
        },
        {
          id: "step-b",
          type: "condition",
          ref: "gate",
          condition: "$steps.step-a.output.status == 'completed'",
          args: {
            expression: "$steps.step-a.output.status == 'completed'",
          },
        },
        {
          id: "step-c",
          type: "transform",
          ref: "reshape",
          args: {
            mapping: {
              summary: "$steps.step-a.output.summary",
            },
          },
        },
        {
          id: "step-d",
          type: "human_approval",
          ref: "manual-check",
          args: {
            approverRole: "operator",
            onReject: "reject_branch",
          },
        },
      ],
      edges: [
        { from: "step-a", to: "step-b", when: "success" },
        { from: "step-b", to: "step-c", when: "true" },
        { from: "step-b", to: "step-d", when: "false" },
      ],
      outputs: [],
      errorPolicy: { onFailure: "fail_fast", notifyUser: true },
      tests: [],
    },
    visual: {
      schemaVersion: "1.0",
      workflowId: "workflow-1",
      viewport: { x: 10, y: 20, zoom: 0.9 },
      selectedNodeId: "step-b",
      selectedEdgeKey: "step-b:step-d:false",
      panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
      nodes: [
        { nodeId: "__trigger__", x: 20, y: 120, width: 220, height: 120 },
        { nodeId: "step-a", x: 280, y: 120, width: 240, height: 120 },
        { nodeId: "step-b", x: 580, y: 120, width: 240, height: 120 },
        { nodeId: "step-c", x: 880, y: 70, width: 240, height: 120 },
        { nodeId: "step-d", x: 880, y: 210, width: 240, height: 120 },
      ],
      edges: [
        { edgeKey: "__trigger__:step-a:any", sourceHandle: "any", targetHandle: "in" },
        { edgeKey: "step-a:step-b:success", sourceHandle: "success", targetHandle: "in", bendPoints: [{ x: 540, y: 140 }] },
        { edgeKey: "step-b:step-c:true", sourceHandle: "true", targetHandle: "in", bendPoints: [{ x: 820, y: 90 }] },
        { edgeKey: "step-b:step-d:false", sourceHandle: "false", targetHandle: "in", bendPoints: [{ x: 820, y: 240 }] },
      ],
    },
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    autosave: {
      enabled: true,
      intervalMs: 15000,
      lastSavedAt: "2026-03-25T00:00:00.000Z",
    },
  };
}

describe("workflow editor adapters", () => {
  it("preserves refs, args, retry metadata, conditions, and visual selections through round-trip", () => {
    const draft = buildDraft();

    const graph = draftToEditorGraph(draft);

    expect(graph.selectedNodeId).toBe("step-b");
    expect(graph.selectedEdgeId).toBe("e-step-b-step-d-false");

    const actionNode = graph.nodes.find((node) => node.id === "step-a");
    expect(actionNode?.data.stepRef).toBe("browser-qa-report");
    expect(actionNode?.data.rawArgs).toEqual({
      goal: "$inputs.url",
      taskProfile: "review",
      integrationMode: "stable_skill",
      nested: { keep: true },
    });
    expect(actionNode?.data.retry).toEqual({ maxAttempts: 2, backoffMs: 500 });

    const conditionNode = graph.nodes.find((node) => node.id === "step-b");
    expect(conditionNode?.data.stepCondition).toBe("$steps.step-a.output.status == 'completed'");

    const rejectionEdge = graph.edges.find((edge) => edge.id === "e-step-b-step-d-false");
    expect(rejectionEdge?.data?.branch).toBe("false");
    expect(rejectionEdge?.data?.bendPoints).toEqual([{ x: 820, y: 240 }]);

    const roundTrip = editorGraphToDraftBundle(graph, draft);

    expect(roundTrip.spec.steps).toEqual(draft.spec.steps);
    expect(roundTrip.spec.edges).toEqual(draft.spec.edges);
    expect(roundTrip.visual.viewport).toEqual(draft.visual.viewport);
    expect(roundTrip.visual.selectedNodeId).toBe("step-b");
    expect(roundTrip.visual.selectedEdgeKey).toBe("step-b:step-d:false");
    expect(roundTrip.visual.nodes.find((node) => node.nodeId === "step-a")).toMatchObject({
      width: 240,
      height: 120,
    });
    expect(roundTrip.visual.edges.find((edge) => edge.edgeKey === "step-a:step-b:success")?.bendPoints).toEqual([
      { x: 540, y: 140 },
    ]);
  });
});
