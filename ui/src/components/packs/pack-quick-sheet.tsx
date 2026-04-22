import { useEffect } from "react";
import { ArrowRight, Clock3, Play, Settings2, Sparkles, X } from "lucide-react";
import { ActionButton } from "@/components/core/primitives";
import { PackProductPreview } from "@/components/packs/pack-product-preview";
import { resolveLocalizedText } from "@/lib/i18n/localized-text";
import type { FridayPackCuratedSkill, FridayPackDefinition } from "@/lib/packs/pack-registry";
import { useAppLocale } from "@/providers/locale-provider";

export interface PackQuickSheetProps {
  open: boolean;
  pack: FridayPackDefinition | null;
  currentRunLabel?: string | null;
  continueLabel?: string | null;
  automationHint?: string | null;
  onClose: () => void;
  onOpenCurrent?: () => void;
  onContinue?: () => void;
  onStartNow: () => void;
  onAdjustBeforeStart: () => void;
  onRemoveFromHome?: () => void;
  onOpenSkill?: (skillId: string) => void;
  onAskFriday?: (prompt: string) => void;
  onOpenAssistant?: () => void;
}

export function PackQuickSheet(props: PackQuickSheetProps) {
  const { locale } = useAppLocale();

  useEffect(() => {
    if (!props.open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.open, props.onClose]);

  if (!props.open || !props.pack) {
    return null;
  }

  const title = resolveLocalizedText(props.pack.title, locale);
  const summary = resolveLocalizedText(props.pack.summary, locale);
  const curatedSkills = props.pack.curatedSkills ?? [];

  return (
    <div className="fixed inset-0 z-50 px-4 py-4 sm:px-6 lg:px-8">
      <button
        type="button"
        data-testid="pack-quick-backdrop"
        aria-label={locale === "zh" ? "关闭任务详情" : "Close task details"}
        onClick={props.onClose}
        className="absolute inset-0 bg-[rgba(20,16,14,0.18)] backdrop-blur-[3px]"
      />

      <div className="relative mx-auto flex h-full max-w-[1100px] items-end lg:items-center">
        <section
          data-testid="pack-quick-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pack-quick-sheet-title"
          className="relative w-full overflow-hidden rounded-[32px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] shadow-[var(--shadow-card-strong)]"
          style={{ maxHeight: "min(90vh, 960px)" }}
        >
          <button
            type="button"
            onClick={props.onClose}
            data-testid="pack-quick-close"
            className="absolute right-4 top-4 z-10 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2 text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
            aria-label={locale === "zh" ? "关闭" : "Close"}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="grid min-h-0 lg:grid-cols-[minmax(0,1.14fr)_340px]">
            <div className="min-h-0 overflow-y-auto px-5 py-5 lg:px-7 lg:py-6">
              <div className="max-w-3xl pr-10">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                  {locale === "zh" ? "行业与任务入口" : "Industry & Tasks"}
                </p>
                <h2
                  id="pack-quick-sheet-title"
                  className="mt-2 text-[26px] font-semibold tracking-tight text-[color:var(--color-text-primary)] lg:text-[30px]"
                >
                  {title}
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-[color:var(--color-text-secondary)] lg:text-[15px]">
                  {summary}
                </p>
              </div>

              {props.automationHint ? (
                <div className="mt-5 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-4">
                  <p className="flex items-start gap-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl bg-[color:var(--color-bg-surface)] text-[color:var(--color-accent)]">
                      <Clock3 className="h-4 w-4" />
                    </span>
                    <span>{props.automationHint}</span>
                  </p>
                </div>
              ) : null}

              <div className="mt-5 rounded-[28px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-3 lg:p-4">
                <PackProductPreview
                  pack={props.pack}
                  compact
                  onUsePrompt={props.onAskFriday ? (prompt) => props.onAskFriday?.(resolveLocalizedText(prompt.prompt, locale)) : undefined}
                  onOpenAssistant={props.onOpenAssistant}
                />
              </div>

              {curatedSkills.length > 0 ? (
                <div className="mt-6 border-t border-[color:var(--color-border-soft)] pt-5">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-2xl bg-[color:var(--color-bg-subtle)] text-[color:var(--color-accent)]">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                        {locale === "zh" ? "推荐技能" : "Curated Skills"}
                      </p>
                      <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
                        {locale === "zh"
                          ? "这些动作会直接落到当前任务上下文里。"
                          : "These actions land directly in the current task context."}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 xl:grid-cols-2">
                    {curatedSkills.map((skill) => (
                      <PackCuratedSkillCard
                        key={skill.skillId}
                        skill={skill}
                        locale={locale}
                        onOpenSkill={props.onOpenSkill}
                        onAskFriday={props.onAskFriday}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <aside
              className="flex min-h-0 flex-col border-t bg-[color:var(--color-bg-subtle)] px-5 py-5 lg:border-l lg:border-t-0 lg:px-6 lg:py-6"
              style={{ borderColor: "var(--color-border-soft)" }}
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                  {locale === "zh" ? "启动方式" : "Launch Options"}
                </p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  {locale === "zh"
                    ? "先决定是否直接开跑、接着上次进度，还是先在聊天里细化。"
                    : "Choose whether to start immediately, continue the latest run, or refine it in chat first."}
                </p>
              </div>

              <div className="mt-5 space-y-3">
                {props.onOpenCurrent && props.currentRunLabel ? (
                  <ActionButton tone="secondary" onClick={props.onOpenCurrent} className="w-full justify-between">
                    <span data-testid="pack-quick-open-current" className="sr-only" />
                    <span>{locale === "zh" ? "打开当前任务" : "Open Current Run"}</span>
                    <span className="max-w-[120px] truncate text-xs text-[color:var(--color-text-tertiary)]">
                      {props.currentRunLabel}
                    </span>
                  </ActionButton>
                ) : null}

                {props.onContinue && props.continueLabel ? (
                  <ActionButton
                    data-testid="pack-quick-continue"
                    tone="secondary"
                    onClick={props.onContinue}
                    className="w-full justify-between"
                  >
                    <span>{locale === "zh" ? "继续上次任务" : "Continue Last"}</span>
                    <span className="max-w-[120px] truncate text-xs text-[color:var(--color-text-tertiary)]">
                      {props.continueLabel}
                    </span>
                  </ActionButton>
                ) : null}

                <ActionButton data-testid="pack-quick-start" onClick={props.onStartNow} className="w-full justify-between">
                  <span>{locale === "zh" ? "直接开始" : "Start Now"}</span>
                  <Play className="h-4 w-4" />
                </ActionButton>

                <ActionButton
                  data-testid="pack-quick-adjust"
                  tone="secondary"
                  onClick={props.onAdjustBeforeStart}
                  className="w-full justify-between"
                >
                  <span>{locale === "zh" ? "调整后开始" : "Adjust Before Start"}</span>
                  <Settings2 className="h-4 w-4" />
                </ActionButton>

                {props.onRemoveFromHome ? (
                  <ActionButton
                    data-testid="pack-quick-remove"
                    tone="secondary"
                    onClick={props.onRemoveFromHome}
                    className="w-full justify-between"
                  >
                    <span>{locale === "zh" ? "从首页拿下" : "Remove From Home"}</span>
                    <ArrowRight className="h-4 w-4" />
                  </ActionButton>
                ) : null}
              </div>

              <div className="mt-5 rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  {locale === "zh" ? "这个面板现在怎么关" : "How to close this panel"}
                </p>
                <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                  {locale === "zh"
                    ? "点空白区域、右上角关闭，或按 Esc 都可以。"
                    : "Click the backdrop, use the top-right close button, or press Esc."}
                </p>
              </div>

              <div className="mt-auto pt-5">
                <ActionButton tone="secondary" onClick={props.onClose} className="w-full">
                  {locale === "zh" ? "关闭" : "Close"}
                </ActionButton>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

function PackCuratedSkillCard(props: {
  skill: FridayPackCuratedSkill;
  locale: "zh" | "en";
  onOpenSkill?: (skillId: string) => void;
  onAskFriday?: (prompt: string) => void;
}) {
  return (
    <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
      <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">
        {resolveLocalizedText(props.skill.title, props.locale)}
      </p>
      <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
        {resolveLocalizedText(props.skill.summary, props.locale)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.onAskFriday ? (
          <ActionButton
            data-testid={`pack-quick-skill-chat-${props.skill.skillId}`}
            onClick={() => props.onAskFriday?.(resolveLocalizedText(props.skill.starterPrompt, props.locale))}
          >
            {props.locale === "zh" ? "去聊天开始" : "Use In Chat"}
          </ActionButton>
        ) : null}
        {props.onOpenSkill ? (
          <ActionButton
            data-testid={`pack-quick-skill-open-${props.skill.skillId}`}
            tone="secondary"
            onClick={() => props.onOpenSkill?.(props.skill.skillId)}
          >
            {props.locale === "zh" ? "打开技能" : "Open Skill"}
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}
