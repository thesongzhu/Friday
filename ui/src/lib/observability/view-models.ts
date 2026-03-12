import type {
  FridayAcceptanceRunSummary,
  FridayAgentLoopRunRecord,
  FridayIssueCard,
  FridayObservabilityAlertSummary,
  FridayObservabilityComponentHealth,
  FridayObservabilityOverview,
  FridayRetryCircuitBreakerSummary,
  FridayRetryEscalationSummary,
} from "@friday-operator-client";

export type FridayObservabilityFocus =
  | "overview"
  | "alerts"
  | "health"
  | "acceptance"
  | "retry"
  | "rules"
  | "loop"
  | "traces"
  | "audit";

export interface FridayObservabilityActionQueueItem {
  id: string;
  title: string;
  summary: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "danger";
  focus: FridayObservabilityFocus;
  affectedArea: string;
  ctaLabel: string;
  routeTarget: string;
  secondaryLabel?: string;
  secondaryRouteTarget?: string;
}

export function buildObservabilityHref(input?: {
  focus?: FridayObservabilityFocus;
  alertId?: string;
  issueId?: string;
  escalationId?: string;
  loopRunId?: string;
}) {
  const params = new URLSearchParams();
  if (input?.focus) params.set("focus", input.focus);
  if (input?.alertId) params.set("alertId", input.alertId);
  if (input?.issueId) params.set("issueId", input.issueId);
  if (input?.escalationId) params.set("escalationId", input.escalationId);
  if (input?.loopRunId) params.set("loopRunId", input.loopRunId);
  const query = params.toString();
  return query.length > 0 ? `/observability?${query}` : "/observability";
}

function toneForSeverity(
  value?: "critical" | "warning" | "info" | "healthy" | "degraded" | "unhealthy" | "unknown",
): "neutral" | "success" | "warning" | "danger" {
  if (value === "critical" || value === "unhealthy") return "danger";
  if (value === "warning" || value === "degraded" || value === "unknown") return "warning";
  if (value === "healthy") return "success";
  return "neutral";
}

function rankIssueSeverity(severity: string) {
  if (severity === "critical") return 4;
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  if (severity === "info") return 1;
  return 0;
}

function summarizeIssueAction(issue: FridayIssueCard) {
  if (issue.kind === "approval_required") {
    return {
      title: "Approve the bounded repair before Friday can continue",
      detail: "A policy boundary is blocking a higher-risk fix. Review the evidence first, then approve or deny it.",
      ctaLabel: "Open guided recovery",
      routeTarget: "/assistant",
      secondaryLabel: "Inspect issue evidence",
      secondaryRouteTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
    };
  }
  if (issue.kind === "failed_fix") {
    return {
      title: "Inspect the failed repair before retrying",
      detail: "Friday already attempted a fix. Confirm the rollback outcome and choose a cleaner next step.",
      ctaLabel: "Inspect rollback evidence",
      routeTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
      secondaryLabel: "Open guided recovery",
      secondaryRouteTarget: "/assistant",
    };
  }
  return {
    title: "Inspect the issue and open the safest next step",
    detail: "Friday has a live issue on record. Review the evidence, then continue through the assistant or the related control page.",
    ctaLabel: "Inspect issue evidence",
    routeTarget: buildObservabilityHref({ focus: "alerts", issueId: issue.id }),
    secondaryLabel: "Open guided recovery",
    secondaryRouteTarget: "/assistant",
  };
}

export function buildObservabilityActionQueue(input: {
  overview?: FridayObservabilityOverview;
  alerts: FridayObservabilityAlertSummary[];
  issues: FridayIssueCard[];
  acceptanceResults: FridayAcceptanceRunSummary[];
  retryEscalations: FridayRetryEscalationSummary[];
  retryCircuitBreakers: FridayRetryCircuitBreakerSummary[];
  agentLoopRuns: FridayAgentLoopRunRecord[];
}) {
  const items: FridayObservabilityActionQueueItem[] = [];

  const issue = [...input.issues].sort((left, right) => rankIssueSeverity(right.severity) - rankIssueSeverity(left.severity))[0];
  if (issue) {
    const summary = summarizeIssueAction(issue);
    items.push({
      id: `issue:${issue.id}`,
      title: summary.title,
      summary: issue.summary,
      detail: summary.detail,
      tone: toneForSeverity(issue.severity as "critical" | "warning" | "info"),
      focus: "alerts",
      affectedArea: "Guided recovery",
      ctaLabel: summary.ctaLabel,
      routeTarget: summary.routeTarget,
      secondaryLabel: summary.secondaryLabel,
      secondaryRouteTarget: summary.secondaryRouteTarget,
    });
  }

  const alert = input.alerts.find((item) => item.severity === "critical") ?? input.alerts[0];
  if (alert) {
    items.push({
      id: `alert:${alert.id}`,
      title: "Investigate the sharpest live alert",
      summary: alert.summary,
      detail: "Friday already has traces, audit, and alert context for this issue. Start here before drilling into lower-priority signals.",
      tone: toneForSeverity(alert.severity),
      focus: "alerts",
      affectedArea: alert.module,
      ctaLabel: "Review alert detail",
      routeTarget: buildObservabilityHref({ focus: "alerts", alertId: alert.id }),
    });
  }

  const failedAcceptance = input.acceptanceResults.find((item) => item.state === "failed");
  if (failedAcceptance) {
    items.push({
      id: `acceptance:${failedAcceptance.id}`,
      title: "Review the failing quality gate",
      summary: `${failedAcceptance.artifactType} is blocked by acceptance checks.`,
      detail: "A failed quality gate can stop deploys and retries. Inspect this before widening the blast radius.",
      tone: "warning",
      focus: "acceptance",
      affectedArea: "Acceptance",
      ctaLabel: "Open acceptance detail",
      routeTarget: buildObservabilityHref({ focus: "acceptance" }),
    });
  }

  const retryEscalation = input.retryEscalations.find((item) => !item.acknowledged) ?? input.retryEscalations[0];
  if (retryEscalation) {
    items.push({
      id: `retry-escalation:${retryEscalation.id}`,
      title: "Acknowledge or resolve the retry escalation",
      summary: retryEscalation.reason,
      detail: "Retries have already crossed an escalation threshold. Decide whether to retry, redirect, or halt the failing path.",
      tone: "warning",
      focus: "retry",
      affectedArea: "Retry",
      ctaLabel: "Open retry escalations",
      routeTarget: buildObservabilityHref({ focus: "retry", escalationId: retryEscalation.id }),
    });
  }

  const nonClosedBreaker = input.retryCircuitBreakers.find((item) => item.state !== "closed");
  if (nonClosedBreaker) {
    items.push({
      id: `circuit-breaker:${nonClosedBreaker.targetId}`,
      title: "Inspect the non-closed circuit breaker",
      summary: `${nonClosedBreaker.targetId} is ${nonClosedBreaker.state}.`,
      detail: "Provider-level protection is active. Review it before assuming the retry system will recover on its own.",
      tone: nonClosedBreaker.state === "open" ? "danger" : "warning",
      focus: "retry",
      affectedArea: "Retry",
      ctaLabel: "Open retry protection",
      routeTarget: buildObservabilityHref({ focus: "retry" }),
    });
  }

  const haltedLoop = input.agentLoopRuns.find((record) => record.run.status === "halted");
  if (haltedLoop) {
    items.push({
      id: `loop:${haltedLoop.run.loopRunId}`,
      title: "Friday paused an autonomous recovery run",
      summary: haltedLoop.action?.summary.title ?? haltedLoop.incident?.summary.rootCauseSummary ?? "Loop run halted after repeated failure.",
      detail: "Repeated failures exhausted the current budget. Review verification, rollback, and lesson extraction before resuming.",
      tone: "warning",
      focus: "loop",
      affectedArea: "Agent loop",
      ctaLabel: "Open loop detail",
      routeTarget: buildObservabilityHref({ focus: "loop", loopRunId: haltedLoop.run.loopRunId }),
    });
  }

  const degradedComponent = input.overview?.health?.components.find((component) => component.status !== "healthy");
  if (degradedComponent) {
    items.push({
      id: `health:${degradedComponent.name}`,
      title: "Check the degraded system component",
      summary: degradedComponent.message ?? `${degradedComponent.name} is reporting degraded health.`,
      detail: "System health can explain downstream failures across assistant, fleet, workflows, and self-healing.",
      tone: toneForSeverity(degradedComponent.status),
      focus: "health",
      affectedArea: degradedComponent.module,
      ctaLabel: "Open health detail",
      routeTarget: buildObservabilityHref({ focus: "health" }),
    });
  }

  return items.slice(0, 6);
}

export function selectObservabilityPrimaryHealthComponent(
  components: FridayObservabilityComponentHealth[],
) {
  return components.find((component) => component.status !== "healthy") ?? components[0] ?? null;
}

export function formatObservabilityFocusLabel(focus: FridayObservabilityFocus) {
  switch (focus) {
    case "alerts":
      return "Alert detail";
    case "health":
      return "System health";
    case "acceptance":
      return "Acceptance";
    case "retry":
      return "Retry";
    case "rules":
      return "Rules";
    case "loop":
      return "Agent loop";
    case "traces":
      return "Trace detail";
    case "audit":
      return "Audit detail";
    case "overview":
    default:
      return "Overview";
  }
}
