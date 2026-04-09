import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock3, ListFilter, Pin, Plus, Sparkles } from "lucide-react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { ContextualHelp } from "@/components/core/contextual-help";
import { CrossBorderActionBoard } from "@/components/packs/cross-border-action-board";
import { PackCard } from "@/components/packs/pack-card";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { useAdaptivePollingInterval } from "@/hooks/use-adaptive-polling";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useCrossBorderWorkflowPresets } from "@/hooks/use-cross-border-workflow-presets";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { crossBorderPackApi } from "@/lib/api/cross-border-pack";
import { uixSnapshotsApi, type UixScheduledAutomationSummary } from "@/lib/api/uix-snapshots";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { findPackRuns } from "@/lib/packs/pack-assistant-receipt";
import {
  buildCrossBorderAssistantNavigationSnapshot,
  buildCrossBorderAssistantNavigationState,
  persistCrossBorderAssistantNavigationSnapshot,
} from "@/lib/packs/cross-border-snapshot";
import { buildPackAssistantHref, buildPackChatHref, buildPackFlowHref } from "@/lib/packs/pack-links";
import { FRIDAY_PACKS, getPackById, type FridayPackDefinition, type HomeWidgetId } from "@/lib/packs/pack-registry";
import { buildSkillHref } from "@/lib/skills/view-models";
import {
  describeRunHealth,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
} from "@/lib/runs/run-health";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

const ACTIVE_RUN_STATUSES = new Set([
  "pending",
  "planning",
  "awaiting_clarification",
  "awaiting_plan_approval",
  "awaiting_tool_approval",
  "executing",
  "testing",
  "fixing",
]);

function formatTimestamp(value: string | undefined, locale: "zh" | "en"): string {
  if (!value) {
    return locale === "zh" ? "刚刚" : "Just now";
  }
  const date = new Date(value);
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatAutomationNextRun(
  automation: UixScheduledAutomationSummary,
  locale: "zh" | "en",
): string {
  if (!automation.schedule) {
    return locale === "zh" ? "手动触发" : "Manual";
  }

  if (!automation.nextRunAt) {
    return `${automation.schedule.cron}${automation.schedule.timezone ? ` · ${automation.schedule.timezone}` : ""}`;
  }

  const formatter = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: automation.schedule.timezone,
  });
  const label = locale === "zh" ? "下次" : "Next";
  return `${label} ${formatter.format(new Date(automation.nextRunAt))}${automation.schedule.timezone ? ` · ${automation.schedule.timezone}` : ""}`;
}

export function HomePage() {
  const navigate = useAppNavigate();
  const queryClient = useQueryClient();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const {
    pinnedPackIds,
    widgetOrder,
    visibleWidgets,
    pinPack,
    unpinPack,
    movePack,
    moveWidget,
    toggleWidget,
  } = useHomeSurfacePreferences(profileType);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null);
  const [editingWidgets, setEditingWidgets] = useState(false);
  const [editingPacks, setEditingPacks] = useState(false);
  const pollInterval = useAdaptivePollingInterval({ activeMs: 12_000, backgroundMs: 36_000 });
  const {
    applyDefaultWorkflows,
    setWorkflowEnabled,
    isApplyingDefaultWorkflows,
    togglingWorkflowId,
  } = useCrossBorderWorkflowPresets();

  const snapshotQuery = useQuery({
    queryKey: ["home", "snapshot", "task-first"],
    queryFn: () => uixSnapshotsApi.getHome(),
    refetchInterval: pollInterval,
  });
  const crossBorderSnapshotQuery = useQuery({
    queryKey: ["cross-border-pack", "snapshot", "home"],
    queryFn: () => crossBorderPackApi.getSnapshot(),
    refetchInterval: pollInterval,
  });

  const openCrossBorderAssistant = async () => {
    const latestSnapshot = await queryClient.fetchQuery({
      queryKey: ["cross-border-pack", "snapshot"],
      queryFn: () => crossBorderPackApi.getSnapshot(),
    });
    const navigationSnapshot = buildCrossBorderAssistantNavigationSnapshot(crossBorderSnapshotQuery.data, latestSnapshot);
    persistCrossBorderAssistantNavigationSnapshot(navigationSnapshot);
    navigate(buildPackAssistantHref("industry-cross-border-ecommerce"), {
      state: buildCrossBorderAssistantNavigationState(navigationSnapshot),
    });
  };

  useEffect(() => {
    if (!pendingPackPath) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      navigate(pendingPackPath);
      setPendingPackPath(null);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [navigate, pendingPackPath]);

  const recentRuns = snapshotQuery.data?.runs ?? [];
  const activeRuns = recentRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const recentResults = recentRuns.filter((run) => run.status === "completed" || run.status === "failed" || run.status === "failed_tests").slice(0, locale === "zh" ? 5 : 3);
  const pendingApprovals = snapshotQuery.data?.pendingApprovals ?? [];
  const scheduledAutomations = useMemo(
    () =>
      (snapshotQuery.data?.scheduledAutomations ?? [])
        .filter((automation) => automation.enabled && automation.schedule)
        .sort((left, right) => {
          const leftTime = left.nextRunAt ? new Date(left.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
          const rightTime = right.nextRunAt ? new Date(right.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
          return leftTime - rightTime;
        })
        .slice(0, 4),
    [snapshotQuery.data?.scheduledAutomations],
  );
  const pinnedPacks = pinnedPackIds
    .map((packId) => getPackById(packId))
    .filter((pack): pack is FridayPackDefinition => Boolean(pack));
  const recommendedPacks = FRIDAY_PACKS
    .filter((pack) => !pinnedPackIds.includes(pack.id))
    .sort((left, right) => Number(right.kind === "industry") - Number(left.kind === "industry"))
    .slice(0, locale === "zh" ? 5 : 3);
  const selectedPack = selectedPackId ? getPackById(selectedPackId) ?? null : null;
  const selectedPackRunState = selectedPack ? findPackRuns(selectedPack, recentRuns) : { activeRun: null, recentRun: null };

  const widgetLabels: Record<HomeWidgetId, string> = {
    active_now: localize(locale, "正在进行", "Active Now"),
    pending_approvals: localize(locale, "待确认", "Pending Approvals"),
    scheduled_soon: localize(locale, "即将执行", "Scheduled"),
    recent_results: localize(locale, "最近结果", "Recent Results"),
    recommended_to_add: localize(locale, "推荐加入", "Recommended"),
  };

  const renderedWidgets = widgetOrder.filter((widgetId) => visibleWidgets.includes(widgetId));

  return (
    <div className="space-y-5 pb-4">
      <section
        data-testid="home-surface-ready"
        className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "任务首页", "Task Home")}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {localize(locale, "继续你现在最该做的事", "Pick up the next thing that matters")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "这里先显示正在进行中的任务、待确认事项，以及你自己固定在首页的行业与任务入口。",
                "Home stays focused on live work, approvals, and the packs you chose to pin.",
              )}
            </p>
            {locale === "zh" && recentRuns.length > 0 && (() => {
              const completed = recentRuns.filter((r) => r.status === "completed").length;
              const total = recentRuns.filter((r) => r.status === "completed" || r.status === "failed" || r.status === "failed_tests").length;
              const rate = total > 0 ? Math.round((completed / total) * 100) : 100;
              return (
                <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[color:var(--color-text-tertiary)]">
                  <span>{`已完成 ${completed} 个任务`}</span>
                  <span className="text-[color:var(--color-border-strong)]">&middot;</span>
                  <span>{`成功率 ${rate}%`}</span>
                  {activeRuns.length > 0 && (
                    <>
                      <span className="text-[color:var(--color-border-strong)]">&middot;</span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
                        {`${activeRuns.length} 个任务运行中`}
                      </span>
                    </>
                  )}
                </p>
              );
            })()}
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton data-testid="home-start-task" onClick={() => navigate("/chat")}>
              <Sparkles className="mr-2 h-4 w-4" />
              {localize(locale, "开始新任务", "Start A Task")}
            </ActionButton>
            <ActionButton data-testid="home-browse-library" tone="secondary" onClick={() => navigate("/packs")}>
              <ListFilter className="mr-2 h-4 w-4" />
              {localize(locale, "浏览行业与任务", "Browse Library")}
            </ActionButton>
          </div>
        </div>
      </section>

      {crossBorderSnapshotQuery.data?.profile ? (
        <CrossBorderActionBoard
          snapshot={crossBorderSnapshotQuery.data}
          onOpenSetup={() => navigate("/packs/cross-border/setup?packId=industry-cross-border-ecommerce&mode=adjust")}
          onOpenAssistant={openCrossBorderAssistant}
          onOpenWorkflowTemplate={(templateId) => navigate(`/workflows/builder?templateId=${encodeURIComponent(templateId)}`)}
          onOpenManagedWorkflow={(workflowId) => navigate(`/workflows/builder?workflowId=${encodeURIComponent(workflowId)}`)}
          onApplyDefaultWorkflows={() => applyDefaultWorkflows()}
          onSetWorkflowEnabled={setWorkflowEnabled}
          isApplyingDefaultWorkflows={isApplyingDefaultWorkflows}
          togglingWorkflowId={togglingWorkflowId}
        />
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-1 text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "首页模块", "Home Widgets")}
              <ContextualHelp locale={locale} text="首页模块可以自由显示或隐藏，点击右侧「编辑模块」调整。" />
            </p>
            <p className="text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, "只保留你想看到的状态模块。", "Keep only the modules you want to see.")}
            </p>
          </div>
          <ActionButton tone="secondary" onClick={() => setEditingWidgets((value) => !value)}>
            {editingWidgets ? localize(locale, "完成调整", "Done") : localize(locale, "编辑模块", "Edit Widgets")}
          </ActionButton>
        </div>

        {editingWidgets ? (
          <ShellCard>
            <div className="space-y-3">
              {widgetOrder.map((widgetId) => (
                <div key={widgetId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{widgetLabels[widgetId]}</p>
                    <p className="text-xs text-[color:var(--color-text-secondary)]">{visibleWidgets.includes(widgetId) ? localize(locale, "当前显示在首页", "Visible on home") : localize(locale, "当前隐藏", "Hidden")}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton tone="secondary" onClick={() => toggleWidget(widgetId)}>
                      {visibleWidgets.includes(widgetId) ? localize(locale, "隐藏", "Hide") : localize(locale, "显示", "Show")}
                    </ActionButton>
                    <ActionButton tone="secondary" onClick={() => moveWidget(widgetId, "up")}>
                      {localize(locale, "上移", "Up")}
                    </ActionButton>
                    <ActionButton tone="secondary" onClick={() => moveWidget(widgetId, "down")}>
                      {localize(locale, "下移", "Down")}
                    </ActionButton>
                  </div>
                </div>
              ))}
            </div>
          </ShellCard>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-3">
          {renderedWidgets.map((widgetId) => {
            if (widgetId === "active_now") {
              return (
                <ShellCard key={widgetId} title={widgetLabels[widgetId]}>
                  {activeRuns.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "现在没有正在运行的任务。", "No task is actively running right now.")}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {activeRuns.slice(0, 3).map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => navigate("/assistant")}
                          className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-left transition hover:border-[color:var(--color-border-strong)]"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-[color:var(--color-text-primary)]">{run.task}</p>
                              <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                                {summarizeRunContext(run, locale) ?? formatTimestamp(run.startedAt, locale)}
                              </p>
                            </div>
                            <StatusPill tone={toneForRunHealth(run)}>{labelForRunHealth(run, locale)}</StatusPill>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </ShellCard>
              );
            }

            if (widgetId === "pending_approvals") {
              return (
                <ShellCard key={widgetId} title={widgetLabels[widgetId]}>
                  {pendingApprovals.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "当前没有需要你确认的自动修复。", "There are no approvals waiting on you right now.")}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {pendingApprovals.slice(0, 2).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => navigate("/assistant")}
                          className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-left transition hover:border-[color:var(--color-border-strong)]"
                        >
                          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{item.title}</p>
                          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">{item.summary}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </ShellCard>
              );
            }

            if (widgetId === "scheduled_soon") {
              return (
                <ShellCard key={widgetId} title={widgetLabels[widgetId]}>
                  {scheduledAutomations.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "还没有固定在跑的自动化。", "No recurring automation is pinned into your flow yet.")}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {scheduledAutomations.map((automation) => (
                        <button
                          key={automation.id}
                          type="button"
                          onClick={() => navigate("/automations")}
                          className="w-full rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-left transition hover:border-[color:var(--color-border-strong)]"
                        >
                          <div className="flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
                            <Clock3 className="h-4 w-4 text-[color:var(--color-accent)]" />
                            <span>{formatAutomationNextRun(automation, locale)}</span>
                          </div>
                          <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{automation.name}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </ShellCard>
              );
            }

            if (widgetId === "recent_results") {
              return (
                <ShellCard key={widgetId} title={widgetLabels[widgetId]}>
                  {recentResults.length === 0 ? (
                    <p className="text-sm text-[color:var(--color-text-secondary)]">
                      {localize(locale, "还没有最近结果。", "There are no recent results yet.")}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {recentResults.map((run) => (
                        <div
                          key={run.id}
                          className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="min-w-0 truncate text-sm font-medium text-[color:var(--color-text-primary)]">{run.task}</p>
                            <StatusPill tone={toneForRunHealth(run)}>{labelForRunHealth(run, locale)}</StatusPill>
                          </div>
                          <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                            {describeRunHealth(run, locale) || formatTimestamp(run.completedAt ?? run.startedAt, locale)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </ShellCard>
              );
            }

            return (
              <ShellCard key={widgetId} title={widgetLabels[widgetId]}>
                <div className="space-y-3">
                  {recommendedPacks.map((pack) => (
                    <PackCard
                      key={pack.id}
                      pack={pack}
                      compact
                      note={pack.productCopy ? localize(locale, pack.productCopy.resultSummary.zh, pack.productCopy.resultSummary.en) : undefined}
                      onOpen={() => setSelectedPackId(pack.id)}
                      onPin={() => pinPack(pack.id)}
                    />
                  ))}
                </div>
              </ShellCard>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "首页入口", "Pinned Packs")}
            </p>
            <p className="text-xs text-[color:var(--color-text-secondary)]">
              {localize(locale, "你常用的行业与任务入口会固定在这里。", "Your chosen industry and task packs stay here for quick access.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton tone="secondary" onClick={() => setEditingPacks((value) => !value)}>
              {editingPacks ? localize(locale, "完成排序", "Done") : localize(locale, "编辑入口", "Edit Packs")}
            </ActionButton>
            <ActionButton tone="secondary" onClick={() => navigate("/packs")}>
              <Plus className="mr-2 h-4 w-4" />
              {localize(locale, "加入更多", "Add More")}
            </ActionButton>
          </div>
        </div>

        {pinnedPacks.length === 0 ? (
          <ShellCard>
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "首页还没有固定入口，先去行业与任务库挑几个放上来。", "No pack is pinned yet. Open the library and pin a few to home.")}
            </p>
          </ShellCard>
        ) : (
          <div className={cn("grid gap-4 md:grid-cols-2", locale === "zh" && "lg:grid-cols-3")}>
            {pinnedPacks.map((pack) => {
              const runState = findPackRuns(pack, recentRuns);
              const note = runState.activeRun
                ? `${localize(locale, "当前任务", "Current run")}: ${runState.activeRun.task}`
                : runState.recentRun
                  ? `${localize(locale, "上次处理", "Last activity")}: ${formatTimestamp(runState.recentRun.completedAt ?? runState.recentRun.startedAt, locale)}`
                  : pack.productCopy
                    ? localize(locale, pack.productCopy.resultSummary.zh, pack.productCopy.resultSummary.en)
                    : localize(locale, "还没有开始过这个入口。", "You have not started this pack yet.");

              return (
                <PackCard
                  key={pack.id}
                  pack={pack}
                  pinned
                  note={note}
                  statusLabel={runState.activeRun ? localize(locale, "正在进行", "Live") : runState.recentRun ? localize(locale, "最近记录", "Recent") : undefined}
                  onOpen={() => setSelectedPackId(pack.id)}
                  onUnpin={editingPacks ? () => unpinPack(pack.id) : undefined}
                  onMoveUp={editingPacks ? () => movePack(pack.id, "up") : undefined}
                  onMoveDown={editingPacks ? () => movePack(pack.id, "down") : undefined}
                />
              );
            })}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between gap-3 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-4 shadow-[var(--shadow-floating)]">
        <div>
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "行业与任务库", "Industry & Tasks Library")}
          </p>
          <p className="text-xs text-[color:var(--color-text-secondary)]">
            {localize(locale, "内置入口不会消失，只会从首页拿下或重新加入。", "Built-in packs always stay in the library and can be pinned again anytime.")}
          </p>
        </div>
        <ActionButton onClick={() => navigate("/packs")}>
          <Pin className="mr-2 h-4 w-4" />
          {localize(locale, "管理首页入口", "Manage Home Packs")}
        </ActionButton>
      </div>

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        currentRunLabel={selectedPackRunState.activeRun ? formatTimestamp(selectedPackRunState.activeRun.startedAt, locale) : null}
        continueLabel={selectedPackRunState.recentRun ? formatTimestamp(selectedPackRunState.recentRun.completedAt ?? selectedPackRunState.recentRun.startedAt, locale) : null}
        onClose={() => setSelectedPackId(null)}
        onOpenCurrent={selectedPackRunState.activeRun ? () => {
          setSelectedPackId(null);
          setPendingPackPath(selectedPack ? buildPackAssistantHref(selectedPack.id) : "/assistant");
        } : undefined}
        onContinue={selectedPackRunState.recentRun ? () => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack));
          }
        } : undefined}
        onStartNow={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack));
          }
        }}
        onAdjustBeforeStart={() => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackFlowHref(selectedPack, { mode: "adjust" }));
          }
        }}
        onOpenSkill={(skillId) => {
          setSelectedPackId(null);
          setPendingPackPath(buildSkillHref(skillId));
        }}
        onAskFriday={(prompt) => {
          setSelectedPackId(null);
          if (selectedPack) {
            setPendingPackPath(buildPackChatHref(selectedPack.id, prompt));
          }
        }}
        onOpenAssistant={selectedPack ? () => {
          setSelectedPackId(null);
          setPendingPackPath(buildPackAssistantHref(selectedPack.id));
        } : undefined}
        onRemoveFromHome={selectedPack && pinnedPackIds.includes(selectedPack.id) ? () => {
          unpinPack(selectedPack.id);
          setSelectedPackId(null);
        } : undefined}
      />
    </div>
  );
}
