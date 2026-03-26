import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface ChoiceCardProps {
  title: string;
  description: string;
  outcome: string;
  risk?: "low" | "medium" | "high";
  recommended?: boolean;
  selected?: boolean;
  disabled?: boolean;
  reason?: string;
  onSelect: () => void;
}

const RISK_TONES = {
  low: { label: "Low risk", border: "border-emerald-400/30", bg: "bg-emerald-400/10", text: "text-emerald-100" },
  medium: { label: "Medium risk", border: "border-amber-300/30", bg: "bg-amber-300/10", text: "text-amber-100" },
  high: { label: "High risk", border: "border-rose-400/30", bg: "bg-rose-400/10", text: "text-rose-100" },
} as const;

export function ChoiceCard(props: ChoiceCardProps) {
  const { title, description, outcome, risk, recommended, selected, disabled, reason, onSelect } = props;
  const riskStyle = risk ? RISK_TONES[risk] : null;

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
          ? "border-[var(--accent-strong)]/50 bg-[var(--accent-strong)]/10"
          : recommended
            ? "border-emerald-300/30 bg-emerald-300/[0.06] hover:border-emerald-300/50 hover:bg-emerald-300/10"
            : "border-white/10 bg-white/[0.04] hover:border-white/[0.18] hover:bg-white/[0.07]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white">{title}</p>
            {recommended && (
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100">
                Recommended
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-5 text-white/60">{description}</p>
        </div>
        {selected && (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--accent-strong)]" />
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
        <span className="text-[11px] text-white/40">
          <span className="font-medium text-white/50">Outcome:</span> {outcome}
        </span>
      </div>

      {reason && recommended && (
        <p className="rounded-2xl border border-emerald-400/10 bg-emerald-400/[0.04] px-3 py-2 text-[11px] leading-4 text-emerald-200/70">
          {reason}
        </p>
      )}
    </button>
  );
}
