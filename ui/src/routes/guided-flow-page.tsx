import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { agentApi } from "@/lib/api/agent";
import { GuidedFlowContainer } from "@/components/guided/guided-flow-container";
import { InvestigationPanel } from "@/components/guided/investigation-panel";
import { ChoiceCard } from "@/components/guided/choice-card";
import { PlanReviewVisual, type PlanStep } from "@/components/guided/plan-review-visual";
import { JourneyTracker, type JourneyPhase } from "@/components/guided/journey-tracker";
import { ActionButton, ShellCard } from "@/components/core/primitives";
import { useGuidedFlow } from "@/hooks/use-guided-flow";
import { useInvestigationEvents } from "@/hooks/use-investigation-events";
import { useAgentRunEvents } from "@/hooks/use-agent-run-events";
import { getGoalCategoryById } from "@/lib/guided/goal-categories";
import { planReviewStepsFromMarkdown, type WizardStepChoice } from "@/lib/guided/flow-adapters";

type FlowPhase = "investigating" | "choosing" | "planning" | "executing" | "completed" | "failed";

function buildChoicesFromWizardResponse(
  wizardQuestions: string[],
  wizardSummary?: string,
): WizardStepChoice[] {
  if (wizardQuestions.length > 0) {
    return [
      {
        value: "proceed",
        label: "Proceed with Friday's approach",
        description: wizardSummary ?? "Friday will proceed based on its analysis.",
        outcome: "Friday handles the details and asks only when essential.",
        risk: "low",
        recommended: true,
        reason: "Friday has enough context to proceed safely.",
      },
      ...wizardQuestions.map((question, index) => ({
        value: `clarify-${String(index)}`,
        label: question,
        description: "Answer this question to help Friday refine the approach.",
        outcome: "A more precise execution aligned with your intent.",
        risk: "low" as const,
      })),
      {
        value: "explore",
        label: "Investigate further",
        description: "Ask Friday to research more alternatives before proceeding.",
        outcome: "Deeper analysis with more options.",
        risk: "low",
      },
    ];
  }

  return [
    {
      value: "proceed",
      label: "Proceed with recommended approach",
      description: wizardSummary ?? "Friday will execute the plan it generated.",
      outcome: "Optimal result based on investigation.",
      risk: "low",
      recommended: true,
      reason: "Friday determined this is the best approach.",
    },
    {
      value: "customize",
      label: "Customize before executing",
      description: "Review and modify the approach before Friday proceeds.",
      outcome: "A tailored execution matching your specific needs.",
      risk: "medium",
    },
    {
      value: "explore",
      label: "Explore more options",
      description: "Ask Friday to investigate further and present more alternatives.",
      outcome: "Additional options and deeper analysis.",
      risk: "low",
    },
  ];
}

export function GuidedFlowPage() {
  const { wizardId } = useParams<{ wizardId: string }>();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<FlowPhase>("investigating");
  const [investigationRunId, setInvestigationRunId] = useState<string | null>(null);
  const [executionRunId, setExecutionRunId] = useState<string | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [wizardAdvanced, setWizardAdvanced] = useState(false);

  const goalCategory = wizardId ? getGoalCategoryById(wizardId) : undefined;
  const goalTitle = goalCategory?.title ?? wizardId ?? "Goal";
  const investigationTask = goalCategory
    ? `Investigate and analyze options for: ${goalCategory.title}. ${goalCategory.subtitle} Provide structured findings with recommendations.`
    : `Investigate and analyze options for the goal: ${wizardId ?? "unknown"}`;

  // ─── Wizard lifecycle (backend state machine) ───
  const guidedFlow = useGuidedFlow({
    wizardId: wizardId ?? "",
    enabled: !!wizardId,
  });

  // ─── Start investigation agent run on mount ───
  const startInvestigation = useMutation({
    mutationFn: async () => {
      return agentApi.startRun({
        task: investigationTask,
        sessionKey: `guided:${wizardId ?? "unknown"}`,
        executionContext: { surface: "guided-flow", interactive: true },
      });
    },
    onSuccess: (result) => {
      setInvestigationRunId(result.runId);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to start investigation");
      setPhase("failed");
    },
  });

  // Start both wizard and investigation on mount
  useEffect(() => {
    if (wizardId && !investigationRunId && !startInvestigation.isPending) {
      guidedFlow.start();
      startInvestigation.mutate();
    }
  }, [wizardId]);

  // ─── Investigation SSE events ───
  const investigation = useInvestigationEvents(investigationRunId, {
    enabled: phase === "investigating",
    onTerminal: (status) => {
      if (status === "completed") {
        // Investigation done → advance wizard with the goal
        if (!wizardAdvanced) {
          setWizardAdvanced(true);
          guidedFlow.continueStep({ goal: investigationTask });
        }
        setPhase("choosing");
      } else {
        setPhase("failed");
      }
    },
  });

  // ─── Execution SSE events ───
  const execution = useAgentRunEvents(executionRunId, {
    enabled: phase === "executing" || phase === "planning",
    onTerminal: (status) => {
      if (status === "completed") {
        setPhase("completed");
      } else {
        setPhase("failed");
      }
    },
  });

  // ─── Detect plan approval from execution ───
  const isAwaitingPlan = execution.status === "awaiting_plan_approval";

  useEffect(() => {
    if (isAwaitingPlan && phase !== "planning") {
      setPhase("planning");
      if (execution.outputText) {
        setPlanSteps(planReviewStepsFromMarkdown(execution.outputText));
      }
    }
  }, [isAwaitingPlan, phase, execution.outputText]);

  // ─── Build choices from wizard response ───
  const choices = useMemo<WizardStepChoice[]>(() => {
    if (phase !== "choosing") return [];

    const wizardResponse = guidedFlow.wizardResponse;
    const wizardQuestions = (wizardResponse?.wizard.collectedValues.questions as string[] | undefined) ?? [];
    const wizardSummary = wizardResponse?.summary;

    return buildChoicesFromWizardResponse(wizardQuestions, wizardSummary ?? undefined);
  }, [phase, guidedFlow.wizardResponse]);

  // ─── Handle choice selection → execute ───
  const executeChoice = useMutation({
    mutationFn: async () => {
      const choice = choices.find((c) => c.value === selectedChoice);

      // If user chose "explore", restart investigation
      if (selectedChoice === "explore") {
        setPhase("investigating");
        setInvestigationRunId(null);
        setWizardAdvanced(false);
        startInvestigation.mutate();
        return null;
      }

      // If user chose a clarification, submit the answer via wizard
      if (selectedChoice?.startsWith("clarify-")) {
        guidedFlow.continueStep({ answer: choice?.label ?? selectedChoice });
        // After answering, the wizard may complete or ask more
        setPhase("choosing");
        setSelectedChoice(null);
        return null;
      }

      // Otherwise, proceed with execution
      const choiceLabel = choice?.label ?? selectedChoice ?? "recommended approach";
      const result = await agentApi.startRun({
        task: `Execute the ${choiceLabel} for: ${goalTitle}. Based on the previous investigation, proceed with implementation.`,
        requireReview: true,
        sessionKey: `guided:${wizardId ?? "unknown"}`,
        executionContext: { surface: "guided-flow", interactive: true },
      });
      return result;
    },
    onSuccess: (result) => {
      if (result) {
        setExecutionRunId(result.runId);
        setPhase("executing");
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to start execution");
    },
  });

  // ─── Plan approval ───
  const approvePlan = useMutation({
    mutationFn: async () => {
      if (!executionRunId) throw new Error("No execution run");
      return agentApi.approvePlan(executionRunId);
    },
    onSuccess: () => {
      setPhase("executing");
    },
  });

  const rejectPlan = useMutation({
    mutationFn: async () => {
      if (!executionRunId) throw new Error("No execution run");
      return agentApi.rejectPlan(executionRunId);
    },
    onSuccess: () => {
      setPhase("choosing");
      setExecutionRunId(null);
      setSelectedChoice(null);
    },
  });

  // ─── Cancel / Retry ───
  function handleCancel() {
    guidedFlow.cancel();
    navigate("/home");
  }

  function handleRetry() {
    setPhase("investigating");
    setInvestigationRunId(null);
    setExecutionRunId(null);
    setSelectedChoice(null);
    setPlanSteps([]);
    setWizardAdvanced(false);
    guidedFlow.reset();
    guidedFlow.start();
    startInvestigation.mutate();
  }

  // ─── Journey phases ───
  const journeyPhases = useMemo<JourneyPhase[]>(() => {
    const phaseOrder: FlowPhase[] = ["investigating", "choosing", "planning", "executing", "completed"];
    const currentIdx = phaseOrder.indexOf(phase);

    function resolveStatus(phaseIdx: number): JourneyPhase["status"] {
      if (phase === "failed" && phaseIdx >= currentIdx) return "error";
      if (phaseIdx < currentIdx) return "completed";
      if (phaseIdx === currentIdx) {
        const activeLabels: Record<string, JourneyPhase["status"]> = {
          investigating: "investigating",
          choosing: "choosing",
          planning: "planning",
          executing: "executing",
          completed: "completed",
        };
        return activeLabels[phase] ?? "pending";
      }
      return "pending";
    }

    return [
      { id: "investigate", label: "Investigate", status: resolveStatus(0) },
      { id: "choose", label: "Choose", status: resolveStatus(1) },
      { id: "plan", label: "Plan", status: resolveStatus(2) },
      { id: "execute", label: "Execute", status: resolveStatus(3) },
      {
        id: "done",
        label: "Done",
        status: resolveStatus(4),
        detail: phase === "failed" ? "Something went wrong" : undefined,
      },
    ];
  }, [phase]);

  const currentPhaseIndex = journeyPhases.findIndex(
    (p) => p.status !== "completed" && p.status !== "pending",
  );

  const containerSteps = journeyPhases.map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status === "investigating" || p.status === "choosing" || p.status === "planning" || p.status === "executing"
      ? "active" as const
      : p.status === "completed"
        ? "completed" as const
        : p.status === "error"
          ? "error" as const
          : "pending" as const,
  }));

  // ─── Render ───
  return (
    <div className="py-4">
      <GuidedFlowContainer
        title={goalTitle}
        steps={containerSteps}
        currentStepIndex={Math.max(0, currentPhaseIndex)}
        onBack={() => navigate("/home")}
        onCancel={handleCancel}
      >
        {/* Phase: Investigating */}
        {phase === "investigating" && (
          <InvestigationPanel
            lines={investigation.findings}
            isStreaming={investigation.isStreaming}
            title={`Investigating: ${goalTitle}`}
          />
        )}

        {/* Phase: Choosing */}
        {phase === "choosing" && (
          <div className="space-y-4">
            <p className="text-sm text-white/60">
              {guidedFlow.wizardResponse?.summary
                ?? "Based on the investigation, here are your options. Click to select, then proceed."}
            </p>

            {guidedFlow.wizard?.unknowns && guidedFlow.wizard.unknowns.length > 0 && (
              <div className="rounded-2xl border border-amber-300/10 bg-amber-300/[0.03] px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/60">
                  Open questions
                </p>
                <ul className="mt-2 space-y-1">
                  {guidedFlow.wizard.unknowns.map((unknown, i) => (
                    <li key={i} className="text-xs leading-5 text-amber-100/50">{unknown}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-3">
              {choices.map((choice) => (
                <ChoiceCard
                  key={choice.value}
                  title={choice.label}
                  description={choice.description}
                  outcome={choice.outcome}
                  risk={choice.risk}
                  recommended={choice.recommended}
                  reason={choice.reason}
                  selected={selectedChoice === choice.value}
                  onSelect={() => setSelectedChoice(choice.value)}
                />
              ))}
            </div>

            {selectedChoice && (
              <ActionButton
                onClick={() => executeChoice.mutate()}
                disabled={executeChoice.isPending || guidedFlow.isContinuing}
                className="w-full"
              >
                {executeChoice.isPending || guidedFlow.isContinuing
                  ? "Working..."
                  : selectedChoice === "explore"
                    ? "Investigate further"
                    : selectedChoice?.startsWith("clarify-")
                      ? "Submit answer"
                      : "Proceed"}
              </ActionButton>
            )}
          </div>
        )}

        {/* Phase: Planning (awaiting plan approval) */}
        {phase === "planning" && (
          <PlanReviewVisual
            title={`Plan for: ${goalTitle}`}
            summary={execution.outputText.slice(0, 300)}
            steps={planSteps}
            assumptions={guidedFlow.wizard?.assumptions}
            unknowns={guidedFlow.wizard?.unknowns}
            riskLevel="low"
            isApproving={approvePlan.isPending}
            isRejecting={rejectPlan.isPending}
            onApprove={() => approvePlan.mutate()}
            onReject={() => rejectPlan.mutate()}
          />
        )}

        {/* Phase: Executing */}
        {phase === "executing" && !isAwaitingPlan && (
          <div className="space-y-4">
            <JourneyTracker
              goalTitle={goalTitle}
              phases={journeyPhases}
              currentPhaseIndex={Math.max(0, currentPhaseIndex)}
            />
            <InvestigationPanel
              lines={execution.outputText
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((text, i) => ({ id: `exec-${String(i)}`, text, type: "info" as const }))}
              isStreaming={execution.connectionState === "streaming"}
              title="Executing..."
            />
          </div>
        )}

        {/* Phase: Completed */}
        {phase === "completed" && (
          <div className="space-y-6">
            <ShellCard className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-3xl border border-emerald-400/20 bg-emerald-400/10">
                <CheckCircle2 className="h-6 w-6 text-emerald-300" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Done</h3>
              <p className="mt-2 text-sm text-white/60">
                Friday has completed the task for: {goalTitle}
              </p>
              {execution.outputText && (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/40">
                    Result
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-white/60">
                    {execution.outputText.slice(0, 500)}
                  </p>
                </div>
              )}
            </ShellCard>

            <div className="flex gap-3">
              <Link to="/automations" className="flex-1">
                <ActionButton tone="secondary" className="w-full">
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  Automate this
                </ActionButton>
              </Link>
              <Link to="/home" className="flex-1">
                <ActionButton tone="primary" className="w-full">
                  Back to Home
                </ActionButton>
              </Link>
            </div>
          </div>
        )}

        {/* Phase: Failed */}
        {phase === "failed" && (
          <div className="space-y-4">
            <ShellCard className="text-center">
              <h3 className="text-lg font-semibold text-rose-200">Something went wrong</h3>
              <p className="mt-2 text-sm text-white/50">
                {investigation.errorMessage ?? execution.errorMessage ?? "The operation could not be completed."}
              </p>
            </ShellCard>
            <div className="flex gap-3">
              <ActionButton tone="secondary" onClick={handleRetry} className="flex-1">
                Try again
              </ActionButton>
              <Link to="/home" className="flex-1">
                <ActionButton tone="primary" className="w-full">
                  Back to Home
                </ActionButton>
              </Link>
            </div>
          </div>
        )}
      </GuidedFlowContainer>
    </div>
  );
}
