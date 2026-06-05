import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ShellCard, StatusPill } from "@/components/core/primitives";
import { useMissionWorkbenchSnapshot } from "@/hooks/use-mission-workbench";
import { localize } from "@/lib/i18n/localized-text";
import {
  type MissionWorkbenchApprovalState,
  type MissionLifecycleState,
  type MissionTranscriptGroupKind,
  type MissionSurfaceKind,
  type MissionTruthLabel,
} from "@/lib/mission-workbench/mission-workbench-contract";
import {
  evidenceRefValues,
  filterMissionTranscriptSections,
  type MissionTranscriptFacetFilter,
} from "@/lib/mission-workbench/mission-transcript-browser-filters";
import { useAppLocale } from "@/providers/locale-provider";

function toneForTruthLabel(label: MissionTruthLabel): "neutral" | "success" | "warning" | "danger" {
  if (label === "friday_owned") return "success";
  if (label === "friday_adopted") return "warning";
  if (label === "unknown") return "danger";
  return "neutral";
}

function toneForState(state: MissionLifecycleState): "neutral" | "success" | "warning" | "danger" {
  if (state === "completed_with_proof") return "success";
  if (state === "blocked" || state === "error") return "danger";
  if (state === "provider_ack" || state === "queued" || state === "waiting" || state === "stale" || state === "reconnecting") {
    return "warning";
  }
  return "neutral";
}

function toneForApproval(state: MissionWorkbenchApprovalState): "neutral" | "success" | "warning" | "danger" {
  if (state === "approved" || state === "not_required") return "success";
  if (state === "blocked") return "danger";
  return "warning";
}

function stateMeansDone(state: MissionLifecycleState): boolean {
  return state === "completed_with_proof";
}

function truthLabelText(label: MissionTruthLabel): string {
  return label.replaceAll("_", "-");
}

export function MissionWorkbenchPage() {
  const { locale } = useAppLocale();
  const [searchParams] = useSearchParams();
  const targetMissionId = searchParams.get("missionId")?.trim() || undefined;
  const { snapshot, isLoading, isLive, liveUnavailable } = useMissionWorkbenchSnapshot(targetMissionId);
  const [query, setQuery] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState<MissionSurfaceKind | "all">("all");
  const [stateFilter, setStateFilter] = useState<MissionLifecycleState | "all">("all");
  const [groupFilter, setGroupFilter] = useState<MissionTranscriptGroupKind | "all">("all");
  const [facetFilter, setFacetFilter] = useState<MissionTranscriptFacetFilter>("all");

  const filteredSections = useMemo(() => {
    return filterMissionTranscriptSections(snapshot?.transcriptSections ?? [], {
      query,
      surface: surfaceFilter,
      state: stateFilter,
      group: groupFilter,
      facet: facetFilter,
    });
  }, [facetFilter, groupFilter, query, snapshot?.transcriptSections, stateFilter, surfaceFilter]);

  if (!snapshot) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-8">
        <header className="mb-6">
          <p className="agent-eyebrow">Mission Spine</p>
          <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "任务工作台", "Mission Workbench")}
          </h1>
          <div className="mt-3 flex flex-wrap gap-2">
            {targetMissionId ? <StatusPill tone="neutral">capture target: {targetMissionId}</StatusPill> : null}
            <StatusPill tone="warning">{isLoading ? "checking live Rust Hub" : "live Rust Hub unavailable"}</StatusPill>
          </div>
        </header>
        <div className="rounded-lg border border-[color:var(--color-border-warning)] bg-[color:var(--color-bg-warning-subtle)] p-4 text-sm text-[color:var(--color-text-primary)]">
          <p className="font-semibold">
            {localize(locale, "真实 Rust Hub 投影不可用。", "Live Rust Hub projection is unavailable.")}
          </p>
          <p className="mt-1 text-[color:var(--color-text-secondary)]">
            {liveUnavailable
              ? localize(
                locale,
                "此页面不会显示占位任务、工作项或证据行；请修复 /v1/mission-spine/workbench 后再捕获。",
                "This page does not display placeholder Missions, WorkItems, or evidence rows; fix /v1/mission-spine/workbench before capture.",
              )
              : localize(
                locale,
                "正在检查 /v1/mission-spine/workbench；真实投影返回前不会渲染任务数据。",
                "Checking /v1/mission-spine/workbench; Mission data is not rendered until a real projection returns.",
              )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="agent-eyebrow">Mission Spine</p>
          <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "任务工作台", "Mission Workbench")}
          </h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill tone="success">{snapshot.missionId}</StatusPill>
            {targetMissionId ? <StatusPill tone={snapshot.missionId === targetMissionId ? "success" : "danger"}>capture target: {targetMissionId}</StatusPill> : null}
            <StatusPill tone="warning">{snapshot.runtimeFeedStatus.replaceAll("_", " ")}</StatusPill>
            {snapshot.statusLabels.map((label) => (
              <StatusPill key={label} tone={label === "error" ? "danger" : "warning"}>{label}</StatusPill>
            ))}
            <StatusPill tone={isLive ? "success" : "warning"}>live Rust Hub</StatusPill>
            {isLoading ? <StatusPill tone="neutral">checking live wire</StatusPill> : null}
          </div>
        </div>
        <div className="grid min-w-[280px] grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
            <p className="text-xs text-[color:var(--color-text-secondary)]">Conversation</p>
            <p className="mt-1 truncate font-medium text-[color:var(--color-text-primary)]">{snapshot.fridayConversationId}</p>
          </div>
          <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-3">
            <p className="text-xs text-[color:var(--color-text-secondary)]">Duplicate preflight</p>
            <p className="mt-1 truncate font-medium text-[color:var(--color-text-primary)]">{snapshot.duplicatePreflight.status}</p>
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="space-y-4">
          <ShellCard
            eyebrow="Rust Hub projection"
            title={localize(locale, "任务生命周期", "Mission lifecycle")}
          >
            <div className="grid gap-3 md:grid-cols-3">
              {snapshot.workItems.map((item) => (
                <div key={item.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{item.title}</p>
                      <p className="mt-1 truncate text-xs text-[color:var(--color-text-secondary)]">{item.id}</p>
                    </div>
                    <StatusPill tone={toneForState(item.state)}>{item.state}</StatusPill>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill tone={toneForTruthLabel(item.owner)}>{truthLabelText(item.owner)}</StatusPill>
                    <StatusPill tone={item.done ? "success" : "warning"}>
                      {item.done ? "done with proof" : "not completion"}
                    </StatusPill>
                  </div>
                  {item.proofRef ? (
                    <p className="mt-3 break-all rounded-lg bg-[color:var(--color-bg-base)] p-2 text-xs text-[color:var(--color-text-secondary)]">
                      {item.proofRef}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </ShellCard>

          <ShellCard eyebrow="Advisor" title={localize(locale, "路由决定", "Route decision")}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={toneForTruthLabel(snapshot.routeDecision.truthLabel)}>
                    {truthLabelText(snapshot.routeDecision.truthLabel)}
                  </StatusPill>
                  <StatusPill tone="neutral">{snapshot.routeDecision.selectedRoute}</StatusPill>
                </div>
                <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  {snapshot.routeDecision.advisorSummary}
                </p>
              </div>
              <div className="space-y-2">
                {snapshot.routeDecision.alternatives.map((alternative) => (
                  <div key={alternative} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">
                    {alternative}
                  </div>
                ))}
              </div>
            </div>
          </ShellCard>

          <ShellCard eyebrow="Bounded timeline" title={localize(locale, "分页时间线", "Timeline pages")}>
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.timelinePages.map((page) => (
                <div key={page.cursor} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">Page {page.page}</p>
                    <StatusPill tone={page.nextCursor ? "warning" : "success"}>{page.nextCursor ? "cursor continues" : "cursor verified"}</StatusPill>
                  </div>
                  <p className="mt-2 break-all text-xs text-[color:var(--color-text-secondary)]">{page.cursor}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {page.eventRefs.map((ref) => <StatusPill key={ref} tone="neutral">{ref}</StatusPill>)}
                  </div>
                </div>
              ))}
            </div>
          </ShellCard>
        </div>

        <div className="space-y-4">
          <ShellCard eyebrow="Proof receipts" title={localize(locale, "证据引用", "Evidence refs")}>
            <div className="space-y-3">
              {[...snapshot.providerReceiptRefs, ...snapshot.channelReceiptRefs].map((ref) => (
                <div key={ref} className="break-all rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3 text-xs text-[color:var(--color-text-secondary)]">
                  {ref}
                </div>
              ))}
            </div>
          </ShellCard>

          <ShellCard eyebrow="Memory" title={localize(locale, "候选记忆", "Memory candidates")}>
            <div className="space-y-3">
              {snapshot.memoryCandidates.map((candidate) => (
                <div key={candidate.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex flex-wrap gap-2">
                    <StatusPill tone="warning">{candidate.state}</StatusPill>
                    <StatusPill tone="danger">authority: false</StatusPill>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{candidate.preview}</p>
                  <p className="mt-3 break-all text-xs text-[color:var(--color-text-tertiary)]">{candidate.evidenceRef}</p>
                </div>
              ))}
            </div>
          </ShellCard>

          <ShellCard eyebrow="Capabilities" title={localize(locale, "能力与审批", "Capability gates")}>
            <div className="space-y-3">
              {snapshot.capabilityStates.map((capability) => (
                <div key={capability.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{capability.label}</p>
                      <p className="mt-1 truncate text-xs text-[color:var(--color-text-secondary)]">{capability.id}</p>
                    </div>
                    <StatusPill tone="neutral">{capability.kind}</StatusPill>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill tone={toneForTruthLabel(capability.truthLabel)}>{truthLabelText(capability.truthLabel)}</StatusPill>
                    <StatusPill tone={toneForApproval(capability.approvalState)}>{capability.approvalState}</StatusPill>
                    <StatusPill tone={capability.dispatchAllowed ? "success" : "warning"}>
                      {capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated"}
                    </StatusPill>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{capability.summary}</p>
                  <p className="mt-3 break-all text-xs text-[color:var(--color-text-tertiary)]">{capability.proofRef}</p>
                </div>
              ))}
            </div>
          </ShellCard>
        </div>
      </div>

      <ShellCard
        className="mt-4"
        eyebrow="Transcript Browser"
        title={localize(locale, "证据浏览器", "Evidence browser")}
        aside={<StatusPill tone="warning">redacted bounded rows</StatusPill>}
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_180px_180px_180px_180px]">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-tertiary)]" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={localize(locale, "搜索任务、工作项、状态或证据引用", "Search mission, work item, status, or proof ref")}
              className="h-11 w-full rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] pl-9 pr-3 text-sm text-[color:var(--color-text-primary)] outline-none transition focus:border-[color:var(--color-border-strong)]"
            />
          </label>
          <select
            aria-label="Surface filter"
            value={surfaceFilter}
            onChange={(event) => setSurfaceFilter(event.target.value as MissionSurfaceKind | "all")}
            className="h-11 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
          >
            <option value="all">All surfaces</option>
            <option value="mobile">Mobile</option>
            <option value="desktop">Desktop</option>
            <option value="telegram">Telegram</option>
            <option value="timeline">Timeline</option>
          </select>
          <select
            aria-label="State filter"
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value as MissionLifecycleState | "all")}
            className="h-11 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
          >
            <option value="all">All states</option>
            <option value="ready">Ready</option>
            <option value="queued">Queued</option>
            <option value="provider_ack">Provider ack</option>
            <option value="waiting">Waiting</option>
            <option value="stale">Stale</option>
            <option value="completed_with_proof">Completed with proof</option>
            <option value="blocked">Blocked</option>
          </select>
          <select
            aria-label="Group filter"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value as MissionTranscriptGroupKind | "all")}
            className="h-11 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
          >
            <option value="all">All groups</option>
            <option value="mission">Mission groups</option>
            <option value="work_item">WorkItem groups</option>
            <option value="provider_session">Provider sessions</option>
            <option value="skill_run">Skill runs</option>
            <option value="channel_task">Channel tasks</option>
            <option value="workflow">Workflows</option>
            <option value="surface">Surface groups</option>
            <option value="status">Status groups</option>
            <option value="time">Time groups</option>
          </select>
          <select
            aria-label="Evidence facet filter"
            value={facetFilter}
            onChange={(event) => setFacetFilter(event.target.value as MissionTranscriptFacetFilter)}
            className="h-11 rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 text-sm text-[color:var(--color-text-primary)]"
          >
            <option value="all">All evidence</option>
            <option value="provider">Provider refs</option>
            <option value="skill">Skill refs</option>
            <option value="channel">Channel refs</option>
            <option value="workflow">Workflow refs</option>
            <option value="surface_thread">Surface threads</option>
            <option value="timeline">Timeline refs</option>
            <option value="proof_receipt">Proof receipts</option>
            <option value="time">Capture time</option>
          </select>
        </div>

        <div className="mt-4 space-y-3">
          {filteredSections.map((section) => (
            <details key={section.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{section.title}</p>
                    <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                      {section.groupKind} / {section.missionId}{section.workItemId ? ` / ${section.workItemId}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusPill tone={toneForTruthLabel(section.truthLabel)}>{truthLabelText(section.truthLabel)}</StatusPill>
                    <StatusPill tone={toneForState(section.status)}>{section.status}</StatusPill>
                  </div>
                </div>
              </summary>
              <div className="mt-4 space-y-2">
                {section.events.map((event) => (
                  <div key={event.id} className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-base)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone="neutral">{event.surface}</StatusPill>
                      <StatusPill tone={toneForTruthLabel(event.truthLabel)}>{truthLabelText(event.truthLabel)}</StatusPill>
                      <StatusPill tone={toneForState(event.status)}>{event.status}</StatusPill>
                      <StatusPill tone={stateMeansDone(event.status) ? "success" : "warning"}>
                        {stateMeansDone(event.status) ? "done" : "not done"}
                      </StatusPill>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">{event.summary}</p>
                    <div className="mt-3 grid gap-2 text-xs text-[color:var(--color-text-tertiary)] md:grid-cols-2">
                      <p className="truncate">{event.id}</p>
                      <p className="truncate">{event.capturedAt}</p>
                      {event.proofRef ? <p className="break-all md:col-span-2">{event.proofRef}</p> : null}
                      {evidenceRefValues(event).map((ref) => (
                        <p key={ref} className="break-all md:col-span-2">{ref}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
          {filteredSections.length === 0 ? (
            <div className="rounded-lg border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-6 text-center text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "没有匹配的证据行。", "No matching evidence rows.")}
            </div>
          ) : null}
        </div>
      </ShellCard>
    </div>
  );
}
