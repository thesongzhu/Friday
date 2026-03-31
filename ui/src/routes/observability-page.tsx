import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  CheckCircle2,
  ChevronRight,
  Edit3,
  HeartPulse,
  Mail,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Siren,
  Square,
  TimerReset,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { assistantDiagnosticsApi } from "@/lib/api/assistant-diagnostics";
import { systemApi } from "@/lib/api/system";
import {
  buildObservabilityActionQueue,
  buildObservabilityHref,
  formatObservabilityFocusLabel,
  selectObservabilityPrimaryHealthComponent,
  type FridayObservabilityFocus,
} from "@/lib/observability/view-models";

function buildRecentWindow(minutes: number) {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

function parseFocus(value: string | null): FridayObservabilityFocus {
  if (
    value === "alerts" ||
    value === "assistant" ||
    value === "health" ||
    value === "acceptance" ||
    value === "retry" ||
    value === "rules" ||
    value === "loop" ||
    value === "traces" ||
    value === "audit" ||
    value === "overview"
  ) {
    return value;
  }
  return "overview";
}

function toneForHealth(status?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "healthy") return "success";
  if (status === "degraded" || status === "unknown") return "warning";
  if (status === "unhealthy") return "danger";
  return "neutral";
}

function toneForAlert(status?: string, severity?: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "resolved") return "success";
  if (severity === "critical") return "danger";
  if (severity === "warning" || status === "firing" || status === "escalated") return "warning";
  return "neutral";
}

function toneForIssueSeverity(
  severity?: "low" | "medium" | "high",
): "neutral" | "success" | "warning" | "danger" {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warning";
  if (severity === "low") return "neutral";
  return "neutral";
}

function formatTimestamp(value?: string): string {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString();
}

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

function FocusChip(props: {
  label: string;
  active: boolean;
  to: string;
}) {
  return (
    <Link
      className={
        props.active
          ? "rounded-full border border-emerald-300/40 bg-emerald-300/15 px-3 py-1 text-xs font-medium text-emerald-100"
          : "rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-white/60 hover:bg-white/[0.08]"
      }
      to={props.to}
    >
      {props.label}
    </Link>
  );
}

function ObservabilityTile(props: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="agent-metric-card">
      <div className="flex items-center gap-2 text-white/40">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className="mt-3 text-xl font-semibold text-white">{props.value}</p>
      <p className="mt-2 text-xs leading-5 text-white/55">{props.detail}</p>
    </div>
  );
}

function ObservabilityActionCard(props: {
  title: string;
  summary: string;
  detail: string;
  affectedArea: string;
  tone: "neutral" | "success" | "warning" | "danger";
  ctaLabel: string;
  routeTarget: string;
  secondaryLabel?: string;
  secondaryRouteTarget?: string;
}) {
  return (
    <div className="agent-subcard p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/40">{props.affectedArea}</p>
          <h3 className="mt-1 text-base font-semibold text-white">{props.title}</h3>
        </div>
        <StatusPill tone={props.tone}>{props.tone}</StatusPill>
      </div>
      <p className="text-sm text-white/70">{props.summary}</p>
      <p className="mt-3 text-xs leading-5 text-white/50">{props.detail}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="inline-flex items-center rounded-2xl bg-emerald-300/20 px-4 py-2 text-sm text-emerald-50 hover:bg-emerald-300/30" to={props.routeTarget}>
          {props.ctaLabel}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
        {props.secondaryLabel && props.secondaryRouteTarget ? (
          <Link className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]" to={props.secondaryRouteTarget}>
            {props.secondaryLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function ObservabilityPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const focus = parseFocus(searchParams.get("focus"));
  const selectedAlertId = searchParams.get("alertId");
  const selectedIssueId = searchParams.get("issueId");
  const selectedEscalationId = searchParams.get("escalationId");
  const selectedLoopRunId = searchParams.get("loopRunId");

  const overviewQuery = useQuery({
    queryKey: ["observability", "overview"],
    queryFn: () => systemApi.getObservabilityOverview(),
    refetchInterval: 15_000,
  });

  const alertsQuery = useQuery({
    queryKey: ["observability", "alerts"],
    queryFn: () => systemApi.listObservabilityAlerts({ limit: 12 }),
    refetchInterval: 15_000,
  });

  const issuesQuery = useQuery({
    queryKey: ["observability", "assistant-issues"],
    queryFn: () => systemApi.listAssistantIssues(12),
    refetchInterval: 15_000,
  });

  const tracesQuery = useQuery({
    queryKey: ["observability", "traces"],
    queryFn: () => systemApi.searchObservabilityTraces({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const auditQuery = useQuery({
    queryKey: ["observability", "audit"],
    queryFn: () => systemApi.searchObservabilityAudit({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const agentLoopRunsQuery = useQuery({
    queryKey: ["observability", "agent-loop-runs"],
    queryFn: () => systemApi.listAgentLoopRuns({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const seriesQuery = useQuery({
    queryKey: ["observability", "time-series", "learning-failures"],
    queryFn: () => {
      const window = buildRecentWindow(60);
      return systemApi.getObservabilityTimeSeries({
        metricName: "friday.learning.failures.total",
        startTime: window.startTime,
        endTime: window.endTime,
        bucketSize: "5m",
      });
    },
    refetchInterval: 15_000,
  });

  const slosQuery = useQuery({
    queryKey: ["observability", "slos"],
    queryFn: () => systemApi.listObservabilitySlos({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const destinationsQuery = useQuery({
    queryKey: ["observability", "alert-destinations"],
    queryFn: () => systemApi.listObservabilityAlertDestinations(),
    refetchInterval: 30_000,
  });

  const acceptanceTestsQuery = useQuery({
    queryKey: ["observability", "acceptance-tests"],
    queryFn: () => systemApi.listAcceptanceTests({ limit: 8 }),
    refetchInterval: 30_000,
  });

  const acceptanceResultsQuery = useQuery({
    queryKey: ["observability", "acceptance-results"],
    queryFn: () => systemApi.listAcceptanceResults({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const retryEscalationsQuery = useQuery({
    queryKey: ["observability", "retry-escalations"],
    queryFn: () => systemApi.listRetryEscalations({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const retryCircuitBreakersQuery = useQuery({
    queryKey: ["observability", "retry-circuit-breakers"],
    queryFn: () => systemApi.listRetryCircuitBreakers(),
    refetchInterval: 15_000,
  });

  const retryCostSummaryQuery = useQuery({
    queryKey: ["observability", "retry-cost-summary"],
    queryFn: () => systemApi.getRetryCostSummary(),
    refetchInterval: 15_000,
  });

  const rulesAuditLogQuery = useQuery({
    queryKey: ["observability", "rules-audit-log"],
    queryFn: () => systemApi.listRulesAuditLog({ limit: 8 }),
    refetchInterval: 15_000,
  });

  const assistantDiagnosticsQuery = useQuery({
    queryKey: ["observability", "assistant-diagnostics"],
    queryFn: () => assistantDiagnosticsApi.get(),
    refetchInterval: 10_000,
  });

  const acknowledgeAlertMutation = useMutation({
    mutationFn: (input: { alertId: string; note?: string }) =>
      systemApi.acknowledgeObservabilityAlert(input.alertId, input.note),
    onSuccess: () => {
      toast.success("Alert acknowledged.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["observability", "overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not acknowledge alert.");
    },
  });

  const resumeLoopRunMutation = useMutation({
    mutationFn: (loopRunId: string) => systemApi.resumeAgentLoopRun(loopRunId),
    onSuccess: () => {
      toast.success("Loop run resumed.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "agent-loop-runs"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not resume loop run.");
    },
  });

  const cancelLoopRunMutation = useMutation({
    mutationFn: (loopRunId: string) => systemApi.cancelAgentLoopRun(loopRunId),
    onSuccess: () => {
      toast.success("Loop run cancelled.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "agent-loop-runs"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not cancel loop run.");
    },
  });

  const deleteDestinationMutation = useMutation({
    mutationFn: (destinationId: string) => systemApi.deleteObservabilityAlertDestination(destinationId),
    onSuccess: () => {
      toast.success("Alert destination deleted.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not delete destination.");
    },
  });

  const createDestinationMutation = useMutation({
    mutationFn: (input: { type: "slack"; name: string; webhookUrl: string }) =>
      systemApi.createObservabilityAlertDestination(input),
    onSuccess: () => {
      toast.success("Alert destination created.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
      setShowCreateDest(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create destination.");
    },
  });

  const updateDestinationMutation = useMutation({
    mutationFn: (input: { id: string; name?: string; enabled?: boolean }) => {
      const { id, ...patch } = input;
      return systemApi.updateObservabilityAlertDestination(id, patch);
    },
    onSuccess: () => {
      toast.success("Alert destination updated.");
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update destination.");
    },
  });

  const [showCreateDest, setShowCreateDest] = useState(false);

  const overview = overviewQuery.data;
  const alerts = alertsQuery.data?.items ?? [];
  const issues = issuesQuery.data ?? [];
  const traces = tracesQuery.data?.items ?? [];
  const auditEntries = auditQuery.data?.items ?? [];
  const agentLoopRuns = agentLoopRunsQuery.data ?? [];
  const series = seriesQuery.data;
  const slos = slosQuery.data ?? [];
  const destinations = destinationsQuery.data ?? [];
  const acceptanceTests = acceptanceTestsQuery.data ?? [];
  const acceptanceResults = acceptanceResultsQuery.data ?? [];
  const retryEscalations = retryEscalationsQuery.data ?? [];
  const retryCircuitBreakers = retryCircuitBreakersQuery.data ?? [];
  const retryCostSummary = retryCostSummaryQuery.data;
  const rulesAuditLog = rulesAuditLogQuery.data ?? [];
  const assistantDiagnostics = assistantDiagnosticsQuery.data;
  const latestAssistantRun = assistantDiagnostics?.recentRuns[0] ?? null;
  const assistantMcpStateCounts = (assistantDiagnostics?.mcpServerStates ?? []).reduce(
    (summary, state) => {
      summary[state.state] += 1;
      return summary;
    },
    {
      configured: 0,
      discoverable: 0,
      loaded: 0,
      deferred: 0,
    },
  );
  const workspaceContextComponent =
    latestAssistantRun?.contextCostSummary?.components.find((component) => component.kind === "workspace_context") ?? null;
  const pathRuleCount = typeof workspaceContextComponent?.metadata?.pathRuleCount === "number"
    ? workspaceContextComponent.metadata.pathRuleCount
    : 0;
  const candidatePaths = Array.isArray(workspaceContextComponent?.metadata?.candidatePaths)
    ? workspaceContextComponent?.metadata?.candidatePaths.filter((value): value is string => typeof value === "string")
    : [];

  const actionQueue = useMemo(
    () =>
      buildObservabilityActionQueue({
        overview,
        alerts,
        issues,
        acceptanceResults,
        retryEscalations,
        retryCircuitBreakers,
        agentLoopRuns,
      }),
    [overview, alerts, issues, acceptanceResults, retryEscalations, retryCircuitBreakers, agentLoopRuns],
  );

  const highlightedAlert = alerts.find((alert) => alert.id === selectedAlertId) ?? alerts[0] ?? null;
  const highlightedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? issues[0] ?? null;
  const highlightedEscalation = retryEscalations.find((item) => item.id === selectedEscalationId) ?? retryEscalations[0] ?? null;
  const highlightedLoopRun =
    agentLoopRuns.find((record) => record.run.loopRunId === selectedLoopRunId) ??
    agentLoopRuns.find((record) => record.run.status === "halted") ??
    agentLoopRuns[0] ??
    null;
  const highlightedHealthComponent = selectObservabilityPrimaryHealthComponent(overview?.health?.components ?? []);
  const highlightedAcceptance = acceptanceResults.find((run) => run.state === "failed") ?? acceptanceResults[0] ?? null;

  const focusSummary = useMemo<{
    title: string;
    summary: string;
    detail: string;
    tone: "neutral" | "success" | "warning" | "danger";
  } | null>(() => {
    switch (focus) {
      case "alerts":
        if (highlightedIssue) {
          return {
            title: highlightedIssue.title,
            summary: highlightedIssue.summary,
            detail:
              highlightedIssue.kind === "approval_required"
                ? "A guided recovery is waiting behind an approval gate."
                : highlightedIssue.kind === "failed_fix"
                  ? "Friday already tried a bounded repair here. Review the rollback evidence before retrying."
                  : "Inspect the issue evidence, then move into a guided recovery path.",
            tone: toneForIssueSeverity(highlightedIssue.severity),
          };
        }
        if (highlightedAlert) {
          return {
            title: highlightedAlert.ruleName,
            summary: highlightedAlert.summary,
            detail: "This is the sharpest live alert. Acknowledge it here, then open the deeper recovery path if needed.",
            tone: toneForAlert(highlightedAlert.status, highlightedAlert.severity),
          };
        }
        return null;
      case "assistant":
        if (!assistantDiagnostics) {
          return {
            title: "Assistant diagnostics are loading",
            summary: "Friday is gathering task profiles, MCP server states, and recent context-cost summaries.",
            detail: "Use this focus to inspect context governance and task profile choices without leaving observability.",
            tone: "neutral",
          };
        }
        return {
          title: latestAssistantRun?.task ?? "Assistant diagnostics",
          summary: latestAssistantRun?.taskProfile
            ? `${latestAssistantRun.taskProfile.label} profile on the latest assistant run.`
            : "No recent assistant run is available yet.",
          detail: `MCP loaded ${assistantMcpStateCounts.loaded}, deferred ${assistantMcpStateCounts.deferred}, path rules ${pathRuleCount}.`,
          tone: assistantMcpStateCounts.deferred > 0 || pathRuleCount > 0 ? "warning" : "success",
        };
      case "health":
        if (!highlightedHealthComponent) return null;
        return {
          title: highlightedHealthComponent.name,
          summary: highlightedHealthComponent.message ?? "This component is currently the main health concern.",
          detail: `Module ${highlightedHealthComponent.module} is ${highlightedHealthComponent.status}.`,
          tone: toneForHealth(highlightedHealthComponent.status),
        };
      case "acceptance":
        if (!highlightedAcceptance) return null;
        return {
          title: `${highlightedAcceptance.artifactType} quality gate`,
          summary: highlightedAcceptance.overallVerdict,
          detail: `${highlightedAcceptance.checksFailed} checks failed for ${highlightedAcceptance.artifactUri}.`,
          tone: highlightedAcceptance.state === "failed" ? "warning" : "neutral",
        };
      case "retry":
        if (highlightedEscalation) {
          return {
            title: highlightedEscalation.reason,
            summary: `${highlightedEscalation.channel} escalation on ${highlightedEscalation.failureCategory}.`,
            detail: highlightedEscalation.acknowledged
              ? "This escalation has already been acknowledged."
              : "This escalation still needs an operator decision.",
            tone: highlightedEscalation.acknowledged ? "neutral" : "warning",
          };
        }
        return {
          title: "Retry protection",
          summary: `${retryCircuitBreakers.filter((item) => item.state !== "closed").length} provider protections are active.`,
          detail: "Review circuit breakers before forcing more retries.",
          tone: retryCircuitBreakers.some((item) => item.state === "open") ? "danger" : "warning",
        };
      case "rules":
        if (rulesAuditLog[0]) {
          return {
            title: `${rulesAuditLog[0].resource} · ${rulesAuditLog[0].action}`,
            summary: `${rulesAuditLog[0].decision} decision from ${rulesAuditLog[0].ruleId ?? "bundle-eval"}.`,
            detail: "Use this audit trail to explain why policy allowed, denied, or warned.",
            tone: rulesAuditLog[0].decision === "deny" ? "danger" : rulesAuditLog[0].decision === "warn" ? "warning" : "success",
          };
        }
        return null;
      case "loop":
        if (!highlightedLoopRun) return null;
        return {
          title: highlightedLoopRun.action?.summary.title ?? highlightedLoopRun.incident?.summary.rootCauseSummary ?? "Loop run",
          summary: highlightedLoopRun.run.status.replaceAll("_", " "),
          detail:
            highlightedLoopRun.run.haltReason ??
            (highlightedLoopRun.run.verificationPassed === false
              ? "Verification failed and Friday recorded the rollback outcome."
              : "Review verification, rollback, and lesson extraction before resuming."),
          tone:
            highlightedLoopRun.run.status === "halted" || highlightedLoopRun.run.status === "failed"
              ? "warning"
              : highlightedLoopRun.run.status === "verified"
                ? "success"
                : "neutral",
        };
      case "traces":
        if (!traces[0]) return null;
        return {
          title: traces[0].name,
          summary: `${traces[0].module} · ${traces[0].traceId}`,
          detail: `${traces[0].spanCount} spans over ${formatDurationMs(traces[0].durationMs)}.`,
          tone: traces[0].status === "error" ? "danger" : traces[0].status === "ok" ? "success" : "neutral",
        };
      case "audit":
        if (!auditEntries[0]) return null;
        return {
          title: auditEntries[0].description,
          summary: `${auditEntries[0].actorDisplayName} · ${auditEntries[0].action}`,
          detail: `${auditEntries[0].outcome} outcome in ${auditEntries[0].module}.`,
          tone: auditEntries[0].outcome === "failure" || auditEntries[0].outcome === "error" ? "danger" : auditEntries[0].outcome === "denied" ? "warning" : "success",
        };
      case "overview":
      default:
        return {
          title: "Work from the action queue first",
          summary: "Friday surfaces the most actionable problems above, then keeps raw telemetry in drill-down sections below.",
          detail: "Use the chips and action cards to move directly to the area that needs the next decision.",
          tone: overview?.alerts.activeAlerts ? "warning" : "success",
        };
    }
  }, [
    focus,
    highlightedIssue,
    highlightedAlert,
    assistantDiagnostics,
    assistantMcpStateCounts.deferred,
    assistantMcpStateCounts.loaded,
    highlightedHealthComponent,
    highlightedAcceptance,
    highlightedEscalation,
    highlightedLoopRun,
    retryCircuitBreakers,
    rulesAuditLog,
    traces,
    auditEntries,
    overview,
    latestAssistantRun,
    pathRuleCount,
  ]);

  const maxPoint = Math.max(1, ...(series?.points ?? []).map((point) => point.value));

  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow="Action queue"
        title="What is wrong and what should I click next"
        aside={
          <StatusPill tone={actionQueue.length > 0 ? "warning" : "success"}>
            {actionQueue.length > 0 ? "action needed" : "stable"}
          </StatusPill>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <FocusChip label="Overview" active={focus === "overview"} to={buildObservabilityHref({ focus: "overview" })} />
          <FocusChip label="Assistant" active={focus === "assistant"} to={buildObservabilityHref({ focus: "assistant" })} />
          <FocusChip label="Alerts" active={focus === "alerts"} to={buildObservabilityHref({ focus: "alerts" })} />
          <FocusChip label="Health" active={focus === "health"} to={buildObservabilityHref({ focus: "health" })} />
          <FocusChip label="Acceptance" active={focus === "acceptance"} to={buildObservabilityHref({ focus: "acceptance" })} />
          <FocusChip label="Retry" active={focus === "retry"} to={buildObservabilityHref({ focus: "retry" })} />
          <FocusChip label="Rules" active={focus === "rules"} to={buildObservabilityHref({ focus: "rules" })} />
          <FocusChip label="Loop" active={focus === "loop"} to={buildObservabilityHref({ focus: "loop" })} />
        </div>
        {actionQueue.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {actionQueue.map((item) => (
              <ObservabilityActionCard key={item.id} {...item} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/60">No urgent action cards are open right now.</p>
        )}
      </ShellCard>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <ShellCard eyebrow="Current focus" title={formatObservabilityFocusLabel(focus)}>
          {focusSummary ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{focusSummary.title}</p>
                    <p className="mt-1 text-sm text-white/65">{focusSummary.summary}</p>
                  </div>
                  <StatusPill tone={focusSummary.tone}>{focusSummary.tone}</StatusPill>
                </div>
                <p className="text-xs leading-5 text-white/50">{focusSummary.detail}</p>
              </div>
              <p className="text-sm text-white/60">
                Friday keeps this page action-first: solve the highlighted problem here, then drill into traces, audit, and history only when you need the deeper evidence.
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/60">No detail is available for this focus yet.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Overview" title="Current operational state">
          {overview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ObservabilityTile
                  icon={<AlertTriangle className="h-4 w-4" />}
                  label="Active alerts"
                  value={String(overview.alerts.activeAlerts)}
                  detail={overview.alerts.highestSeverity ? `Highest severity ${overview.alerts.highestSeverity}` : "No active alert severity"}
                />
                <ObservabilityTile
                  icon={<HeartPulse className="h-4 w-4" />}
                  label="Health"
                  value={overview.health?.status ?? "unavailable"}
                  detail={overview.health?.message ?? "No health checks registered yet."}
                />
                <ObservabilityTile
                  icon={<Activity className="h-4 w-4" />}
                  label="Completed traces"
                  value={String(overview.traces.totalTraces)}
                  detail={`Average duration ${formatDurationMs(overview.traces.avgDurationMs)}`}
                />
                <ObservabilityTile
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="Audit entries"
                  value={String(overview.audit.totalEntries)}
                  detail={`${Object.keys(overview.audit.byOutcome).length} tracked outcomes`}
                />
              </div>
              <p className="text-xs text-white/50">
                Generated at {formatTimestamp(overview.generatedAt)}. This page stays aligned with `/assistant`: action queue first, telemetry second.
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/60">Loading the current system state...</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        {focus === "overview" || focus === "assistant" ? (
          <ShellCard eyebrow="Assistant diagnostics" title="Context governance, MCP loading, and task profiles">
            {assistantDiagnostics ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <ObservabilityTile
                    icon={<BellRing className="h-4 w-4" />}
                    label="MCP loaded"
                    value={String(assistantMcpStateCounts.loaded)}
                    detail={`${assistantMcpStateCounts.configured} configured · ${assistantMcpStateCounts.discoverable} discoverable`}
                  />
                  <ObservabilityTile
                    icon={<RotateCcw className="h-4 w-4" />}
                    label="Deferred"
                    value={String(assistantMcpStateCounts.deferred)}
                    detail="Deferred servers stay out of the default context until they are needed."
                  />
                  <ObservabilityTile
                    icon={<Mail className="h-4 w-4" />}
                    label="Path rules"
                    value={String(pathRuleCount)}
                    detail={candidatePaths.length > 0 ? candidatePaths.slice(0, 2).join(" · ") : "No path-specific rule candidates surfaced."}
                  />
                  <ObservabilityTile
                    icon={<Activity className="h-4 w-4" />}
                    label="Preprocessors"
                    value={String(assistantDiagnostics.supportedPreprocessors.length)}
                    detail={assistantDiagnostics.supportedPreprocessors.join(", ")}
                  />
                </div>
                {latestAssistantRun ? (
                  <div className="agent-subcard p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-white">{latestAssistantRun.task}</p>
                        <p className="text-xs text-white/50">
                          {latestAssistantRun.taskProfile?.label ?? "No task profile"} · {latestAssistantRun.status}
                        </p>
                      </div>
                      <StatusPill tone={latestAssistantRun.status === "completed" ? "success" : latestAssistantRun.status === "failed" ? "danger" : "warning"}>
                        {latestAssistantRun.status}
                      </StatusPill>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-white/55">
                      <p>Workspace context: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "workspace_context")?.estimatedChars ?? 0} chars</p>
                      <p>Starter skills: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "starter_skills")?.estimatedChars ?? 0} chars</p>
                      <p>MCP: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "mcp")?.estimatedChars ?? 0} chars</p>
                      <p>Subagents: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "subagents")?.estimatedChars ?? 0} chars</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-white/60">No recent assistant runs have been recorded yet.</p>
                )}
                <div className="space-y-3">
                  {(assistantDiagnostics.mcpServerStates ?? []).length === 0 ? (
                    <p className="text-sm text-white/60">No MCP servers are configured for this runtime.</p>
                  ) : (
                    assistantDiagnostics.mcpServerStates.map((state) => (
                      <div key={state.serverId} className="agent-subcard p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium text-white">{state.serverId}</p>
                            <p className="text-xs text-white/50">
                              {state.transport} · {state.lazyDiscovery ? "lazy discovery" : "eager discovery"}
                            </p>
                          </div>
                          <StatusPill tone={state.state === "loaded" ? "success" : state.state === "deferred" ? "warning" : "neutral"}>
                            {state.state}
                          </StatusPill>
                        </div>
                        <p className="mt-3 text-xs text-white/55">
                          Tools {state.toolCount ?? 0} · Resources {state.resourceCount ?? 0} · Prompts {state.promptCount ?? 0}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-white/60">Loading assistant diagnostics...</p>
            )}
          </ShellCard>
        ) : null}

        <ShellCard eyebrow="Live alerts" title="Investigate, acknowledge, or hand off to guided recovery">
          {alerts.length > 0 ? (
            <div className="space-y-3">
              {alerts.slice(0, 6).map((alert) => (
                <div key={alert.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{alert.summary}</p>
                      <p className="text-xs text-white/50">{alert.ruleName} · {alert.module}</p>
                    </div>
                    <StatusPill tone={toneForAlert(alert.status, alert.severity)}>
                      {alert.severity} · {alert.status}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-white/60">Detected {formatTimestamp(alert.detectedAt)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]" to={buildObservabilityHref({ focus: "alerts", alertId: alert.id })}>
                      Investigate
                    </Link>
                    <Link className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]" to="/assistant">
                      Open guided recovery
                    </Link>
                    {alert.status !== "acknowledged" && alert.status !== "resolved" ? (
                      <button
                        className="inline-flex items-center rounded-2xl bg-emerald-300/20 px-4 py-2 text-sm text-emerald-50 hover:bg-emerald-300/30 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={acknowledgeAlertMutation.isPending}
                        onClick={() =>
                          acknowledgeAlertMutation.mutate({
                            alertId: alert.id,
                            note: "Acknowledged from observability action queue.",
                          })}
                        type="button"
                      >
                        Acknowledge
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">No active alerts are firing right now.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Guided issues" title="Problems that map back to the assistant">
          {issues.length > 0 ? (
            <div className="space-y-3">
              {issues.slice(0, 6).map((issue) => (
                <div key={issue.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{issue.title}</p>
                      <p className="text-xs text-white/50">{issue.kind.replaceAll("_", " ")}</p>
                    </div>
                    <StatusPill tone={toneForIssueSeverity(issue.severity)}>
                      {issue.severity}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-white/60">{issue.summary}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className="inline-flex items-center rounded-2xl bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/[0.14]" to={buildObservabilityHref({ focus: "alerts", issueId: issue.id })}>
                      Inspect evidence
                    </Link>
                    <Link className="inline-flex items-center rounded-2xl bg-emerald-300/20 px-4 py-2 text-sm text-emerald-50 hover:bg-emerald-300/30" to="/assistant">
                      Continue in assistant
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">No guided issues are open right now.</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow="Acceptance and retry" title="Quality gates and retry pressure">
          {acceptanceResults.length > 0 || retryEscalations.length > 0 || retryCircuitBreakers.length > 0 ? (
            <div className="space-y-3">
              <ObservabilityTile
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Failed acceptance"
                value={String(acceptanceResults.filter((run) => run.state === "failed").length)}
                detail={`${acceptanceTests.filter((test) => test.enabled).length} quality gates enabled`}
              />
              <ObservabilityTile
                icon={<TimerReset className="h-4 w-4" />}
                label="Retry escalations"
                value={String(retryEscalations.filter((item) => !item.acknowledged).length)}
                detail={`${retryCircuitBreakers.filter((item) => item.state !== "closed").length} non-closed circuit breakers`}
              />
              {retryCostSummary ? (
                <div className="agent-detail-note p-4 text-xs text-white/55">
                  <p>Total retry records: {retryCostSummary.summary.recordCount}</p>
                  <p>Budget exceeded: {retryCostSummary.summary.budgetExceeded ? "yes" : "no"}</p>
                  <p>Token cost: {retryCostSummary.summary.totalCost.tokens}</p>
                </div>
              ) : null}
              {retryEscalations.slice(0, 3).map((escalation) => (
                <div key={escalation.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{escalation.reason}</p>
                      <p className="text-xs text-white/50">{escalation.channel} · {escalation.failureCategory}</p>
                    </div>
                    <StatusPill tone={escalation.acknowledged ? "success" : "warning"}>
                      {escalation.acknowledged ? "acknowledged" : "open"}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">No acceptance or retry pressure is active right now.</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Agent loop and rules" title="Autonomous recovery and policy state">
          {agentLoopRuns.length > 0 || rulesAuditLog.length > 0 ? (
            <div className="space-y-3">
              {agentLoopRuns.slice(0, 3).map((record) => (
                <LoopRunCard
                  key={record.run.loopRunId}
                  record={record}
                  onResume={(id) => resumeLoopRunMutation.mutate(id)}
                  onCancel={(id) => cancelLoopRunMutation.mutate(id)}
                  resumePending={resumeLoopRunMutation.isPending}
                  cancelPending={cancelLoopRunMutation.isPending}
                />
              ))}
              {rulesAuditLog.slice(0, 3).map((entry) => (
                <div key={entry.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{entry.resource} · {entry.action}</p>
                      <p className="text-xs text-white/50">{entry.ruleId ?? "bundle-eval"}</p>
                    </div>
                    <StatusPill tone={entry.decision === "allow" ? "success" : entry.decision === "warn" ? "warning" : "danger"}>
                      {entry.decision}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">No loop or rules events need attention right now.</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow="Time series" title="Trend context after you know what to inspect">
          {series ? (
            <div className="space-y-3">
              <div className="grid gap-2">
                {series.points.map((point) => (
                  <div key={point.timestamp} className="grid grid-cols-[104px_1fr_48px] items-center gap-3 text-xs text-white/60">
                    <span>{new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <div className="h-2 rounded-full bg-white/[0.08]">
                      <div
                        className="h-2 rounded-full bg-emerald-300/70"
                        style={{ width: `${Math.max(4, (point.value / maxPoint) * 100)}%` }}
                      />
                    </div>
                    <span className="text-right text-white">{point.value}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-white/50">
                Metric: {series.metricName} · Bucket {series.bucketSize}
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/60">Loading time-series data...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow="Deep evidence" title="Traces and audit stay available as drill-down">
          {traces.length > 0 || auditEntries.length > 0 ? (
            <div className="space-y-3">
              {traces.slice(0, 3).map((trace) => (
                <div key={trace.traceId} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{trace.name}</p>
                      <p className="text-xs text-white/50">{trace.module} · {trace.traceId}</p>
                    </div>
                    <StatusPill tone={trace.status === "error" ? "danger" : trace.status === "ok" ? "success" : "neutral"}>
                      {trace.status}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-xs text-white/55">{trace.spanCount} spans · {formatDurationMs(trace.durationMs)}</p>
                </div>
              ))}
              {auditEntries.slice(0, 3).map((entry) => (
                <div key={entry.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{entry.description}</p>
                      <p className="text-xs text-white/50">{entry.action} · {entry.resourceType}</p>
                    </div>
                    <StatusPill tone={entry.outcome === "success" ? "success" : entry.outcome === "failure" ? "danger" : "warning"}>
                      {entry.outcome}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-xs text-white/55">{entry.actorDisplayName} · {formatTimestamp(entry.recordedAt)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">Trace and audit evidence will appear here when the system has more history.</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow="SLO pack" title="Service level state">
          {slos.length > 0 ? (
            <div className="space-y-3">
              {slos.map((slo) => (
                <SloCard key={slo.id} slo={slo} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-white/60">No SLO definitions are configured yet.</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow="Alert routing"
          title="Who gets notified when Friday escalates"
          aside={
            <ActionButton tone="secondary" onClick={() => setShowCreateDest(!showCreateDest)}>
              <Plus className="mr-1.5 h-3 w-3" />
              Add destination
            </ActionButton>
          }
        >
          {showCreateDest && <CreateDestinationForm onSubmit={(input) => createDestinationMutation.mutate(input)} pending={createDestinationMutation.isPending} onCancel={() => setShowCreateDest(false)} />}
          {destinations.length > 0 ? (
            <div className="space-y-3">
              {destinations.map((destination) => (
                <div key={destination.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="rounded-full border border-white/[0.08] bg-white/[0.04] p-2 text-white/70">
                        {destination.type === "slack" ? <BellRing className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-white">{destination.name}</p>
                        <p className="text-xs text-white/50">{destination.type}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${destination.enabled ? "bg-emerald-300/15 text-emerald-200 hover:bg-emerald-300/25" : "bg-white/[0.06] text-white/50 hover:bg-white/10"}`}
                        disabled={updateDestinationMutation.isPending}
                        onClick={() => updateDestinationMutation.mutate({ id: destination.id, enabled: !destination.enabled })}
                      >
                        {destination.enabled ? "enabled" : "disabled"}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-white/30 transition hover:bg-white/10 hover:text-red-400"
                        disabled={deleteDestinationMutation.isPending}
                        onClick={() => deleteDestinationMutation.mutate(destination.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : !showCreateDest ? (
            <p className="text-sm text-white/60">No alert destinations are configured yet.</p>
          ) : null}
        </ShellCard>
      </div>
    </div>
  );
}

function LoopRunCard(props: {
  record: Awaited<ReturnType<typeof systemApi.listAgentLoopRuns>>[number];
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  resumePending: boolean;
  cancelPending: boolean;
}) {
  const { record } = props;
  const [expanded, setExpanded] = useState(false);
  const detailQuery = useQuery({
    queryKey: ["observability", "loop-run-detail", record.run.loopRunId],
    queryFn: () => systemApi.getAgentLoopRun(record.run.loopRunId),
    enabled: expanded,
  });

  return (
    <div className="agent-subcard p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-white">{record.action?.summary.title ?? record.incident?.summary.rootCauseSummary ?? "Loop run"}</p>
          <p className="text-xs text-white/50">{record.run.loopRunId}</p>
        </div>
        <StatusPill tone={record.run.status === "verified" ? "success" : record.run.status === "halted" ? "warning" : "neutral"}>
          {record.run.status.replaceAll("_", " ")}
        </StatusPill>
      </div>
      <p className="mt-3 text-xs text-white/55">
        Verification: {record.run.verificationPassed === undefined ? "pending" : record.run.verificationPassed ? "passed" : "failed"} ·
        Rollback: {record.run.rollbackAttempted ? (record.run.rollbackSucceeded ? " succeeded" : " attempted") : " not needed"}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {record.run.status === "paused" ? (
          <ActionButton tone="secondary" disabled={props.resumePending} onClick={() => props.onResume(record.run.loopRunId)}>
            <Play className="mr-1.5 h-3 w-3" />Resume
          </ActionButton>
        ) : null}
        {record.run.status === "running" || record.run.status === "paused" ? (
          <ActionButton tone="secondary" disabled={props.cancelPending} onClick={() => props.onCancel(record.run.loopRunId)}>
            <Square className="mr-1.5 h-3 w-3" />Cancel
          </ActionButton>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs font-medium text-white/50 transition hover:text-white/80"
        >
          <ChevronRight className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`} />
          {expanded ? "Less" : "Detail"}
        </button>
      </div>
      {expanded && detailQuery.data ? (
        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.02] p-3 text-xs text-white/55 space-y-1">
          <p>Risk tier: {detailQuery.data.run.riskTier}</p>
          <p>Attempt: {detailQuery.data.run.attemptNumber}</p>
          <p>Approval required: {detailQuery.data.run.approvalRequired ? "yes" : "no"}</p>
          {detailQuery.data.run.haltReason ? <p>Halt reason: {detailQuery.data.run.haltReason}</p> : null}
          {detailQuery.data.run.lastError ? <p>Last error: {detailQuery.data.run.lastError}</p> : null}
          {detailQuery.data.run.correlationId ? <p>Correlation: {detailQuery.data.run.correlationId}</p> : null}
        </div>
      ) : expanded && detailQuery.isLoading ? (
        <p className="mt-3 text-xs text-white/40">Loading...</p>
      ) : null}
    </div>
  );
}

function CreateDestinationForm(props: {
  onSubmit: (input: { type: "slack"; name: string; webhookUrl: string }) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  return (
    <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">New Slack destination</p>
      <input
        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-300/40 focus:outline-none"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-emerald-300/40 focus:outline-none"
        placeholder="Webhook URL"
        value={webhookUrl}
        onChange={(e) => setWebhookUrl(e.target.value)}
      />
      <div className="flex gap-2">
        <ActionButton disabled={props.pending || !name.trim() || !webhookUrl.trim()} onClick={() => props.onSubmit({ type: "slack", name: name.trim(), webhookUrl: webhookUrl.trim() })}>
          Create
        </ActionButton>
        <ActionButton tone="secondary" onClick={props.onCancel}>Cancel</ActionButton>
      </div>
    </div>
  );
}

function SloCard(props: { slo: Awaited<ReturnType<typeof systemApi.listObservabilitySlos>>[number] }) {
  const { slo } = props;
  const [expanded, setExpanded] = useState(false);
  const detailQuery = useQuery({
    queryKey: ["observability", "slo-detail", slo.id],
    queryFn: () => systemApi.getObservabilitySlo(slo.id),
    enabled: expanded,
  });

  return (
    <div className="agent-subcard p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{slo.name}</p>
          <p className="text-xs text-white/50">{slo.sliMetricName}</p>
        </div>
        <StatusPill tone={slo.status === "healthy" ? "success" : slo.status === "warning" ? "warning" : "danger"}>
          {slo.status}
        </StatusPill>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-white/55">
        <p>Target: {slo.target}%</p>
        <p>Current value: {slo.currentValue?.toFixed(2) ?? "n/a"}%</p>
        <p>Budget consumed: {slo.budgetConsumedPercent?.toFixed(2) ?? "0"}%</p>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-3 flex items-center gap-1 text-xs font-medium text-white/50 transition hover:text-white/80"
      >
        <ChevronRight className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`} />
        {expanded ? "Hide detail" : "Show detail"}
      </button>
      {expanded && detailQuery.data ? (
        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.02] p-3 text-xs text-white/55">
          <div className="grid gap-2">
            {detailQuery.data.slo.description ? <p>{detailQuery.data.slo.description}</p> : null}
            <p>Compliance window: {detailQuery.data.slo.complianceWindowDays} days</p>
            {detailQuery.data.errorBudget ? (
              <>
                <p>Error budget remaining: {detailQuery.data.errorBudget.remainingBudgetPercent.toFixed(2)}%</p>
                <p>Budget exhausted: {detailQuery.data.errorBudget.exhausted ? "Yes" : "No"}</p>
                <p>Window: {new Date(detailQuery.data.errorBudget.windowStart).toLocaleDateString()} – {new Date(detailQuery.data.errorBudget.windowEnd).toLocaleDateString()}</p>
              </>
            ) : null}
            {detailQuery.data.burnRates.length > 0 ? (
              <div>
                <p className="font-medium text-white/70">Burn rates:</p>
                {detailQuery.data.burnRates.map((rate) => (
                  <p key={rate.windowLabel}>{rate.windowLabel}: {rate.rate.toFixed(2)}x</p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : expanded && detailQuery.isLoading ? (
        <p className="mt-3 text-xs text-white/40">Loading...</p>
      ) : null}
    </div>
  );
}
