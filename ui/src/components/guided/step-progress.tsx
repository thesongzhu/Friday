import { Check, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface StepProgressStep {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "error";
  detail?: string;
}

export interface StepProgressProps {
  steps: StepProgressStep[];
  orientation?: "horizontal" | "vertical";
}

function StepIcon(props: { status: StepProgressStep["status"] }) {
  switch (props.status) {
    case "completed":
      return <Check className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />;
    case "error":
      return <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--color-text-primary)]" />;
    case "active":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--color-accent)]" />;
    default:
      return <div className="h-2 w-2 rounded-full bg-[color:var(--color-border-soft)]" />;
  }
}

function stepTone(status: StepProgressStep["status"]) {
  switch (status) {
    case "completed":
      return "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]";
    case "error":
      return "border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-contrast)]";
    case "active":
      return "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]";
    default:
      return "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)]";
  }
}

export function StepProgress(props: StepProgressProps) {
  const { steps, orientation = "horizontal" } = props;

  if (orientation === "vertical") {
    return (
      <div className="flex flex-col gap-0">
        {steps.map((step, index) => (
          <div key={step.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border",
                  stepTone(step.status),
                )}
              >
                <StepIcon status={step.status} />
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "w-px flex-1 min-h-6",
                    step.status === "completed" ? "bg-[color:var(--color-accent-soft)]" : "bg-[color:var(--color-border-soft)]",
                  )}
                />
              )}
            </div>
            <div className="pb-6 pt-1">
              <p
                className={cn(
                  "text-sm font-medium",
                  step.status === "active" ? "text-[color:var(--color-text-primary)]" : step.status === "completed" ? "text-[color:var(--color-text-secondary)]" : "text-[color:var(--color-text-faint)]",
                )}
              >
                {step.label}
              </p>
              {step.detail && (
                <p className="mt-0.5 text-xs text-[color:var(--color-text-faint)]">{step.detail}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center gap-1">
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border",
                stepTone(step.status),
              )}
            >
              <StepIcon status={step.status} />
            </div>
            <span
              className={cn(
                "text-xs font-medium whitespace-nowrap",
                step.status === "active" ? "text-[color:var(--color-text-primary)]" : step.status === "completed" ? "text-[color:var(--color-text-secondary)]" : "text-[color:var(--color-text-faint)]",
              )}
            >
              {step.label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div
              className={cn(
                "h-px w-6",
                step.status === "completed" ? "bg-[color:var(--color-accent-soft)]" : "bg-[color:var(--color-border-soft)]",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}
