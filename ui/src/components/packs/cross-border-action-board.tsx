import { ArrowRight, Flag, ShieldAlert, TrendingUp } from "lucide-react";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import type { FridayCrossBorderSnapshot } from "../../../../src/packs/cross-border/friday-cross-border-pack.types";
import { getFridayCrossBorderWorkflowCatalogEntry } from "../../../../src/packs/cross-border/friday-cross-border-workflow-catalog";
import { useAppLocale } from "@/providers/locale-provider";

function toneLabel(tone: "neutral" | "watch" | "urgent", locale: "zh" | "en"): string {
  switch (tone) {
    case "urgent":
      return localize(locale, "高优先级", "Urgent");
    case "watch":
      return localize(locale, "继续跟踪", "Watch");
    default:
      return localize(locale, "常规", "Normal");
  }
}

function localizeRuleText(
  locale: "zh" | "en",
  text: { zh: string; en: string },
): string {
  return locale === "zh" ? text.zh : text.en;
}

export function CrossBorderActionBoard(props: {
  snapshot: FridayCrossBorderSnapshot;
  onOpenSetup?: () => void;
  onOpenAssistant?: () => void;
  onOpenWorkflowTemplate?: (templateId: string) => void;
  onOpenManagedWorkflow?: (workflowId: string) => void;
  onApplyDefaultWorkflows?: () => void;
  onSetWorkflowEnabled?: (workflowId: FridayCrossBorderSnapshot["workflowRecommendations"][number]["id"], enabled: boolean) => void;
  isApplyingDefaultWorkflows?: boolean;
  togglingWorkflowId?: string | null;
}) {
  const { locale } = useAppLocale();
  const { snapshot } = props;
  if (!snapshot.profile) {
    return null;
  }

  const operatingMode = snapshot.profile.regionFocus === "sea_tiktok"
    ? localize(locale, "东南亚 / TikTok Shop", "SEA / TikTok Shop")
    : localize(locale, "北美 / Amazon", "North America / Amazon");

  return (
    <ShellCard
      className="cross-border-action-board"
      eyebrow={localize(locale, "跨境经营系统", "Cross-border Operating System")}
      title={localize(locale, "今日跨境动作板", "Today’s Cross-border Board")}
      aside={<StatusPill tone="success">{operatingMode}</StatusPill>}
    >
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]" data-testid="cross-border-action-board">
        <div className="space-y-3">
          <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
              <ShieldAlert className="h-4 w-4 text-[color:var(--color-accent)]" />
              <span>{localize(locale, "当前最需要盯的 3 件事", "Top 3 things to watch now")}</span>
            </div>
            <div className="mt-3 space-y-3">
              {snapshot.riskClusters.length === 0 ? (
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  {localize(locale, "还没有足够数据，先完成 setup 和第一批导入。", "There is not enough data yet. Finish setup and your first import batch.")}
                </p>
              ) : snapshot.riskClusters.slice(0, 3).map((risk) => (
                <div key={risk.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{risk.title}</p>
                    <StatusPill tone={risk.tone === "urgent" ? "danger" : risk.tone === "watch" ? "warning" : "neutral"}>
                      {toneLabel(risk.tone, locale)}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{risk.summary}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
              <Flag className="h-4 w-4 text-[color:var(--color-accent)]" />
              <span>{localize(locale, "今天必须处理的动作", "Must-do actions today")}</span>
            </div>
            <div className="mt-3 space-y-3">
              {snapshot.nextActions.slice(0, 4).map((action) => (
                <div key={action.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{action.title}</p>
                    <StatusPill tone={action.requiresApproval ? "warning" : action.tone === "urgent" ? "danger" : "neutral"}>
                      {action.requiresApproval
                        ? localize(locale, "需确认", "Approval")
                        : toneLabel(action.tone, locale)}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{action.summary}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {[snapshot.storeHealth, snapshot.categoryWatch, snapshot.priceGapBoard, snapshot.spikingProducts].filter(Boolean).map((board) => (
            <div key={board!.title} className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{board!.title}</p>
                <StatusPill tone={board!.tone === "urgent" ? "danger" : board!.tone === "watch" ? "warning" : "neutral"}>
                  {toneLabel(board!.tone, locale)}
                </StatusPill>
              </div>
              <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{board!.summary}</p>
              <ul className="mt-3 space-y-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                {board!.bullets.slice(0, 3).map((bullet) => (
                  <li key={bullet} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-2">
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
                <TrendingUp className="h-4 w-4 text-[color:var(--color-accent)]" />
                <span>{localize(locale, "默认稳定流程", "Default stable workflows")}</span>
              </div>
              {props.onApplyDefaultWorkflows ? (
                <ActionButton
                  tone="secondary"
                  data-testid="cross-border-apply-default-workflows"
                  onClick={() => props.onApplyDefaultWorkflows?.()}
                  disabled={props.isApplyingDefaultWorkflows}
                >
                  {props.isApplyingDefaultWorkflows
                    ? localize(locale, "启用中…", "Enabling…")
                    : localize(locale, "启用默认流程", "Enable defaults")}
                </ActionButton>
              ) : null}
            </div>
            <div className="mt-3 space-y-3">
              {snapshot.workflowRecommendations.map((workflow) => (
                <div key={workflow.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3">
                  {(() => {
                    const catalogEntry = getFridayCrossBorderWorkflowCatalogEntry(workflow.id);
                    const workflowTitle = locale === "zh" ? catalogEntry.titleZh : catalogEntry.titleEn;
                    return (
                      <>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{workflowTitle}</p>
                    <StatusPill tone={workflow.automation?.status === "active" ? "success" : workflow.automation?.status === "paused" ? "warning" : "neutral"}>
                      {workflow.automation?.status === "active"
                        ? localize(locale, "已启用", "Active")
                        : workflow.automation?.status === "paused"
                          ? localize(locale, "已暂停", "Paused")
                          : workflow.cadence === "daily"
                            ? localize(locale, "每日", "Daily")
                            : localize(locale, "每周", "Weekly")}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{workflow.rationale}</p>
                  <div className="mt-2 space-y-2 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3 text-[11px] leading-5 text-[color:var(--color-text-secondary)]">
                    <p>
                      <span className="font-medium text-[color:var(--color-text-primary)]">
                        {localize(locale, "默认节奏：", "Default cadence:")}
                      </span>
                      {localizeRuleText(locale, workflow.policy.cadence.summary)}
                    </p>
                    <p>
                      <span className="font-medium text-[color:var(--color-text-primary)]">
                        {localize(locale, "当前建议：", "Current guidance:")}
                      </span>
                      {localizeRuleText(locale, workflow.policy.currentGuidance.summary)}
                    </p>
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">
                        {localize(locale, "建议暂停条件", "Pause when")}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {workflow.policy.pauseConditions.slice(0, 2).map((condition) => (
                          <li key={`${workflow.id}:${condition.en}`} className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1.5">
                            {localizeRuleText(locale, condition)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="font-medium text-[color:var(--color-text-primary)]">
                        {localize(locale, "需人工确认", "Approval boundary")}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {workflow.policy.approvalBoundaries.slice(0, 2).map((boundary) => (
                          <li key={`${workflow.id}:${boundary.en}`} className="rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-2.5 py-1.5">
                            {localizeRuleText(locale, boundary)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {workflow.automation?.nextRunAt ? (
                    <p className="mt-2 text-[11px] leading-5 text-[color:var(--color-text-secondary)]">
                      {localize(locale, "下次执行：", "Next run: ")}
                      {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: workflow.automation.schedule.timezone,
                      }).format(new Date(workflow.automation.nextRunAt))}
                      {workflow.automation.schedule.timezone ? ` · ${workflow.automation.schedule.timezone}` : ""}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {workflow.automation && props.onOpenManagedWorkflow ? (
                      <ActionButton
                        tone="secondary"
                        data-testid={`cross-border-open-managed-workflow-${workflow.id}`}
                        onClick={() => props.onOpenManagedWorkflow?.(workflow.automation!.managedWorkflowId)}
                      >
                        {localize(locale, "打开已启用流程", "Open active workflow")}
                      </ActionButton>
                    ) : props.onOpenWorkflowTemplate ? (
                      <ActionButton
                        tone="secondary"
                        data-testid={`cross-border-open-workflow-${workflow.id}`}
                        onClick={() => props.onOpenWorkflowTemplate?.(workflow.templateId)}
                      >
                        {localize(locale, "打开流程模板", "Open workflow template")}
                      </ActionButton>
                    ) : null}
                    {props.onSetWorkflowEnabled ? (
                      workflow.automation?.status === "active" ? (
                        <ActionButton
                          data-testid={`cross-border-disable-workflow-${workflow.id}`}
                          onClick={() => props.onSetWorkflowEnabled?.(workflow.id, false)}
                          disabled={props.togglingWorkflowId === workflow.id}
                        >
                          {props.togglingWorkflowId === workflow.id
                            ? localize(locale, "处理中…", "Working…")
                            : localize(locale, "暂停自动运行", "Pause automation")}
                        </ActionButton>
                      ) : (
                        <ActionButton
                          data-testid={`cross-border-enable-workflow-${workflow.id}`}
                          onClick={() => props.onSetWorkflowEnabled?.(workflow.id, true)}
                          disabled={props.togglingWorkflowId === workflow.id}
                        >
                          {props.togglingWorkflowId === workflow.id
                            ? localize(locale, "处理中…", "Working…")
                            : workflow.automation?.status === "paused"
                              ? localize(locale, "恢复自动运行", "Resume automation")
                              : localize(locale, "启用这个流程", "Enable this workflow")}
                        </ActionButton>
                      )
                    ) : null}
                  </div>
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {props.onOpenSetup ? (
          <ActionButton data-testid="cross-border-open-setup" tone="secondary" onClick={props.onOpenSetup}>
            {localize(locale, "调整经营设置", "Adjust operating profile")}
          </ActionButton>
        ) : null}
        {props.onOpenAssistant ? (
          <ActionButton data-testid="cross-border-open-assistant" onClick={props.onOpenAssistant}>
            {localize(locale, "进入助手交接", "Open assistant handoff")}
            <ArrowRight className="ml-2 h-4 w-4" />
          </ActionButton>
        ) : null}
      </div>
    </ShellCard>
  );
}
