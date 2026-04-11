import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, HeartPulse, Link2, RadioTower, ShieldCheck, Workflow } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { ActionButton, ConfirmDialog, ShellCard, SkeletonCard, SkeletonList, StatusPill } from "@/components/core/primitives";
import { HelpTooltip } from "@/components/core/help-tooltip";
import { localize, type AppLocale } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import { fleetApi } from "@/lib/api/fleet";
import { systemApi } from "@/lib/api/system";
import {
  buildFleetHref,
  buildFleetRecoverySteps,
  buildFleetRuntimeRecoveryCard,
  formatFleetHeartbeatAge,
  formatFleetTimestamp,
  type FridayFleetFocus,
  toneForFleetHealth,
  toneForFleetPairing,
  toneForFleetTrust,
} from "@/lib/fleet/view-models";

function toneForLoopRun(record: {
  run: { status: string; verificationPassed?: boolean };
}): "neutral" | "success" | "warning" | "danger" {
  if (record.run.status === "verified") return "success";
  if (record.run.status === "awaiting_approval" || record.run.status === "paused" || record.run.status === "cooldown") {
    return "warning";
  }
  if (record.run.status === "failed" || record.run.status === "halted" || record.run.verificationPassed === false) {
    return "danger";
  }
  return "neutral";
}

function FleetMetricCard(props: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="agent-metric-card">
      <div className="flex items-center justify-between gap-3">
        <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2 text-[color:var(--color-text-primary)]">
          {props.icon}
        </div>
        <p className="text-2xl font-semibold text-[color:var(--color-text-primary)]">{props.value}</p>
      </div>
      <p className="mt-3 text-sm font-medium text-[color:var(--color-text-primary)]">{props.label}</p>
      <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-tertiary)]">{props.detail}</p>
    </div>
  );
}

export function FleetPage() {
  const { locale } = useAppLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSatelliteId, setSelectedSatelliteId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const requestedSatelliteId = searchParams.get("satelliteId");
  const requestedFocus = searchParams.get("focus");
  const focus: FridayFleetFocus =
    requestedFocus === "recovery" || requestedFocus === "queue" || requestedFocus === "trust"
      ? requestedFocus
      : "details";

  const overviewQuery = useQuery({
    queryKey: ["fleet", "overview"],
    queryFn: () => fleetApi.getOverview(),
    refetchInterval: 15_000,
  });

  const satellitesQuery = useQuery({
    queryKey: ["fleet", "satellites"],
    queryFn: () => fleetApi.listSatellites({ limit: 50 }),
    refetchInterval: 15_000,
  });

  const satellites = satellitesQuery.data?.items ?? [];

  const pairingQuery = useQuery({
    queryKey: ["fleet", "pairing-requests"],
    queryFn: () => fleetApi.listPairingRequests(),
    refetchInterval: 10_000,
  });
  const pendingPairings = useMemo(() => pairingQuery.data ?? [], [pairingQuery.data]);
  const [pairingToApprove, setPairingToApprove] = useState<string | null>(null);
  const approvePairingMutation = useMutation({
    mutationFn: (satelliteId: string) => fleetApi.approvePairing(satelliteId),
    onSuccess: () => {
      setPairingToApprove(null);
      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
    },
  });
  const loopRunsQuery = useQuery({
    queryKey: ["fleet", "loop-runs"],
    queryFn: () => systemApi.listAgentLoopRuns({ limit: 12 }),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (requestedSatelliteId && satellites.some((entry) => entry.satelliteId === requestedSatelliteId)) {
      if (requestedSatelliteId !== selectedSatelliteId) {
        setSelectedSatelliteId(requestedSatelliteId);
      }
      return;
    }

    if (!selectedSatelliteId && satellites.length > 0) {
      const nextSatelliteId = satellites[0]!.satelliteId;
      setSelectedSatelliteId(nextSatelliteId);
      setSearchParams(new URLSearchParams(buildFleetHref(nextSatelliteId, focus).replace("/fleet?", "")), { replace: true });
    }
  }, [focus, requestedSatelliteId, selectedSatelliteId, setSearchParams, satellites]);

  const handleSelectSatellite = (satelliteId: string) => {
    setSelectedSatelliteId(satelliteId);
    setSearchParams(new URLSearchParams(buildFleetHref(satelliteId, focus).replace("/fleet?", "")), { replace: false });
  };

  const selectedSatellite = satellites.find((entry) => entry.satelliteId === selectedSatelliteId);

  const detailQuery = useQuery({
    queryKey: ["fleet", "detail", selectedSatelliteId],
    queryFn: () => fleetApi.getSatellite(selectedSatelliteId!),
    enabled: selectedSatelliteId !== null,
    refetchInterval: 15_000,
  });
  const remediationMutation = useMutation({
    mutationFn: async (input: { satelliteId: string; actionId: string }) =>
      fleetApi.executeSatelliteRemediationAction(input.satelliteId, input.actionId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["fleet", "overview"] }),
        queryClient.invalidateQueries({ queryKey: ["fleet", "satellites"] }),
        queryClient.invalidateQueries({ queryKey: ["fleet", "detail", selectedSatelliteId] }),
      ]);
    },
  });

  const overview = overviewQuery.data;
  const detail = detailQuery.data;
  const recoverySteps = buildFleetRecoverySteps(detail ?? null);
  const runtimeRecoveryCard = buildFleetRuntimeRecoveryCard(detail ?? null);
  const fleetLoopRuns = (loopRunsQuery.data ?? []).filter((record) => {
    const summary = `${record.action?.summary.title ?? ""} ${record.incident?.summary.rootCauseSummary ?? ""}`.toLowerCase();
    return summary.includes("satellite") || summary.includes("fleet");
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="space-y-4">
        <ShellCard
          eyebrow={localize(locale, "助手引导", "Assistant Handoff")}
          title={localize(locale, "通过引导操作恢复降级节点", "Recover degraded nodes with guided actions")}
          aside={
            overview ? (
              <StatusPill tone={overview.totals.degraded > 0 ? "warning" : "success"}>
                {overview.totals.degraded > 0 ? (locale === "zh" ? "需要关注" : "needs attention") : (locale === "zh" ? "稳定" : "stable")}
              </StatusPill>
            ) : undefined
          }
        >
          {overview ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <p>
                {locale === "zh"
                  ? "Friday 使用此页面作为深度集群控制台，在助手已发现节点、队列或部署问题之后。从下方降级或阻塞的卫星节点开始，然后使用恢复循环和节点详情面板检查下一个安全操作。"
                  : "Friday uses this page as the deep fleet console after Assistant has already found a node, queue, or placement issue. Start from the degraded or blocked satellite below, then use the recovery loop and node detail panels to inspect the next safe action."}
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <FleetMetricCard
                  icon={<RadioTower className="h-4 w-4" />}
                  label={locale === "zh" ? "需要恢复" : "Needs recovery"}
                  value={String(overview.totals.degraded)}
                  detail={`${overview.totals.online} ${locale === "zh" ? "在线" : "online"} / ${overview.totals.satellites} ${locale === "zh" ? "总计" : "total"}`}
                />
                <FleetMetricCard
                  icon={<Link2 className="h-4 w-4" />}
                  label={localize(locale, "阻塞任务", "Blocked work")}
                  value={String(overview.queue.deadLetter + overview.queue.failed)}
                  detail={`${overview.queue.queued + overview.queue.leased} ${locale === "zh" ? "排队中或已分配" : "queued or leased"}`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label={localize(locale, "恢复循环", "Recovery loops")}
                  value={String(fleetLoopRuns.length)}
                  detail={locale === "zh" ? "活跃或近期的修复运行" : "Active or recent remediation runs"}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "正在加载集群引导..." : "Loading fleet guidance..."}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "设备集群控制台", "Fleet Control Plane")} title={<><HelpTooltip term="fleet" /> — {localize(locale, "分布式执行概览", "distributed execution overview")}</>}>
          {overview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <FleetMetricCard
                  icon={<RadioTower className="h-4 w-4" />}
                  label={localize(locale, "在线节点", "Online satellites")}
                  value={String(overview.totals.online)}
                  detail={`${overview.totals.satellites} ${locale === "zh" ? "已注册" : "registered"} · ${overview.totals.degraded} ${locale === "zh" ? "降级" : "degraded"}`}
                />
                <FleetMetricCard
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label={locale === "zh" ? "信任状态" : "Trust posture"}
                  value={`${overview.trust.averageScore}`}
                  detail={`${overview.trust.lowTrustCount} ${locale === "zh" ? "低信任" : "low-trust"} · ${overview.trust.restrictedCount} ${locale === "zh" ? "受限" : "restricted"}`}
                />
                <FleetMetricCard
                  icon={<Link2 className="h-4 w-4" />}
                  label={locale === "zh" ? "队列积压" : "Queue backlog"}
                  value={String(overview.queue.queued + overview.queue.leased)}
                  detail={`${overview.queue.deadLetter} ${locale === "zh" ? "死信" : "dead letters"} · ${overview.queue.failed} ${locale === "zh" ? "失败" : "failed"}`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label={locale === "zh" ? "工作流压力" : "Workflow pressure"}
                  value={String(overview.workflows.activeRuns)}
                  detail={`${overview.workflows.completed1h} ${locale === "zh" ? "已完成" : "completed"} / ${overview.workflows.failed1h} ${locale === "zh" ? "失败 (1小时内)" : "failed in 1h"}`}
                />
              </div>
              <div className="agent-detail-note p-4 text-sm text-[color:var(--color-text-secondary)]">
                {locale === "zh" ? "集群健康状态为" : "Fleet health is"} <span className="font-medium text-[color:var(--color-text-primary)]">{overview.health.state}</span> {locale === "zh" ? "得分" : "with score"}{" "}
                <span className="font-medium text-[color:var(--color-text-primary)]">{overview.health.score}</span>{locale === "zh" ? "。原因：" : ". Reasons:"}{" "}
                {overview.health.reasons.length > 0 ? overview.health.reasons.join(" · ") : (locale === "zh" ? "无活跃问题。" : "No active concerns.")}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "正在加载集群概览..." : "Loading fleet overview..."}</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "卫星节点", "Satellites")} title={<>{localize(locale, "选择一个", "Choose a ")} <HelpTooltip term="satellite" /> {localize(locale, "查看或恢复", "to inspect or recover")}</>}>
          {pendingPairings.length > 0 && (
            <div className="mb-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-text-tertiary)]">{localize(locale, "待配对", "Pending Pairing")}</p>
              {pendingPairings.map((req) => (
                <div key={req.satelliteId} className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{req.displayName ?? req.satelliteId}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{localize(locale, "等待批准配对", "Waiting for pairing approval")}</p>
                  </div>
                  <ActionButton className="!min-h-[36px] !px-3 !text-xs" onClick={() => setPairingToApprove(req.satelliteId)} disabled={approvePairingMutation.isPending}>
                    {localize(locale, "批准配对", "Approve")}
                  </ActionButton>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-3">
            {satellites.map((satellite) => (
              <button
                key={satellite.satelliteId}
                type="button"
                onClick={() => handleSelectSatellite(satellite.satelliteId)}
                className="agent-selection-card"
                data-active={satellite.satelliteId === selectedSatelliteId}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-[color:var(--color-text-primary)]">{satellite.displayName}</p>
                    <p className="text-xs text-[color:var(--color-text-tertiary)]">{satellite.satelliteId}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <StatusPill tone={toneForFleetPairing(satellite.pairingStatus)}>{satellite.pairingStatus}</StatusPill>
                    <StatusPill tone={toneForFleetTrust(satellite.trustLevel)}>{satellite.trustLevel}</StatusPill>
                    <StatusPill tone={toneForFleetHealth(satellite.healthState)}>{satellite.healthState}</StatusPill>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)] sm:grid-cols-2">
                  <p>{locale === "zh" ? "最后活跃：" : "Last seen:"} {formatFleetTimestamp(satellite.lastSeenAt)}</p>
                  <p>{locale === "zh" ? "心跳：" : "Heartbeat:"} {formatFleetHeartbeatAge(satellite.heartbeatAgeMs)}</p>
                  <p>{locale === "zh" ? "队列深度：" : "Queue depth:"} {satellite.queueDepth ?? 0}</p>
                  <p>{locale === "zh" ? "活跃运行：" : "Active runs:"} {satellite.activeRuns ?? 0}</p>
                </div>
                {satellite.alerts.length > 0 ? (
                  <p className="mt-3 text-xs text-[color:var(--color-text-primary)]">{satellite.alerts.join(" · ")}</p>
                ) : null}
              </button>
            ))}
            {satellites.length === 0 ? (
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>{localize(locale, "暂无卫星节点注册。", "No satellites have registered yet.")}</p>
                <p>{locale === "zh" ? "Friday 可以帮你设置远程设备以扩展自动化范围。" : "Friday can help you set up remote devices to extend your automation reach."}</p>
                <Link to="/chat" className="inline-flex items-center rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent-strong)]">{localize(locale, "在聊天中了解更多", "Learn more in Chat")}</Link>
              </div>
            ) : null}
          </div>
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "恢复循环", "Recovery Loop")} title={localize(locale, "修复尝试和阻塞的恢复", "Repair attempts and blocked recovery")}>
          {fleetLoopRuns.length > 0 ? (
            <div className="space-y-3">
              {fleetLoopRuns.map((record) => (
                <div key={record.run.loopRunId} className="agent-subcard p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">
                        {record.action?.summary.title ?? record.incident?.summary.rootCauseSummary ?? (locale === "zh" ? "集群恢复运行" : "Fleet recovery run")}
                      </p>
                      <p className="text-xs text-[color:var(--color-text-tertiary)]">
                        {record.run.loopRunId} · attempt {record.run.attemptNumber}
                      </p>
                    </div>
                    <StatusPill tone={toneForLoopRun(record)}>
                      {record.run.status.replaceAll("_", " ")}
                    </StatusPill>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)] sm:grid-cols-2">
                    <p>{locale === "zh" ? "风险等级：" : "Risk tier:"} {record.run.riskTier}</p>
                    <p>{locale === "zh" ? "验证：" : "Verification:"} {record.run.verificationPassed === undefined ? "pending" : record.run.verificationPassed ? "passed" : "failed"}</p>
                    {record.run.haltReason ? <p className="sm:col-span-2">{locale === "zh" ? "停止原因：" : "Halt reason:"} {record.run.haltReason.replaceAll("_", " ")}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "当前无活跃的集群修复循环。" : "No active fleet remediation loops are recorded right now."}</p>
          )}
        </ShellCard>
      </div>

      <div className="space-y-4">
        <ShellCard
          eyebrow={localize(locale, "节点详情", "Node Detail")}
          title={selectedSatellite?.displayName ? `${selectedSatellite.displayName} ${localize(locale, "详情", "detail")}` : localize(locale, "卫星节点详情", "Satellite detail")}
          aside={
            detail?.satellite ? (
              <StatusPill tone={toneForFleetPairing(detail.satellite.pairingStatus)}>
                {detail.satellite.pairingStatus}
              </StatusPill>
            ) : undefined
          }
        >
          {detail ? (
            <div className="space-y-4">
              <div className="agent-subcard-strong p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "恢复阶梯" : "Recovery ladder"}</p>
                <h3 className="mt-2 text-lg font-semibold text-[color:var(--color-text-primary)]">{locale === "zh" ? "从最安全的下一个恢复步骤开始" : "Start with the safest next recovery step"}</h3>
                <div className="mt-4 space-y-3">
                  {recoverySteps.map((step, index) => (
                    <article key={step.id} className="agent-subcard p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                            {index === 0 ? (locale === "zh" ? "从这里开始" : "Start here") : (locale === "zh" ? "然后" : "Then")}
                          </p>
                          <h4 className="mt-2 font-medium text-[color:var(--color-text-primary)]">{step.title}</h4>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <StatusPill tone={step.tone}>{step.status ?? step.tone}</StatusPill>
                          {step.riskClass ? <StatusPill tone="neutral">{step.riskClass}</StatusPill> : null}
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{step.summary}</p>
                      <p className="mt-3 text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "Friday 推荐此步骤的原因" : "Why Friday suggests this"}</p>
                      <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{step.reason}</p>
                      {step.requiresApproval ? (
                        <p className="mt-4 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-3 py-2 text-xs text-[color:var(--color-text-primary)]">
                          {locale === "zh" ? "需要审批后 Friday 才能执行此恢复步骤。" : "Requires approval before Friday can apply this recovery step."}
                        </p>
                      ) : null}
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        {selectedSatelliteId && step.actionId && step.status === "ready" ? (
                          <button
                            type="button"
                            className="inline-flex items-center rounded-2xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:border-[color:var(--color-accent)] hover:bg-[color:var(--color-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={remediationMutation.isPending}
                            onClick={() =>
                              remediationMutation.mutate({
                                satelliteId: selectedSatelliteId,
                                actionId: step.actionId!,
                              })
                            }
                          >
                            {remediationMutation.isPending ? localize(locale, "运行中...", "Running...") : localize(locale, "执行步骤", "Run step")}
                          </button>
                        ) : null}
                        <Link
                          className="inline-flex items-center rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-surface-strong)]"
                          to={
                            step.routeTarget === "/assistant"
                              ? step.routeTarget
                              : step.routeTarget === "/observability"
                                ? step.routeTarget
                                : buildFleetHref(
                                    selectedSatelliteId,
                                    step.id === "resume-blocked-work" || step.id === "resume_blocked_work"
                                      ? "queue"
                                      : "recovery",
                                  )
                          }
                        >
                          {locale === "zh" ? "查看详情" : "Open details"}
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
                {remediationMutation.error ? (
                  <div className="mt-4 rounded-3xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3 text-xs text-[color:var(--color-text-primary)]">
                    {locale === "zh" ? "恢复步骤失败：" : "Recovery step failed:"} {remediationMutation.error instanceof Error ? remediationMutation.error.message : (locale === "zh" ? "未知错误" : "Unknown error")}
                  </div>
                ) : null}
                {remediationMutation.data ? (
                  <div className="mt-4 rounded-3xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-4 py-3 text-xs text-[color:var(--color-text-primary)]">
                    {remediationMutation.data.summary}
                    {remediationMutation.data.affectedCount > 0
                      ? ` (${remediationMutation.data.affectedCount} item${remediationMutation.data.affectedCount === 1 ? "" : "s"} affected)`
                      : ""}
                  </div>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="agent-subcard p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "信任" : "Trust"}</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{detail.trustBreakdown.finalScore}</p>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{detail.trustBreakdown.band} {locale === "zh" ? "等级" : "band"}</p>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">{detail.trustBreakdown.reasons.join(" · ") || (locale === "zh" ? "无信任警告。" : "No trust warnings.")}</p>
                </div>
                <div className="agent-subcard p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "健康" : "Health"}</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{detail.healthBreakdown.finalScore}</p>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{detail.healthBreakdown.state}</p>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
                    {locale === "zh" ? "心跳" : "Heartbeat"} {detail.healthBreakdown.heartbeatScore} · {locale === "zh" ? "队列" : "Queue"} {detail.healthBreakdown.queueScore} · {locale === "zh" ? "可靠性" : "Reliability"} {detail.healthBreakdown.reliabilityScore}
                  </p>
                </div>
              </div>

              {runtimeRecoveryCard ? (
                <div className="agent-subcard p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "运行时边界" : "Runtime boundary"}</p>
                      <h3 className="mt-2 text-lg font-semibold text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.title}</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={runtimeRecoveryCard.tone}>{detail.runtimeRecovery.state.replaceAll("_", " ")}</StatusPill>
                      <StatusPill tone={runtimeRecoveryCard.autoRetryActive ? "warning" : "neutral"}>
                        {runtimeRecoveryCard.autoRetryActive ? (locale === "zh" ? "自动重试中" : "auto retry active") : (locale === "zh" ? "自动重试空闲" : "auto retry idle")}
                      </StatusPill>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{runtimeRecoveryCard.summary}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "续接边界" : "Continuation boundary"}</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.continuationLabel}</p>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        {locale === "zh" ? "Friday 只会继续节点离线前已分发的工作。" : "Friday only continues work that was already dispatched before the node went offline."}
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "离线规划" : "Offline planning"}</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.offlinePlanningLabel}</p>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        {locale === "zh" ? "新的离线规划将延迟到节点恢复到健康信任域。" : "New offline planning remains deferred until the node returns to a healthy trust domain."}
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "队列恢复" : "Queue recovery"}</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.queueRecoveryLabel}</p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "同步恢复" : "Sync recovery"}</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.syncRecoveryLabel}</p>
                    </div>
                  </div>
                  <div className="mt-4 rounded-3xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] px-4 py-3 text-sm text-[color:var(--color-text-primary)]">
                    {locale === "zh" ? "Friday 的下一步操作：" : "Friday's next operator action:"} <span className="font-medium">{runtimeRecoveryCard.nextActionLabel}</span>
                  </div>
                  {runtimeRecoveryCard.reasons.length > 0 ? (
                    <div className="mt-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">{locale === "zh" ? "此边界激活的原因" : "Why this boundary is active"}</p>
                      <ul className="mt-2 space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                        {runtimeRecoveryCard.reasons.map((reason) => (
                          <li key={reason}>• {reason}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {runtimeRecoveryCard.requiresOperatorIntervention ? (
                    <div className="mt-4 rounded-3xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3 text-xs text-[color:var(--color-text-primary)]">
                      {locale === "zh" ? "在 Friday 超出有限续接范围前仍需操作员干预。" : "Operator intervention is still required before Friday can move beyond bounded continuation."}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                <FleetMetricCard
                  icon={<Cpu className="h-4 w-4" />}
                  label={locale === "zh" ? "队列" : "Queue"}
                  value={String(detail.queue.queued + detail.queue.leased)}
                  detail={`${detail.queue.failed} ${locale === "zh" ? "失败" : "failed"} · ${detail.queue.deadLetter} ${locale === "zh" ? "死信" : "dead letter"}`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label={locale === "zh" ? "工作流负载" : "Workflow load"}
                  value={String(detail.workflowLoad.runningNodes)}
                  detail={`${detail.workflowLoad.queuedNodes} ${locale === "zh" ? "排队中" : "queued"} · ${detail.workflowLoad.blockedOfflineNodes} ${locale === "zh" ? "离线阻塞" : "blocked offline"}`}
                />
                <FleetMetricCard
                  icon={<HeartPulse className="h-4 w-4" />}
                  label={locale === "zh" ? "能力" : "Capabilities"}
                  value={String(detail.capabilities.filter((capability) => capability.available).length)}
                  detail={`${detail.capabilities.length} ${locale === "zh" ? "已报告的能力键" : "reported capability keys"}`}
                />
              </div>

              <div className="agent-subcard p-4">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{locale === "zh" ? "能力目录" : "Capability directory"}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.capabilities.map((capability) => (
                    <StatusPill
                      key={capability.key}
                      tone={capability.available ? "success" : "neutral"}
                    >
                      {capability.key}
                    </StatusPill>
                  ))}
                  {detail.capabilities.length === 0 ? (
                    <span className="text-sm text-[color:var(--color-text-secondary)]">{locale === "zh" ? "暂无已报告的能力。" : "No capabilities reported yet."}</span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {locale === "zh" ? "选择一个卫星节点以检查信任、队列、部署和能力详情，然后执行恢复操作。" : "Select a satellite to inspect trust, queue, placement, and capability detail before taking a recovery action."}
            </p>
          )}
        </ShellCard>
      </div>
      <ConfirmDialog
        open={pairingToApprove !== null}
        title={localize(locale, "确认配对卫星", "Confirm Satellite Pairing")}
        description={localize(locale, "批准后该节点将加入集群并可接收任务。", "Once approved, this satellite joins the fleet and can receive dispatched work.")}
        confirmLabel={localize(locale, "批准", "Approve")}
        cancelLabel={localize(locale, "取消", "Cancel")}
        tone="primary"
        loading={approvePairingMutation.isPending}
        onConfirm={() => { if (pairingToApprove) approvePairingMutation.mutate(pairingToApprove); }}
        onCancel={() => setPairingToApprove(null)}
      />
    </div>
  );
}
