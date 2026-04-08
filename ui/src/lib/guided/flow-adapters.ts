import type { StepProgressStep } from "@/components/guided/step-progress";
import type { ChoiceCardProps } from "@/components/guided/choice-card";
import type { JourneyPhase } from "@/components/guided/journey-tracker";
import type { PlanStep } from "@/components/guided/plan-review-visual";
import type { FridayGuidedWizardState } from "@/lib/api/system-types";
import type { LocalizedText } from "@/lib/i18n/localized-text";

export function wizardStepsToProgress(wizard: FridayGuidedWizardState): StepProgressStep[] {
  const currentIndex = wizard.steps.findIndex((step) => step.id === wizard.currentStepId);

  return wizard.steps.map((step, index) => ({
    id: step.id,
    label: step.title,
    status:
      index < currentIndex
        ? "completed"
        : index === currentIndex
          ? "active"
          : "pending",
  }));
}

export interface WizardStepChoice {
  value: string;
  label: LocalizedText;
  description: LocalizedText;
  outcome: LocalizedText;
  risk?: "low" | "medium" | "high";
  recommended?: boolean;
  reason?: LocalizedText;
}

export function wizardStepToChoiceCards(
  choices: WizardStepChoice[],
  selectedValue?: string,
  onSelect?: (value: string) => void,
): Omit<ChoiceCardProps, "onSelect">[] {
  return choices.map((choice) => ({
    title: choice.label,
    description: choice.description,
    outcome: choice.outcome,
    risk: choice.risk,
    recommended: choice.recommended,
    reason: choice.reason,
    selected: selectedValue === choice.value,
  }));
}

export function buildGuidedFlowJourneyPhases(
  wizard: FridayGuidedWizardState | null,
  investigationActive: boolean,
  executionActive: boolean,
): JourneyPhase[] {
  const phases: JourneyPhase[] = [
    {
      id: "investigate",
      label: "Investigate",
      status: investigationActive
        ? "investigating"
        : wizard?.status === "awaiting_input" || wizard?.status === "ready" || wizard?.status === "completed"
          ? "completed"
          : "pending",
    },
    {
      id: "choose",
      label: "Choose",
      status:
        wizard?.status === "awaiting_input"
          ? "choosing"
          : wizard?.status === "ready" || wizard?.status === "completed"
            ? "completed"
            : "pending",
    },
    {
      id: "plan",
      label: "Plan",
      status:
        wizard?.status === "ready"
          ? "planning"
          : wizard?.status === "completed"
            ? "completed"
            : "pending",
    },
    {
      id: "execute",
      label: "Execute",
      status: executionActive
        ? "executing"
        : wizard?.status === "completed"
          ? "completed"
          : "pending",
    },
    {
      id: "done",
      label: "Done",
      status: wizard?.status === "completed" ? "completed" : "pending",
    },
  ];

  return phases;
}

export function buildGuidedFlowCurrentPhaseIndex(
  phases: JourneyPhase[],
): number {
  const activeIndex = phases.findIndex(
    (phase) => phase.status !== "completed" && phase.status !== "pending",
  );
  return activeIndex >= 0 ? activeIndex : 0;
}

export function planReviewStepsFromMarkdown(planMarkdown: string): PlanStep[] {
  const lines = planMarkdown.split("\n").filter((line) => line.trim().length > 0);
  const steps: PlanStep[] = [];
  let stepIndex = 0;

  for (const line of lines) {
    const listMatch = line.match(/^\s*[-*]\s+(.+)/);
    const numberedMatch = line.match(/^\s*\d+[.)]\s+(.+)/);
    const match = listMatch ?? numberedMatch;

    if (match) {
      const text = match[1].trim();
      const hasHighRisk = /\b(danger|destructive|irreversible|breaking)\b/i.test(text);
      const hasMediumRisk = /\b(risk|careful|approval|manual)\b/i.test(text);

      steps.push({
        id: `plan-step-${String(stepIndex)}`,
        label: text,
        risk: hasHighRisk ? "high" : hasMediumRisk ? "medium" : "low",
        status: "pending",
      });
      stepIndex++;
    }
  }

  return steps;
}
