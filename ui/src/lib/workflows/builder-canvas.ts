import type {
  FridayWorkflowBuilderValidationIssue,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowEditorEdge,
  FridayWorkflowSpecEdgeWhen,
  WorkflowNodeType,
} from "@/lib/api/types";

export type BuilderValidationTone = "warning" | "danger";
export type BuilderPaletteGroupId = "execution" | "logic" | "data";

export interface BuilderPaletteEntry {
  type: Exclude<WorkflowNodeType, "trigger">;
  label: string;
  description: string;
  groupId: BuilderPaletteGroupId;
  groupLabel: string;
}

export interface BuilderValidationIssueSummary {
  tone: BuilderValidationTone;
  issues: FridayWorkflowBuilderValidationIssue[];
  count: number;
  primaryIssueMessage: string;
  remainingCount: number;
}

export interface BuilderPaletteGroup {
  id: BuilderPaletteGroupId;
  label: string;
  entries: BuilderPaletteEntry[];
}

export interface BuilderValidationIssueNavigationItem {
  key: string;
  issue: FridayWorkflowBuilderValidationIssue;
  targetKey: string;
  targetKind: "node" | "edge";
}

export interface BuilderDropTargetNodeInput {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
}

export const BUILDER_NODE_PALETTE: BuilderPaletteEntry[] = [
  {
    type: "action",
    label: "Action",
    description: "Call a stable skill or external operation as a concrete workflow step.",
    groupId: "execution",
    groupLabel: "Execution",
  },
  {
    type: "ai",
    label: "AI / Tool",
    description: "Run an AI completion or direct tool invocation inside the workflow graph.",
    groupId: "execution",
    groupLabel: "Execution",
  },
  {
    type: "condition",
    label: "Condition",
    description: "Branch on true/false or success/failure logic without editing raw JSON.",
    groupId: "logic",
    groupLabel: "Logic",
  },
  {
    type: "approval",
    label: "Approval",
    description: "Gate execution behind a human review or owner/operator approval step.",
    groupId: "logic",
    groupLabel: "Logic",
  },
  {
    type: "data",
    label: "Transform",
    description: "Map, template, or reshape data between workflow steps.",
    groupId: "data",
    groupLabel: "Data",
  },
];

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

export function buildBuilderPaletteGroups(options?: { query?: string }): BuilderPaletteGroup[] {
  const normalizedQuery = options?.query?.trim().toLowerCase() ?? "";
  const filteredEntries =
    normalizedQuery.length === 0
      ? BUILDER_NODE_PALETTE
      : BUILDER_NODE_PALETTE.filter((entry) => (
          entry.label.toLowerCase().includes(normalizedQuery)
          || entry.groupLabel.toLowerCase().includes(normalizedQuery)
          || entry.description.toLowerCase().includes(normalizedQuery)
        ));

  const groups = new Map<BuilderPaletteGroupId, BuilderPaletteGroup>();
  for (const entry of filteredEntries) {
    const existing = groups.get(entry.groupId);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    groups.set(entry.groupId, {
      id: entry.groupId,
      label: entry.groupLabel,
      entries: [entry],
    });
  }

  return [
    groups.get("execution"),
    groups.get("logic"),
    groups.get("data"),
  ].filter((group): group is BuilderPaletteGroup => Boolean(group));
}

export function snapFlowPositionToGrid(
  input: { x: number; y: number },
  options?: { gridSize?: number },
): { x: number; y: number } {
  const gridSize = Math.max(1, options?.gridSize ?? 28);
  return {
    x: Math.round(input.x / gridSize) * gridSize,
    y: Math.round(input.y / gridSize) * gridSize,
  };
}

export function validationIssueTargetKeyFor(issue: FridayWorkflowBuilderValidationIssue): string | null {
  if (issue.stepId) {
    return issue.stepId;
  }
  if (issue.edgeRef) {
    return edgeKeyFor({
      source: issue.edgeRef.from,
      target: issue.edgeRef.to,
      branch: issue.edgeRef.when,
    });
  }
  return null;
}

export function validationIssueKeyFor(
  issue: FridayWorkflowBuilderValidationIssue,
  index: number,
): string {
  return [
    issue.stage,
    issue.code,
    validationIssueTargetKeyFor(issue) ?? "global",
    String(index),
  ].join("::");
}

export function buildValidationIssueNavigationItems(
  validation?: FridayWorkflowBuilderValidationReport | null,
): BuilderValidationIssueNavigationItem[] {
  return (validation?.issues ?? []).flatMap((issue, index) => {
    const targetKey = validationIssueTargetKeyFor(issue);
    if (!targetKey) {
      return [];
    }
    return [{
      key: validationIssueKeyFor(issue, index),
      issue,
      targetKey,
      targetKind: issue.stepId ? "node" : "edge",
    }];
  });
}

export function findClosestDropTargetNodeId(
  nodes: BuilderDropTargetNodeInput[],
  position: { x: number; y: number },
  options?: { thresholdPx?: number; fallbackWidth?: number; fallbackHeight?: number },
): string | null {
  const thresholdPx = Math.max(1, options?.thresholdPx ?? 220);
  const fallbackWidth = Math.max(1, options?.fallbackWidth ?? 240);
  const fallbackHeight = Math.max(1, options?.fallbackHeight ?? 124);

  let closestId: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const node of nodes) {
    const centerX = node.position.x + ((node.width ?? fallbackWidth) / 2);
    const centerY = node.position.y + ((node.height ?? fallbackHeight) / 2);
    const distance = Math.hypot(centerX - position.x, centerY - position.y);
    if (distance > thresholdPx || distance >= closestDistance) {
      continue;
    }
    closestId = node.id;
    closestDistance = distance;
  }

  return closestId;
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
      primaryIssueMessage: issue.message,
      remainingCount: 0,
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
    primaryIssueMessage: existing.primaryIssueMessage,
    remainingCount: existing.count,
  });
}

export function summarizeWorkflowValidationIssues(validation?: FridayWorkflowBuilderValidationReport | null): {
  nodeIssues: Map<string, BuilderValidationIssueSummary>;
  edgeIssues: Map<string, BuilderValidationIssueSummary>;
  globalIssues: FridayWorkflowBuilderValidationIssue[];
  focusableIssues: FridayWorkflowBuilderValidationIssue[];
} {
  const nodeIssues = new Map<string, BuilderValidationIssueSummary>();
  const edgeIssues = new Map<string, BuilderValidationIssueSummary>();
  const globalIssues: FridayWorkflowBuilderValidationIssue[] = [];
  const focusableIssues: FridayWorkflowBuilderValidationIssue[] = [];

  for (const issue of validation?.issues ?? []) {
    if (issue.stepId) {
      appendIssue(nodeIssues, issue.stepId, issue);
      focusableIssues.push(issue);
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
      focusableIssues.push(issue);
    }
    if (!issue.stepId && !issue.edgeRef) {
      globalIssues.push(issue);
    }
  }

  return { nodeIssues, edgeIssues, globalIssues, focusableIssues };
}
