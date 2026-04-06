import { useBudgetStatus } from "@/hooks/use-budget-status";

const TONE_CLASSES = {
  neutral: "text-white/50",
  warning: "text-amber-300",
  critical: "text-red-400",
} as const;

export function BudgetIndicator() {
  const budget = useBudgetStatus();

  if (budget.loading || budget.limitUsd === null) {
    return null;
  }

  const label = budget.percentUsed !== null
    ? `$${budget.spentUsd.toFixed(2)} / $${budget.limitUsd.toFixed(2)} (${budget.percentUsed.toFixed(0)}%)`
    : `$${budget.spentUsd.toFixed(2)} spent`;

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium ${TONE_CLASSES[budget.tone]}`}
      title={`Monthly budget: ${label}`}
    >
      {budget.tone === "critical" && (
        <span className="inline-block h-2 w-2 rounded-full bg-red-400 animate-pulse" />
      )}
      {budget.tone === "warning" && (
        <span className="inline-block h-2 w-2 rounded-full bg-amber-300" />
      )}
      {label}
    </div>
  );
}
