import { ShieldAlert, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { localize, localizedText, resolveLocalizedText, type LocalizedText } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";
import { useAppLocale } from "@/providers/locale-provider";
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
  title: string | LocalizedText;
  summary: string | LocalizedText;
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
      return <XCircle className="h-4 w-4 text-[color:var(--color-text-primary)]" />;
    case "medium":
      return <AlertTriangle className="h-4 w-4 text-[color:var(--color-text-primary)]" />;
    default:
      return <CheckCircle2 className="h-4 w-4 text-[color:var(--color-accent)]" />;
  }
}

function riskTone(level?: "low" | "medium" | "high") {
  switch (level) {
    case "high":
      return "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)]";
    case "medium":
      return "border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)]";
    default:
      return "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]";
  }
}

export function PlanReviewVisual(props: PlanReviewVisualProps) {
  const { locale } = useAppLocale();
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
  const localizedTitle = typeof title === "string" ? localizedText(title, title) : title;
  const localizedSummary = typeof summary === "string" ? localizedText(summary, summary) : summary;

  const progressSteps: StepProgressStep[] = steps.map((step) => ({
    id: step.id,
    label: step.label,
    status: step.status,
    detail: step.detail,
  }));

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-floating)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "审核计划", "Plan Review")}
            </p>
            <p className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
              {resolveLocalizedText(localizedTitle, locale)}
            </p>
          </div>
          <div className={cn("rounded-2xl border p-2", riskTone(riskLevel))}>
            {riskIcon(riskLevel)}
          </div>
        </div>

        <p className="mt-3 text-sm leading-6 text-[color:var(--color-text-secondary)]">
          {resolveLocalizedText(localizedSummary, locale)}
        </p>

        {steps.length > 0 && (
          <div className="mt-5">
            <StepProgress steps={progressSteps} orientation="vertical" />
          </div>
        )}

        {assumptions && assumptions.length > 0 && (
          <div className="mt-4 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              {localize(locale, "假设条件", "Assumptions")}
            </p>
            <ul className="mt-2 space-y-1">
              {assumptions.map((assumption, index) => (
                <li key={index} className="text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {assumption}
                </li>
              ))}
            </ul>
          </div>
        )}

        {unknowns && unknowns.length > 0 && (
          <div className="mt-3 rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)] px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
              <ShieldAlert className="h-3 w-3" />
              {localize(locale, "未知项", "Unknowns")}
            </p>
            <ul className="mt-2 space-y-1">
              {unknowns.map((unknown, index) => (
                <li key={index} className="text-xs leading-5 text-[color:var(--color-text-secondary)]">
                  {unknown}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {clarificationQuestion && (
        <div className="rounded-3xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)] p-5">
          <p className="text-sm font-medium text-[color:var(--color-text-primary)]">{clarificationQuestion}</p>
          {clarificationChoices && clarificationChoices.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {clarificationChoices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onClick={() => onClarificationAnswer?.(choice.value)}
                  className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-3.5 py-2 text-sm text-[color:var(--color-text-primary)] transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-surface-strong)]"
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
          {isApproving ? localize(locale, "正在批准…", "Approving…") : localize(locale, "批准计划", "Approve Plan")}
        </ActionButton>
        <ActionButton
          tone="secondary"
          onClick={onReject}
          disabled={isApproving || isRejecting}
          className="flex-1"
        >
          {isRejecting ? localize(locale, "正在驳回…", "Rejecting…") : localize(locale, "退回修改", "Reject")}
        </ActionButton>
      </div>
    </div>
  );
}
