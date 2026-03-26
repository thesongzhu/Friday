import type {
  FridayWorkflowBuilderValidationIssue,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowEditorEdge,
  FridayWorkflowSpecEdgeWhen,
} from "@/lib/api/types";

export type BuilderValidationTone = "warning" | "danger";

export interface BuilderValidationIssueSummary {
  tone: BuilderValidationTone;
  issues: FridayWorkflowBuilderValidationIssue[];
  count: number;
}

export function edgeKeyFor(input: { source: string; target: string; branch?: string }): string {
  return `${input.source}:${input.target}:${input.branch ?? "any"}`;
}

export function describeWorkflowEdgeBranch(branch?: FridayWorkflowSpecEdgeWhen | string | null): string | null {
  switch (branch) {
    case "success":
      return "On success";
    case "failure":
      return "On failure";
    case "true":
      return "If true";
    case "false":
      return "If false";
    default:
      return null;
  }
}

export function describeWorkflowEdgeLabel(
  data?: Pick<NonNullable<FridayWorkflowEditorEdge["data"]>, "branch" | "condition"> | null,
  options?: { includeFallback?: boolean },
): string | null {
  if (typeof data?.condition === "string" && data.condition.trim().length > 0) {
    return data.condition.trim();
  }
  const branchLabel = describeWorkflowEdgeBranch(data?.branch);
  if (branchLabel) {
    return branchLabel;
  }
  return options?.includeFallback ? "Always" : null;
}

function toneRank(severity: FridayWorkflowBuilderValidationIssue["severity"]): number {
  if (severity === "error") return 2;
  if (severity === "warning") return 1;
  return 0;
}

function toneFromSeverity(severity: FridayWorkflowBuilderValidationIssue["severity"]): BuilderValidationTone {
  return severity === "error" ? "danger" : "warning";
}

function appendIssue(
  map: Map<string, BuilderValidationIssueSummary>,
  key: string,
  issue: FridayWorkflowBuilderValidationIssue,
): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      tone: toneFromSeverity(issue.severity),
      issues: [issue],
      count: 1,
    });
    return;
  }

  const nextTone =
    toneRank(issue.severity) > toneRank(existing.tone === "danger" ? "error" : "warning")
      ? toneFromSeverity(issue.severity)
      : existing.tone;

  map.set(key, {
    tone: nextTone,
    issues: [...existing.issues, issue],
    count: existing.count + 1,
  });
}

export function summarizeWorkflowValidationIssues(validation?: FridayWorkflowBuilderValidationReport | null): {
  nodeIssues: Map<string, BuilderValidationIssueSummary>;
  edgeIssues: Map<string, BuilderValidationIssueSummary>;
} {
  const nodeIssues = new Map<string, BuilderValidationIssueSummary>();
  const edgeIssues = new Map<string, BuilderValidationIssueSummary>();

  for (const issue of validation?.issues ?? []) {
    if (issue.stepId) {
      appendIssue(nodeIssues, issue.stepId, issue);
    }
    if (issue.edgeRef) {
      appendIssue(
        edgeIssues,
        edgeKeyFor({
          source: issue.edgeRef.from,
          target: issue.edgeRef.to,
          branch: issue.edgeRef.when,
        }),
        issue,
      );
    }
  }

  return { nodeIssues, edgeIssues };
}
