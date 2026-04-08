import { ArrowRight, ClipboardList, MessageSquareText, ShieldAlert, Sparkles } from "lucide-react";
import type { AgentRunRecord } from "@/lib/api/types";
import { ActionButton, StatusPill } from "@/components/core/primitives";
import { localize, resolveLocalizedText } from "@/lib/i18n/localized-text";
import {
  buildPackAssistantReceiptModel,
  type FridayPackReceiptAction,
} from "@/lib/packs/pack-assistant-receipt";
import type { FridayPackDefinition, FridayPackEntryPrompt } from "@/lib/packs/pack-registry";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

export interface PackAssistantHandoffCardProps {
  pack: FridayPackDefinition;
  runs?: AgentRunRecord[];
  approvalsCount?: number;
  alertCount?: number;
  compact?: boolean;
  onUsePrompt?: (prompt: FridayPackEntryPrompt) => void;
  onContinueInChat?: () => void;
  onOpenAssistant?: () => void;
  onReviewApprovals?: () => void;
  onOpenObservability?: () => void;
}

export function PackAssistantHandoffCard(props: PackAssistantHandoffCardProps) {
  const { locale } = useAppLocale();
  const productCopy = props.pack.productCopy;

  if (!productCopy) {
    return null;
  }

  const receipt = buildPackAssistantReceiptModel({
    pack: props.pack,
    runs: props.runs ?? [],
    locale,
    approvalsCount: props.approvalsCount,
    alertCount: props.alertCount,
  });

  if (!receipt) {
    return null;
  }

  const promptById = new Map(productCopy.entryPrompts.map((prompt) => [prompt.id, prompt]));
  const actionHandlers: Record<FridayPackReceiptAction["id"], ((action: FridayPackReceiptAction) => void) | undefined> = {
    use_prompt: (action) => {
      const prompt = action.promptId ? promptById.get(action.promptId) : null;
      if (prompt && props.onUsePrompt) {
        props.onUsePrompt(prompt);
      }
    },
    continue_chat: props.onContinueInChat ? () => props.onContinueInChat?.() : undefined,
    open_assistant: props.onOpenAssistant ? () => props.onOpenAssistant?.() : undefined,
    review_approvals: props.onReviewApprovals ? () => props.onReviewApprovals?.() : undefined,
    open_observability: props.onOpenObservability ? () => props.onOpenObservability?.() : undefined,
  };
  const visibleActions = receipt.nextActions.filter((action) => actionHandlers[action.id]).slice(0, props.compact ? 3 : 4);
  const visibleDeliverables = props.compact ? receipt.deliverables.slice(0, 2) : receipt.deliverables;
  const contextNotes = props.compact ? receipt.contextNotes.slice(0, 2) : receipt.contextNotes;

  return (
    <div
      data-testid={`pack-assistant-receipt-${props.pack.id}`}
      className={cn(
        "rounded-[24px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)]",
        props.compact ? "px-4 py-4" : "px-5 py-5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
            {resolveLocalizedText(props.pack.title, locale)}
          </p>
          <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {receipt.headline}
          </p>
        </div>
        <StatusPill tone={receipt.stateTone}>
          <ClipboardList className="mr-1 h-3.5 w-3.5" />
          {receipt.stateLabel}
        </StatusPill>
      </div>

      <div className={cn("mt-4 grid gap-3", props.compact ? "md:grid-cols-1" : "lg:grid-cols-[1.05fr_0.95fr]")}>
        <div className="rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "当前交接状态", "Current Handoff State")}
          </p>
          <p className="mt-2 text-sm font-medium text-[color:var(--color-text-primary)]">
            {receipt.latestTask ?? resolveLocalizedText(productCopy.resultTitle, locale)}
          </p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
            {receipt.evidence}
          </p>
        </div>

        <div className="rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "助手现在掌握的线索", "Signals Assistant Is Holding")}
          </p>
          <div className="mt-2 space-y-2">
            {contextNotes.map((note) => (
              <div
                key={note}
                className="rounded-[16px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2"
              >
                <p className="text-xs leading-5 text-[color:var(--color-text-secondary)]">{note}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-[color:var(--color-accent)]" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "这次交接会带回什么", "What This Handoff Returns")}
          </p>
        </div>
        <div className="space-y-2">
          {visibleDeliverables.map((deliverable) => (
            <div
              key={deliverable.title}
              className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                    {deliverable.title}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {deliverable.detail}
                  </p>
                </div>
                <StatusPill tone={deliverable.tone}>{deliverable.statusLabel}</StatusPill>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-[color:var(--color-accent)]" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "下一步动作", "Next Actions")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleActions.map((action) => (
            <ActionButton
              key={`${action.id}-${action.promptId ?? "none"}`}
              tone={action.tone === "primary" ? "primary" : "secondary"}
              onClick={() => actionHandlers[action.id]?.(action)}
              data-testid={action.id === "open_assistant" ? "pack-product-open-assistant" : undefined}
            >
              {action.id === "use_prompt" ? <Sparkles className="mr-2 h-4 w-4" /> : null}
              {action.id === "open_assistant" ? <ArrowRight className="mr-2 h-4 w-4" /> : null}
              {action.label}
            </ActionButton>
          ))}
        </div>
      </div>

      {!props.compact && productCopy.entryPrompts.length > 0 ? (
        <div className="mt-4 rounded-[20px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "如果要继续推进，推荐这样开场", "If You Want To Keep Going, Start Like This")}
          </p>
          <div className="mt-3 grid gap-3">
            {productCopy.entryPrompts.slice(0, 2).map((prompt) => (
              <button
                key={prompt.id}
                type="button"
                data-testid={`pack-product-prompt-${prompt.id}`}
                onClick={() => props.onUsePrompt?.(prompt)}
                disabled={!props.onUsePrompt}
                className="rounded-[18px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3 text-left transition hover:border-[color:var(--color-border-strong)] disabled:cursor-default disabled:opacity-90"
              >
                <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
                  {resolveLocalizedText(prompt.label, locale)}
                </p>
                <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {resolveLocalizedText(prompt.prompt, locale)}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
