import type {
  FridayWorkflowOverview,
  FridayWorkflowVisualization,
} from "@friday-operator-client";

export type FridayWorkflowFocus =
  | "details"
  | "recovery"
  | "deploy"
  | "export"
  | "history";

export interface FridayWorkflowClickAction {
  title: string;
  summary: string;
  tone: "neutral" | "success" | "warning" | "danger";
  focus: FridayWorkflowFocus;
  primaryLabel: string;
  secondaryLabel?: string;
}

export interface FridayWorkflowGuidedStep {
  id: string;
  title: string;
  summary: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

export function buildWorkflowHref(
  workflowId: string,
  focus: FridayWorkflowFocus = "details",
): string {
  const params = new URLSearchParams({
    workflowId,
    focus,
  });
  return `/workflows?${params.toString()}`;
}

export function summarizeWorkflowAttention(
  overview: FridayWorkflowOverview,
): FridayWorkflowClickAction {
  if (overview.latestRun?.status === "failed") {
    return {
      title: "Recover the failed run first",
      summary:
        overview.latestRunNodeTimeline[0]?.message ??
        "The latest run failed. Friday already knows which workflow to inspect next.",
      tone: "danger",
      focus: "recovery",
      primaryLabel: "Open recovery path",
      secondaryLabel: overview.latestDraft ? "Deploy repaired draft" : "Review run history",
    };
  }

  if (overview.latestDraft) {
    return {
      title: "Deploy the latest draft",
      summary:
        "A draft is ready. Friday can publish it, run it, or export a bundle without sending you into the builder first.",
      tone: "warning",
      focus: "deploy",
      primaryLabel: "Deploy now",
      secondaryLabel: "Export bundle",
    };
  }

  if (overview.publishedVersion) {
    return {
      title: "Inspect the live workflow",
      summary:
        "The published version is healthy enough to inspect, export evidence, or review version history without editing raw graph details.",
      tone: "success",
      focus: "details",
      primaryLabel: "Open workflow details",
      secondaryLabel: "Version history",
    };
  }

  return {
    title: "Create the first draft",
    summary:
      "Friday needs a draft before it can deploy or export this workflow. Start from Assistant if you want guided generation.",
    tone: "neutral",
    focus: "deploy",
    primaryLabel: "Open draft workflow",
    secondaryLabel: "Version history",
  };
}

export function buildWorkflowGuidedSteps(input: {
  overview: FridayWorkflowOverview;
  visualization?: FridayWorkflowVisualization;
}): FridayWorkflowGuidedStep[] {
  const { overview, visualization } = input;
  const steps: FridayWorkflowGuidedStep[] = [];

  if (overview.latestRun?.status === "failed") {
    steps.push({
      id: "failed-run",
      title: "Recover the latest failed run",
      summary:
        visualization?.nodeTimeline[0]?.message ??
        overview.latestRunNodeTimeline[0]?.message ??
        "Review the failure path first so Friday can recommend the next safe deploy or rerun.",
      tone: "danger",
    });
  }

  if (overview.latestDraft) {
    steps.push({
      id: "deploy-draft",
      title: "Deploy or export the current draft",
      summary:
        "Use one-click deploy when you want Friday to publish and rerun, or export a bundle if you need portable evidence first.",
      tone: overview.latestRun?.status === "failed" ? "warning" : "success",
    });
  }

  if (overview.publishedVersion) {
    steps.push({
      id: "inspect-live",
      title: "Inspect the live version only after action cards",
      summary:
        "The graph and version history are still here, but they stay behind the recovery and deploy actions so you do not need DAG literacy first.",
      tone: "neutral",
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: "no-draft",
      title: "Start from Assistant to generate a draft",
      summary:
        "This workflow has no draft or published version yet. Friday should guide generation before you return here for deploy details.",
      tone: "warning",
    });
  }

  return steps.slice(0, 3);
}
