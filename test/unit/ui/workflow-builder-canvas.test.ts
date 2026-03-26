import { describe, expect, it } from "vitest";

import {
  describeWorkflowEdgeLabel,
  edgeKeyFor,
  summarizeWorkflowValidationIssues,
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
    });
    expect(summary.edgeIssues.get("step-b:step-c:false")).toMatchObject({
      tone: "danger",
      count: 1,
    });
    expect(summary.nodeIssues.get("step-a")?.issues.map((issue) => issue.code)).toEqual([
      "missing-ref",
      "missing-timeout",
    ]);
  });
});
