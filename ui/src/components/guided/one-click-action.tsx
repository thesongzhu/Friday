import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { useAppLocale } from "@/providers/locale-provider";
import {
  resolveLocalizedText,
  type LocalizedText,
} from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";

export interface OneClickActionProps {
  icon: LucideIcon;
  title: LocalizedText;
  summary: LocalizedText;
  tone?: "neutral" | "success" | "warning" | "danger";
  ctaLabel: LocalizedText;
  isPending?: boolean;
  disabled?: boolean;
  onExecute: () => void;
}

function toneBorder(tone: OneClickActionProps["tone"]) {
  switch (tone) {
    case "success":
      return "border-[color:var(--color-accent)] hover:border-[color:var(--color-accent)]";
    case "warning":
      return "border-[color:var(--color-border-strong)] hover:border-[color:var(--color-accent)]";
    case "danger":
      return "border-[color:var(--color-border-strong)] hover:border-[color:var(--color-border-strong)]";
    default:
      return "border-[color:var(--color-border-soft)] hover:border-[color:var(--color-border-strong)]";
  }
}

function toneIcon(tone: OneClickActionProps["tone"]) {
  switch (tone) {
    case "success":
      return "text-[color:var(--color-accent)]";
    case "warning":
      return "text-[color:var(--color-text-primary)]";
    case "danger":
      return "text-[color:var(--color-text-primary)]";
    default:
      return "text-[color:var(--color-text-secondary)]";
  }
}

export function OneClickAction(props: OneClickActionProps) {
  const { icon: Icon, title, summary, tone = "neutral", ctaLabel, isPending, disabled, onExecute } = props;
  const { locale } = useAppLocale();

  return (
    <button
      type="button"
      disabled={disabled || isPending}
      onClick={onExecute}
      className={cn(
        "flex min-h-[88px] w-full items-start gap-3 rounded-2xl border bg-[color:var(--color-bg-surface)] p-4 text-left transition-all",
        "hover:bg-[color:var(--color-bg-surface-strong)] active:scale-[0.99]",
        "disabled:pointer-events-none disabled:opacity-40",
        toneBorder(tone),
      )}
    >
      <div className={cn("mt-0.5 shrink-0", toneIcon(tone))}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[color:var(--color-text-primary)]">
          {resolveLocalizedText(title, locale)}
        </p>
        <p className="mt-1 text-xs leading-5 text-[color:var(--color-text-secondary)]">
          {resolveLocalizedText(summary, locale)}
        </p>
      </div>
      <span className="shrink-0 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)]">
        {resolveLocalizedText(ctaLabel, locale)}
      </span>
    </button>
  );
}
