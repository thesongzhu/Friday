import type { LucideIcon } from "lucide-react";
import { resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

export interface GoalCardProps {
  icon: LucideIcon;
  title: LocalizedText;
  subtitle: LocalizedText;
  outcome: LocalizedText;
  recommended?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function GoalCard(props: GoalCardProps) {
  const { locale } = useAppLocale();
  const { icon: Icon, title, subtitle, outcome, recommended, active, disabled, onClick } = props;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex min-h-[220px] flex-col gap-3 rounded-3xl border p-5 text-left transition-all",
        "hover:scale-[1.02] active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-40",
        active
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
          : recommended
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)] hover:bg-[color:var(--color-accent-soft)]"
            : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]",
      )}
    >
      {recommended && (
        <span className="absolute -top-2.5 right-4 rounded-full border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-primary)]">
          {locale === "zh" ? "推荐" : "Recommended"}
        </span>
      )}

      <div className="flex items-start gap-3">
        <div
          className={cn(
            "rounded-2xl border p-2.5",
            recommended
              ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]"
              : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-secondary)] group-hover:text-[color:var(--color-text-primary)]",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{resolveLocalizedText(title, locale)}</p>
          <p className="mt-2 text-xs leading-5 text-[color:var(--color-text-secondary)]">{resolveLocalizedText(subtitle, locale)}</p>
        </div>
      </div>

      <div className="mt-auto rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
          {locale === "zh" ? "结果" : "Outcome"}
        </p>
        <p className="mt-2 text-[11px] leading-5 text-[color:var(--color-text-secondary)]">{resolveLocalizedText(outcome, locale)}</p>
      </div>
    </button>
  );
}
