import { ShieldAlert, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { StepProgress, type StepProgressStep } from "./step-progress";
import { ActionButton } from "@/components/core/primitives";

export interface PlanStep {
  id: string;
  label: string;
  detail?: string;
  risk?: "low" | "medium" | "high";
  status: "pending" | "active" | "completed" | "error";
}

export interface PlanReviewVisualProps {
  title: string;
  summary: string;
  steps: PlanStep[];
  assumptions?: string[];
  unknowns?: string[];
  riskLevel?: "low" | "medium" | "high";
  isApproving?: boolean;
  isRejecting?: boolean;
  onApprove: () => void;
  onReject: () => void;
  clarificationQuestion?: string;
  clarificationChoices?: Array<{ label: string; value: string }>;
  onClarificationAnswer?: (value: string) => void;
}

function riskIcon(level?: "low" | "medium" | "high") {
  switch (level) {
    case "high":
      return <XCircle className="h-4 w-4 text-rose-300" />;
    case "medium":
      return <AlertTriangle className="h-4 w-4 text-amber-300" />;
    default:
      return <CheckCircle2 className="h-4 w-4 text-emerald-300" />;
  }
}

function riskTone(level?: "low" | "medium" | "high") {
  switch (level) {
    case "high":
      return "border-rose-400/20 bg-rose-400/[0.06]";
    case "medium":
      return "border-amber-300/20 bg-amber-300/[0.06]";
    default:
      return "border-emerald-400/20 bg-emerald-400/[0.06]";
  }
}

export function PlanReviewVisual(props: PlanReviewVisualProps) {
  const {
    title,
    summary,
    steps,
    assumptions,
    unknowns,
    riskLevel,
    isApproving,
    isRejecting,
    onApprove,
    onReject,
    clarificationQuestion,
    clarificationChoices,
    onClarificationAnswer,
  } = props;

  const progressSteps: StepProgressStep[] = steps.map((step) => ({
    id: step.id,
    label: step.label,
    status: step.status,
    detail: step.detail,
  }));

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
              Plan Review
            </p>
            <h3 className="mt-1 text-lg font-semibold text-white">{title}</h3>
          </div>
          <div className={cn("rounded-2xl border p-2", riskTone(riskLevel))}>
            {riskIcon(riskLevel)}
          </div>
        </div>

        <p className="mt-3 text-sm leading-6 text-white/60">{summary}</p>

        {steps.length > 0 && (
          <div className="mt-5">
            <StepProgress steps={progressSteps} orientation="vertical" />
          </div>
        )}

        {assumptions && assumptions.length > 0 && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
              Assumptions
            </p>
            <ul className="mt-2 space-y-1">
              {assumptions.map((assumption, index) => (
                <li key={index} className="text-xs leading-5 text-white/50">
                  {assumption}
                </li>
              ))}
            </ul>
          </div>
        )}

        {unknowns && unknowns.length > 0 && (
          <div className="mt-3 rounded-2xl border border-amber-300/10 bg-amber-300/[0.03] px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/60">
              <ShieldAlert className="h-3 w-3" />
              Unknowns
            </p>
            <ul className="mt-2 space-y-1">
              {unknowns.map((unknown, index) => (
                <li key={index} className="text-xs leading-5 text-amber-100/50">
                  {unknown}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {clarificationQuestion && (
        <div className="rounded-3xl border border-amber-300/20 bg-amber-300/[0.04] p-5">
          <p className="text-sm font-medium text-amber-100">{clarificationQuestion}</p>
          {clarificationChoices && clarificationChoices.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {clarificationChoices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => onClarificationAnswer?.(choice.value)}
                  className="rounded-2xl border border-white/10 bg-white/[0.06] px-3.5 py-2 text-sm text-white transition hover:border-white/20 hover:bg-white/10"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <ActionButton
          tone="primary"
          onClick={onApprove}
          disabled={isApproving || isRejecting}
          className="flex-1"
        >
          {isApproving ? "Approving..." : "Approve Plan"}
        </ActionButton>
        <ActionButton
          tone="secondary"
          onClick={onReject}
          disabled={isApproving || isRejecting}
          className="flex-1"
        >
          {isRejecting ? "Rejecting..." : "Reject"}
        </ActionButton>
      </div>
    </div>
  );
}
