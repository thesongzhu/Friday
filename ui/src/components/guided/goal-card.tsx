import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface GoalCardProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  outcome: string;
  recommended?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function GoalCard(props: GoalCardProps) {
  const { icon: Icon, title, subtitle, outcome, recommended, active, disabled, onClick } = props;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-3 rounded-3xl border p-5 text-left transition-all",
        "hover:scale-[1.02] active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-40",
        active
          ? "border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10"
          : recommended
            ? "border-emerald-300/30 bg-emerald-300/[0.06] hover:border-emerald-300/50 hover:bg-emerald-300/10"
            : "border-white/10 bg-white/[0.04] hover:border-white/[0.18] hover:bg-white/[0.07]",
      )}
    >
      {recommended && (
        <span className="absolute -top-2.5 right-4 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100">
          Recommended
        </span>
      )}

      <div className="flex items-start gap-3">
        <div
          className={cn(
            "rounded-2xl border p-2.5",
            recommended
              ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
              : "border-white/10 bg-white/[0.07] text-white/70 group-hover:text-white",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{title}</p>
          <p className="mt-1 text-xs leading-5 text-white/50">{subtitle}</p>
        </div>
      </div>

      <p className="text-[11px] leading-4 text-white/40">
        <span className="font-medium text-white/50">Outcome:</span> {outcome}
      </p>
    </button>
  );
}
