import { ArrowRight, Clock3, Play, Settings2, X } from "lucide-react";
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
  if (!props.open || !props.pack) {
    return null;
  }

  const title = resolveLocalizedText(props.pack.title, locale);
  const summary = resolveLocalizedText(props.pack.summary, locale);
  const curatedSkills = props.pack.curatedSkills ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(20,16,14,0.18)] px-4 py-4 backdrop-blur-[2px] lg:items-center">
      <div
        data-testid="pack-quick-sheet"
        className="w-full max-w-lg rounded-[32px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-elevated)] p-5 shadow-[var(--shadow-card-strong)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {locale === "zh" ? "行业与任务入口" : "Industry & Tasks"}
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">{summary}</p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            data-testid="pack-quick-close"
            className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2 text-[color:var(--color-text-tertiary)] transition hover:text-[color:var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {props.automationHint ? (
          <div className="mt-4 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
            <p className="flex items-center gap-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">
              <Clock3 className="h-4 w-4 text-[color:var(--color-accent)]" />
              {props.automationHint}
            </p>
          </div>
        ) : null}

        <div className="mt-5 space-y-3">
          {props.onOpenCurrent && props.currentRunLabel ? (
            <ActionButton tone="secondary" onClick={props.onOpenCurrent} className="w-full justify-between">
              <span data-testid="pack-quick-open-current" className="sr-only" />
              <span>{locale === "zh" ? "打开当前任务" : "Open Current Run"}</span>
              <span className="text-xs text-[color:var(--color-text-tertiary)]">{props.currentRunLabel}</span>
            </ActionButton>
          ) : null}

          {props.onContinue && props.continueLabel ? (
            <ActionButton data-testid="pack-quick-continue" tone="secondary" onClick={props.onContinue} className="w-full justify-between">
              <span>{locale === "zh" ? "继续上次任务" : "Continue Last"}</span>
              <span className="text-xs text-[color:var(--color-text-tertiary)]">{props.continueLabel}</span>
            </ActionButton>
          ) : null}

          <ActionButton data-testid="pack-quick-start" onClick={props.onStartNow} className="w-full justify-between">
            <span>{locale === "zh" ? "直接开始" : "Start Now"}</span>
            <Play className="h-4 w-4" />
          </ActionButton>

          <ActionButton data-testid="pack-quick-adjust" tone="secondary" onClick={props.onAdjustBeforeStart} className="w-full justify-between">
            <span>{locale === "zh" ? "调整后开始" : "Adjust Before Start"}</span>
            <Settings2 className="h-4 w-4" />
          </ActionButton>

          {props.onRemoveFromHome ? (
            <ActionButton data-testid="pack-quick-remove" tone="secondary" onClick={props.onRemoveFromHome} className="w-full justify-between">
              <span>{locale === "zh" ? "从首页拿下" : "Remove From Home"}</span>
              <ArrowRight className="h-4 w-4" />
            </ActionButton>
          ) : null}
        </div>

        <div className="mt-5">
          <PackProductPreview
            pack={props.pack}
            compact
            onUsePrompt={props.onAskFriday ? (prompt) => props.onAskFriday?.(resolveLocalizedText(prompt.prompt, locale)) : undefined}
            onOpenAssistant={props.onOpenAssistant}
          />
        </div>

        {curatedSkills.length > 0 ? (
          <div className="mt-5 border-t border-[color:var(--color-border-soft)] pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {locale === "zh" ? "推荐技能" : "Curated Skills"}
            </p>
            <div className="mt-3 space-y-3">
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
    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4">
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
