import type {
  FridayBeginnerIntentResolution,
  FridayFixPlanRecord,
  FridayIssueCard,
  FridayObservabilityAlertSummary,
  FridayWorkflowOverview,
} from "@friday-operator-client";
import type {
  AgentRunRecord,
  FridayFleetSatelliteCard,
  FridayPendingSatellitePairingRequest,
  SkillCatalogItem,
  SkillGenerationEvidence,
} from "@/lib/api/types";
import { buildFleetHref } from "@/lib/fleet/view-models";
import { buildWorkflowHref } from "@/lib/workflows/view-models";
import { buildObservabilityHref } from "@/lib/observability/view-models";

export function describeIntentConfidence(intent?: FridayBeginnerIntentResolution): string {
  if (!intent) {
    return "Waiting for a goal.";
  }
  if (intent.confidence >= 0.85) {
    return "High confidence";
  }
  if (intent.confidence >= 0.65) {
    return "Medium confidence";
  }
  return "Needs clarification";
}

export function toneForIssue(
  issue: FridayIssueCard,
): "neutral" | "warning" | "danger" | "success" {
  if (issue.kind === "failed_fix") {
    return "danger";
  }
  if (issue.kind === "approval_required") {
    return "warning";
  }
  return issue.status === "open" ? "warning" : "neutral";
}

export function summarizeActionStatus(action: FridayFixPlanRecord): string {
  const approval = action.approval?.status;
  if (approval === "pending") {
    return "Awaiting approval";
  }
  if (action.summary.status === "rolled_back") {
    return "Rolled back after failed verification";
  }
  if (action.summary.status === "applied" && action.summary.outcome === "success") {
    return "Applied successfully";
  }
  if (action.summary.status === "rejected") {
    return "Rejected before execution";
  }
  return "Planned fix";
}

export function summarizeSkillEvidence(evidence?: SkillGenerationEvidence | null): string {
  if (!evidence) {
    return "No draft evidence yet.";
  }
  if (evidence.approvalReadiness.ready) {
    return "Ready to approve and stage a candidate for lifecycle review.";
  }
  if (!evidence.validationSummary.ok) {
    return "Draft needs validation fixes.";
  }
  if (!evidence.executableTestSummary?.ok) {
    return "Draft still needs to pass the explicit self-test.";
  }
  return evidence.approvalReadiness.reason;
}

export function getNextClarificationQuestion(
  run?: Pick<AgentRunRecord, "status" | "planReview"> | null,
): string | null {
  if (!run || run.status !== "awaiting_clarification") {
    return null;
  }
  const questions = run.planReview?.gate?.clarificationQuestions ?? [];
  const answeredCount = run.planReview?.gate?.answers?.length ?? 0;
  const nextQuestion = questions[answeredCount];
  return typeof nextQuestion === "string" && nextQuestion.trim().length > 0
    ? nextQuestion
    : null;
}

export interface FridayAssistantQuickAction {
  id: string;
  title: string;
  summary: string;
  tone: "neutral" | "warning" | "danger" | "success";
  kind: "workflow" | "skill" | "issue" | "fleet" | "alert";
}

export interface FridayAssistantRecoveryPath {
  id: string;
  title: string;
  summary: string;
  reason: string;
  kind: "approval" | "fleet" | "alert" | "workflow";
  tone: "neutral" | "warning" | "danger" | "success";
  routeTarget: string;
}

export interface FridayAssistantIssuePlaybook {
  title: string;
  summary: string;
  primaryLabel: string;
  primaryRouteTarget: string;
  secondaryLabel?: string;
  secondaryRouteTarget?: string;
}

export function buildAssistantQuickActions(input: {
  issues: FridayIssueCard[];
  workflowOverviews: FridayWorkflowOverview[];
  catalogItems: SkillCatalogItem[];
  degradedSatellites: FridayFleetSatelliteCard[];
  pairingRequests: FridayPendingSatellitePairingRequest[];
  alerts: FridayObservabilityAlertSummary[];
}): FridayAssistantQuickAction[] {
  const actions: FridayAssistantQuickAction[] = [];
  const topIssue = input.issues[0];
  if (topIssue) {
    actions.push({
      id: `issue:${topIssue.id}`,
      title: topIssue.kind === "approval_required" ? "Approve or inspect a fix" : topIssue.title,
      summary: topIssue.summary,
      tone: toneForIssue(topIssue),
      kind: "issue",
    });
  }

  const failedWorkflow = input.workflowOverviews.find((overview) => overview.latestRun?.status === "failed");
  if (failedWorkflow?.latestDraft) {
    actions.push({
      id: `workflow:${failedWorkflow.workflow.id}`,
      title: "Recover a failed workflow",
      summary: `Friday can redeploy or export ${failedWorkflow.workflow.name} from the assistant.`,
      tone: "danger",
      kind: "workflow",
    });
  } else {
    const deployableWorkflow = input.workflowOverviews.find((overview) => overview.latestDraft);
    if (deployableWorkflow?.latestDraft) {
      actions.push({
        id: `workflow:${deployableWorkflow.workflow.id}`,
        title: "Deploy the next workflow draft",
        summary: `${deployableWorkflow.workflow.name} is ready for one-click deploy from the assistant.`,
        tone: "warning",
        kind: "workflow",
      });
    }
  }

  const installableSkill = input.catalogItems.find((item) => !item.installed);
  if (installableSkill) {
    actions.push({
      id: `skill:${installableSkill.skillId}`,
      title: "Install a recommended skill",
      summary: `${installableSkill.skillName} is available without opening the skills page.`,
      tone: installableSkill.signatureValid ? "success" : "warning",
      kind: "skill",
    });
  }

  const pendingPairing = input.pairingRequests[0];
  if (pendingPairing) {
    actions.push({
      id: `pairing:${pendingPairing.satelliteId}`,
      title: "Approve or reject a new node",
      summary: `${pendingPairing.displayName} is waiting for pairing approval.`,
      tone: "warning",
      kind: "fleet",
    });
  } else {
    const degradedSatellite = input.degradedSatellites[0];
    if (degradedSatellite) {
      actions.push({
        id: `fleet:${degradedSatellite.satelliteId}`,
        title: "Recover a degraded node",
        summary: `${degradedSatellite.displayName} needs fleet recovery attention.`,
        tone: "warning",
        kind: "fleet",
      });
    }
  }

  const activeAlert = input.alerts[0];
  if (activeAlert) {
    actions.push({
      id: `alert:${activeAlert.id}`,
      title: "Triage an active alert",
      summary: activeAlert.summary,
      tone: activeAlert.severity === "critical" ? "danger" : "warning",
      kind: "alert",
    });
  }

  return actions.slice(0, 5);
}

export function buildAssistantRecoveryPaths(input: {
  issues: FridayIssueCard[];
  workflowOverviews: FridayWorkflowOverview[];
  degradedSatellites: FridayFleetSatelliteCard[];
  alerts: FridayObservabilityAlertSummary[];
}): FridayAssistantRecoveryPath[] {
  const paths: FridayAssistantRecoveryPath[] = [];

  const approvalIssue = input.issues.find((issue) => issue.kind === "approval_required");
  if (approvalIssue) {
    paths.push({
      id: `approval:${approvalIssue.id}`,
      title: "Approve or inspect the blocked fix",
      summary: approvalIssue.summary,
      reason: "A higher-risk repair is waiting for a decision before Friday can continue.",
      kind: "approval",
      tone: toneForIssue(approvalIssue),
      routeTarget: "/assistant",
    });
  }

  const degradedSatellite = input.degradedSatellites[0];
  if (degradedSatellite) {
    paths.push({
      id: `fleet:${degradedSatellite.satelliteId}`,
      title: "Recover the degraded node first",
      summary: `${degradedSatellite.displayName} is ${degradedSatellite.pairingStatus} and affecting fleet health.`,
      reason: "Node health problems can block placement, retries, and downstream repair work.",
      kind: "fleet",
      tone: "warning",
      routeTarget: buildFleetHref(degradedSatellite.satelliteId, "recovery"),
    });
  }

  const criticalAlert = input.alerts.find((alert) => alert.severity === "critical") ?? input.alerts[0];
  if (criticalAlert) {
    paths.push({
      id: `alert:${criticalAlert.id}`,
      title: "Triage the active alert",
      summary: criticalAlert.summary,
      reason: "Observability is already telling you where the sharpest live problem is.",
      kind: "alert",
      tone: criticalAlert.severity === "critical" ? "danger" : "warning",
      routeTarget: buildObservabilityHref({ focus: "alerts", alertId: criticalAlert.id }),
    });
  }

  const failedWorkflow = input.workflowOverviews.find((overview) => overview.latestRun?.status === "failed");
  if (failedWorkflow) {
    paths.push({
      id: `workflow:${failedWorkflow.workflow.id}`,
      title: "Recover the failed workflow run",
      summary: `${failedWorkflow.workflow.name} failed on its latest run and already has a draft path available for recovery.`,
      reason: "Workflow failures are often the shortest path to a concrete fix and rerun.",
      kind: "workflow",
      tone: "danger",
      routeTarget: buildWorkflowHref(failedWorkflow.workflow.id, "recovery"),
    });
  }

  return paths.slice(0, 4);
}

export function buildAssistantIssuePlaybook(input: {
  issue: FridayIssueCard;
  action: FridayFixPlanRecord | null;
}): FridayAssistantIssuePlaybook {
  const { issue, action } = input;

  if (issue.kind === "approval_required") {
    return {
      title: "Friday has a bounded repair ready",
      summary: action?.summary.requiresApproval
        ? "Approve the fix when you're comfortable, or open the deeper evidence before deciding."
        : "Review the repair path and execute it when you're ready.",
      primaryLabel: action?.summary.requiresApproval ? "Approve fix" : "Review repair",
      primaryRouteTarget: "/assistant",
      secondaryLabel: "Inspect evidence",
      secondaryRouteTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
    };
  }

  if (issue.kind === "failed_fix") {
    return {
      title: "Friday already tried a repair and needs a cleaner recovery path",
      summary:
        "Inspect the evidence, confirm the rollback outcome, and then choose whether to retry or redirect the repair.",
      primaryLabel: "Inspect rollback evidence",
      primaryRouteTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
      secondaryLabel: "Open recovery path",
      secondaryRouteTarget: "/assistant",
    };
  }

  return {
    title: "Friday found a problem that still needs a guided next step",
    summary:
      "Open the evidence first, then move to the assistant or the related control page to continue with a bounded repair.",
    primaryLabel: "Inspect issue evidence",
    primaryRouteTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
    secondaryLabel: "Open guided recovery",
    secondaryRouteTarget: "/assistant",
  };
}
