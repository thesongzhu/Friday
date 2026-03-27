import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { StepProgress, type StepProgressStep } from "./step-progress";

export type JourneyPhaseStatus =
  | "pending"
  | "investigating"
  | "choosing"
  | "planning"
  | "executing"
  | "completed"
  | "error";

export interface JourneyPhase {
  id: string;
  label: string;
  status: JourneyPhaseStatus;
  detail?: string;
}

export interface JourneyTrackerProps {
  goalTitle: string;
  phases: JourneyPhase[];
  currentPhaseIndex: number;
}

function phaseToStepStatus(status: JourneyPhaseStatus): StepProgressStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "error":
      return "error";
    case "pending":
      return "pending";
    default:
      return "active";
  }
}

export function JourneyTracker(props: JourneyTrackerProps) {
  const { goalTitle, phases, currentPhaseIndex } = props;
  const currentPhase = phases[currentPhaseIndex];

  const progressSteps: StepProgressStep[] = phases.map((phase) => ({
    id: phase.id,
    label: phase.label,
    status: phaseToStepStatus(phase.status),
    detail: phase.detail,
  }));

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center gap-2.5">
        {currentPhase && currentPhase.status !== "completed" && currentPhase.status !== "error" && (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--accent-strong)]" />
        )}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
            Working on
          </p>
          <p className="text-sm font-medium text-white">{goalTitle}</p>
        </div>
      </div>

      <div className="mt-4">
        <StepProgress steps={progressSteps} orientation="horizontal" />
      </div>

      {currentPhase?.detail && (
        <p className={cn("mt-3 text-xs", currentPhase.status === "error" ? "text-rose-200/70" : "text-white/50")}>
          {currentPhase.detail}
        </p>
      )}
    </div>
  );
}
