import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, RefreshCcw, ShieldAlert, Sparkles } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { CrossBorderAssistantHandoffCard } from "@/components/packs/cross-border-assistant-handoff-card";
import { PackAssistantHandoffCard } from "@/components/packs/pack-assistant-handoff-card";
import { useAdaptivePollingInterval } from "@/hooks/use-adaptive-polling";
import { useAppNavigate } from "@/hooks/use-app-navigate";
import { useCrossBorderWorkflowPresets } from "@/hooks/use-cross-border-workflow-presets";
import { useHomeSurfacePreferences } from "@/hooks/use-home-surface-preferences";
import { useUserProfile } from "@/hooks/use-user-profile";
import { crossBorderPackApi } from "@/lib/api/cross-border-pack";
import { uixSnapshotsApi } from "@/lib/api/uix-snapshots";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { buildPackAssistantHref, buildPackChatHref } from "@/lib/packs/pack-links";
import { mergeCrossBorderSnapshots, readNavigationCrossBorderSnapshot } from "@/lib/packs/cross-border-snapshot";
import { getPackById } from "@/lib/packs/pack-registry";
import {
  describeRunHealth,
  labelForRunHealth,
  summarizeRunContext,
  toneForRunHealth,
} from "@/lib/runs/run-health";
import { buildSkillHref } from "@/lib/skills/view-models";
import { useAppLocale } from "@/providers/locale-provider";
export function AssistantInboxPage() {
  const navigate = useAppNavigate();
  const { locale } = useAppLocale();
  const { profileType } = useUserProfile();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { pinnedPackIds } = useHomeSurfacePreferences(profileType);
  const pollInterval = useAdaptivePollingInterval({ activeMs: 12_000, backgroundMs: 36_000 });
  const { setWorkflowEnabled, togglingWorkflowId } = useCrossBorderWorkflowPresets();

  const snapshotQuery = useQuery({
    queryKey: ["assistant-inbox", "snapshot"],
    queryFn: () => uixSnapshotsApi.getAssistantInbox(),
    refetchInterval: pollInterval,
  });
  const selectedPackId = searchParams.get("packId");
  const navigationCrossBorderSnapshot = selectedPackId === "industry-cross-border-ecommerce"
    ? readNavigationCrossBorderSnapshot(location.state)
    : undefined;
  const crossBorderSnapshotQuery = useQuery({
    queryKey: ["cross-border-pack", "snapshot"],
    queryFn: () => crossBorderPackApi.getSnapshot(),
    refetchInterval: pollInterval,
    enabled: selectedPackId === "industry-cross-border-ecommerce" || pinnedPackIds.includes("industry-cross-border-ecommerce"),
    initialData: navigationCrossBorderSnapshot,
    staleTime: navigationCrossBorderSnapshot ? 30_000 : 0,
  });
  const effectiveCrossBorderSnapshot = useMemo(
    () => mergeCrossBorderSnapshots(navigationCrossBorderSnapshot, crossBorderSnapshotQuery.data),
    [crossBorderSnapshotQuery.data, navigationCrossBorderSnapshot],
  );

  const approvals = snapshotQuery.data?.approvals ?? [];
  const alerts = snapshotQuery.data?.alerts ?? [];
  const recentRuns = snapshotQuery.data?.recentRuns ?? [];
  const curatedPacks = pinnedPackIds
    .map((packId) => getPackById(packId))
    .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => Boolean(pack))
    .filter((pack) => pack.curatedSkills.length > 0)
    .slice(0, 3);
  const selectedPack = selectedPackId ? getPackById(selectedPackId) ?? null : null;
  const scrollToSection = (sectionId: string) => {
    const target = document.getElementById(sectionId);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-5 pb-4">
      <section
        data-testid="assistant-inbox"
        className="rounded-[30px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-5 py-5 shadow-[var(--shadow-floating)]"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "助手收件箱", "Assistant")}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
              {localize(locale, "先处理待确认、异常和恢复路径", "Focus on approvals, issues, and recovery")}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {localize(
                locale,
                "这里不再承担开始新任务的职责，只收拢你现在必须看一眼的风险、待确认动作和最近运行轨迹。",
                "Assistant no longer acts as the main start page. It stays focused on what needs attention now: approvals, risks, and recent run history.",
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ActionButton data-testid="assistant-inbox-start-task" onClick={() => navigate("/chat")}>
              <Sparkles className="mr-2 h-4 w-4" />
              {localize(locale, "回到聊天开始新任务", "Start a new task in chat")}
            </ActionButton>
          </div>
        </div>
      </section>

      {selectedPack?.productCopy ? (
        <ShellCard title={localize(locale, "当前行业包交接", "Current Pack Handoff")}>
          {selectedPack.id === "industry-cross-border-ecommerce" && effectiveCrossBorderSnapshot?.profile ? (
            <div className="mb-4">
              <CrossBorderAssistantHandoffCard
                snapshot={effectiveCrossBorderSnapshot}
                onOpenSetup={() => navigate("/packs/cross-border/setup?packId=industry-cross-border-ecommerce&mode=adjust")}
                onContinueInChat={() => navigate(buildPackChatHref(selectedPack.id))}
                onOpenWorkflowTemplate={(templateId) => navigate(`/workflows/builder?templateId=${encodeURIComponent(templateId)}`)}
                onOpenManagedWorkflow={(workflowId) => navigate(`/workflows/builder?workflowId=${encodeURIComponent(workflowId)}`)}
                onSetWorkflowEnabled={setWorkflowEnabled}
                togglingWorkflowId={togglingWorkflowId}
              />
            </div>
          ) : null}
          <PackAssistantHandoffCard
            pack={selectedPack}
            runs={recentRuns}
            approvalsCount={approvals.length}
            alertCount={alerts.length}
            onUsePrompt={(prompt) => navigate(buildPackChatHref(selectedPack.id, resolveLocalizedText(prompt.prompt, locale)))}
            onContinueInChat={() => navigate(buildPackChatHref(selectedPack.id))}
            onReviewApprovals={() => scrollToSection("assistant-approvals-section")}
            onOpenObservability={() => navigate("/observability")}
          />
        </ShellCard>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <ShellCard title={localize(locale, "待确认", "Pending Approvals")}>
          <div id="assistant-approvals-section" />
          {approvals.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "当前没有需要你确认的动作。", "There is nothing waiting for your approval right now.")}
            </p>
          ) : (
            <div className="space-y-3">
              {approvals.map((action) => (
                <div
                  key={action.id}
                  className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{action.title}</p>
                    <StatusPill tone="warning">{localize(locale, "待确认", "Needs Review")}</StatusPill>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{action.summary}</p>
                </div>
              ))}
            </div>
          )}
        </ShellCard>

        <ShellCard title={localize(locale, "恢复路径", "Recovery Paths")}>
          <div id="assistant-recovery-section" />
          {alerts.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              {localize(locale, "当前没有正在触发的告警。", "There are no active alerts firing right now.")}
            </p>
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div key={alert.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-[color:var(--color-accent)]" />
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{alert.title}</p>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {alert.summary}
                  </p>
                </div>
              ))}
            </div>
          )}
        </ShellCard>
      </div>

      <ShellCard title={localize(locale, "最近运行轨迹", "Recent Run History")}>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {localize(locale, "最近还没有运行记录。", "There is no recent run history yet.")}
          </p>
        ) : (
          <div className="space-y-3">
            {recentRuns.map((run) => (
              <div key={run.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[color:var(--color-text-primary)]">{run.task}</p>
                    <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
                      {describeRunHealth(run, locale)
                        || summarizeRunContext(run, locale)
                        || run.summary
                        || run.responseText
                        || run.errorMessage
                        || localize(locale, "等待更多输出", "Waiting for more output")}
                    </p>
                  </div>
                  <StatusPill tone={toneForRunHealth(run)}>{labelForRunHealth(run, locale)}</StatusPill>
                </div>
              </div>
            ))}
          </div>
        )}
      </ShellCard>

      {curatedPacks.length > 0 ? (
        <ShellCard title={localize(locale, "固定行业包的推荐动作", "Curated Skills From Your Pinned Packs")}>
          <div className="space-y-3">
            {curatedPacks.map((pack) => (
              <div
                key={pack.id}
                className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                      {resolveLocalizedText(pack.title, locale)}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                      {resolveLocalizedText(pack.summary, locale)}
                    </p>
                  </div>
                  <StatusPill tone="neutral">
                    {localize(locale, "已固定", "Pinned")}
                  </StatusPill>
                </div>
                <div className="mt-3 space-y-3">
                  {pack.curatedSkills.map((skill) => (
                    <div
                      key={skill.skillId}
                      className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3"
                    >
                      <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                        {resolveLocalizedText(skill.title, locale)}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                        {resolveLocalizedText(skill.summary, locale)}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <ActionButton tone="secondary" onClick={() => navigate(buildSkillHref(skill.skillId))}>
                          {localize(locale, "打开技能", "Open Skill")}
                        </ActionButton>
                        <ActionButton
                          onClick={() => navigate(buildPackChatHref(pack.id, resolveLocalizedText(skill.starterPrompt, locale)))}
                        >
                          {localize(locale, "去聊天开始", "Use In Chat")}
                        </ActionButton>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ShellCard>
      ) : null}

      {pinnedPackIds.length > 0 ? (
        <ShellCard title={localize(locale, "固定行业包的结果交接", "Pinned Pack Handoffs")}>
          <div className="grid gap-3 lg:grid-cols-2">
            {pinnedPackIds
              .map((packId) => getPackById(packId))
              .filter((pack): pack is NonNullable<ReturnType<typeof getPackById>> => Boolean(pack?.productCopy))
              .slice(0, 4)
              .map((pack) => (
                <PackAssistantHandoffCard
                  key={pack.id}
                  pack={pack}
                  runs={recentRuns}
                  approvalsCount={approvals.length}
                  alertCount={alerts.length}
                  compact
                  onUsePrompt={(prompt) => navigate(buildPackChatHref(pack.id, resolveLocalizedText(prompt.prompt, locale)))}
                  onContinueInChat={() => navigate(buildPackChatHref(pack.id))}
                  onOpenAssistant={() => navigate(buildPackAssistantHref(pack.id))}
                  onReviewApprovals={() => scrollToSection("assistant-approvals-section")}
                  onOpenObservability={() => navigate("/observability")}
                />
              ))}
          </div>
        </ShellCard>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <ActionButton tone="secondary" className="w-full" onClick={() => navigate("/observability")}>
          <ShieldAlert className="mr-2 h-4 w-4" />
          {localize(locale, "看告警和系统健康", "Open observability")}
        </ActionButton>
        <ActionButton tone="secondary" className="w-full" onClick={() => navigate("/automations")}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          {localize(locale, "看自动化队列", "Open automations")}
        </ActionButton>
        <ActionButton tone="secondary" className="w-full" onClick={() => navigate("/command-center")}>
          <CheckCircle2 className="mr-2 h-4 w-4" />
          {localize(locale, "进入更深的控制台", "Go deeper")}
          <ArrowRight className="ml-2 h-4 w-4" />
        </ActionButton>
      </div>
    </div>
  );
}
