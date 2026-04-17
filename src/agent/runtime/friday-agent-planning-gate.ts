import { FridayDomainError } from "#errors";
import type { Database } from "better-sqlite3";

import { FRIDAY_AGENT_ERROR_CODES, FRIDAY_AGENT_MAX_ATTEMPTS } from "../friday-agent.constants.js";
import type {
  FridayAgentActualExecution,
  FridayAgentEventMap,
  FridayAgentPlanReviewPayload,
  FridayAgentRunStatus,
} from "../model/friday-agent.types.js";
import type { FridayAgentRunEventRepository } from "../persistence/friday-agent-run-event-repository.js";
import type { FridayAgentRunRepository } from "../persistence/friday-agent-run-repository.js";
import type { FridayAgentEventEmitter } from "./friday-agent-event-emitter.js";
import type {
  FridayAgentConversationContext,
  FridayAgentResumeRunParams,
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
} from "./friday-agent-runtime.types.js";
import type { FridayResolvedAgentTaskProfile } from "./friday-agent-task-profile.js";

export type FridayPlanningKind =
  | "generate_skill"
  | "generate_workflow"
  | "deploy_workflow"
  | "export_workflow_bundle"
  | "major_decision";

export type FridayAgentPlanningGateDecision =
  | { action: "pass_through"; pendingPlanRunId?: string | null }
  | { action: "return"; result: FridayAgentRuntimeResult; pendingPlanRunId?: string | null }
  | { action: "approve"; runId: string; pendingPlanRunId?: null }
  | { action: "reject"; runId: string; pendingPlanRunId?: null };

export interface FridayAgentPlanningGateService {
  handleTurn(input: {
    runId: string;
    task: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    taskProfile?: FridayResolvedAgentTaskProfile;
    constraints?: { readOnly?: boolean; operationalMode?: string };
    reviewRequired?: boolean;
    conversationContext?: FridayAgentConversationContext;
    focusState?: {
      pendingPlanRunId?: string;
      operationalMode?: string;
    } | null;
  }): FridayAgentPlanningGateDecision;
  approvePlan(input: FridayAgentResumeRunParams): Promise<FridayAgentRuntimeResult>;
  rejectPlan(input: {
    runId: string;
  }): FridayAgentRuntimeResult;
  /** P2-RUNTIME: Clean up internal state for a completed/failed run. */
  cleanupRun(runId: string): void;
}

export interface CreateFridayAgentPlanningGateServiceDeps {
  repo: FridayAgentRunRepository;
  runEventRepository?: FridayAgentRunEventRepository;
  runtime: FridayAgentRuntime;
  eventEmitter: FridayAgentEventEmitter;
  db: {
    withReadConnection<T>(fn: (db: Database) => T): T;
    withWriteTransaction<T>(fn: (db: Database) => T): T;
  };
  idGenerator: () => string;
  nowIso: () => string;
}

const APPROVE_COMMAND = /^(approve|approved|go ahead|proceed with the plan|proceed with plan|yes,? approve|yes approve|同意|批准|通过这个计划|按这个计划继续)$/i;
const REJECT_COMMAND = /^(reject|rejected|decline|cancel plan|stop|do not proceed|don't proceed|不同意|拒绝|驳回|取消这个计划)$/i;
const GENERATE_SKILL_HINTS = /\b(?:generate|create|build)\s+(?:a\s+)?(?:new\s+)?(?:friday\s+)?skill\b|\bskill generator\b/i;
const GENERATE_WORKFLOW_HINTS = /\b((?:generate|create|build|set up|make) (?:a )?(?:new )?(?:workflow|automation|pipeline))\b/i;
const DEPLOY_WORKFLOW_HINTS = /\b(deploy workflow|publish workflow|ship workflow|roll out workflow)\b/i;
const EXPORT_WORKFLOW_HINTS = /\b(export workflow|workflow bundle|package workflow)\b/i;
const MAJOR_DECISION_HINTS = /\b(architecture|architect|strategy|migration|roadmap|implementation plan|rollout plan|major refactor|large refactor|overhaul|choose between|decision|tradeoff|design the approach)\b/i;
const CONSTRAINT_HINTS = /\b(must|should|avoid|without|constraint|permission|runtime|read.?only|safe|safely|don't|do not|cannot)\b/i;
const DETAIL_HINTS = /\b(trigger|input|output|destination|runtime|workspace|browser|provider|channel|timeline|success|goal|constraint|notify|deploy|export)\b/i;

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function summarize(text: string, max = 160): string {
  const normalized = normalizeText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

const QA_BYPASS_HINTS = /\b(summarize|summarise|explain|describe|what is|tell me about|list|show|how does|overview|translate|recap|compare|analyze|analyse)\b/i;

function detectPlanningKind(task: string, reviewRequired?: boolean): FridayPlanningKind | null {
  const normalized = normalizeText(task);
  if (reviewRequired) {
    return "major_decision";
  }
  // Ordinary Q&A / summarization requests should never enter the planning gate
  if (QA_BYPASS_HINTS.test(normalized)) return null;
  if (GENERATE_SKILL_HINTS.test(normalized)) return "generate_skill";
  if (DEPLOY_WORKFLOW_HINTS.test(normalized)) return "deploy_workflow";
  if (EXPORT_WORKFLOW_HINTS.test(normalized)) return "export_workflow_bundle";
  if (GENERATE_WORKFLOW_HINTS.test(normalized)) return "generate_workflow";
  if (MAJOR_DECISION_HINTS.test(normalized)) return "major_decision";
  return null;
}

function isTaskDetailedEnough(task: string, kind: FridayPlanningKind): boolean {
  const normalized = normalizeText(task);
  const longEnough = normalized.length >= (kind === "major_decision" ? 140 : 110);
  const hasDetails = DETAIL_HINTS.test(normalized);
  const hasConstraints = CONSTRAINT_HINTS.test(normalized);
  return longEnough && hasDetails && (kind === "major_decision" ? hasConstraints : true);
}

function questionsForKind(kind: FridayPlanningKind): string[] {
  switch (kind) {
    case "generate_skill":
      return [
        "What exact outcome should this skill deliver for the user?",
        "What inputs, tools, or systems should it use or avoid?",
      ];
    case "generate_workflow":
      return [
        "What should trigger this workflow, and what output should it produce?",
        "Where should it run and what constraints or integrations matter?",
      ];
    case "deploy_workflow":
      return [
        "Which workflow or outcome are you trying to deploy, and to which environment?",
        "Should Friday run it immediately after deploy, or only publish it?",
      ];
    case "export_workflow_bundle":
      return [
        "Which workflow outcome are you packaging, and what should be included in the export bundle?",
        "What evidence or environment-specific settings need to be preserved in the bundle?",
      ];
    case "major_decision":
      return [
        "What outcome matters most for this decision?",
        "What constraints, risks, or non-goals must the plan respect?",
      ];
  }
}

function readAnswerCount(planReview: FridayAgentPlanReviewPayload | undefined): number {
  return planReview?.gate?.answers?.length ?? 0;
}

function buildClarificationPrompt(input: {
  kind: FridayPlanningKind;
  question: string;
  answeredCount: number;
  totalQuestions: number;
}): string {
  return [
    `Before I execute this ${input.kind.replaceAll("_", " ")}, I need one detail to make sure the direction is correct.`,
    `Question ${String(input.answeredCount + 1)}/${String(input.totalQuestions)}: ${input.question}`,
  ].join("\n");
}

function buildPlanMarkdown(input: {
  task: string;
  kind: FridayPlanningKind;
  answers: Array<{ question?: string; answer: string }>;
}): { summary: string; markdown: string } {
  const answerLines = input.answers.length > 0
    ? input.answers.map((entry) =>
      entry.question
        ? `- ${entry.question} ${entry.answer}`
        : `- ${entry.answer}`)
    : ["- No extra clarifications were required."];

  const steps = (() => {
    switch (input.kind) {
      case "generate_skill":
        return [
          "Confirm the final scope, runtime, and safety boundaries for the skill.",
          "Generate the skill implementation and manifest with Friday's existing skill toolchain.",
          "Run validation/tests, capture evidence, and summarize any remaining gaps before handoff.",
        ];
      case "generate_workflow":
        return [
          "Lock the workflow trigger, outputs, and runtime boundaries.",
          "Generate the workflow draft plus validation/test scaffolding.",
          "Verify the generated workflow, then report the publish/deploy next step with evidence.",
        ];
      case "deploy_workflow":
        return [
          "Confirm the workflow target and deploy expectations.",
          "Prepare the publish/deploy path using the existing workflow tooling.",
          "Validate the outcome and report the resulting deployment state truthfully.",
        ];
      case "export_workflow_bundle":
        return [
          "Confirm which workflow state and artifacts belong in the export bundle.",
          "Assemble the export bundle with the required evidence and metadata.",
          "Validate the bundle contents and report exactly what was produced.",
        ];
      case "major_decision":
        return [
          "Gather the minimum system/workspace facts required for the decision.",
          "Compare the viable options against the stated constraints and goals.",
          "Recommend a concrete path, then execute the first approved safe step if the task requires action.",
        ];
    }
  })();

  const summary = `Approved plan for ${input.kind.replaceAll("_", " ")}: ${summarize(input.task, 100)}`;
  const markdown = [
    "# Proposed plan",
    "",
    `Objective: ${summarize(input.task, 220)}`,
    "",
    "What Friday is optimizing for:",
    ...answerLines,
    "",
    "Execution path:",
    ...steps.map((step, index) => `${String(index + 1)}. ${step}`),
    "",
    "Approval requirement:",
    "Reply `approve` to continue or `reject` to stop before any real generation or execution starts.",
  ].join("\n");

  return { summary, markdown };
}

function buildExecutionTaskPrompt(input: {
  task: string;
  planReview: FridayAgentPlanReviewPayload;
}): string {
  const answerLines = input.planReview.gate?.answers?.map((entry) =>
    entry.question
      ? `- ${entry.question} ${entry.answer}`
      : `- ${entry.answer}`) ?? [];
  const toolchainInstruction = (() => {
    switch (input.planReview.gate?.kind) {
      case "generate_skill":
        return "CRITICAL execution rule: use the dedicated skill_generate toolchain to start, clarify, generate, and approve the skill. Do not create skill files manually with write/edit/exec unless skill_generate is unavailable or returns a concrete blocker you report truthfully.";
      case "generate_workflow":
      case "deploy_workflow":
      case "export_workflow_bundle":
        return "CRITICAL execution rule: use the workflow_generate / workflow toolchain for generation, deployment, or export. Do not hand-author workflow files with write/edit/exec unless the workflow toolchain is unavailable or returns a concrete blocker you report truthfully.";
      default:
        return undefined;
    }
  })();
  return [
    "The user already approved this plan. Execute the task now instead of asking for a new plan, unless a new hard blocker appears.",
    `Original task: ${input.task}`,
    input.planReview.gate?.planMarkdown ? `Approved plan:\n${input.planReview.gate.planMarkdown}` : undefined,
    answerLines.length > 0 ? `Confirmed details:\n${answerLines.join("\n")}` : undefined,
    toolchainInstruction,
    "Carry out the approved task truthfully, use tools when needed, and report what really happened.",
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
}

function parsePlanCommand(task: string): "approve" | "reject" | null {
  const normalized = normalizeText(task);
  if (APPROVE_COMMAND.test(normalized)) return "approve";
  if (REJECT_COMMAND.test(normalized)) return "reject";
  return null;
}

export function createFridayAgentPlanningGateService(
  deps: CreateFridayAgentPlanningGateServiceDeps,
): FridayAgentPlanningGateService {
  const seqCounters = new Map<string, number>();

  function nextSeq(runId: string): number {
    let current = seqCounters.get(runId) ?? 0;
    if (deps.runEventRepository) {
      const existing = deps.db.withReadConnection((reader) =>
        deps.runEventRepository!.list(reader, runId));
      current = Math.max(current, existing.at(-1)?.seq ?? 0);
    }
    const next = current + 1;
    seqCounters.set(runId, next);
    return next;
  }

  function emitRunEvent<K extends keyof FridayAgentEventMap>(
    eventName: K,
    payload: FridayAgentEventMap[K],
    runId: string,
  ): void {
    if (deps.runEventRepository) {
      const now = deps.nowIso();
      deps.db.withWriteTransaction((writer) =>
        deps.runEventRepository!.append(writer, {
          eventId: deps.idGenerator(),
          runId,
          seq: nextSeq(runId),
          eventName,
          payload: payload as unknown as Record<string, unknown>,
          emittedAt: now,
          createdAt: now,
        }));
    }
    deps.eventEmitter.emit(eventName, payload);
  }

  function persistAwaitingRun(input: {
    runId: string;
    task: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    taskProfile?: FridayResolvedAgentTaskProfile;
    constraints?: { readOnly?: boolean };
    kind: FridayPlanningKind;
    status: "awaiting_clarification" | "awaiting_plan_approval";
    message: string;
    planReview: FridayAgentPlanReviewPayload;
  }): FridayAgentRuntimeResult {
    const existing = deps.db.withReadConnection((reader) => deps.repo.getById(reader, input.runId));
    const actualExecution: FridayAgentActualExecution = {
      requestedProviderId: input.providerId,
      requestedModel: input.model,
      taskProfileId: input.taskProfile?.id,
      taskProfileModel: input.taskProfile?.model,
      modelSelectionSource: input.model
        ? (input.providerId ? "provider+model" : "model")
        : input.taskProfile?.model
          ? "task_profile"
          : "route_default",
      turns: [],
    };
    if (!existing) {
      deps.db.withWriteTransaction((writer) =>
        deps.repo.create(writer, {
          id: input.runId,
          task: input.task,
          sessionKey: input.sessionKey ?? `agent:run:${input.runId}`,
          providerId: input.providerId,
          model: input.model,
          maxAttempts: FRIDAY_AGENT_MAX_ATTEMPTS,
          nowIso: deps.nowIso(),
          constraints: input.constraints,
        }));
      emitRunEvent("agent.run.started", {
        runId: input.runId,
        task: input.task,
        model: input.model ?? "default",
        providerId: input.providerId ?? "default",
        ...(input.taskProfile
          ? {
              taskProfile: {
                id: input.taskProfile.id,
                model: input.taskProfile.model,
                modelSelectionSource: actualExecution.modelSelectionSource,
              },
            }
          : {}),
      }, input.runId);
    }

    deps.db.withWriteTransaction((writer) =>
      deps.repo.update(writer, {
        id: input.runId,
        status: input.status,
        startedAt: existing?.startedAt ?? deps.nowIso(),
        responseText: input.message,
        summary: summarize(input.message),
        planReview: input.planReview,
        actualExecution,
      }));

    emitRunEvent("agent.run.planning", {
      runId: input.runId,
      message: `Planning gate for ${input.kind.replaceAll("_", " ")}`,
    }, input.runId);

    if (input.status === "awaiting_clarification") {
      emitRunEvent("agent.run.awaiting_clarification", {
        runId: input.runId,
        status: "awaiting_clarification",
        message: input.message,
        questions: input.planReview.gate?.clarificationQuestions ?? [],
        planKind: input.kind,
      }, input.runId);
    } else {
      if (input.planReview.gate?.planMarkdown && input.planReview.gate?.planSummary) {
        emitRunEvent("agent.run.plan_ready", {
          runId: input.runId,
          planMarkdown: input.planReview.gate.planMarkdown,
          planSummary: input.planReview.gate.planSummary,
          planKind: input.kind,
        }, input.runId);
      }
      emitRunEvent("agent.run.awaiting_plan_approval", {
        runId: input.runId,
        status: "awaiting_plan_approval",
        message: input.message,
        planMarkdown: input.planReview.gate?.planMarkdown ?? input.message,
        planSummary: input.planReview.gate?.planSummary ?? summarize(input.message),
        planKind: input.kind,
      }, input.runId);
    }

    emitRunEvent("agent.run.progress", {
      runId: input.runId,
      phase: input.status,
      elapsedMs: 0,
      subagentCount: 0,
      etaConfidence: "unavailable",
    }, input.runId);

    return {
      runId: input.runId,
      status: input.status,
      response: input.message,
      toolCallCount: 0,
      durationMs: 0,
      usageInput: 0,
      usageOutput: 0,
      finalResponse: input.message,
    };
  }

  function buildInitialPlanReview(input: {
    task: string;
    kind: FridayPlanningKind;
  }): FridayAgentPlanReviewPayload {
    return {
      plan: {
        task: input.task,
        stepCount: 3,
        description: `Planning gate for ${input.kind.replaceAll("_", " ")}`,
      },
      gate: {
        kind: input.kind,
        state: "awaiting_clarification",
        clarificationQuestions: questionsForKind(input.kind),
        answers: [],
      },
    };
  }

  function continueClarification(input: {
    runId: string;
    task: string;
    existing: ReturnType<FridayAgentRunRepository["getById"]>;
  }): FridayAgentRuntimeResult {
    if (!input.existing?.planReview?.gate) {
      throw new FridayDomainError("AGENT_PLAN_NOT_FOUND", "Pending plan state not found", { httpStatus: 404 });
    }
    const gate = input.existing.planReview.gate;
    const questions = gate.clarificationQuestions ?? [];
    const answers = [...(gate.answers ?? [])];
    const answeredCount = answers.length;
    const question = questions[answeredCount];
    answers.push({
      ...(question ? { question } : {}),
      answer: normalizeText(input.task),
    });

    const requiredAnswers = questions.length > 0 ? questions.length : 1;
    if (answers.length < requiredAnswers) {
      const nextQuestion = questions[answers.length] ?? questions.at(-1) ?? "What detail matters most before I continue?";
      const updatedReview: FridayAgentPlanReviewPayload = {
        ...input.existing.planReview,
        gate: {
          ...gate,
          state: "awaiting_clarification",
          answers,
        },
      };
      const prompt = buildClarificationPrompt({
        kind: gate.kind,
        question: nextQuestion,
        answeredCount: answers.length,
        totalQuestions: questions.length,
      });
      return persistAwaitingRun({
        runId: input.runId,
        task: input.existing.task,
        sessionKey: input.existing.sessionKey,
        providerId: input.existing.providerId,
        model: input.existing.model,
        taskProfile: input.existing.taskProfile,
        constraints: input.existing.constraints,
        kind: gate.kind,
        status: "awaiting_clarification",
        message: prompt,
        planReview: updatedReview,
      });
    }

    const plan = buildPlanMarkdown({
      task: input.existing.task,
      kind: gate.kind,
      answers,
    });
    const updatedReview: FridayAgentPlanReviewPayload = {
      ...input.existing.planReview,
      decision: undefined,
      gate: {
        ...gate,
        state: "awaiting_plan_approval",
        answers,
        planMarkdown: plan.markdown,
        planSummary: plan.summary,
        approvalPrompt: "Reply `approve` to continue or `reject` to stop.",
        approvalUpdatedAt: deps.nowIso(),
      },
    };
    return persistAwaitingRun({
      runId: input.runId,
      task: input.existing.task,
      sessionKey: input.existing.sessionKey,
      providerId: input.existing.providerId,
      model: input.existing.model,
      taskProfile: input.existing.taskProfile,
      constraints: input.existing.constraints,
      kind: gate.kind,
      status: "awaiting_plan_approval",
      message: plan.markdown,
      planReview: updatedReview,
    });
  }

  function revisePlan(input: {
    runId: string;
    task: string;
    existing: ReturnType<FridayAgentRunRepository["getById"]>;
  }): FridayAgentRuntimeResult {
    if (!input.existing?.planReview?.gate) {
      throw new FridayDomainError("AGENT_PLAN_NOT_FOUND", "Pending plan state not found", { httpStatus: 404 });
    }
    const gate = input.existing.planReview.gate;
    const answers = [
      ...(gate.answers ?? []),
      { question: "Plan feedback", answer: normalizeText(input.task) },
    ];
    const plan = buildPlanMarkdown({
      task: input.existing.task,
      kind: gate.kind,
      answers,
    });
    const updatedReview: FridayAgentPlanReviewPayload = {
      ...input.existing.planReview,
      decision: undefined,
      gate: {
        ...gate,
        state: "awaiting_plan_approval",
        answers,
        planMarkdown: plan.markdown,
        planSummary: plan.summary,
        approvalPrompt: "Reply `approve` to continue or `reject` to stop.",
        approvalUpdatedAt: deps.nowIso(),
      },
    };
    return persistAwaitingRun({
      runId: input.runId,
      task: input.existing.task,
      sessionKey: input.existing.sessionKey,
      providerId: input.existing.providerId,
      model: input.existing.model,
      taskProfile: input.existing.taskProfile,
      constraints: input.existing.constraints,
      kind: gate.kind,
      status: "awaiting_plan_approval",
      message: plan.markdown,
      planReview: updatedReview,
    });
  }

  return {
    handleTurn(input) {
      const turnKind = input.conversationContext?.turnKind;
      if (turnKind === "status_check") {
        return { action: "pass_through" };
      }

      const pendingRunId = input.focusState?.pendingPlanRunId?.trim();
      if (pendingRunId) {
        const pendingRun = deps.db.withReadConnection((reader) => deps.repo.getById(reader, pendingRunId));
        if (!pendingRun) {
          return { action: "pass_through", pendingPlanRunId: null };
        }
        const command = parsePlanCommand(input.task);
        if (command === "approve") {
          return { action: "approve", runId: pendingRunId, pendingPlanRunId: null };
        }
        if (command === "reject") {
          return { action: "reject", runId: pendingRunId, pendingPlanRunId: null };
        }
        if (pendingRun.status === "awaiting_clarification") {
          return {
            action: "return",
            result: continueClarification({
              runId: pendingRunId,
              task: input.task,
              existing: pendingRun,
            }),
            pendingPlanRunId: pendingRunId,
          };
        }
        if (pendingRun.status === "awaiting_plan_approval") {
          return {
            action: "return",
            result: revisePlan({
              runId: pendingRunId,
              task: input.task,
              existing: pendingRun,
            }),
            pendingPlanRunId: pendingRunId,
          };
        }
        return { action: "pass_through", pendingPlanRunId: null };
      }

      // ─── Plan mode bypass: force all tasks through the planning gate ───
      const operationalMode = input.focusState?.operationalMode ?? input.constraints?.operationalMode;
      const kind = operationalMode === "plan"
        ? "major_decision" as FridayPlanningKind
        : detectPlanningKind(input.task, input.reviewRequired);
      if (!kind) {
        return { action: "pass_through" };
      }

      if (isTaskDetailedEnough(input.task, kind)) {
        const initialReview = buildInitialPlanReview({
          task: input.task,
          kind,
        });
        const plan = buildPlanMarkdown({
          task: input.task,
          kind,
          answers: [],
        });
        initialReview.gate = {
          ...initialReview.gate!,
          state: "awaiting_plan_approval",
          planMarkdown: plan.markdown,
          planSummary: plan.summary,
          approvalPrompt: "Reply `approve` to continue or `reject` to stop.",
          approvalUpdatedAt: deps.nowIso(),
        };
        return {
          action: "return",
          result: persistAwaitingRun({
            runId: input.runId,
            task: input.task,
            sessionKey: input.sessionKey,
            providerId: input.providerId,
            model: input.model,
            taskProfile: input.taskProfile,
            constraints: input.constraints,
            kind,
            status: "awaiting_plan_approval",
            message: plan.markdown,
            planReview: initialReview,
          }),
          pendingPlanRunId: input.runId,
        };
      }

      const initialReview = buildInitialPlanReview({
        task: input.task,
        kind,
      });
      const prompt = buildClarificationPrompt({
        kind,
        question: initialReview.gate?.clarificationQuestions?.[0] ?? "What detail matters most before I continue?",
        answeredCount: 0,
        totalQuestions: initialReview.gate?.clarificationQuestions?.length ?? 1,
      });
      return {
        action: "return",
        result: persistAwaitingRun({
          runId: input.runId,
          task: input.task,
          sessionKey: input.sessionKey,
          providerId: input.providerId,
          model: input.model,
          taskProfile: input.taskProfile,
          constraints: input.constraints,
          kind,
          status: "awaiting_clarification",
          message: prompt,
          planReview: initialReview,
        }),
        pendingPlanRunId: input.runId,
      };
    },

    async approvePlan(input) {
      const run = deps.db.withReadConnection((reader) => deps.repo.getById(reader, input.runId));
      if (!run) {
        throw new FridayDomainError("AGENT_RUN_NOT_FOUND", "Agent run not found", { httpStatus: 404 });
      }
      if (run.status !== "awaiting_plan_approval") {
        throw new FridayDomainError(
          "AGENT_PLAN_NOT_AWAITING_APPROVAL",
          `Run ${input.runId} is not awaiting plan approval`,
          { httpStatus: 409 },
        );
      }

      const planReview: FridayAgentPlanReviewPayload = {
        ...(run.planReview ?? {
          plan: {
            task: run.task,
            stepCount: 3,
            description: summarize(run.task),
          },
        }),
        decision: {
          approved: true,
          mode: "manual-approve",
          reason: "Approved by user",
          reviewedAt: deps.nowIso(),
        },
        gate: {
          ...(run.planReview?.gate ?? {
            kind: "major_decision" as const,
          }),
          state: "approved",
          approvalUpdatedAt: deps.nowIso(),
        },
      };

      deps.db.withWriteTransaction((writer) =>
        deps.repo.update(writer, {
          id: run.id,
          planReview,
        }));

      return deps.runtime.executeRun({
        runId: run.id,
        task: run.task,
        taskPrompt: buildExecutionTaskPrompt({
          task: run.task,
          planReview,
        }),
        sessionKey: input.sessionKey ?? run.sessionKey,
        providerId: input.providerId ?? run.providerId,
        tenantContext: input.tenantContext,
        model: input.model ?? run.model,
        timezone: input.timezone,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        constraints: input.constraints ?? run.constraints,
        principalId: input.principalId,
        scopes: input.scopes,
        executionContext: input.executionContext,
        historyMessages: input.historyMessages,
        conversationContext: input.conversationContext,
        resumeExistingRun: true,
        skipPlanningReview: true,
        planReviewOverride: planReview,
      });
    },

    rejectPlan(input) {
      const run = deps.db.withReadConnection((reader) => deps.repo.getById(reader, input.runId));
      if (!run) {
        throw new FridayDomainError("AGENT_RUN_NOT_FOUND", "Agent run not found", { httpStatus: 404 });
      }
      const completedAt = deps.nowIso();
      const response = "Plan rejected. Friday stopped before executing any real generation or action.";
      const planReview: FridayAgentPlanReviewPayload = {
        ...(run.planReview ?? {
          plan: {
            task: run.task,
            stepCount: 0,
            description: summarize(run.task),
          },
        }),
        decision: {
          approved: false,
          mode: "manual-reject",
          reason: "Rejected by user",
          reviewedAt: completedAt,
        },
        gate: {
          ...(run.planReview?.gate ?? {
            kind: "major_decision" as const,
          }),
          state: "rejected",
          approvalUpdatedAt: completedAt,
        },
      };
      deps.db.withWriteTransaction((writer) =>
        deps.repo.update(writer, {
          id: run.id,
          status: "cancelled",
          completedAt,
          durationMs: 0,
          responseText: response,
          summary: summarize(response),
          planReview,
        }));
      emitRunEvent("agent.run.cancelled", {
        runId: run.id,
        reason: "Plan rejected by user",
      }, run.id);
      return {
        runId: run.id,
        status: "cancelled",
        response,
        toolCallCount: 0,
        durationMs: 0,
        usageInput: 0,
        usageOutput: 0,
        finalResponse: response,
      };
    },

    // P2-RUNTIME-005: Clean up seqCounters entry to prevent memory leak
    cleanupRun(runId: string): void {
      seqCounters.delete(runId);
    },
  };
}
