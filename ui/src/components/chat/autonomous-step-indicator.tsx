import { Check, X } from "lucide-react";
import type { AutonomousGoalViewModel } from "@/hooks/use-agent-run-events";
import { localize } from "@/lib/i18n/localized-text";
import { cn } from "@/lib/utils/cn";

export interface AutonomousStepIndicatorProps {
  goal: AutonomousGoalViewModel;
  locale: "zh" | "en";
}

const DOT_CLASSES: Record<string, string> = {
  pending: "bg-[color:var(--color-text-faint)]",
  executing: "bg-[color:var(--color-accent)] animate-pulse",
  completed: "bg-[color:var(--ok)]",
  failed: "bg-[color:var(--danger)]",
};

export function AutonomousStepIndicator({ goal, locale }: AutonomousStepIndicatorProps) {
  const isTerminal = goal.status === "completed" || goal.status === "failed";
  const currentStep =
    goal.currentStepIndex >= 0 && goal.currentStepIndex < goal.steps.length
      ? goal.steps[goal.currentStepIndex]
      : null;

  return (
    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-4 py-3 shadow-sm">
      {/* Goal description */}
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-faint)]">
        {localize(locale, "自主任务", "Autonomous Task")}
      </p>
      <p className="mt-1 text-sm font-medium text-[color:var(--color-text-primary)]">
        {goal.description}
      </p>

      {/* Step dots */}
      {goal.steps.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5">
          {goal.steps.map((step) => (
            <div
              key={step.id}
              title={step.instruction}
              className={cn(
                "h-2 w-2 rounded-full transition-colors",
                DOT_CLASSES[step.status] ?? DOT_CLASSES.pending,
              )}
            />
          ))}
        </div>
      )}

      {/* Current step instruction or terminal status */}
      <div className="mt-2">
        {isTerminal ? (
          <div className="flex items-center gap-1.5">
            {goal.status === "completed" ? (
              <>
                <Check className="h-3.5 w-3.5 text-[color:var(--ok)]" />
                <span className="text-xs font-medium text-[color:var(--ok)]">
                  {localize(locale, "完成", "Done")}
                </span>
              </>
            ) : (
              <>
                <X className="h-3.5 w-3.5 text-[color:var(--danger)]" />
                <span className="text-xs font-medium text-[color:var(--danger)]">
                  {localize(locale, "失败", "Failed")}
                </span>
              </>
            )}
          </div>
        ) : currentStep ? (
          <p className="text-xs leading-relaxed text-[color:var(--color-text-secondary)]">
            {currentStep.instruction}
          </p>
        ) : goal.status === "pending" ? (
          <p className="text-xs text-[color:var(--color-text-faint)]">
            {localize(locale, "准备中...", "Preparing...")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
