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
import { ActionButton, ShellCard, SkeletonCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { assistantDiagnosticsApi } from "@/lib/api/assistant-diagnostics";
import { learningApi } from "@/lib/api/learning";
import { systemApi } from "@/lib/api/system";
import {
  describeRunHealth,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
} from "@/lib/runs/run-health";
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
  if (!value) return "—";
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
          ? "rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-3 py-1 text-xs font-medium text-[color:var(--color-text-primary)]"
          : "rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1 text-xs font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-surface-strong)]"
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
      <div className="flex items-center gap-2 text-[color:var(--color-text-secondary)]">
        {props.icon}
        <span className="text-xs font-semibold uppercase tracking-[0.18em]">{props.label}</span>
      </div>
      <p className="mt-3 text-xl font-semibold text-[color:var(--color-text-primary)]">{props.value}</p>
      <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{props.detail}</p>
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
          <p className="text-xs uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{props.affectedArea}</p>
          <h3 className="mt-1 text-base font-semibold text-[color:var(--color-text-primary)]">{props.title}</h3>
        </div>
        <StatusPill tone={props.tone}>{props.tone}</StatusPill>
      </div>
      <p className="text-sm text-[color:var(--color-text-secondary)]">{props.summary}</p>
      <p className="mt-3 text-xs leading-5 text-[color:var(--color-text-tertiary)]">{props.detail}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="inline-flex min-h-[44px] items-center rounded-2xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:opacity-90" to={props.routeTarget}>
          {props.ctaLabel}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Link>
        {props.secondaryLabel && props.secondaryRouteTarget ? (
          <Link className="inline-flex min-h-[44px] items-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-surface-strong)] hover:text-[color:var(--color-text-primary)]" to={props.secondaryRouteTarget}>
            {props.secondaryLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function ObservabilityPage() {
  const { locale } = useAppLocale();
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

  const expertLoopRunsQuery = useQuery({
    queryKey: ["observability", "expert-loop-runs"],
    queryFn: () => systemApi.listExpertAgentLoopRuns({ limit: 8 }),
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

  const learningOverviewQuery = useQuery({
    queryKey: ["observability", "learning-overview"],
    queryFn: () => learningApi.getOverview(12),
    refetchInterval: 20_000,
  });

  const acknowledgeAlertMutation = useMutation({
    mutationFn: (input: { alertId: string; note?: string }) =>
      systemApi.acknowledgeObservabilityAlert(input.alertId, input.note),
    onSuccess: () => {
      toast.success(localize(locale, "告警已确认。", "Alert acknowledged."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["observability", "overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法确认告警。", "Could not acknowledge alert."));
    },
  });

  const resumeLoopRunMutation = useMutation({
    mutationFn: (loopRunId: string) => systemApi.resumeAgentLoopRun(loopRunId),
    onSuccess: () => {
      toast.success(localize(locale, "循环运行已恢复。", "Loop run resumed."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "agent-loop-runs"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法恢复循环运行。", "Could not resume loop run."));
    },
  });

  const cancelLoopRunMutation = useMutation({
    mutationFn: (loopRunId: string) => systemApi.cancelAgentLoopRun(loopRunId),
    onSuccess: () => {
      toast.success(localize(locale, "循环运行已取消。", "Loop run cancelled."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "agent-loop-runs"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法取消循环运行。", "Could not cancel loop run."));
    },
  });

  const deleteDestinationMutation = useMutation({
    mutationFn: (destinationId: string) => systemApi.deleteObservabilityAlertDestination(destinationId),
    onSuccess: () => {
      toast.success(localize(locale, "告警目标已删除。", "Alert destination deleted."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法删除告警目标。", "Could not delete destination."));
    },
  });

  const createDestinationMutation = useMutation({
    mutationFn: (input: { type: "slack"; name: string; webhookUrl: string }) =>
      systemApi.createObservabilityAlertDestination(input),
    onSuccess: () => {
      toast.success(localize(locale, "告警目标已创建。", "Alert destination created."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
      setShowCreateDest(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法创建告警目标。", "Could not create destination."));
    },
  });

  const updateDestinationMutation = useMutation({
    mutationFn: (input: { id: string; name?: string; enabled?: boolean }) => {
      const { id, ...patch } = input;
      return systemApi.updateObservabilityAlertDestination(id, patch);
    },
    onSuccess: () => {
      toast.success(localize(locale, "告警目标已更新。", "Alert destination updated."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "alert-destinations"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法更新告警目标。", "Could not update destination."));
    },
  });

  const testAlertDispatchMutation = useMutation({
    mutationFn: (input: { alertId: string; destinationId?: string }) =>
      systemApi.testObservabilityAlertDispatch(input.alertId, input.destinationId),
    onSuccess: () => {
      toast.success(localize(locale, "测试告警已发送。", "Test alert dispatched."));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法发送测试告警。", "Could not dispatch test alert."));
    },
  });

  const createSloMutation = useMutation({
    mutationFn: (input: { name: string; target: number; description?: string; complianceWindowDays?: number }) =>
      systemApi.createObservabilitySlo({
        ...input,
        sliMetric: { name: "custom.metric", displayName: input.name, description: input.description ?? "", type: "success_rate", unit: "percent", module: "system" },
      }),
    onSuccess: () => {
      toast.success(localize(locale, "SLO 已创建。", "SLO created."));
      setShowCreateSlo(false);
      void queryClient.invalidateQueries({ queryKey: ["observability", "slos"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法创建 SLO。", "Could not create SLO."));
    },
  });

  const deleteSloMutation = useMutation({
    mutationFn: (input: { sloId: string; etag: string }) =>
      systemApi.deleteObservabilitySlo(input.sloId, input.etag),
    onSuccess: () => {
      toast.success(localize(locale, "SLO 已删除。", "SLO deleted."));
      void queryClient.invalidateQueries({ queryKey: ["observability", "slos"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : localize(locale, "无法删除 SLO。", "Could not delete SLO."));
    },
  });

  const [showCreateDest, setShowCreateDest] = useState(false);
  const [showCreateSlo, setShowCreateSlo] = useState(false);

  const overview = overviewQuery.data;
  const alerts = alertsQuery.data?.items ?? [];
  const issues = issuesQuery.data ?? [];
  const traces = tracesQuery.data?.items ?? [];
  const auditEntries = auditQuery.data?.items ?? [];
  const agentLoopRuns = agentLoopRunsQuery.data ?? [];
  const expertLoopRuns = expertLoopRunsQuery.data ?? [];
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
  const learningOverview = learningOverviewQuery.data;
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
                ? localize(locale, "一个引导恢复正在审批门后等待。", "A guided recovery is waiting behind an approval gate.")
                : highlightedIssue.kind === "failed_fix"
                  ? localize(locale, "Friday 已尝试过有限修复。请先检查回滚证据再重试。", "Friday already tried a bounded repair here. Review the rollback evidence before retrying.")
                  : localize(locale, "检查问题证据，然后进入引导恢复路径。", "Inspect the issue evidence, then move into a guided recovery path."),
            tone: toneForIssueSeverity(highlightedIssue.severity),
          };
        }
        if (highlightedAlert) {
          return {
            title: highlightedAlert.ruleName,
            summary: highlightedAlert.summary,
            detail: localize(locale, "这是最紧急的实时告警。在此确认后，根据需要打开更深的恢复路径。", "This is the sharpest live alert. Acknowledge it here, then open the deeper recovery path if needed."),
            tone: toneForAlert(highlightedAlert.status, highlightedAlert.severity),
          };
        }
        return null;
      case "assistant":
        if (!assistantDiagnostics) {
          return {
            title: localize(locale, "助手诊断加载中", "Assistant diagnostics are loading"),
            summary: localize(locale, "Friday 正在收集任务配置、MCP 服务器状态和近期上下文成本摘要。", "Friday is gathering task profiles, MCP server states, and recent context-cost summaries."),
            detail: localize(locale, "使用此焦点在不离开可观测性页面的情况下检查上下文治理和任务配置选择。", "Use this focus to inspect context governance and task profile choices without leaving observability."),
            tone: "neutral",
          };
        }
        return {
          title: latestAssistantRun?.task ?? localize(locale, "助手诊断", "Assistant diagnostics"),
          summary: latestAssistantRun?.taskProfile
            ? localize(locale, `${latestAssistantRun.taskProfile.label} 配置文件用于最近的助手运行。`, `${latestAssistantRun.taskProfile.label} profile on the latest assistant run.`)
            : localize(locale, "暂无最近的助手运行。", "No recent assistant run is available yet."),
          detail: localize(locale, `MCP 已加载 ${assistantMcpStateCounts.loaded}，延迟 ${assistantMcpStateCounts.deferred}，路径规则 ${pathRuleCount}。`, `MCP loaded ${assistantMcpStateCounts.loaded}, deferred ${assistantMcpStateCounts.deferred}, path rules ${pathRuleCount}.`),
          tone: assistantMcpStateCounts.deferred > 0 || pathRuleCount > 0 ? "warning" : "success",
        };
      case "health":
        if (!highlightedHealthComponent) return null;
        return {
          title: highlightedHealthComponent.name,
          summary: highlightedHealthComponent.message ?? localize(locale, "此组件是当前主要健康关注点。", "This component is currently the main health concern."),
          detail: localize(locale, `模块 ${highlightedHealthComponent.module} 状态为 ${highlightedHealthComponent.status}。`, `Module ${highlightedHealthComponent.module} is ${highlightedHealthComponent.status}.`),
          tone: toneForHealth(highlightedHealthComponent.status),
        };
      case "acceptance":
        if (!highlightedAcceptance) return null;
        return {
          title: `${highlightedAcceptance.artifactType} quality gate`,
          summary: highlightedAcceptance.overallVerdict,
          detail: localize(locale, `${highlightedAcceptance.checksFailed} 项检查未通过，目标 ${highlightedAcceptance.artifactUri}。`, `${highlightedAcceptance.checksFailed} checks failed for ${highlightedAcceptance.artifactUri}.`),
          tone: highlightedAcceptance.state === "failed" ? "warning" : "neutral",
        };
      case "retry":
        if (highlightedEscalation) {
          return {
            title: highlightedEscalation.reason,
            summary: localize(locale, `${highlightedEscalation.channel} 升级，类别 ${highlightedEscalation.failureCategory}。`, `${highlightedEscalation.channel} escalation on ${highlightedEscalation.failureCategory}.`),
            detail: highlightedEscalation.acknowledged
              ? localize(locale, "此升级已被确认。", "This escalation has already been acknowledged.")
              : localize(locale, "此升级仍需运维人员决策。", "This escalation still needs an operator decision."),
            tone: highlightedEscalation.acknowledged ? "neutral" : "warning",
          };
        }
        return {
          title: localize(locale, "重试保护", "Retry protection"),
          summary: localize(locale, `${retryCircuitBreakers.filter((item) => item.state !== "closed").length} 个提供商保护处于活跃状态。`, `${retryCircuitBreakers.filter((item) => item.state !== "closed").length} provider protections are active.`),
          detail: localize(locale, "在强制更多重试之前请先检查断路器。", "Review circuit breakers before forcing more retries."),
          tone: retryCircuitBreakers.some((item) => item.state === "open") ? "danger" : "warning",
        };
      case "rules":
        if (rulesAuditLog[0]) {
          return {
            title: `${rulesAuditLog[0].resource} · ${rulesAuditLog[0].action}`,
            summary: localize(locale, `${rulesAuditLog[0].decision} 决策，来自 ${rulesAuditLog[0].ruleId ?? "bundle-eval"}。`, `${rulesAuditLog[0].decision} decision from ${rulesAuditLog[0].ruleId ?? "bundle-eval"}.`),
            detail: localize(locale, "使用此审计记录解释策略为何允许、拒绝或警告。", "Use this audit trail to explain why policy allowed, denied, or warned."),
            tone: rulesAuditLog[0].decision === "deny" ? "danger" : rulesAuditLog[0].decision === "warn" ? "warning" : "success",
          };
        }
        return null;
      case "loop":
        if (!highlightedLoopRun) return null;
        return {
          title: highlightedLoopRun.action?.summary.title ?? highlightedLoopRun.incident?.summary.rootCauseSummary ?? localize(locale, "循环运行", "Loop run"),
          summary: highlightedLoopRun.run.status.replaceAll("_", " "),
          detail:
            highlightedLoopRun.run.haltReason ??
            (highlightedLoopRun.run.verificationPassed === false
              ? localize(locale, "验证失败，Friday 已记录回滚结果。", "Verification failed and Friday recorded the rollback outcome.")
              : localize(locale, "在恢复之前请先检查验证、回滚和教训提取。", "Review verification, rollback, and lesson extraction before resuming.")),
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
          detail: localize(locale, `${traces[0].spanCount} 个 span，耗时 ${formatDurationMs(traces[0].durationMs)}。`, `${traces[0].spanCount} spans over ${formatDurationMs(traces[0].durationMs)}.`),
          tone: traces[0].status === "error" ? "danger" : traces[0].status === "ok" ? "success" : "neutral",
        };
      case "audit":
        if (!auditEntries[0]) return null;
        return {
          title: auditEntries[0].description,
          summary: `${auditEntries[0].actorDisplayName} · ${auditEntries[0].action}`,
          detail: localize(locale, `${auditEntries[0].outcome} 结果，模块 ${auditEntries[0].module}。`, `${auditEntries[0].outcome} outcome in ${auditEntries[0].module}.`),
          tone: auditEntries[0].outcome === "failure" || auditEntries[0].outcome === "error" ? "danger" : auditEntries[0].outcome === "denied" ? "warning" : "success",
        };
      case "overview":
      default:
        return {
          title: localize(locale, "优先处理操作队列", "Work from the action queue first"),
          summary: localize(locale, "Friday 在上方展示最需要行动的问题，原始遥测数据在下方的下钻区域中。", "Friday surfaces the most actionable problems above, then keeps raw telemetry in drill-down sections below."),
          detail: localize(locale, "使用标签和操作卡片直接跳转到需要下一个决策的区域。", "Use the chips and action cards to move directly to the area that needs the next decision."),
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
    locale,
  ]);

  const maxPoint = Math.max(1, ...(series?.points ?? []).map((point) => point.value));

  return (
    <div className="space-y-4">
      <ShellCard
        eyebrow={localize(locale, "操作队列", "Action queue")}
        title={localize(locale, "哪里出了问题，我该点什么", "What is wrong and what should I click next")}
        aside={
          <StatusPill tone={actionQueue.length > 0 ? "warning" : "success"}>
            {actionQueue.length > 0 ? localize(locale, "需要操作", "action needed") : localize(locale, "稳定", "stable")}
          </StatusPill>
        }
      >
        <div className="mb-4 flex gap-2 overflow-x-chips lg:flex-wrap">
          <FocusChip label={localize(locale, "概览", "Overview")} active={focus === "overview"} to={buildObservabilityHref({ focus: "overview" })} />
          <FocusChip label={localize(locale, "助手", "Assistant")} active={focus === "assistant"} to={buildObservabilityHref({ focus: "assistant" })} />
          <FocusChip label={localize(locale, "告警", "Alerts")} active={focus === "alerts"} to={buildObservabilityHref({ focus: "alerts" })} />
          <FocusChip label={localize(locale, "健康", "Health")} active={focus === "health"} to={buildObservabilityHref({ focus: "health" })} />
          <FocusChip label={localize(locale, "验收", "Acceptance")} active={focus === "acceptance"} to={buildObservabilityHref({ focus: "acceptance" })} />
          <FocusChip label={localize(locale, "重试", "Retry")} active={focus === "retry"} to={buildObservabilityHref({ focus: "retry" })} />
          <FocusChip label={localize(locale, "规则", "Rules")} active={focus === "rules"} to={buildObservabilityHref({ focus: "rules" })} />
          <FocusChip label={localize(locale, "循环", "Loop")} active={focus === "loop"} to={buildObservabilityHref({ focus: "loop" })} />
        </div>
        {actionQueue.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {actionQueue.map((item) => (
              <ObservabilityActionCard key={item.id} {...item} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有紧急操作卡片。", "No urgent action cards are open right now.")}</p>
        )}
      </ShellCard>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <ShellCard eyebrow={localize(locale, "当前焦点", "Current focus")} title={formatObservabilityFocusLabel(focus)}>
          {focusSummary ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{focusSummary.title}</p>
                    <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{focusSummary.summary}</p>
                  </div>
                  <StatusPill tone={focusSummary.tone}>{focusSummary.tone}</StatusPill>
                </div>
                <p className="text-xs leading-5 text-[color:var(--color-text-tertiary)]">{focusSummary.detail}</p>
              </div>
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {localize(locale, "Friday 以行动为先展示此页面：先解决上方高亮的问题，需要更深证据时再下钻到追踪、审计和历史。", "Friday keeps this page action-first: solve the highlighted problem here, then drill into traces, audit, and history only when you need the deeper evidence.")}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "此焦点暂无详细信息。", "No detail is available for this focus yet.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "概览", "Overview")} title={localize(locale, "当前运行状态", "Current operational state")}>
          {overview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ObservabilityTile
                  icon={<AlertTriangle className="h-4 w-4" />}
                  label={localize(locale, "活跃告警", "Active alerts")}
                  value={String(overview.alerts.activeAlerts)}
                  detail={overview.alerts.highestSeverity ? localize(locale, `最高严重级别 ${overview.alerts.highestSeverity}`, `Highest severity ${overview.alerts.highestSeverity}`) : localize(locale, "无活跃告警严重级别", "No active alert severity")}
                />
                <ObservabilityTile
                  icon={<HeartPulse className="h-4 w-4" />}
                  label={localize(locale, "健康", "Health")}
                  value={overview.health?.status ?? "unavailable"}
                  detail={overview.health?.message ?? localize(locale, "尚未注册健康检查。", "No health checks registered yet.")}
                />
                <ObservabilityTile
                  icon={<Activity className="h-4 w-4" />}
                  label={localize(locale, "已完成追踪", "Completed traces")}
                  value={String(overview.traces.totalTraces)}
                  detail={localize(locale, `平均耗时 ${formatDurationMs(overview.traces.avgDurationMs)}`, `Average duration ${formatDurationMs(overview.traces.avgDurationMs)}`)}
                />
                <ObservabilityTile
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label={localize(locale, "审计条目", "Audit entries")}
                  value={String(overview.audit.totalEntries)}
                  detail={localize(locale, `${Object.keys(overview.audit.byOutcome).length} 个追踪结果`, `${Object.keys(overview.audit.byOutcome).length} tracked outcomes`)}
                />
              </div>
              <p className="text-xs text-[color:var(--color-text-tertiary)]">
                {localize(locale, `生成于 ${formatTimestamp(overview.generatedAt)}。本页面与 /assistant 保持一致：操作队列优先，遥测数据其次。`, `Generated at ${formatTimestamp(overview.generatedAt)}. This page stays aligned with \`/assistant\`: action queue first, telemetry second.`)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载当前系统状态...", "Loading the current system state...")}</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow={localize(locale, "学习可解释性", "Learning explainability")} title={localize(locale, "教训、路由偏移和候选阻断", "Lessons, route shifts, and blocked candidates")}>
          {learningOverview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ObservabilityTile
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  label={localize(locale, "教训", "Lessons")}
                  value={String(learningOverview.coverage.lessons)}
                  detail={localize(locale, `${learningOverview.coverage.routeAdjustments} 个路由调整可供运维控制`, `${learningOverview.coverage.routeAdjustments} route adjustments available to operator controls`)}
                />
                <ObservabilityTile
                  icon={<RotateCcw className="h-4 w-4" />}
                  label={localize(locale, "近期路由偏移", "Recent route shifts")}
                  value={String(learningOverview.coverage.recentDecisionDiffs)}
                  detail={localize(locale, `${learningOverview.coverage.blockedRoutes} 条阻断路由出现在近期决策追踪中`, `${learningOverview.coverage.blockedRoutes} blocked routes observed in recent decision traces`)}
                />
              </div>
              {learningOverview.recentDecisionDiffs.slice(0, 2).map((record) => (
                <div key={record.runId} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{record.reasonCode ?? "configured"}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{formatTimestamp(record.createdAt)}</p>
                    </div>
                    <StatusPill tone={record.learningAdjusted ? "success" : "warning"}>
                      {record.learningAdjusted ? localize(locale, "选择已变更", "selection changed") : localize(locale, "信号存在", "signals present")}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                    {record.selectedBeforeLearning
                      ? `${record.selectedBeforeLearning.providerId} / ${record.selectedBeforeLearning.model}`
                      : "n/a"} → {record.selectedAfterLearning
                      ? `${record.selectedAfterLearning.providerId} / ${record.selectedAfterLearning.model}`
                      : "n/a"}
                  </p>
                  {record.reasonText ? (
                    <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">{record.reasonText}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载学习概览...", "Learning overview is loading...")}</p>
          )}
        </ShellCard>

        {focus === "overview" || focus === "assistant" ? (
          <ShellCard eyebrow={localize(locale, "助手诊断", "Assistant diagnostics")} title={localize(locale, "上下文治理、MCP 加载和任务配置", "Context governance, MCP loading, and task profiles")}>
            {assistantDiagnostics ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <ObservabilityTile
                    icon={<BellRing className="h-4 w-4" />}
                    label={localize(locale, "MCP 已加载", "MCP loaded")}
                    value={String(assistantMcpStateCounts.loaded)}
                    detail={localize(locale, `${assistantMcpStateCounts.configured} 已配置 · ${assistantMcpStateCounts.discoverable} 可发现`, `${assistantMcpStateCounts.configured} configured · ${assistantMcpStateCounts.discoverable} discoverable`)}
                  />
                  <ObservabilityTile
                    icon={<RotateCcw className="h-4 w-4" />}
                    label={localize(locale, "延迟加载", "Deferred")}
                    value={String(assistantMcpStateCounts.deferred)}
                    detail={localize(locale, "延迟服务器在需要时才会加入默认上下文。", "Deferred servers stay out of the default context until they are needed.")}
                  />
                  <ObservabilityTile
                    icon={<Mail className="h-4 w-4" />}
                    label={localize(locale, "路径规则", "Path rules")}
                    value={String(pathRuleCount)}
                    detail={candidatePaths.length > 0 ? candidatePaths.slice(0, 2).join(" · ") : localize(locale, "暂无路径特定的规则候选。", "No path-specific rule candidates surfaced.")}
                  />
                  <ObservabilityTile
                    icon={<Activity className="h-4 w-4" />}
                    label={localize(locale, "预处理器", "Preprocessors")}
                    value={String(assistantDiagnostics.supportedPreprocessors.length)}
                    detail={assistantDiagnostics.supportedPreprocessors.join(", ")}
                  />
                </div>
                {latestAssistantRun ? (
                  <div className="agent-subcard p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-[color:var(--color-text-primary)]">{latestAssistantRun.task}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">
                          {summarizeRunContext(latestAssistantRun, "en")
                            ?? `${latestAssistantRun.taskProfile?.label ?? "No task profile"} · ${labelForRunHealth(latestAssistantRun, "en")}`}
                        </p>
                      </div>
                      <StatusPill tone={toneForRunHealth(latestAssistantRun)}>
                        {labelForRunHealth(latestAssistantRun, "en")}
                      </StatusPill>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
                      <p>{describeRunHealth(latestAssistantRun, "en")}</p>
                      <p>{localize(locale, "工作区上下文", "Workspace context")}: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "workspace_context")?.estimatedChars ?? 0} {localize(locale, "字符", "chars")}</p>
                      <p>{localize(locale, "初始技能", "Starter skills")}: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "starter_skills")?.estimatedChars ?? 0} {localize(locale, "字符", "chars")}</p>
                      <p>MCP: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "mcp")?.estimatedChars ?? 0} {localize(locale, "字符", "chars")}</p>
                      <p>{localize(locale, "子代理", "Subagents")}: {latestAssistantRun.contextCostSummary?.components.find((item) => item.kind === "subagents")?.estimatedChars ?? 0} {localize(locale, "字符", "chars")}</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "尚未记录最近的助手运行。", "No recent assistant runs have been recorded yet.")}</p>
                )}
                <div className="space-y-3">
                  {(assistantDiagnostics.mcpServerStates ?? []).length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "此运行时未配置 MCP 服务器。", "No MCP servers are configured for this runtime.")}</p>
                  ) : (
                    assistantDiagnostics.mcpServerStates.map((state) => (
                      <div key={state.serverId} className="agent-subcard p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium text-[color:var(--color-text-primary)]">{state.serverId}</p>
                            <p className="text-xs text-[color:var(--color-text-tertiary)]">
                              {state.transport} · {state.lazyDiscovery ? localize(locale, "延迟发现", "lazy discovery") : localize(locale, "即时发现", "eager discovery")}
                            </p>
                          </div>
                          <StatusPill tone={state.state === "loaded" ? "success" : state.state === "deferred" ? "warning" : "neutral"}>
                            {state.state}
                          </StatusPill>
                        </div>
                        <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
                          {localize(locale, "工具", "Tools")} {state.toolCount ?? 0} · {localize(locale, "资源", "Resources")} {state.resourceCount ?? 0} · {localize(locale, "提示", "Prompts")} {state.promptCount ?? 0}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载助手诊断...", "Loading assistant diagnostics...")}</p>
            )}
          </ShellCard>
        ) : null}

        <ShellCard eyebrow={localize(locale, "实时告警", "Live alerts")} title={localize(locale, "调查、确认或移交引导恢复", "Investigate, acknowledge, or hand off to guided recovery")}>
          {alerts.length > 0 ? (
            <div className="space-y-3">
              {alerts.slice(0, 6).map((alert) => (
                <div key={alert.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{alert.summary}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{alert.ruleName} · {alert.module}</p>
                    </div>
                    <StatusPill tone={toneForAlert(alert.status, alert.severity)}>
                      {alert.severity} · {alert.status}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "检测于", "Detected")} {formatTimestamp(alert.detectedAt)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]" to={buildObservabilityHref({ focus: "alerts", alertId: alert.id })}>
                      {localize(locale, "调查", "Investigate")}
                    </Link>
                    <Link className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]" to="/assistant">
                      {localize(locale, "打开引导恢复", "Open guided recovery")}
                    </Link>
                    {alert.status !== "acknowledged" && alert.status !== "resolved" ? (
                      <button
                        className="inline-flex items-center rounded-2xl bg-[color:var(--color-accent-soft)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={acknowledgeAlertMutation.isPending}
                        onClick={() =>
                          acknowledgeAlertMutation.mutate({
                            alertId: alert.id,
                            note: "Acknowledged from observability action queue.",
                          })}
                        type="button"
                      >
                        {localize(locale, "确认", "Acknowledge")}
                      </button>
                    ) : null}
                    <button
                      className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={testAlertDispatchMutation.isPending}
                      onClick={() => testAlertDispatchMutation.mutate({ alertId: alert.id })}
                      type="button"
                    >
                      {localize(locale, "测试分发", "Test dispatch")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有活跃告警。", "No active alerts are firing right now.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "引导问题", "Guided issues")} title={localize(locale, "映射回助手的问题", "Problems that map back to the assistant")}>
          {issues.length > 0 ? (
            <div className="space-y-3">
              {issues.slice(0, 6).map((issue) => (
                <div key={issue.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{issue.title}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{issue.kind.replaceAll("_", " ")}</p>
                    </div>
                    <StatusPill tone={toneForIssueSeverity(issue.severity)}>
                      {issue.severity}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{issue.summary}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className="inline-flex items-center rounded-2xl bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]" to={buildObservabilityHref({ focus: "alerts", issueId: issue.id })}>
                      {localize(locale, "检查证据", "Inspect evidence")}
                    </Link>
                    <Link className="inline-flex items-center rounded-2xl bg-[color:var(--color-accent-soft)] px-4 py-2 text-sm text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]" to="/assistant">
                      {localize(locale, "在助手中继续", "Continue in assistant")}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有打开的引导问题。", "No guided issues are open right now.")}</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow={localize(locale, "验收与重试", "Acceptance and retry")} title={localize(locale, "质量门控和重试压力", "Quality gates and retry pressure")}>
          {acceptanceResults.length > 0 || retryEscalations.length > 0 || retryCircuitBreakers.length > 0 ? (
            <div className="space-y-3">
              <ObservabilityTile
                icon={<ShieldCheck className="h-4 w-4" />}
                label={localize(locale, "验收失败", "Failed acceptance")}
                value={String(acceptanceResults.filter((run) => run.state === "failed").length)}
                detail={localize(locale, `${acceptanceTests.filter((test) => test.enabled).length} 个质量门控已启用`, `${acceptanceTests.filter((test) => test.enabled).length} quality gates enabled`)}
              />
              <ObservabilityTile
                icon={<TimerReset className="h-4 w-4" />}
                label={localize(locale, "重试升级", "Retry escalations")}
                value={String(retryEscalations.filter((item) => !item.acknowledged).length)}
                detail={localize(locale, `${retryCircuitBreakers.filter((item) => item.state !== "closed").length} 个未关闭的断路器`, `${retryCircuitBreakers.filter((item) => item.state !== "closed").length} non-closed circuit breakers`)}
              />
              {retryCostSummary ? (
                <div className="agent-detail-note p-4 text-xs text-[color:var(--color-text-tertiary)]">
                  <p>{localize(locale, "总重试记录", "Total retry records")}: {retryCostSummary.summary.recordCount}</p>
                  <p>{localize(locale, "预算超出", "Budget exceeded")}: {retryCostSummary.summary.budgetExceeded ? localize(locale, "是", "yes") : localize(locale, "否", "no")}</p>
                  <p>{localize(locale, "Token 成本", "Token cost")}: {retryCostSummary.summary.totalCost.tokens}</p>
                </div>
              ) : null}
              {retryEscalations.slice(0, 3).map((escalation) => (
                <div key={escalation.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{escalation.reason}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{escalation.channel} · {escalation.failureCategory}</p>
                    </div>
                    <StatusPill tone={escalation.acknowledged ? "success" : "warning"}>
                      {escalation.acknowledged ? localize(locale, "已确认", "acknowledged") : localize(locale, "待处理", "open")}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有验收或重试压力。", "No acceptance or retry pressure is active right now.")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "Agent 循环与规则", "Agent loop and rules")} title={localize(locale, "自主恢复和策略状态", "Autonomous recovery and policy state")}>
          {agentLoopRuns.length > 0 || expertLoopRuns.length > 0 || rulesAuditLog.length > 0 ? (
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
              {expertLoopRuns.length > 0 && (
                <div className="border-t border-[color:var(--color-border-soft)] pt-3">
                  <p className="mb-2 text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "专家模式运行", "Expert mode runs")}</p>
                  {expertLoopRuns.slice(0, 3).map((record) => (
                    <LoopRunCard
                      key={record.run.loopRunId}
                      record={record}
                      onResume={(id) => resumeLoopRunMutation.mutate(id)}
                      onCancel={(id) => cancelLoopRunMutation.mutate(id)}
                      resumePending={resumeLoopRunMutation.isPending}
                      cancelPending={cancelLoopRunMutation.isPending}
                    />
                  ))}
                </div>
              )}
              {rulesAuditLog.slice(0, 3).map((entry) => (
                <div key={entry.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{entry.resource} · {entry.action}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{entry.ruleId ?? "bundle-eval"}</p>
                    </div>
                    <StatusPill tone={entry.decision === "allow" ? "success" : entry.decision === "warn" ? "warning" : "danger"}>
                      {entry.decision}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当前没有需要关注的循环或规则事件。", "No loop or rules events need attention right now.")}</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard eyebrow={localize(locale, "时间序列", "Time series")} title={localize(locale, "确定检查目标后的趋势上下文", "Trend context after you know what to inspect")}>
          {series ? (
            <div className="space-y-3">
              <div className="grid gap-2">
                {series.points.map((point) => (
                  <div key={point.timestamp} className="grid grid-cols-[104px_1fr_48px] items-center gap-3 text-xs text-[color:var(--color-text-secondary)]">
                    <span>{new Date(point.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <div className="h-2 rounded-full bg-[color:var(--color-bg-surface-strong)]">
                      <div
                        className="h-2 rounded-full bg-[color:var(--color-accent)]"
                        style={{ width: `${Math.max(4, (point.value / maxPoint) * 100)}%` }}
                      />
                    </div>
                    <span className="text-right text-[color:var(--color-text-primary)]">{point.value}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[color:var(--color-text-tertiary)]">
                {localize(locale, "指标", "Metric")}: {series.metricName} · {localize(locale, "桶大小", "Bucket")} {series.bucketSize}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "正在加载时间序列数据...", "Loading time-series data...")}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "深度证据", "Deep evidence")} title={localize(locale, "追踪和审计作为下钻入口保持可用", "Traces and audit stay available as drill-down")}>
          {traces.length > 0 || auditEntries.length > 0 ? (
            <div className="space-y-3">
              {traces.slice(0, 3).map((trace) => (
                <div key={trace.traceId} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{trace.name}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{trace.module} · {trace.traceId}</p>
                    </div>
                    <StatusPill tone={trace.status === "error" ? "danger" : trace.status === "ok" ? "success" : "neutral"}>
                      {trace.status}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">{trace.spanCount} spans · {formatDurationMs(trace.durationMs)}</p>
                </div>
              ))}
              {auditEntries.slice(0, 3).map((entry) => (
                <div key={entry.id} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">{entry.description}</p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">{entry.action} · {entry.resourceType}</p>
                    </div>
                    <StatusPill tone={entry.outcome === "success" ? "success" : entry.outcome === "failure" ? "danger" : "warning"}>
                      {entry.outcome}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">{entry.actorDisplayName} · {formatTimestamp(entry.recordedAt)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "当系统有更多历史记录时，追踪和审计证据将显示在此处。", "Trace and audit evidence will appear here when the system has more history.")}</p>
          )}
        </ShellCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <ShellCard
          eyebrow={localize(locale, "SLO 包", "SLO pack")}
          title={localize(locale, "服务等级状态", "Service level state")}
          aside={
            <ActionButton tone="secondary" onClick={() => setShowCreateSlo(!showCreateSlo)}>
              <Plus className="mr-1.5 h-3 w-3" />
              {localize(locale, "添加 SLO", "Add SLO")}
            </ActionButton>
          }
        >
          {showCreateSlo && (
            <CreateSloForm
              onSubmit={(input) => createSloMutation.mutate(input)}
              pending={createSloMutation.isPending}
              onCancel={() => setShowCreateSlo(false)}
            />
          )}
          {slos.length > 0 ? (
            <div className="space-y-3">
              {slos.map((slo) => (
                <SloCard
                  key={slo.id}
                  slo={slo}
                  onDelete={(id, etag) => { if (window.confirm("确认删除此 SLO？")) deleteSloMutation.mutate({ sloId: id, etag }); }}
                  deletePending={deleteSloMutation.isPending}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "尚未配置 SLO 定义。点击\"添加 SLO\"创建一个。", "No SLO definitions are configured yet. Click \"Add SLO\" to create one.")}</p>
          )}
        </ShellCard>

        <ShellCard
          eyebrow={localize(locale, "告警路由", "Alert routing")}
          title={localize(locale, "Friday 升级时谁会被通知", "Who gets notified when Friday escalates")}
          aside={
            <ActionButton tone="secondary" onClick={() => setShowCreateDest(!showCreateDest)}>
              <Plus className="mr-1.5 h-3 w-3" />
              {localize(locale, "添加目标", "Add destination")}
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
                      <div className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-2 text-[color:var(--color-text-secondary)]">
                        {destination.type === "slack" ? <BellRing className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-[color:var(--color-text-primary)]">{destination.name}</p>
                        <p className="text-xs text-[color:var(--color-text-tertiary)]">{destination.type}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${destination.enabled ? "bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]" : "bg-[color:var(--color-bg-surface)] text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-surface)]"}`}
                        disabled={updateDestinationMutation.isPending}
                        onClick={() => updateDestinationMutation.mutate({ id: destination.id, enabled: !destination.enabled })}
                      >
                        {destination.enabled ? localize(locale, "已启用", "enabled") : localize(locale, "已禁用", "disabled")}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg p-1.5 text-[color:var(--color-text-faint)] transition hover:bg-[color:var(--color-bg-surface)] hover:text-[color:var(--color-text-primary)]"
                        disabled={deleteDestinationMutation.isPending}
                        onClick={() => { if (window.confirm("确认删除此告警目标？")) deleteDestinationMutation.mutate(destination.id); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : !showCreateDest ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{localize(locale, "尚未配置告警目标。", "No alert destinations are configured yet.")}</p>
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
  const { locale } = useAppLocale();
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
          <p className="font-medium text-[color:var(--color-text-primary)]">{record.action?.summary.title ?? record.incident?.summary.rootCauseSummary ?? localize(locale, "循环运行", "Loop run")}</p>
          <p className="text-xs text-[color:var(--color-text-tertiary)]">{record.run.loopRunId}</p>
        </div>
        <StatusPill tone={record.run.status === "verified" ? "success" : record.run.status === "halted" ? "warning" : "neutral"}>
          {record.run.status.replaceAll("_", " ")}
        </StatusPill>
      </div>
      <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
        {localize(locale, "验证", "Verification")}: {record.run.verificationPassed === undefined ? localize(locale, "待定", "pending") : record.run.verificationPassed ? localize(locale, "通过", "passed") : localize(locale, "失败", "failed")} ·
        {localize(locale, "回滚", "Rollback")}: {record.run.rollbackAttempted ? (record.run.rollbackSucceeded ? localize(locale, " 成功", " succeeded") : localize(locale, " 已尝试", " attempted")) : localize(locale, " 不需要", " not needed")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {record.run.status === "paused" ? (
          <ActionButton tone="secondary" disabled={props.resumePending} onClick={() => props.onResume(record.run.loopRunId)}>
            <Play className="mr-1.5 h-3 w-3" />{localize(locale, "恢复", "Resume")}
          </ActionButton>
        ) : null}
        {record.run.status === "running" || record.run.status === "paused" ? (
          <ActionButton tone="secondary" disabled={props.cancelPending} onClick={() => props.onCancel(record.run.loopRunId)}>
            <Square className="mr-1.5 h-3 w-3" />{localize(locale, "取消", "Cancel")}
          </ActionButton>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs font-medium text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
        >
          <ChevronRight className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`} />
          {expanded ? localize(locale, "收起", "Less") : localize(locale, "详情", "Detail")}
        </button>
      </div>
      {expanded && detailQuery.data ? (
        <div className="mt-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3 text-xs text-[color:var(--color-text-tertiary)] space-y-1">
          <p>{localize(locale, "风险等级", "Risk tier")}: {detailQuery.data.run.riskTier}</p>
          <p>{localize(locale, "尝试次数", "Attempt")}: {detailQuery.data.run.attemptNumber}</p>
          <p>{localize(locale, "需要审批", "Approval required")}: {detailQuery.data.run.approvalRequired ? localize(locale, "是", "yes") : localize(locale, "否", "no")}</p>
          {detailQuery.data.run.haltReason ? <p>{localize(locale, "停止原因", "Halt reason")}: {detailQuery.data.run.haltReason}</p> : null}
          {detailQuery.data.run.lastError ? <p>{localize(locale, "最后错误", "Last error")}: {detailQuery.data.run.lastError}</p> : null}
          {detailQuery.data.run.correlationId ? <p>{localize(locale, "关联 ID", "Correlation")}: {detailQuery.data.run.correlationId}</p> : null}
        </div>
      ) : expanded && detailQuery.isLoading ? (
        <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">{localize(locale, "加载中...", "Loading...")}</p>
      ) : null}
    </div>
  );
}

function CreateDestinationForm(props: {
  onSubmit: (input: { type: "slack"; name: string; webhookUrl: string }) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const { locale } = useAppLocale();
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  return (
    <div className="mb-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">{localize(locale, "新建 Slack 目标", "New Slack destination")}</p>
      <input
        className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
        placeholder={localize(locale, "名称", "Name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
        placeholder={localize(locale, "Webhook 地址", "Webhook URL")}
        value={webhookUrl}
        onChange={(e) => setWebhookUrl(e.target.value)}
      />
      <div className="flex gap-2">
        <ActionButton disabled={props.pending || !name.trim() || !webhookUrl.trim()} onClick={() => props.onSubmit({ type: "slack", name: name.trim(), webhookUrl: webhookUrl.trim() })}>
          {localize(locale, "创建", "Create")}
        </ActionButton>
        <ActionButton tone="secondary" onClick={props.onCancel}>{localize(locale, "取消", "Cancel")}</ActionButton>
      </div>
    </div>
  );
}

function SloCard(props: {
  slo: Awaited<ReturnType<typeof systemApi.listObservabilitySlos>>[number];
  onDelete: (sloId: string, etag: string) => void;
  deletePending: boolean;
}) {
  const { locale } = useAppLocale();
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
          <p className="truncate font-medium text-[color:var(--color-text-primary)]">{slo.name}</p>
          <p className="text-xs text-[color:var(--color-text-tertiary)]">{slo.sliMetricName}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={slo.status === "healthy" ? "success" : slo.status === "warning" ? "warning" : "danger"}>
            {slo.status}
          </StatusPill>
          {detailQuery.data?.slo.etag && (
            <button
              type="button"
              className="rounded-lg p-1.5 text-[color:var(--color-text-faint)] transition hover:bg-[color:var(--color-bg-surface)] hover:text-[color:var(--color-text-primary)]"
              disabled={props.deletePending}
              onClick={() => props.onDelete(slo.id, detailQuery.data!.slo.etag)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)]">
        <p>{localize(locale, "目标", "Target")}: {slo.target}%</p>
        <p>{localize(locale, "当前值", "Current value")}: {slo.currentValue?.toFixed(2) ?? "n/a"}%</p>
        <p>{localize(locale, "预算已消耗", "Budget consumed")}: {slo.budgetConsumedPercent?.toFixed(2) ?? "0"}%</p>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-3 flex items-center gap-1 text-xs font-medium text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
      >
        <ChevronRight className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`} />
        {expanded ? localize(locale, "隐藏详情", "Hide detail") : localize(locale, "显示详情", "Show detail")}
      </button>
      {expanded && detailQuery.data ? (
        <div className="mt-3 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3 text-xs text-[color:var(--color-text-tertiary)]">
          <div className="grid gap-2">
            {detailQuery.data.slo.description ? <p>{detailQuery.data.slo.description}</p> : null}
            <p>{localize(locale, "合规窗口", "Compliance window")}: {detailQuery.data.slo.complianceWindowDays} {localize(locale, "天", "days")}</p>
            {detailQuery.data.errorBudget ? (
              <>
                <p>{localize(locale, "剩余错误预算", "Error budget remaining")}: {detailQuery.data.errorBudget.remainingBudgetPercent.toFixed(2)}%</p>
                <p>{localize(locale, "预算已耗尽", "Budget exhausted")}: {detailQuery.data.errorBudget.exhausted ? localize(locale, "是", "Yes") : localize(locale, "否", "No")}</p>
                <p>{localize(locale, "窗口", "Window")}: {new Date(detailQuery.data.errorBudget.windowStart).toLocaleDateString()} – {new Date(detailQuery.data.errorBudget.windowEnd).toLocaleDateString()}</p>
              </>
            ) : null}
            {detailQuery.data.burnRates.length > 0 ? (
              <div>
                <p className="font-medium text-[color:var(--color-text-secondary)]">{localize(locale, "消耗速率:", "Burn rates:")}</p>
                {detailQuery.data.burnRates.map((rate) => (
                  <p key={rate.windowLabel}>{rate.windowLabel}: {rate.rate.toFixed(2)}x</p>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : expanded && detailQuery.isLoading ? (
        <p className="mt-3 text-xs text-[color:var(--color-text-faint)]">{localize(locale, "加载中...", "Loading...")}</p>
      ) : null}
    </div>
  );
}

function CreateSloForm(props: {
  onSubmit: (input: { name: string; target: number; description?: string; complianceWindowDays?: number }) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const { locale } = useAppLocale();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("99.5");
  const [description, setDescription] = useState("");
  const [windowDays, setWindowDays] = useState("30");

  const canSubmit = name.trim().length > 0 && Number(target) > 0 && Number(target) <= 100;

  return (
    <div className="mb-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] p-4 space-y-3">
      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{localize(locale, "创建 SLO", "Create SLO")}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "名称", "Name")}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={localize(locale, "例如 API 可用性", "e.g. API Availability")} className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-border-strong)] focus:outline-none" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "目标 (%)", "Target (%)")}</label>
          <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} min={0} max={100} step={0.1} className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] focus:border-[color:var(--color-border-strong)] focus:outline-none" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "描述", "Description")}</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={localize(locale, "可选", "Optional")} className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-faint)] focus:border-[color:var(--color-border-strong)] focus:outline-none" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "合规窗口（天）", "Compliance window (days)")}</label>
          <input type="number" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} min={1} max={365} className="w-full rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface-strong)] px-3 py-2 text-sm text-[color:var(--color-text-primary)] focus:border-[color:var(--color-border-strong)] focus:outline-none" />
        </div>
      </div>
      <div className="flex gap-2">
        <ActionButton
          disabled={!canSubmit || props.pending}
          onClick={() => props.onSubmit({
            name: name.trim(),
            target: Number(target),
            description: description.trim() || undefined,
            complianceWindowDays: Number(windowDays) || undefined,
          })}
        >
          {props.pending ? localize(locale, "创建中...", "Creating...") : localize(locale, "创建", "Create")}
        </ActionButton>
        <ActionButton tone="secondary" onClick={props.onCancel}>{localize(locale, "取消", "Cancel")}</ActionButton>
      </div>
    </div>
  );
}
