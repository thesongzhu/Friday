import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface OneClickActionProps {
  icon: LucideIcon;
  title: string;
  summary: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  ctaLabel: string;
  isPending?: boolean;
  disabled?: boolean;
  onExecute: () => void;
}

function toneBorder(tone: OneClickActionProps["tone"]) {
  switch (tone) {
    case "success":
      return "border-emerald-400/20 hover:border-emerald-400/40";
    case "warning":
      return "border-amber-300/20 hover:border-amber-300/40";
    case "danger":
      return "border-rose-400/20 hover:border-rose-400/40";
    default:
      return "border-white/10 hover:border-white/20";
  }
}

function toneIcon(tone: OneClickActionProps["tone"]) {
  switch (tone) {
    case "success":
      return "text-emerald-300";
    case "warning":
      return "text-amber-300";
    case "danger":
      return "text-rose-300";
    default:
      return "text-white/60";
  }
}

export function OneClickAction(props: OneClickActionProps) {
  const { icon: Icon, title, summary, tone = "neutral", ctaLabel, isPending, disabled, onExecute } = props;

  return (
    <button
      type="button"
      disabled={disabled || isPending}
      onClick={onExecute}
      className={cn(
        "flex w-full items-start gap-3 rounded-2xl border bg-white/[0.02] p-4 text-left transition-all",
        "hover:bg-white/[0.05] active:scale-[0.99]",
        "disabled:pointer-events-none disabled:opacity-40",
        toneBorder(tone),
      )}
    >
      <div className={cn("mt-0.5 shrink-0", toneIcon(tone))}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="mt-0.5 text-xs text-white/50">{summary}</p>
      </div>
      <span className="shrink-0 rounded-xl border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-white/70">
        {ctaLabel}
      </span>
    </button>
  );
}
