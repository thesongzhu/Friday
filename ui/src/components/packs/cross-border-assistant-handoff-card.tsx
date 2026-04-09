import { ArrowRight, Flag, ListChecks, MessageSquareWarning } from "lucide-react";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import type { FridayCrossBorderSnapshot } from "../../../../src/packs/cross-border/friday-cross-border-pack.types";
import { getFridayCrossBorderWorkflowCatalogEntry } from "../../../../src/packs/cross-border/friday-cross-border-workflow-catalog";
import { useAppLocale } from "@/providers/locale-provider";

function localizeRuleText(
  locale: "zh" | "en",
  text: { zh: string; en: string },
): string {
  return locale === "zh" ? text.zh : text.en;
}

export function CrossBorderAssistantHandoffCard(props: {
  snapshot: FridayCrossBorderSnapshot;
  onOpenSetup?: () => void;
  onContinueInChat?: () => void;
  onOpenWorkflowTemplate?: (templateId: string) => void;
  onOpenManagedWorkflow?: (workflowId: string) => void;
  onSetWorkflowEnabled?: (workflowId: FridayCrossBorderSnapshot["workflowRecommendations"][number]["id"], enabled: boolean) => void;
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
    <div
      className="rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-5 py-5"
      data-testid="cross-border-assistant-handoff"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "跨境经营交接", "Cross-border Handoff")}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
            {localize(locale, "把今天的经营问题压成可执行动作", "Turn today’s operating issues into executable moves")}
          </h3>
        </div>
        <StatusPill tone="success">{operatingMode}</StatusPill>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <section className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
              <MessageSquareWarning className="h-4 w-4 text-[color:var(--color-accent)]" />
              <span>{localize(locale, "当前最严重的 3 个问题", "Top 3 issues right now")}</span>
            </div>
            <div className="mt-3 space-y-3">
              {snapshot.riskClusters.slice(0, 3).map((risk) => (
                <div key={risk.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{risk.title}</p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">{risk.summary}</p>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
              <Flag className="h-4 w-4 text-[color:var(--color-accent)]" />
              <span>{localize(locale, "今日必须处理动作", "Today’s must-do actions")}</span>
            </div>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              {snapshot.nextActions.slice(0, 4).map((action) => (
                <li key={action.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                  <span className="font-medium text-[color:var(--color-text-primary)]">{action.title}</span>
                  <span className="ml-1">{action.summary}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="space-y-3">
          <section className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
              <ListChecks className="h-4 w-4 text-[color:var(--color-accent)]" />
              <span>{localize(locale, "本周继续跟踪", "Keep tracking this week")}</span>
            </div>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              {(snapshot.workflowRecommendations.slice(0, 3)).map((workflow) => (
                <li key={workflow.id} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                  <span className="font-medium text-[color:var(--color-text-primary)]">
                    {locale === "zh"
                      ? getFridayCrossBorderWorkflowCatalogEntry(workflow.id).titleZh
                      : getFridayCrossBorderWorkflowCatalogEntry(workflow.id).titleEn}
                  </span>
                  <span className="ml-1">{workflow.rationale}</span>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {workflow.automation && props.onOpenManagedWorkflow ? (
                      <ActionButton
                        tone="secondary"
                        data-testid={`cross-border-handoff-open-managed-workflow-${workflow.id}`}
                        onClick={() => props.onOpenManagedWorkflow?.(workflow.automation!.managedWorkflowId)}
                      >
                        {localize(locale, "打开已启用流程", "Open active workflow")}
                      </ActionButton>
                    ) : props.onOpenWorkflowTemplate ? (
                      <ActionButton
                        tone="secondary"
                        data-testid={`cross-border-handoff-open-workflow-${workflow.id}`}
                        onClick={() => props.onOpenWorkflowTemplate?.(workflow.templateId)}
                      >
                        {localize(locale, "打开流程模板", "Open workflow template")}
                      </ActionButton>
                    ) : null}
                    {props.onSetWorkflowEnabled ? (
                      workflow.automation?.status === "active" ? (
                        <ActionButton
                          data-testid={`cross-border-handoff-disable-workflow-${workflow.id}`}
                          onClick={() => props.onSetWorkflowEnabled?.(workflow.id, false)}
                          disabled={props.togglingWorkflowId === workflow.id}
                        >
                          {props.togglingWorkflowId === workflow.id
                            ? localize(locale, "处理中…", "Working…")
                            : localize(locale, "暂停自动运行", "Pause automation")}
                        </ActionButton>
                      ) : (
                        <ActionButton
                          data-testid={`cross-border-handoff-enable-workflow-${workflow.id}`}
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
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {localize(locale, "Friday 建议的流程调整", "Friday’s workflow tuning suggestions")}
            </p>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              {snapshot.workflowRecommendations.slice(0, 3).map((workflow) => (
                <li key={`tune:${workflow.id}`} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                  <span className="font-medium text-[color:var(--color-text-primary)]">
                    {locale === "zh"
                      ? getFridayCrossBorderWorkflowCatalogEntry(workflow.id).titleZh
                      : getFridayCrossBorderWorkflowCatalogEntry(workflow.id).titleEn}
                  </span>
                  <span className="ml-1">{localizeRuleText(locale, workflow.policy.currentGuidance.summary)}</span>
                </li>
              ))}
              {snapshot.workflowRecommendations
                .flatMap((workflow) => workflow.policy.approvalBoundaries.slice(0, 1))
                .slice(0, 2)
                .map((boundary) => (
                  <li key={`approval:${boundary.en}`} className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
                    {localizeRuleText(locale, boundary)}
                  </li>
                ))}
            </ul>
          </section>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {props.onOpenSetup ? (
          <ActionButton data-testid="cross-border-handoff-open-setup" tone="secondary" onClick={props.onOpenSetup}>
            {localize(locale, "调整经营设置", "Adjust profile")}
          </ActionButton>
        ) : null}
        {props.onContinueInChat ? (
          <ActionButton data-testid="cross-border-handoff-continue-chat" onClick={props.onContinueInChat}>
            {localize(locale, "继续让 Friday 跟进", "Continue with Friday")}
            <ArrowRight className="ml-2 h-4 w-4" />
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}
