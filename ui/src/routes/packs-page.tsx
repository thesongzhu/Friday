import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { CustomPackBuilder } from "@/components/core/custom-pack-builder";
import { PackCard } from "@/components/packs/pack-card";
import { PackQuickSheet } from "@/components/packs/pack-quick-sheet";
import { useAdaptivePollingInterval } from "@/hooks/use-adaptive-polling";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useCustomPacks } from "@/hooks/use-custom-packs";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { usePackLaunchActions } from "@/hooks/use-pack-launch-actions";
import { useUserProfile } from "@/hooks/use-user-profile";
import { agentApi } from "@/lib/api/agent";
import type { AgentRunRecord } from "@/lib/api/types";
import { localize } from "@/lib/i18n/localized-text";
import { buildAgentRunHref } from "@/lib/packs/custom-pack-runtime";
import { findPackRuns } from "@/lib/packs/pack-assistant-receipt";
import { buildPackAssistantHref, buildPackChatHref } from "@/lib/packs/pack-links";
import { buildCustomPackId, getPackById } from "@/lib/packs/pack-registry";
import { displayRunPreview, displayRunTask } from "@/lib/runs/run-health";
import { buildSkillHref } from "@/lib/skills/view-models";
import { useAppLocale } from "@/providers/locale-provider";

function labelForRunStatus(status: AgentRunRecord["status"], locale: "zh" | "en"): string {
  const labels: Record<AgentRunRecord["status"], { zh: string; en: string }> = {
    pending: { zh: "待开始", en: "Pending" },
    planning: { zh: "规划中", en: "Planning" },
    awaiting_clarification: { zh: "待澄清", en: "Needs Clarification" },
    awaiting_plan_approval: { zh: "待批计划", en: "Awaiting Plan Approval" },
    awaiting_tool_approval: { zh: "待批工具", en: "Awaiting Tool Approval" },
    executing: { zh: "执行中", en: "Executing" },
    testing: { zh: "验证中", en: "Validating" },
    fixing: { zh: "修复中", en: "Fixing" },
    completed: { zh: "已完成", en: "Completed" },
    failed: { zh: "失败", en: "Failed" },
    failed_tests: { zh: "测试失败", en: "Failed Tests" },
    cancelled: { zh: "已取消", en: "Cancelled" },
  };
  return locale === "zh" ? labels[status].zh : labels[status].en;
}

function toneForRunStatus(status: AgentRunRecord["status"]): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "failed_tests":
    case "cancelled":
      return "danger";
    case "pending":
    case "planning":
    case "awaiting_clarification":
    case "awaiting_plan_approval":
    case "awaiting_tool_approval":
    case "executing":
    case "testing":
    case "fixing":
      return "warning";
    default:
      return "neutral";
  }
}

function formatRunTimestamp(value: string, locale: "zh" | "en"): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function summarizeRun(run: AgentRunRecord, locale: "zh" | "en"): string {
  const text = displayRunPreview(run) || displayRunTask(run);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 139).trimEnd()}…`;
}

export function PacksPage() {
  const navigate = useAppNavigate();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const { pinnedPackIds, pinPack, unpinPack } = useHomeSurfacePreferences(profileType);
  const { customPackInputs, removeCustomPack } = useCustomPacks();
  const { startPackNow, adjustPackBeforeStart } = usePackLaunchActions(customPackInputs, { surface: "packs" });
  const pollInterval = useAdaptivePollingInterval({ activeMs: 12_000, backgroundMs: 36_000 });
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);

  const recentRunsQuery = useQuery({
    queryKey: ["packs", "recent-runs"],
    queryFn: () => agentApi.listRuns({ limit: 40 }),
    refetchInterval: pollInterval,
  });

  const customPacks = useMemo(
    () => customPackInputs
      .map((input, index) => {
        const packId = buildCustomPackId(input, index);
        const pack = getPackById(packId, customPackInputs);
        return pack ? { input, index, pack, packId } : null;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [customPackInputs],
  );
  const recentRuns = recentRunsQuery.data ?? [];
  const customPackIdSet = useMemo(() => new Set(customPacks.map((item) => item.pack.id)), [customPacks]);
  const recentCustomRuns = useMemo(
    () => recentRuns
      .filter((run) => {
        const packId = run.metadata?.packContext?.packId;
        return typeof packId === "string" && customPackIdSet.has(packId);
      })
      .slice(0, 8),
    [customPackIdSet, recentRuns],
  );

  const handleDeleteCustomPack = useCallback((index: number) => {
    if (!window.confirm(localize(locale, "确定删除这个自创任务吗？", "Are you sure you want to delete this custom task?"))) return;
    removeCustomPack(index);
  }, [locale, removeCustomPack]);

  const selectedPack = selectedPackId ? getPackById(selectedPackId, customPackInputs) ?? null : null;

  return (
    <div className="space-y-5 pb-4">
      <section
        data-testid="packs-surface-ready"
        className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]"
      >
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
          {localize(locale, "用户任务库", "User Task Library")}
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
          {localize(locale, "这里只展示你自创的任务", "Only your custom tasks live here")}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {localize(
            locale,
            "内置行业包和官方任务先不在这里展示。这个页面只保留你自己创建的任务，并直接挂真实运行状态与最近结果。",
            "Built-in packs stay hidden here for now. This page only shows the tasks you created and connects them to live runs and recent results.",
          )}
        </p>
      </section>

      <ShellCard title={localize(locale, "你的自创任务", "Your Custom Tasks")}>
        {customPacks.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-5 py-10 text-center">
            <p className="text-base font-medium text-[color:var(--color-text-primary)]">
              {localize(locale, "还没有自创任务", "You do not have any custom tasks yet")}
            </p>
            <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "先创建一个任务包，再让 Friday 用真实 run 去执行它。",
                "Create a task pack first, then let Friday execute it through real runs.",
              )}
            </p>
            <div className="mt-5 flex justify-center">
              <ActionButton onClick={() => setShowBuilder(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {localize(locale, "创建自创任务", "Create a custom task")}
              </ActionButton>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {customPacks.map(({ input, index, pack, packId }) => {
              const runState = findPackRuns(pack, recentRuns);
              const latestRun = runState.activeRun ?? runState.recentRun;
              const note = latestRun
                ? summarizeRun(latestRun, locale)
                : localize(locale, input.description, input.descriptionEn || input.description);

              return (
                <div key={packId} className="relative">
                  <PackCard
                    pack={pack}
                    pinned={pinnedPackIds.includes(packId)}
                    statusLabel={runState.activeRun
                      ? localize(locale, "真实运行中", "Live run")
                      : runState.recentRun
                        ? localize(locale, "最近真实运行", "Recent live run")
                        : undefined}
                    note={note}
                    onOpen={() => setSelectedPackId(pack.id)}
                    onPin={!pinnedPackIds.includes(packId) ? () => pinPack(packId) : undefined}
                    onUnpin={pinnedPackIds.includes(packId) ? () => unpinPack(packId) : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => handleDeleteCustomPack(index)}
                    className="absolute right-3 top-3 rounded-lg p-1.5 text-[color:var(--color-text-tertiary)] hover:bg-[color:var(--color-bg-hover)] hover:text-[color:var(--color-danger)]"
                    title={localize(locale, "删除", "Delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => setShowBuilder(true)}
              className="flex min-h-[100px] items-center justify-center rounded-2xl border-2 border-dashed border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-6 text-sm font-medium text-[color:var(--color-text-secondary)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]"
            >
              <Plus className="mr-2 h-4 w-4" />
              {localize(locale, "创建自创任务", "Create a custom task")}
            </button>
          </div>
        )}
      </ShellCard>

      <ShellCard title={localize(locale, "最近真实运行", "Recent Live Runs")}>
        {recentRunsQuery.isLoading ? (
          <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "正在读取真实运行记录。", "Loading live run history.")}
          </div>
        ) : recentCustomRuns.length === 0 ? (
          <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4 text-sm text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "你的自创任务还没有产生真实 run。点开任意任务后直接开始，列表就会开始显示真实执行记录。",
              "Your custom tasks have not produced any live runs yet. Start one from a task card and this list will begin reflecting real execution history.",
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {recentCustomRuns.map((run) => {
              const runPackId = run.metadata?.packContext?.packId ?? "";
              const pack = getPackById(runPackId, customPackInputs);
              return (
                <div
                  key={run.id}
                  className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {pack ? (
                          <span className="rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1 text-xs text-[color:var(--color-text-secondary)]">
                            {locale === "zh" ? pack.title.zh : pack.title.en}
                          </span>
                        ) : null}
                        <StatusPill tone={toneForRunStatus(run.status)}>
                          {labelForRunStatus(run.status, locale)}
                        </StatusPill>
                      </div>
                      <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">{displayRunTask(run)}</p>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                        {summarizeRun(run, locale)}
                      </p>
                      <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-text-faint)]">
                        {formatRunTimestamp(run.completedAt ?? run.startedAt, locale)}
                      </p>
                    </div>
                    <ActionButton tone="secondary" onClick={() => navigate(buildAgentRunHref(run.id))}>
                      {localize(locale, "打开运行", "Open run")}
                    </ActionButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ShellCard>

      <CustomPackBuilder
        open={showBuilder}
        onClose={() => setShowBuilder(false)}
        onSaved={() => undefined}
      />

      <PackQuickSheet
        open={Boolean(selectedPack)}
        pack={selectedPack}
        onClose={() => setSelectedPackId(null)}
        onStartNow={() => {
          if (!selectedPack) {
            return;
          }
          setSelectedPackId(null);
          void startPackNow(selectedPack);
        }}
        onAdjustBeforeStart={() => {
          if (!selectedPack) {
            return;
          }
          setSelectedPackId(null);
          adjustPackBeforeStart(selectedPack);
        }}
        onOpenSkill={(skillId) => {
          setSelectedPackId(null);
          navigate(buildSkillHref(skillId));
        }}
        onAskFriday={(prompt) => {
          setSelectedPackId(null);
          if (selectedPack) {
            navigate(buildPackChatHref(selectedPack.id, prompt));
          }
        }}
        onOpenAssistant={selectedPack ? () => {
          setSelectedPackId(null);
          navigate(buildPackAssistantHref(selectedPack.id));
        } : undefined}
        onRemoveFromHome={selectedPack && pinnedPackIds.includes(selectedPack.id) ? () => {
          unpinPack(selectedPack.id);
          setSelectedPackId(null);
        } : undefined}
      />
    </div>
  );
}
