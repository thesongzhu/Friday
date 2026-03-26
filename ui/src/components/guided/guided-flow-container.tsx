import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { StepProgress, type StepProgressStep } from "./step-progress";

export interface GuidedFlowContainerProps {
  title: string;
  steps: StepProgressStep[];
  currentStepIndex: number;
  children: ReactNode;
  onBack?: () => void;
  onCancel?: () => void;
  showBack?: boolean;
  showCancel?: boolean;
}

export function GuidedFlowContainer(props: GuidedFlowContainerProps) {
  const {
    title,
    steps,
    currentStepIndex,
    children,
    onBack,
    onCancel,
    showBack = true,
    showCancel = true,
  } = props;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {showBack && onBack && currentStepIndex > 0 && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/60 transition hover:bg-white/[0.08] hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        {showCancel && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/40 transition hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {steps.length > 1 && (
        <StepProgress steps={steps} orientation="horizontal" />
      )}

      <div className={cn("transition-opacity duration-200")}>
        {children}
      </div>
    </div>
  );
}
