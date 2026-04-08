import { ArrowRight, ClipboardList, MessageSquareText, Sparkles } from "lucide-react";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { resolveLocalizedText } from "@/lib/i18n/localized-text";
import type { FridayPackDefinition, FridayPackEntryPrompt } from "@/lib/packs/pack-registry";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

export interface PackProductPreviewProps {
  pack: FridayPackDefinition;
  compact?: boolean;
  onUsePrompt?: (prompt: FridayPackEntryPrompt) => void;
  onOpenAssistant?: () => void;
}

export function PackProductPreview(props: PackProductPreviewProps) {
  const { locale } = useAppLocale();
  const productCopy = props.pack.productCopy;

  if (!productCopy) {
    return null;
  }

  return (
    <div
      className={cn(
        "rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]",
        props.compact ? "space-y-4 px-4 py-4" : "space-y-5 px-5 py-5",
      )}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill>
            {locale === "zh" ? "适合谁" : "Who this is for"}
          </StatusPill>
          <StatusPill tone="success">
            <ClipboardList className="mr-1 h-3.5 w-3.5" />
            {locale === "zh" ? "结果预期" : "Expected Output"}
          </StatusPill>
        </div>
        <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {resolveLocalizedText(productCopy.audience, locale)}
        </p>
        <div>
          <p className="text-base font-semibold text-[color:var(--color-text-primary)]">
            {resolveLocalizedText(productCopy.resultTitle, locale)}
          </p>
          <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {resolveLocalizedText(productCopy.resultSummary, locale)}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
          {locale === "zh" ? "你会拿到什么" : "What Friday Hands Back"}
        </p>
        <div className="space-y-3">
          {productCopy.deliverables.map((deliverable) => (
            <div
              key={deliverable.title.en}
              className="rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3"
            >
              <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                {resolveLocalizedText(deliverable.title, locale)}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                {resolveLocalizedText(deliverable.detail, locale)}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
          {locale === "zh" ? "推荐开场方式" : "Suggested Starts"}
        </p>
        <div className="grid gap-3">
          {productCopy.entryPrompts.map((prompt) => (
            <button
              key={prompt.id}
              type="button"
              data-testid={`pack-product-prompt-${prompt.id}`}
              onClick={() => props.onUsePrompt?.(prompt)}
              disabled={!props.onUsePrompt}
              className="rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-left transition hover:border-[color:var(--color-border-strong)] disabled:cursor-default disabled:opacity-90"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {resolveLocalizedText(prompt.label, locale)}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {resolveLocalizedText(prompt.prompt, locale)}
                  </p>
                </div>
                {props.onUsePrompt ? <Sparkles className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" /> : null}
              </div>
            </button>
          ))}
        </div>
      </div>

      {productCopy.assistantHandoff && props.onOpenAssistant ? (
        <div className="rounded-[22px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-2 text-[color:var(--color-accent)]">
              <MessageSquareText className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                {resolveLocalizedText(productCopy.assistantHandoff.title, locale)}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                {resolveLocalizedText(productCopy.assistantHandoff.summary, locale)}
              </p>
            </div>
          </div>
          <div className="mt-3">
            <ActionButton tone="secondary" onClick={props.onOpenAssistant} className="w-full justify-between">
              <span data-testid="pack-product-open-assistant" className="sr-only" />
              <span>{resolveLocalizedText(productCopy.assistantHandoff.actionLabel, locale)}</span>
              <ArrowRight className="h-4 w-4" />
            </ActionButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
