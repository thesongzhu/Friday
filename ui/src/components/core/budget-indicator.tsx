import { useBudgetStatus } from "@/hooks/use-budget-status";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

const TONE_CLASSES = {
  neutral: "text-[color:var(--color-text-secondary)]",
  warning: "text-[color:var(--color-text-primary)]",
  critical: "text-[color:var(--color-text-primary)]",
} as const;

export function BudgetIndicator() {
  const budget = useBudgetStatus();
  const { locale } = useAppLocale();

  if (budget.loading || budget.limitUsd === null) {
    return null;
  }

  const usedLabel = localize(locale, "已用", "Used");
  const label = budget.percentUsed !== null
    ? `${usedLabel} $${budget.spentUsd.toFixed(2)} / $${budget.limitUsd.toFixed(2)} (${budget.percentUsed.toFixed(0)}%)`
    : `${usedLabel} $${budget.spentUsd.toFixed(2)}`;

  return (
    <div
      className={`flex min-h-[32px] items-center gap-1.5 rounded-full border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3 py-1 text-xs font-medium shadow-[var(--shadow-floating)] ${TONE_CLASSES[budget.tone]}`}
      title={localize(locale, `月度预算: ${label}`, `Monthly budget: ${label}`)}
    >
      {budget.tone === "critical" && (
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[color:var(--color-text-primary)]" />
      )}
      {budget.tone === "warning" && (
        <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--color-accent)]" />
      )}
      {label}
    </div>
  );
}
