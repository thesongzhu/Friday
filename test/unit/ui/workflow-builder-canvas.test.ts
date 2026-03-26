import { describe, expect, it } from "vitest";

import {
  buildBuilderPaletteGroups,
  buildValidationIssueNavigationItems,
  describeWorkflowEdgeLabel,
  edgeKeyFor,
  findClosestDropTargetNodeId,
  snapFlowPositionToGrid,
  summarizeWorkflowValidationIssues,
  validationIssueKeyFor,
  validationIssueTargetKeyFor,
} from "../../../ui/src/lib/workflows/builder-canvas";
import type { FridayWorkflowBuilderValidationReport } from "../../../ui/src/lib/api/types";

describe("workflow builder canvas helpers", () => {
  it("builds stable edge keys and readable edge labels", () => {
    expect(edgeKeyFor({ source: "a", target: "b" })).toBe("a:b:any");
    expect(edgeKeyFor({ source: "a", target: "b", branch: "success" })).toBe("a:b:success");

    expect(describeWorkflowEdgeLabel({ branch: "success", condition: undefined })).toBe("On success");
    expect(describeWorkflowEdgeLabel({ branch: undefined, condition: "result.ok == true" })).toBe("result.ok == true");
    expect(describeWorkflowEdgeLabel({ branch: undefined, condition: undefined }, { includeFallback: true })).toBe("Always");
  });

  it("groups palette entries by domain and filters by search query", () => {
    expect(buildBuilderPaletteGroups().map((group) => group.label)).toEqual([
      "Execution",
      "Logic",
      "Data",
    ]);
    expect(buildBuilderPaletteGroups().find((group) => group.label === "Execution")?.entries.map((entry) => entry.type)).toEqual([
      "action",
      "ai",
    ]);
    expect(buildBuilderPaletteGroups({ query: "logic" }).flatMap((group) => group.entries.map((entry) => entry.type))).toEqual([
      "condition",
      "approval",
    ]);
    expect(buildBuilderPaletteGroups({ query: "transform" }).flatMap((group) => group.entries.map((entry) => entry.type))).toEqual([
      "data",
    ]);
  });

  it("snaps preview coordinates onto the workflow grid", () => {
    expect(snapFlowPositionToGrid({ x: 15, y: 41 })).toEqual({ x: 28, y: 28 });
    expect(snapFlowPositionToGrid({ x: 57, y: 73 }, { gridSize: 16 })).toEqual({ x: 64, y: 80 });
  });

  it("builds stable navigation items and issue keys for focusable diagnostics", () => {
    const validation: FridayWorkflowBuilderValidationReport = {
      valid: false,
      generatedAt: "2026-03-25T00:00:00.000Z",
      issues: [
        {
          code: "missing-ref",
          stage: "graph_compile",
          severity: "error",
          message: "step-a has no ref",
          stepId: "step-a",
        },
        {
          code: "edge-condition",
          stage: "compiled_graph",
          severity: "warning",
          message: "true branch is too broad",
          edgeRef: { from: "step-a", to: "step-b", when: "true" },
        },
        {
          code: "workflow-metadata",
          stage: "graph_compile",
          severity: "warning",
          message: "description is empty",
        },
      ],
    };

    const items = buildValidationIssueNavigationItems(validation);

    expect(validationIssueTargetKeyFor(validation.issues[0]!)).toBe("step-a");
    expect(validationIssueTargetKeyFor(validation.issues[1]!)).toBe("step-a:step-b:true");
    expect(validationIssueTargetKeyFor(validation.issues[2]!)).toBeNull();
    expect(validationIssueKeyFor(validation.issues[0]!, 0)).toBe("graph_compile::missing-ref::step-a::0");
    expect(items).toEqual([
      {
        key: "graph_compile::missing-ref::step-a::0",
        issue: validation.issues[0],
        targetKey: "step-a",
        targetKind: "node",
      },
      {
        key: "compiled_graph::edge-condition::step-a:step-b:true::1",
        issue: validation.issues[1],
        targetKey: "step-a:step-b:true",
        targetKind: "edge",
      },
    ]);
  });

  it("finds the nearest drop target node within a threshold", () => {
    const nodes = [
      { id: "step-a", position: { x: 120, y: 100 }, width: 240, height: 124 },
      { id: "step-b", position: { x: 520, y: 240 }, width: 240, height: 124 },
    ];

    expect(findClosestDropTargetNodeId(nodes, { x: 270, y: 166 })).toBe("step-a");
    expect(findClosestDropTargetNodeId(nodes, { x: 640, y: 320 })).toBe("step-b");
    expect(findClosestDropTargetNodeId(nodes, { x: 20, y: 20 }, { thresholdPx: 80 })).toBeNull();
  });

  it("groups compile issues by node id and edge ref with severity-aware tones", () => {
    const validation: FridayWorkflowBuilderValidationReport = {
      valid: false,
      generatedAt: "2026-03-25T00:00:00.000Z",
      issues: [
        {
          code: "missing-ref",
          stage: "graph_compile",
          severity: "warning",
          message: "step-a has no ref",
          stepId: "step-a",
        },
        {
          code: "bad-edge",
          stage: "compiled_graph",
          severity: "error",
          message: "false branch is dangling",
          edgeRef: { from: "step-b", to: "step-c", when: "false" },
        },
        {
          code: "missing-timeout",
          stage: "tests",
          severity: "error",
          message: "step-a requires a timeout",
          stepId: "step-a",
        },
      ],
    };

    const summary = summarizeWorkflowValidationIssues(validation);

    expect(summary.nodeIssues.get("step-a")).toMatchObject({
      tone: "danger",
      count: 2,
      primaryIssueMessage: "step-a has no ref",
      remainingCount: 1,
    });
    expect(summary.edgeIssues.get("step-b:step-c:false")).toMatchObject({
      tone: "danger",
      count: 1,
      primaryIssueMessage: "false branch is dangling",
      remainingCount: 0,
    });
    expect(summary.nodeIssues.get("step-a")?.issues.map((issue) => issue.code)).toEqual([
      "missing-ref",
      "missing-timeout",
    ]);
    expect(summary.globalIssues).toEqual([]);
    expect(summary.focusableIssues).toHaveLength(3);
  });

  it("separates non-focusable global issues from node and edge diagnostics", () => {
    const validation: FridayWorkflowBuilderValidationReport = {
      valid: false,
      generatedAt: "2026-03-25T00:00:00.000Z",
      issues: [
        {
          code: "workflow-metadata",
          stage: "graph_compile",
          severity: "warning",
          message: "workflow description is empty",
        },
        {
          code: "edge-condition",
          stage: "compiled_graph",
          severity: "warning",
          message: "edge condition is too broad",
          edgeRef: { from: "step-a", to: "step-b", when: "success" },
        },
      ],
    };

    const summary = summarizeWorkflowValidationIssues(validation);

    expect(summary.globalIssues.map((issue) => issue.code)).toEqual(["workflow-metadata"]);
    expect(summary.focusableIssues.map((issue) => issue.code)).toEqual(["edge-condition"]);
  });
});
