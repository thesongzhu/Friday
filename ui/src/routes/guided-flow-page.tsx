import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { localize, localizedText, resolveLocalizedText } from "@/lib/i18n/localized-text";
import { resolvePackLaunchContext } from "@/lib/packs/pack-links";
import { useAppLocale } from "@/providers/locale-provider";

type FlowPhase = "investigating" | "choosing" | "planning" | "executing" | "completed" | "failed";

function buildChoicesFromWizardResponse(
  wizardQuestions: string[],
  wizardSummary?: string,
): WizardStepChoice[] {
  if (wizardQuestions.length > 0) {
    return [
      {
        value: "proceed",
        label: localizedText("按 Friday 的建议继续", "Proceed With Friday's Approach"),
        description: localizedText(
          wizardSummary ?? "Friday 会按当前分析继续执行。",
          wizardSummary ?? "Friday will proceed based on its analysis.",
        ),
        outcome: localizedText(
          "Friday 负责处理细节，只在必要时打断你。",
          "Friday handles the details and asks only when essential.",
        ),
        risk: "low",
        recommended: true,
        reason: localizedText(
          "当前上下文已经足够安全推进。",
          "Friday has enough context to proceed safely.",
        ),
      },
      ...wizardQuestions.map((question, index) => ({
        value: `clarify-${String(index)}`,
        label: localizedText(`补充第 ${String(index + 1)} 个问题`, question),
        description: localizedText(
          "先补充这个信息，Friday 才能把执行方案收得更准。",
          "Answer this question to help Friday refine the approach.",
        ),
        outcome: localizedText(
          "得到一个更贴近你真实意图的执行方案。",
          "A more precise execution aligned with your intent.",
        ),
        risk: "low" as const,
      })),
      {
        value: "explore",
        label: localizedText("继续深入分析", "Investigate Further"),
        description: localizedText(
          "让 Friday 先多研究几种方案，再回来给你选。",
          "Ask Friday to research more alternatives before proceeding.",
        ),
        outcome: localizedText(
          "拿到更深一层的比较和更多选项。",
          "Get deeper analysis with more options.",
        ),
        risk: "low",
      },
    ];
  }

  return [
    {
      value: "proceed",
      label: localizedText("采用推荐方案", "Proceed With Recommended Approach"),
      description: localizedText(
        wizardSummary ?? "Friday 会按已生成的方案执行。",
        wizardSummary ?? "Friday will execute the plan it generated.",
      ),
      outcome: localizedText(
        "基于当前调查结果拿到最稳的执行路径。",
        "Get the best result based on the investigation.",
      ),
      risk: "low",
      recommended: true,
      reason: localizedText("这是当前判断下最优的路径。", "Friday determined this is the best approach."),
    },
    {
      value: "customize",
      label: localizedText("执行前先自定义", "Customize Before Executing"),
      description: localizedText(
        "先看一遍方案，再按你的要求微调后继续。",
        "Review and modify the approach before Friday proceeds.",
      ),
      outcome: localizedText(
        "得到一个更贴近你偏好的定制执行方案。",
        "Get a tailored execution matching your specific needs.",
      ),
      risk: "medium",
    },
    {
      value: "explore",
      label: localizedText("再多看几个方案", "Explore More Options"),
      description: localizedText(
        "让 Friday 再挖深一点，带回更多可比方案。",
        "Ask Friday to investigate further and present more alternatives.",
      ),
      outcome: localizedText(
        "得到更多选择和更完整的判断依据。",
        "Get additional options and deeper analysis.",
      ),
      risk: "low",
    },
  ];
}

export function GuidedFlowPage() {
  const { wizardId } = useParams<{ wizardId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { locale } = useAppLocale();
  const [phase, setPhase] = useState<FlowPhase>("investigating");
  const [investigationRunId, setInvestigationRunId] = useState<string | null>(null);
  const [executionRunId, setExecutionRunId] = useState<string | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [wizardAdvanced, setWizardAdvanced] = useState(false);
  const [focusNote, setFocusNote] = useState("");
  const [readyToStart, setReadyToStart] = useState(searchParams.get("mode") !== "adjust");

  const goalCategory = wizardId ? getGoalCategoryById(wizardId) : undefined;
  const packIdParam = searchParams.get("packId");
  const activePack = resolvePackLaunchContext(wizardId, packIdParam);
  const packExecutionContext = activePack
    ? { packId: activePack.id }
    : undefined;
  const goalTitle = goalCategory?.title ?? localizedText(wizardId ?? "目标", wizardId ?? "Goal");
  const goalTitleInline = resolveLocalizedText(goalTitle, locale);
  const investigationTask = goalCategory
    ? `Investigate and analyze options for: ${goalCategory.title.en}. ${goalCategory.subtitle.en} ${focusNote ? `Focus note: ${focusNote}.` : ""} Provide structured findings with recommendations.`
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
        executionContext: {
          surface: "guided-flow",
          interactive: true,
          ...(packExecutionContext ?? {}),
        },
      });
    },
    onSuccess: (result) => {
      setInvestigationRunId(result.runId);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "无法开始调查 / Failed to start investigation");
      setPhase("failed");
    },
  });

  // Start both wizard and investigation on mount
  useEffect(() => {
    if (wizardId && readyToStart && !investigationRunId && !startInvestigation.isPending) {
      guidedFlow.start();
      startInvestigation.mutate();
    }
  }, [readyToStart, wizardId]);

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
        guidedFlow.continueStep({ answer: choice?.label.en ?? selectedChoice });
        // After answering, the wizard may complete or ask more
        setPhase("choosing");
        setSelectedChoice(null);
        return null;
      }

      // Otherwise, proceed with execution
      const choiceLabel = choice?.label.en ?? selectedChoice ?? "recommended approach";
      const result = await agentApi.startRun({
        task: `Execute the ${choiceLabel} for: ${goalTitle.en}. Based on the previous investigation, proceed with implementation.`,
        requireReview: true,
        sessionKey: `guided:${wizardId ?? "unknown"}`,
        executionContext: {
          surface: "guided-flow",
          interactive: true,
          ...(packExecutionContext ?? {}),
        },
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
      toast.error(error instanceof Error ? error.message : localize(locale, "无法开始执行", "Failed to start execution"));
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
    if (searchParams.get("mode") !== "adjust") {
      guidedFlow.start();
      startInvestigation.mutate();
    } else {
      setReadyToStart(false);
    }
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
      { id: "investigate", label: localize(locale, "分析", "Investigate"), status: resolveStatus(0) },
      { id: "choose", label: localize(locale, "选择", "Choose"), status: resolveStatus(1) },
      { id: "plan", label: localize(locale, "计划", "Plan"), status: resolveStatus(2) },
      { id: "execute", label: localize(locale, "执行", "Execute"), status: resolveStatus(3) },
      {
        id: "done",
        label: localize(locale, "完成", "Done"),
        status: resolveStatus(4),
        detail: phase === "failed" ? localize(locale, "执行中断", "Something went wrong") : undefined,
      },
    ];
  }, [locale, phase]);

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
        {!readyToStart ? (
          <div className="space-y-4">
            <ShellCard>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                {localize(locale, "调整后开始", "Adjust Before Start")}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "先补一句你这次最想让 Friday 聚焦什么", "Add one note about what Friday should focus on")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                {localize(
                  locale,
                  "这不会变成一大串表单，只是让这次分析和执行更贴近你当前要处理的细节。",
                  "This is not a long form. It just helps Friday tune the investigation and execution for this run.",
                )}
              </p>
              <textarea
                value={focusNote}
                onChange={(event) => setFocusNote(event.target.value)}
                rows={4}
                className="agent-textarea mt-4"
                placeholder={localize(locale, "例如：先看风险最高的部分；不要改动生产；我更想要一个可执行的清单。", "For example: focus on the highest risk part; avoid production changes; give me an actionable checklist.")}
              />
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <ActionButton tone="secondary" onClick={() => navigate("/home")}>
                  {localize(locale, "返回首页", "Back To Home")}
                </ActionButton>
                <ActionButton onClick={() => setReadyToStart(true)}>
                  {localize(locale, "开始分析", "Start Investigating")}
                </ActionButton>
              </div>
            </ShellCard>
          </div>
        ) : null}

        {/* Phase: Investigating */}
        {readyToStart && phase === "investigating" && (
          <InvestigationPanel
            lines={investigation.findings}
            isStreaming={investigation.isStreaming}
            title={`${localize(locale, "正在分析", "Investigating")}: ${goalTitleInline}`}
          />
        )}

        {/* Phase: Choosing */}
        {readyToStart && phase === "choosing" && (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-[color:var(--color-text-secondary)]">
              {guidedFlow.wizardResponse?.summary
                ?? localize(locale, "先看这些选项。选一个，再继续下一步。", "Review these options, pick one, then continue.")}
            </p>

            {guidedFlow.wizard?.unknowns && guidedFlow.wizard.unknowns.length > 0 && (
              <div className="rounded-2xl border border-[color:var(--color-border-strong)] bg-[color:var(--color-accent-muted)] px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                  {localize(locale, "待补充问题", "Open Questions")}
                </p>
                <ul className="mt-2 space-y-1">
                  {guidedFlow.wizard.unknowns.map((unknown, i) => (
                    <li key={i} className="text-xs leading-5 text-[color:var(--color-text-secondary)]">{unknown}</li>
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
                  ? localize(locale, "处理中…", "Working…")
                  : selectedChoice === "explore"
                    ? localize(locale, "继续深入分析", "Investigate Further")
                    : selectedChoice?.startsWith("clarify-")
                      ? localize(locale, "提交补充信息", "Submit Answer")
                      : localize(locale, "继续执行", "Proceed")}
              </ActionButton>
            )}
          </div>
        )}

        {/* Phase: Planning (awaiting plan approval) */}
        {readyToStart && phase === "planning" && (
          <PlanReviewVisual
            title={localizedText(`关于“${goalTitle.zh}”的计划`, `Plan for ${goalTitle.en}`)}
            summary={localizedText(
              execution.outputText.slice(0, 300),
              execution.outputText.slice(0, 300),
            )}
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
        {readyToStart && phase === "executing" && !isAwaitingPlan && (
          <div className="space-y-4">
            <JourneyTracker
              goalTitle={goalTitleInline}
              phases={journeyPhases}
              currentPhaseIndex={Math.max(0, currentPhaseIndex)}
            />
            <InvestigationPanel
              lines={execution.outputText
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .map((text, i) => ({ id: `exec-${String(i)}`, text, type: "info" as const }))}
              isStreaming={execution.connectionState === "streaming"}
              title={localize(locale, "正在执行", "Executing")}
            />
          </div>
        )}

        {/* Phase: Completed */}
        {readyToStart && phase === "completed" && (
          <div className="space-y-6">
            <ShellCard className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-3xl border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]">
                <CheckCircle2 className="h-6 w-6 text-[color:var(--color-accent)]" />
              </div>
              <p className="mt-4 text-lg font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "已经完成", "Done")}
              </p>
              <p className="mt-2 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                {localize(locale, `Friday 已经完成“${goalTitle.zh}”这项任务。`, `Friday has completed the task for ${goalTitle.en}.`)}
              </p>
              {execution.outputText && (
                <div className="mt-4 rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] p-4 text-left">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
                    {localize(locale, "结果摘要", "Result")}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[color:var(--color-text-secondary)]">
                    {execution.outputText.slice(0, 500)}
                  </p>
                </div>
              )}
            </ShellCard>

            <div className="flex gap-3">
              <Link to="/automations" className="flex-1">
                <ActionButton tone="secondary" className="w-full">
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  {localize(locale, "把它自动化", "Automate This")}
                </ActionButton>
              </Link>
              <Link to="/home" className="flex-1">
                <ActionButton tone="primary" className="w-full">
                  {localize(locale, "回到首页", "Back To Home")}
                </ActionButton>
              </Link>
            </div>
          </div>
        )}

        {/* Phase: Failed */}
        {readyToStart && phase === "failed" && (
          <div className="space-y-4">
            <ShellCard className="text-center">
              <p className="text-lg font-semibold text-[color:var(--color-text-primary)]">
                {localize(locale, "过程中断了", "Something went wrong")}
              </p>
              <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
                {investigation.errorMessage ?? execution.errorMessage ?? localize(locale, "这次执行没有完成。", "The operation could not be completed.")}
              </p>
            </ShellCard>
            <div className="flex gap-3">
              <ActionButton tone="secondary" onClick={handleRetry} className="flex-1">
                {localize(locale, "再试一次", "Try Again")}
              </ActionButton>
              <Link to="/home" className="flex-1">
                <ActionButton tone="primary" className="w-full">
                  {localize(locale, "回到首页", "Back To Home")}
                </ActionButton>
              </Link>
            </div>
          </div>
        )}
      </GuidedFlowContainer>
    </div>
  );
}
