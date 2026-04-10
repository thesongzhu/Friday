import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, HeartPulse, Link2, RadioTower, ShieldCheck, Workflow } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { ShellCard, SkeletonCard, SkeletonList, StatusPill } from "@/components/core/primitives";
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
                {overview.totals.degraded > 0 ? "needs attention" : "stable"}
              </StatusPill>
            ) : undefined
          }
        >
          {overview ? (
            <div className="space-y-4 text-sm text-[color:var(--color-text-secondary)]">
              <p>
                Friday uses this page as the deep fleet console after Assistant has already found a node, queue, or
                placement issue. Start from the degraded or blocked satellite below, then use the recovery loop and
                node detail panels to inspect the next safe action.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <FleetMetricCard
                  icon={<RadioTower className="h-4 w-4" />}
                  label="Needs recovery"
                  value={String(overview.totals.degraded)}
                  detail={`${overview.totals.online} online / ${overview.totals.satellites} total`}
                />
                <FleetMetricCard
                  icon={<Link2 className="h-4 w-4" />}
                  label={localize(locale, "阻塞任务", "Blocked work")}
                  value={String(overview.queue.deadLetter + overview.queue.failed)}
                  detail={`${overview.queue.queued + overview.queue.leased} queued or leased`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label={localize(locale, "恢复循环", "Recovery loops")}
                  value={String(fleetLoopRuns.length)}
                  detail="Active or recent remediation runs"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading fleet guidance...</p>
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
                  detail={`${overview.totals.satellites} registered · ${overview.totals.degraded} degraded`}
                />
                <FleetMetricCard
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="Trust posture"
                  value={`${overview.trust.averageScore}`}
                  detail={`${overview.trust.lowTrustCount} low-trust · ${overview.trust.restrictedCount} restricted`}
                />
                <FleetMetricCard
                  icon={<Link2 className="h-4 w-4" />}
                  label="Queue backlog"
                  value={String(overview.queue.queued + overview.queue.leased)}
                  detail={`${overview.queue.deadLetter} dead letters · ${overview.queue.failed} failed`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label="Workflow pressure"
                  value={String(overview.workflows.activeRuns)}
                  detail={`${overview.workflows.completed1h} completed / ${overview.workflows.failed1h} failed in 1h`}
                />
              </div>
              <div className="agent-detail-note p-4 text-sm text-[color:var(--color-text-secondary)]">
                Fleet health is <span className="font-medium text-[color:var(--color-text-primary)]">{overview.health.state}</span> with score{" "}
                <span className="font-medium text-[color:var(--color-text-primary)]">{overview.health.score}</span>. Reasons:{" "}
                {overview.health.reasons.length > 0 ? overview.health.reasons.join(" · ") : "No active concerns."}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading fleet overview...</p>
          )}
        </ShellCard>

        <ShellCard eyebrow={localize(locale, "卫星节点", "Satellites")} title={<>{localize(locale, "选择一个", "Choose a ")} <HelpTooltip term="satellite" /> {localize(locale, "查看或恢复", "to inspect or recover")}</>}>
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
                  <p>Last seen: {formatFleetTimestamp(satellite.lastSeenAt)}</p>
                  <p>Heartbeat: {formatFleetHeartbeatAge(satellite.heartbeatAgeMs)}</p>
                  <p>Queue depth: {satellite.queueDepth ?? 0}</p>
                  <p>Active runs: {satellite.activeRuns ?? 0}</p>
                </div>
                {satellite.alerts.length > 0 ? (
                  <p className="mt-3 text-xs text-[color:var(--color-text-primary)]">{satellite.alerts.join(" · ")}</p>
                ) : null}
              </button>
            ))}
            {satellites.length === 0 ? (
              <div className="space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                <p>{localize(locale, "暂无卫星节点注册。", "No satellites have registered yet.")}</p>
                <p>Friday can help you set up remote devices to extend your automation reach.</p>
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
                        {record.action?.summary.title ?? record.incident?.summary.rootCauseSummary ?? "Fleet recovery run"}
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
                    <p>Risk tier: {record.run.riskTier}</p>
                    <p>Verification: {record.run.verificationPassed === undefined ? "pending" : record.run.verificationPassed ? "passed" : "failed"}</p>
                    {record.run.haltReason ? <p className="sm:col-span-2">Halt reason: {record.run.haltReason.replaceAll("_", " ")}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">No active fleet remediation loops are recorded right now.</p>
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
                <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">Recovery ladder</p>
                <h3 className="mt-2 text-lg font-semibold text-[color:var(--color-text-primary)]">Start with the safest next recovery step</h3>
                <div className="mt-4 space-y-3">
                  {recoverySteps.map((step, index) => (
                    <article key={step.id} className="agent-subcard p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">
                            {index === 0 ? "Start here" : "Then"}
                          </p>
                          <h4 className="mt-2 font-medium text-[color:var(--color-text-primary)]">{step.title}</h4>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <StatusPill tone={step.tone}>{step.status ?? step.tone}</StatusPill>
                          {step.riskClass ? <StatusPill tone="neutral">{step.riskClass}</StatusPill> : null}
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{step.summary}</p>
                      <p className="mt-3 text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Why Friday suggests this</p>
                      <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">{step.reason}</p>
                      {step.requiresApproval ? (
                        <p className="mt-4 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-3 py-2 text-xs text-[color:var(--color-text-primary)]">
                          Requires approval before Friday can apply this recovery step.
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
                          Open details
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
                {remediationMutation.error ? (
                  <div className="mt-4 rounded-3xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3 text-xs text-[color:var(--color-text-primary)]">
                    Recovery step failed: {remediationMutation.error instanceof Error ? remediationMutation.error.message : "Unknown error"}
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
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">Trust</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{detail.trustBreakdown.finalScore}</p>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{detail.trustBreakdown.band} band</p>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">{detail.trustBreakdown.reasons.join(" · ") || "No trust warnings."}</p>
                </div>
                <div className="agent-subcard p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">Health</p>
                  <p className="mt-2 text-2xl font-semibold text-[color:var(--color-text-primary)]">{detail.healthBreakdown.finalScore}</p>
                  <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">{detail.healthBreakdown.state}</p>
                  <p className="mt-3 text-xs text-[color:var(--color-text-tertiary)]">
                    Heartbeat {detail.healthBreakdown.heartbeatScore} · Queue {detail.healthBreakdown.queueScore} · Reliability {detail.healthBreakdown.reliabilityScore}
                  </p>
                </div>
              </div>

              {runtimeRecoveryCard ? (
                <div className="agent-subcard p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--color-text-faint)]">Runtime boundary</p>
                      <h3 className="mt-2 text-lg font-semibold text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.title}</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={runtimeRecoveryCard.tone}>{detail.runtimeRecovery.state.replaceAll("_", " ")}</StatusPill>
                      <StatusPill tone={runtimeRecoveryCard.autoRetryActive ? "warning" : "neutral"}>
                        {runtimeRecoveryCard.autoRetryActive ? "auto retry active" : "auto retry idle"}
                      </StatusPill>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">{runtimeRecoveryCard.summary}</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Continuation boundary</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.continuationLabel}</p>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        Friday only continues work that was already dispatched before the node went offline.
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Offline planning</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.offlinePlanningLabel}</p>
                      <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">
                        New offline planning remains deferred until the node returns to a healthy trust domain.
                      </p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Queue recovery</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.queueRecoveryLabel}</p>
                    </div>
                    <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Sync recovery</p>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{runtimeRecoveryCard.syncRecoveryLabel}</p>
                    </div>
                  </div>
                  <div className="mt-4 rounded-3xl border border-[color:var(--color-accent-soft)] bg-[color:var(--color-accent-muted)] px-4 py-3 text-sm text-[color:var(--color-text-primary)]">
                    Friday's next operator action: <span className="font-medium">{runtimeRecoveryCard.nextActionLabel}</span>
                  </div>
                  {runtimeRecoveryCard.reasons.length > 0 ? (
                    <div className="mt-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[color:var(--color-text-faint)]">Why this boundary is active</p>
                      <ul className="mt-2 space-y-2 text-sm text-[color:var(--color-text-secondary)]">
                        {runtimeRecoveryCard.reasons.map((reason) => (
                          <li key={reason}>• {reason}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {runtimeRecoveryCard.requiresOperatorIntervention ? (
                    <div className="mt-4 rounded-3xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)] px-4 py-3 text-xs text-[color:var(--color-text-primary)]">
                      Operator intervention is still required before Friday can move beyond bounded continuation.
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                <FleetMetricCard
                  icon={<Cpu className="h-4 w-4" />}
                  label="Queue"
                  value={String(detail.queue.queued + detail.queue.leased)}
                  detail={`${detail.queue.failed} failed · ${detail.queue.deadLetter} dead letter`}
                />
                <FleetMetricCard
                  icon={<Workflow className="h-4 w-4" />}
                  label="Workflow load"
                  value={String(detail.workflowLoad.runningNodes)}
                  detail={`${detail.workflowLoad.queuedNodes} queued · ${detail.workflowLoad.blockedOfflineNodes} blocked offline`}
                />
                <FleetMetricCard
                  icon={<HeartPulse className="h-4 w-4" />}
                  label="Capabilities"
                  value={String(detail.capabilities.filter((capability) => capability.available).length)}
                  detail={`${detail.capabilities.length} reported capability keys`}
                />
              </div>

              <div className="agent-subcard p-4">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">Capability directory</p>
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
                    <span className="text-sm text-[color:var(--color-text-secondary)]">No capabilities reported yet.</span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              Select a satellite to inspect trust, queue, placement, and capability detail before taking a recovery
              action.
            </p>
          )}
        </ShellCard>
      </div>
    </div>
  );
}
