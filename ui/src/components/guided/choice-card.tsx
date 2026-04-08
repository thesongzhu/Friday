import { CheckCircle2 } from "lucide-react";
import { localize, resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";

export interface ChoiceCardProps {
  title: LocalizedText;
  description: LocalizedText;
  outcome: LocalizedText;
  risk?: "low" | "medium" | "high";
  recommended?: boolean;
  selected?: boolean;
  disabled?: boolean;
  reason?: LocalizedText;
  onSelect: () => void;
}

export function ChoiceCard(props: ChoiceCardProps) {
  const { locale } = useAppLocale();
  const { title, description, outcome, risk, recommended, selected, disabled, reason, onSelect } = props;
  const riskStyle = risk
    ? {
      label: risk === "low"
        ? localize(locale, "低风险", "Low Risk")
        : risk === "medium"
          ? localize(locale, "需留意", "Review Carefully")
          : localize(locale, "人工把关", "Manual Check"),
      border: risk === "low" ? "border-[color:var(--color-accent)]" : "border-[color:var(--color-border-strong)]",
      bg: risk === "low" ? "bg-[color:var(--color-accent-soft)]" : risk === "medium" ? "bg-[color:var(--color-accent-muted)]" : "bg-[color:var(--color-bg-contrast)]",
      text: "text-[color:var(--color-text-primary)]",
    }
    : null;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group relative flex flex-col gap-3 rounded-3xl border p-5 text-left transition-all",
        "hover:scale-[1.01] active:scale-[0.99]",
        "disabled:pointer-events-none disabled:opacity-40",
        selected
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
          : recommended
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)] hover:bg-[color:var(--color-accent-soft)]"
            : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-[color:var(--color-text-primary)]">{resolveLocalizedText(title, locale)}</p>
            {recommended && (
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
                  locale === "zh"
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-strong)] text-[color:var(--color-text-primary)] font-bold"
                    : "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-text-primary)]",
                )}
              >
                {localize(locale, "推荐", "Recommended")}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-5 text-[color:var(--color-text-secondary)]">{resolveLocalizedText(description, locale)}</p>
        </div>
        {selected && (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-[color:var(--color-accent)]" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {riskStyle && (
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]",
              riskStyle.border,
              riskStyle.bg,
              riskStyle.text,
            )}
          >
            {riskStyle.label}
          </span>
        )}
        <div className="flex-1 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "结果", "Outcome")}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-[color:var(--color-text-secondary)]">{resolveLocalizedText(outcome, locale)}</p>
        </div>
      </div>

      {reason && recommended && (
        <div className="rounded-2xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-muted)] px-3 py-2">
          <p className="text-[11px] leading-5 text-[color:var(--color-text-secondary)]">{resolveLocalizedText(reason, locale)}</p>
        </div>
      )}
    </button>
  );
}
