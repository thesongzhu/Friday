import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { FridayDomainError } from "#errors";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";
import type {
  FridayProviderAttempt,
  FridayProviderBackendKind,
} from "#providers";

import {
  FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
  FRIDAY_AGENT_COMPACTION_THRESHOLD,
  FRIDAY_AGENT_ERROR_CODES,
  FRIDAY_AGENT_MAX_ATTEMPTS,
  FRIDAY_AGENT_MAX_LOOP_ITERATIONS,
  FRIDAY_AGENT_MAX_TOOL_CALLS,
  FRIDAY_AGENT_RUN_TIMEOUT_MS,
  FRIDAY_AGENT_SESSION_KEY_PREFIX,
  FRIDAY_AGENT_TOOL_RESULT_CAPS,
  FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS,
  FRIDAY_AGENT_TOOL_TIMEOUT_MS,
} from "../friday-agent.constants.js";
import type {
  FridayAgentActualExecution,
  FridayAgentActualTurn,
  FridayAgentArtifact,
  FridayAgentContentBlock,
  FridayAgentEtaConfidence,
  FridayAgentImageBlock,
  FridayAgentMessage,
  FridayAgentPlanReviewPayload,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentTestResult,
  FridayAgentToolCallRecord,
  FridayAgentToolDefinition,
  FridayAgentToolResult,
  FridayAgentToolResultBlock,
  FridayAgentToolUseBlock,
} from "../model/friday-agent.types.js";
import type { FridayWorldState } from "../model/friday-agent-world-state.types.js";
import { createFridayAgentRunRepository } from "../persistence/friday-agent-run-repository.js";
import type {
  FridayAgentLlmStreamEvent,
  FridayAgentLlmStreamParams,
} from "./friday-agent-llm-client.types.js";
import type {
  CreateFridayAgentRuntimeDeps,
  FridayAgentConversationContext,
  FridayAgentExecutionContext,
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
  FridayAgentSystemPromptBuildResult,
} from "./friday-agent-runtime.types.js";
import { evaluateFridayAnswerAlignment } from "./friday-agent-answer-alignment.js";
import { buildFridayLearningContextFragment } from "./friday-agent-workspace-context.js";
import { notifyFridayContextEngineAfterTurn } from "./friday-agent-context-engine.js";
import type { FridayDecisionContext } from "./friday-agent-decision-engine.types.js";
import { createFridayFileVersionTracker } from "./friday-agent-file-version-tracker.js";
import {
  classifyToolBatchDependencies,
  executeToolBatch,
  extractFilePaths,
} from "./friday-agent-tool-batch-executor.js";
import { attachFridayAgentToolExecutionContext } from "./friday-agent-tool-execution-context.js";
import { shouldDelegateFridayAgentTask } from "./friday-agent-delegation-policy.js";
import { resolveFridayAgentTaskProfile } from "./friday-agent-task-profile.js";
import { isMutatingToolCall } from "./friday-agent-tool-mutation.js";
import { getApprovalRequiredReasonForToolCall } from "./friday-agent-tool-risk.js";
import { summarizeToolCall } from "../services/friday-tool-call-summary.js";
import {
  extractJsonCodeBlocks,
  looksLikeJson,
  type ParsedTextToolCall,
  recoverToolCallsFromAssistantText,
  unwrapJsonCodeFence,
} from "./friday-agent-tool-call-recovery.js";
import {
  buildRunTimeContext,
  evaluateTimeSensitiveResponse,
  extractMessageText,
  hasTimeSensitiveNewsIntent,
  readPreferredTimezone,
  type RunTimeContext,
  type TimeSensitiveResponseDecision,
} from "./friday-agent-time-sensitive-handler.js";
import {
  buildArtifactTruthRetryPrompt,
  buildDesktopContentInspectionRetryPrompt,
  buildEvidenceRetryPrompt,
  detectArtifactTruthGap,
  detectEvidenceClosureGap,
  detectOutputClosureGap,
  enforceBoundaryClarityResponse,
  enforceFeedbackPersistenceEvidence,
  enforceToolEvidenceForCompletionClaim,
  FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE,
  FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE,
  hasDesktopContentInspectionCoverageEvidence,
  hasSafeDiagnosticCompletionEvidence,
  hasSuccessfulToolEvidence,
  normalizeDefaultRouteSentinel,
  type OutputClosureGap,
  responseAddressesDesktopContentInspection,
  shouldEnforceToolEvidenceForTask,
  taskRequiresReadOnlyDesktopInspection,
  toolCallViolatesDesktopInspectionIntent,
} from "./friday-agent-closure-gap-detector.js";

const RULES_EVALUATE_SCOPE = "rules:evaluate";
const TERMINAL_CONTEXT_ENGINE_STATUSES: ReadonlySet<FridayAgentRunStatus> = new Set([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);

function hasCjkText(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function deriveReplyAnchorAssistantFact(
  conversationContext?: FridayAgentConversationContext,
): string | undefined {
  const replyAnchorSummary = conversationContext?.selectedBlocks
    ?.find((block) => block.source === "reply_anchor")
    ?.summary
    ?.trim();
  if (replyAnchorSummary) {
    const assistantMatch = replyAnchorSummary.match(/assistant:\s*([\s\S]+)$/i);
    const fact = assistantMatch?.[1]?.trim() ?? replyAnchorSummary;
    return fact.length > 0 ? fact : undefined;
  }

  const assistantAnchorSummary = conversationContext?.selectedBlocks
    ?.find((block) => block.source === "assistant_anchor")
    ?.summary
    ?.trim();
  return assistantAnchorSummary && assistantAnchorSummary.length > 0
    ? assistantAnchorSummary
    : undefined;
}

function buildReplyAnchorFallbackResponse(params: {
  task: string;
  conversationContext?: FridayAgentConversationContext;
}): string | undefined {
  const assistantFact = deriveReplyAnchorAssistantFact(params.conversationContext);
  if (!assistantFact) {
    return undefined;
  }

  if (hasCjkText(params.task)) {
    return [
      `我把这条追问锚定到前面的回复：${assistantFact}${assistantFact.endsWith("。") ? "" : "。"}`,
      "基于这条已知事实，我目前能确认的是前面提到的情况本身。",
      "更深一层的根因我现在没有可验证证据，所以不做额外假设。",
    ].join("");
  }

  return [
    `I'm anchoring this follow-up to the earlier reply: ${assistantFact}${/[.!?]$/.test(assistantFact) ? "" : "."}`,
    " Based on that referenced fact, that's the concrete explanation I can verify here.",
    " I do not have deeper root-cause evidence beyond that, so I won't speculate.",
  ].join("");
}

function hasExplicitResearchIntent(task: string): boolean {
  return /\b(search|research|look up|lookup|find sources|find source|latest|news|browse|google|compare|price|current|today|now|check online)\b/i.test(task)
    || /(搜索|搜一下|查一下|查一查|上网查|最新|新闻|帮我找资料|对比|价格|多少钱|现在|当前|查查)/.test(task);
}

// ─── Factory ───

export function createFridayAgentRuntime(
  deps: CreateFridayAgentRuntimeDeps,
): FridayAgentRuntime {
  const {
    db,
    llmClient,
    model,
    providerId,
    systemPrompt: staticSystemPrompt,
    systemPromptBuilder,
    tools: depsTools,
    eventEmitter,
    idGenerator,
    nowIso,
    reviewGate,
    runEventRepository,
    selfTestService,
    workdir,
    sessionMirror,
    usageRecorder,
    artifactWriter,
    evaluateRules,
    learningContextBuilder,
    communicationPromptBuilder,
    delegationHandler,
    contextEngine,
    decisionEngine,
  } = deps;

  // Clone the tools array so registerTool does not mutate the caller's array.
  const tools = [...depsTools];

  const repo = createFridayAgentRunRepository();
  const toolMap = new Map<string, FridayAgentToolDefinition>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // ─── Per-run event sequence counter ───
  const runSeqCounters = new Map<string, number>();

  function nextSeq(runId: string): number {
    let current = runSeqCounters.get(runId);
    if (current === undefined) {
      if (runEventRepository) {
        try {
          const existingEvents = db.withReadConnection((reader) =>
            runEventRepository.list(reader, runId),
          );
          current = existingEvents.at(-1)?.seq ?? 0;
        } catch (err) {
          console.warn("[friday][agent-runtime] seq-counter-recover:", err instanceof Error ? err.message : String(err));
          current = 0;
        }
      } else {
        current = 0;
      }
    }
    const next = current + 1;
    runSeqCounters.set(runId, next);
    return next;
  }

  /** Persist event durably (if repo available) then emit. */
  function emitRunEvent(
    eventName: string,
    payload: Record<string, unknown>,
    runId: string,
  ): void {
    if (runEventRepository) {
      const seq = nextSeq(runId);
      const now = nowIso();
      try {
        db.withWriteTransaction((writer) =>
          runEventRepository.append(writer, {
            eventId: idGenerator(),
            runId,
            seq,
            eventName,
            payload,
            emittedAt: now,
            createdAt: now,
          }),
        );
      } catch (err) {
        // Non-fatal: event persistence failure should not kill the run
        console.warn("[friday][agent-runtime] event-persist:", err instanceof Error ? err.message : String(err));
      }
    }
    eventEmitter.emit(eventName as keyof typeof eventEmitter extends never ? never : Parameters<typeof eventEmitter.emit>[0], payload as never);
  }

  return {
    registerTool(tool) {
      const existingIndex = tools.findIndex((t) => t.name === tool.name);
      if (existingIndex >= 0) {
        tools[existingIndex] = tool;
      } else {
        tools.push(tool);
      }
      toolMap.set(tool.name, tool);
    },

    resumeStaleRunsOnBoot(): number {
      const staleRuns = db.withReadConnection((reader) => repo.listActive(reader));
      let failedCount = 0;
      for (const run of staleRuns) {
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: run.id,
            status: "failed",
            completedAt: nowIso(),
            durationMs: 0,
            errorCode: FRIDAY_AGENT_ERROR_CODES.INTERRUPTED,
            errorMessage: `Agent run was in "${run.status}" state when the system restarted. Marked as failed on boot.`,
          }),
        );

        emitRunEvent("agent.run.failed", {
          runId: run.id,
          error: {
            code: FRIDAY_AGENT_ERROR_CODES.INTERRUPTED,
            message: `Stale run recovered on boot (was "${run.status}")`,
          },
          durationMs: 0,
          routeId: "agent.resume_stale_runs",
          correlationId: run.id,
        }, run.id);

        failedCount++;
      }
      return failedCount;
    },

    async executeRun(params) {
      const runId = params.runId ?? idGenerator();
      const runCorrelationId = runId;
      const sessionKey = params.sessionKey ?? `${FRIDAY_AGENT_SESSION_KEY_PREFIX}${runId}`;
      const existingRun = params.resumeExistingRun
        ? db.withReadConnection((reader) => repo.getById(reader, runId))
        : null;
      if (params.resumeExistingRun && !existingRun) {
        throw new FridayDomainError(
          FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
          `Cannot resume agent run '${runId}' because it does not exist`,
          { httpStatus: 404 },
        );
      }
      const maxAttempts = params.maxAttempts ?? FRIDAY_AGENT_MAX_ATTEMPTS;
      const timeoutMs = params.timeoutMs ?? FRIDAY_AGENT_RUN_TIMEOUT_MS;
      const startedAt = Date.now();
      const constraints = params.constraints;
      const isReadOnly = constraints?.readOnly === true;
      const disabledToolNames = new Set(normalizeToolNameSet(params.disabledToolNames));
      const executionContext = params.executionContext;
      const conversationContext = params.conversationContext;
      const hasAnchoredAssistantFact = Boolean(
        deriveReplyAnchorAssistantFact(conversationContext),
      );
      if (hasAnchoredAssistantFact && !hasExplicitResearchIntent(params.task)) {
        disabledToolNames.add("web_search");
      }
      const principalId =
        typeof params.principalId === "string" && params.principalId.trim().length > 0
          ? params.principalId
          : undefined;
      const scopes = normalizeScopes(params.scopes);
      let currentPhase: FridayAgentRunStatus = "pending";
      let activeToolName: string | undefined;
      let latestSubagentId: string | undefined;
      let nonFatalWarningCount = 0;
      const activeSubagentIds = new Set<string>();

      // Resolve per-run overrides (FIX-1)
      const explicitRequestedProviderId = normalizeDefaultRouteSentinel(params.providerId);
      const explicitRequestedModel = normalizeDefaultRouteSentinel(params.model);
      const taskProfileRequestedModel = normalizeDefaultRouteSentinel(params.taskProfile?.model);
      const requestedProviderId = explicitRequestedProviderId
        ?? normalizeDefaultRouteSentinel(providerId);
      const requestedModel = explicitRequestedModel
        ?? taskProfileRequestedModel
        ?? normalizeDefaultRouteSentinel(model);
      const modelSelectionSource: FridayAgentActualExecution["modelSelectionSource"] =
        params.modelSelectionSourceOverride === "inherited"
          ? "inherited"
          : explicitRequestedProviderId && explicitRequestedModel
            ? "provider+model"
            : explicitRequestedModel
              ? "model"
              : taskProfileRequestedModel
                ? "task_profile"
                : "route_default";
      const resolvedTaskProfile = resolveFridayAgentTaskProfile({
        id: params.taskProfile?.id ?? "default",
        model: requestedModel,
        temperature: params.taskProfile?.temperature,
        reasoningEffort: params.taskProfile?.reasoningEffort,
        reason: params.taskProfile?.reason,
      });
      let latestContextCostSummary: FridayAgentRuntimeResult["contextCostSummary"];
      const mirrorAssistantResponse = async (
        response: string,
        toolCalls?: FridayAgentToolCallRecord[],
      ): Promise<void> => {
        if (!sessionMirror || response.trim().length === 0) {
          return;
        }
        try {
          await sessionMirror(sessionKey, {
            role: "assistant",
            content: response,
            contentText: response,
            idempotencyKey: `agent-run:${runId}:response`,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
          });
        } catch (error) {
          console.warn(
            `[friday][W-AG-SESSION-MIRROR-001] Failed to mirror assistant response for run ${runId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      };
      const finalizeResult = async (
        input: FridayAgentRuntimeResult & {
          summary?: string;
          artifactDir?: string;
        },
      ): Promise<FridayAgentRuntimeResult> => {
        if (TERMINAL_CONTEXT_ENGINE_STATUSES.has(input.status)) {
          await notifyFridayContextEngineAfterTurn(contextEngine, {
            runId,
            userId: principalId,
            sessionKey,
            task: params.task,
            response: input.response,
            status: input.status,
            summary: input.summary ?? deriveSummary(input.response),
            artifactDir: input.artifactDir,
            conversationContext,
          });
        }

        return {
          runId: input.runId,
          status: input.status,
          response: input.response,
          toolCallCount: input.toolCallCount,
          durationMs: input.durationMs,
          usageInput: input.usageInput,
          usageOutput: input.usageOutput,
          ...(input.images ? { images: input.images } : {}),
          ...(input.finalResponse ? { finalResponse: input.finalResponse } : {}),
          ...(nonFatalWarningCount > 0 ? { nonFatalWarningCount } : {}),
        };
      };

      function deriveEta(elapsedMs: number): { eta?: number; etaConfidence: FridayAgentEtaConfidence } {
        if (timeoutMs > elapsedMs) {
          return {
            eta: timeoutMs - elapsedMs,
            etaConfidence: "low",
          };
        }
        return { etaConfidence: "unavailable" };
      }

      const emitProgressEvent = (): void => {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const eta = deriveEta(elapsedMs);
        emitRunEvent("agent.run.progress", {
          runId,
          phase: currentPhase,
          elapsedMs,
          ...(activeToolName ? { activeTool: activeToolName } : {}),
          subagentCount: activeSubagentIds.size,
          ...(latestSubagentId ? { latestSubagentId } : {}),
          ...(activeSubagentIds.size > 0 ? { activeSubagentIds: [...activeSubagentIds] } : {}),
          ...(typeof eta.eta === "number" ? { eta: eta.eta } : {}),
          etaConfidence: eta.etaConfidence,
        }, runId);
      };

      const handleTrackedEvent = (eventName: string, payload: Record<string, unknown>): void => {
        switch (eventName) {
          case "agent.run.started":
            currentPhase = "pending";
            break;
          case "agent.run.planning":
            currentPhase = "planning";
            break;
          case "agent.run.awaiting_clarification":
            currentPhase = "awaiting_clarification";
            activeToolName = undefined;
            break;
          case "agent.run.awaiting_plan_approval":
            currentPhase = "awaiting_plan_approval";
            activeToolName = undefined;
            break;
          case "agent.run.executing":
            currentPhase = "executing";
            break;
          case "agent.run.tool_start":
            if (typeof payload.toolName === "string" && payload.toolName.trim().length > 0) {
              activeToolName = payload.toolName;
            }
            break;
          case "agent.run.tool_end":
            if (typeof payload.toolName === "string" && payload.toolName === activeToolName) {
              activeToolName = undefined;
            }
            break;
          case "agent.run.completed":
            currentPhase = "completed";
            activeToolName = undefined;
            break;
          case "agent.run.failed":
            currentPhase = "failed";
            activeToolName = undefined;
            break;
          case "agent.run.cancelled":
            currentPhase = "cancelled";
            activeToolName = undefined;
            break;
        }

        emitRunEvent(eventName, payload, runId);
        if (eventName !== "agent.run.text_delta" && eventName !== "agent.run.progress") {
          emitProgressEvent();
        }
      };

      const onSubagentSpawned = (payload: { parentRunId: string; subagentId: string }): void => {
        if (payload.parentRunId !== runId) return;
        activeSubagentIds.add(payload.subagentId);
        latestSubagentId = payload.subagentId;
        emitProgressEvent();
      };

      const onSubagentCompleted = (payload: { parentRunId: string; subagentId: string }): void => {
        if (payload.parentRunId !== runId) return;
        activeSubagentIds.delete(payload.subagentId);
        latestSubagentId = payload.subagentId;
        emitProgressEvent();
      };

      eventEmitter.on("agent.subagent.spawned", onSubagentSpawned);
      eventEmitter.on("agent.subagent.completed", onSubagentCompleted);
      const progressTimer = setInterval(() => {
        emitProgressEvent();
      }, 15_000);

      // 1. Create run record unless we are resuming a previously gated run.
      if (!existingRun) {
        db.withWriteTransaction((writer) =>
          repo.create(writer, {
            id: runId,
            task: params.task,
            sessionKey,
            providerId: requestedProviderId,
            model: requestedModel,
            maxAttempts,
            nowIso: nowIso(),
            constraints,
          }),
        );
      }

      // Setup abort controller with timeout
      const runAbortController = new AbortController();
      const abortTimer = setTimeout(() => {
        runAbortController.abort(new Error("Agent run timed out"));
      }, Math.max(1, timeoutMs));

      // Wire external signal
      const onExternalAbort = () => {
        runAbortController.abort(params.signal?.reason);
      };
      if (params.signal?.aborted) {
        runAbortController.abort(params.signal.reason);
      } else {
        params.signal?.addEventListener("abort", onExternalAbort, { once: true });
      }

      const messages: FridayAgentMessage[] = normalizeHistoryMessages(params.historyMessages);
      const llmTask = typeof params.taskPrompt === "string" && params.taskPrompt.trim().length > 0
        ? params.taskPrompt.trim()
        : params.task;
      let learnedPreferences: Record<string, unknown> = {};
      let learningContextFragment = "";
      if (learningContextBuilder && principalId) {
        try {
          const learningCtx = learningContextBuilder({ userId: principalId, nowIso: nowIso() });
          if (learningCtx.preferences && typeof learningCtx.preferences === "object") {
            learnedPreferences = learningCtx.preferences;
          }
          learningContextFragment = buildFridayLearningContextFragment({
            individuationStage: learningCtx.individuationStage,
            activePatterns: learningCtx.activePatterns,
          });
        } catch (err) {
          // Non-fatal: preference enrichment failure should not kill the run.
          console.warn("[friday][agent-runtime] preference-enrichment:", err instanceof Error ? err.message : String(err));
          nonFatalWarningCount++;
        }
      }
      const runTimeContext = buildRunTimeContext(
        nowIso(),
        params.timezone,
        readPreferredTimezone(learnedPreferences),
      );
      const timeSensitiveNewsRequested = hasTimeSensitiveNewsIntent(params.task, messages);
      const allToolCalls: FridayAgentToolCallRecord[] = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let responseText = "";
      const actualTurns: FridayAgentActualTurn[] = [];
      let latestTestResults: FridayAgentTestResult[] = [];
      let latestArtifacts: FridayAgentArtifact[] = [];
      let latestActualExecution: FridayAgentActualExecution | undefined;
      let latestCostUsd: number | undefined;
      let latestFallbackAttempts: FridayProviderAttempt[] = [];
      let latestBackendKind: FridayProviderBackendKind | undefined;
      let latestActualProviderKind: string | undefined;
      let latestActualProviderApi: string | undefined;
      let latestRoutingDecisionReason: string | undefined;
      let latestLearningAdjusted = false;
      let latestRouteDecisionTrace: FridayAgentActualExecution["routeDecisionTrace"] | undefined;

      const estimateRoutingContext = (): NonNullable<FridayAgentLlmStreamParams["routingContext"]> => {
        const estimatedChars =
          params.task.length
          + messages.reduce((sum, message) => {
            if (typeof message.content === "string") {
              return sum + message.content.length;
            }
            return sum + JSON.stringify(message.content).length;
          }, 0);
        const complexity = resolvedTaskProfile.id === "planning" || resolvedTaskProfile.id === "review"
          ? "complex"
          : estimatedChars < 1200
            ? "simple"
            : "medium";
        return {
          estimatedInputTokens: Math.max(1, Math.ceil(estimatedChars / 4)),
          complexity,
          requiresNativeTools: true,
          taskProfileId: resolvedTaskProfile.id,
        };
      };

      const summarizeBlockedTools = (): FridayAgentActualExecution["blockedTools"] => {
        const blocked = allToolCalls
          .filter((record) => record.result.isError && (
            record.result.routeId === "agent.execute.tool.guard"
            || record.result.routeId === "agent.execute.tool.policy"
            || record.result.routeId === "agent.execute.tool.readonly"
            || record.result.routeId === "agent.execute.tool.approval_required"
          ))
          .map((record) => ({
            toolName: record.toolName,
            reason: record.result.content,
            ...(record.result.routeId ? { routeId: record.result.routeId } : {}),
          }));
        return blocked.length > 0 ? blocked : undefined;
      };

      const buildActualExecution = (input?: {
        finalFailureReason?: string;
        fallbackAttempts?: FridayProviderAttempt[];
        backendKind?: FridayProviderBackendKind;
        routingDecisionReason?: string;
        learningAdjusted?: boolean;
        routeDecisionTrace?: FridayAgentActualExecution["routeDecisionTrace"];
      }): FridayAgentActualExecution => {
        const totalCostUsd = actualTurns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
        const lastTurn = actualTurns[actualTurns.length - 1];
        return {
          requestedProviderId,
          requestedModel,
          taskProfileId: resolvedTaskProfile.id,
          taskProfileModel: resolvedTaskProfile.model,
          modelSelectionSource,
          actualProviderId: lastTurn?.providerId,
          actualModel: lastTurn?.model,
          actualProviderKind: latestActualProviderKind,
          actualProviderApi: latestActualProviderApi,
          backendKind: input?.backendKind ?? latestBackendKind,
          totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
          fallbackAttempts: (input?.fallbackAttempts ?? latestFallbackAttempts).length > 0
            ? [...(input?.fallbackAttempts ?? latestFallbackAttempts)]
            : undefined,
          routingDecisionReason: input?.routingDecisionReason ?? latestRoutingDecisionReason,
          learningAdjusted: input?.learningAdjusted ?? (latestLearningAdjusted ? true : undefined),
          ...(input?.routeDecisionTrace ?? latestRouteDecisionTrace
            ? { routeDecisionTrace: input?.routeDecisionTrace ?? latestRouteDecisionTrace }
            : {}),
          blockedTools: summarizeBlockedTools(),
          ...(input?.finalFailureReason ? { finalFailureReason: input.finalFailureReason } : {}),
          turns: actualTurns,
        };
      };

      const persistRunArtifacts = (input: {
        status: string;
        response: string;
        durationMs: number;
        completedAt: string;
        testResults: FridayAgentTestResult[];
        artifacts: FridayAgentArtifact[];
        costUsd?: number;
      }): { artifactDir?: string; artifacts: FridayAgentArtifact[] } => {
        let artifactDir: string | undefined;
        let writtenArtifacts = input.artifacts;
        if (!artifactWriter) {
          return { artifactDir, artifacts: writtenArtifacts };
        }

        try {
          const writerResult = artifactWriter.writeRunArtifacts({
            runId,
            task: params.task,
            status: input.status,
            response: input.response,
            toolCalls: allToolCalls,
            testResults: input.testResults,
            artifacts: input.artifacts,
            durationMs: input.durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: input.costUsd,
            completedAt: input.completedAt,
            conversationContext,
          });
          artifactDir = writerResult.artifactDir;
          writtenArtifacts = writerResult.artifacts;
        } catch (error) {
          console.warn(
            `[friday][W-AG-ARTIFACT-WRITE-001] Failed to persist run artifacts for run ${runId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }

        return { artifactDir, artifacts: writtenArtifacts };
      };

      const transitionToAwaitingClarification = async (input: {
        kind: FridayPlanningGateKind;
        questions: string[];
        currentPlanReview?: FridayAgentPlanReviewPayload;
      }): Promise<FridayAgentRuntimeResult> => {
        const durationMs = Date.now() - startedAt;
        const totalCostUsd = actualTurns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
        const actualExecution = buildActualExecution();
        latestActualExecution = actualExecution;
        latestCostUsd = totalCostUsd > 0 ? totalCostUsd : undefined;

        const clarificationResponse = buildGeneratorClarificationResponse(input);
        const clarificationPlanReview: FridayAgentPlanReviewPayload = {
          ...(input.currentPlanReview ?? {
            plan: {
              task: params.task,
              stepCount: 3,
              description: summarizeTask(params.task),
            },
          }),
          decision: undefined,
          gate: {
            ...(input.currentPlanReview?.gate ?? { kind: input.kind }),
            kind: input.kind,
            state: "awaiting_clarification",
            clarificationQuestions: input.questions,
            approvalUpdatedAt: nowIso(),
          },
        };

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "awaiting_clarification",
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
            actualExecution,
            planReview: clarificationPlanReview,
            responseText: clarificationResponse,
            summary: deriveSummary(clarificationResponse),
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
          }),
        );

        handleTrackedEvent("agent.run.awaiting_clarification", {
          runId,
          status: "awaiting_clarification",
          message: clarificationResponse,
          questions: input.questions,
          planKind: input.kind,
        });
        await mirrorAssistantResponse(clarificationResponse, allToolCalls);

        return {
          runId,
          status: "awaiting_clarification",
          response: clarificationResponse,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
          finalResponse: clarificationResponse,
          taskProfile: resolvedTaskProfile,
        };
      };

      try {
        // 2. Emit started event and transition to planning
        if (evaluateRules) {
          const runPolicy = await safeEvaluateRules(evaluateRules, {
            resource: "agent",
            action: "execute",
            args: {
              task: params.task,
              providerId: requestedProviderId ?? "default",
              model: requestedModel ?? "default",
              constraints: {
                readOnly: isReadOnly,
              },
            },
            source: "agent",
            principalId,
            runId,
            sessionId: sessionKey,
            scopes,
          }, runAbortController.signal);
          // P1-SEC-006: Treat null (rules evaluation error) as deny — fail-closed
          if (runPolicy === null || (runPolicy && !runPolicy.allowed)) {
            const durationMs = Date.now() - startedAt;
            const message = runPolicy?.message ?? "Agent run denied by policy";
            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt: nowIso(),
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: message,
                actualExecution: buildActualExecution({ finalFailureReason: message }),
                summary: deriveSummary(message),
                taskProfile: resolvedTaskProfile,
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message,
              },
              durationMs,
              routeId: "agent.execute.run.policy",
              correlationId: runCorrelationId,
            });

            return await finalizeResult({
              runId,
              status: "failed",
              response: message,
              toolCallCount: 0,
              durationMs,
              usageInput: 0,
              usageOutput: 0,
              taskProfile: resolvedTaskProfile,
              summary: deriveSummary(message),
            });
          }
        }

        handleTrackedEvent("agent.run.started", {
          runId,
          task: params.task,
          model: requestedModel,
          providerId: requestedProviderId,
          taskProfile: {
            id: resolvedTaskProfile.id,
            model: resolvedTaskProfile.model,
            modelSelectionSource,
          },
          contextSelection: conversationContext
            ? {
              turnKind: conversationContext.turnKind,
              selectedBlocks: (conversationContext.selectedBlocks ?? []).map((block) => ({
                id: block.id,
                source: block.source,
                summary: block.summary,
                score: block.score,
                reason: block.reason,
                messageIds: block.messageIds,
              })),
              selectionReasons: conversationContext.selectionReasons,
            }
            : undefined,
        });

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "planning",
            startedAt: nowIso(),
            taskProfile: resolvedTaskProfile,
          }),
        );

        // Build plan summary
        const planSummary = params.planReviewOverride?.plan ?? existingRun?.planReview?.plan ?? {
          task: params.task,
          stepCount: 1,
          description: `Planning approach for: ${params.task.slice(0, 200)}`,
        };

        const planReview = params.planReviewOverride
          ? {
            ...params.planReviewOverride,
            plan: params.planReviewOverride.plan ?? planSummary,
          }
          : existingRun?.planReview
            ? {
              ...existingRun.planReview,
              plan: existingRun.planReview.plan ?? planSummary,
            }
            : {
              plan: planSummary,
              decision: undefined as { approved: boolean; mode: string; reason?: string; reviewedAt: string } | undefined,
            };

        // Review gate check (IMPL-1)
        if (!params.skipPlanningReview && params.reviewRequired && reviewGate) {
          const decision = reviewGate.review(planSummary, nowIso());
          planReview.decision = decision;

          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              planReview,
              taskProfile: resolvedTaskProfile,
            }),
          );

          if (!decision.approved) {
            // Rejected by review gate
            const durationMs = Date.now() - startedAt;
            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt: nowIso(),
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: `Plan rejected by review gate: ${decision.reason ?? "no reason"}`,
                actualExecution: buildActualExecution({
                  finalFailureReason: `Plan rejected by review gate: ${decision.reason ?? "no reason"}`,
                }),
                planReview,
                taskProfile: resolvedTaskProfile,
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message: `Plan rejected by review gate: ${decision.reason ?? "no reason"}`,
              },
              durationMs,
              routeId: "agent.execute.run.review",
              correlationId: runCorrelationId,
            });

            return await finalizeResult({
              runId,
              status: "failed",
              response: `Plan rejected: ${decision.reason ?? "no reason"}`,
              toolCallCount: 0,
              durationMs,
              usageInput: 0,
              usageOutput: 0,
              taskProfile: resolvedTaskProfile,
              summary: deriveSummary(`Plan rejected: ${decision.reason ?? "no reason"}`),
            });
          }
        } else if (!planReview.decision) {
          // No review required — auto-approve silently
          planReview.decision = {
            approved: true,
            mode: params.skipPlanningReview ? "manual-approve" : "off",
            reason: params.skipPlanningReview ? "Plan already approved by user" : "No review required",
            reviewedAt: nowIso(),
          };
        }

        // Persist plan review
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            planReview,
            taskProfile: resolvedTaskProfile,
          }),
        );

        handleTrackedEvent("agent.run.planning", {
          runId,
          message: `Planning approach (${String(planSummary.stepCount)} step(s))`,
        });

        if (
          delegationHandler
          && shouldDelegateFridayAgentTask({
            task: params.task,
            conversationContext,
          })
        ) {
          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "executing",
              taskProfile: resolvedTaskProfile,
            }),
          );
          handleTrackedEvent("agent.run.executing", {
            runId,
            step: 1,
            description: "Delegating task to sub-agent",
          });

          const delegated = await delegationHandler({
            runId,
            sessionKey,
            task: params.task,
            taskPrompt: llmTask,
            providerId: requestedProviderId,
            tenantContext: params.tenantContext,
            model: requestedModel,
            timezone: params.timezone,
            timeoutMs,
            signal: runAbortController.signal,
            constraints,
            principalId,
            conversationContext,
            taskProfile: resolvedTaskProfile,
          });

          if (delegated) {
            const childRunRecord = db.withReadConnection((reader) =>
              repo.getById(reader, delegated.childRunId),
            );
            const delegatedToolCalls = loadDelegatedToolCalls(childRunRecord);
            const delegatedToolEvents = loadDelegatedToolEvents({
              runId: delegated.childRunId,
              db,
              runEventRepository,
            });
            if (delegatedToolCalls.length > 0) {
              allToolCalls.push(...delegatedToolCalls);
            }
            const delegatedToolCallCount = delegatedToolCalls.length > 0
              ? delegatedToolCalls.length
              : countDelegatedToolCalls({
                runId: delegated.childRunId,
                fallback: delegated.outcome.toolCallCount,
                db,
                runEventRepository,
              });
            const delegatedImages = delegated.outcome.images
              ?? extractImagePathsFromToolCalls(delegatedToolCalls);
            latestArtifacts = childRunRecord?.artifacts
              ?? (delegatedToolCalls.length > 0 ? deriveArtifactsFromToolCalls(delegatedToolCalls) : []);
            latestTestResults = childRunRecord?.testResults ?? [];
            latestActualExecution = childRunRecord?.actualExecution;
            latestCostUsd = childRunRecord?.costUsd;
            totalInputTokens = childRunRecord?.usageInput ?? delegated.outcome.usageInput;
            totalOutputTokens = childRunRecord?.usageOutput ?? delegated.outcome.usageOutput;
            responseText = childRunRecord?.responseText ?? delegated.outcome.response;
            replayDelegatedToolEvents({
              parentRunId: runId,
              parentCorrelationId: runId,
              events: delegatedToolEvents,
              emitRunEvent,
            });
            const durationMs = Date.now() - startedAt;
            const completedAt = nowIso();
            const summaryText = deriveSummary(responseText);
            const terminalStatus = delegated.outcome.status;
            const terminalResponse = responseText.trim().length > 0
              ? responseText
              : terminalStatus === "completed"
                ? `Delegated sub-agent ${delegated.subagentId} completed without a response.`
                : `Delegated sub-agent ${delegated.subagentId} ${terminalStatus}.`;
            const persistedArtifacts = persistRunArtifacts({
              status: terminalStatus,
              response: terminalResponse,
              durationMs,
              completedAt,
              testResults: latestTestResults,
              artifacts: latestArtifacts,
              costUsd: latestCostUsd,
            });

            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: terminalStatus,
                completedAt,
                durationMs,
                usageInput: totalInputTokens,
                usageOutput: totalOutputTokens,
                costUsd: latestCostUsd,
                actualExecution: latestActualExecution,
                testResults: latestTestResults,
                artifacts: persistedArtifacts.artifacts,
                responseText: terminalResponse,
                summary: summaryText || undefined,
                artifactDir: persistedArtifacts.artifactDir,
                contextCostSummary: latestContextCostSummary,
                taskProfile: resolvedTaskProfile,
              }),
            );

            if (terminalStatus === "completed") {
              handleTrackedEvent("agent.run.completed", {
                runId,
                durationMs,
                toolCallCount: delegatedToolCallCount,
                testsPassed: latestTestResults.every((result) => result.passed),
                artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
              });

              await mirrorAssistantResponse(terminalResponse, allToolCalls);

              return await finalizeResult({
                runId,
                status: "completed",
                response: terminalResponse,
                toolCallCount: delegatedToolCallCount,
                durationMs,
                usageInput: totalInputTokens,
                usageOutput: totalOutputTokens,
                contextCostSummary: latestContextCostSummary,
                taskProfile: resolvedTaskProfile,
                images: delegatedImages.length > 0 ? delegatedImages : undefined,
                summary: summaryText || undefined,
                artifactDir: persistedArtifacts.artifactDir,
              });
            }

            if (terminalStatus === "cancelled") {
              handleTrackedEvent("agent.run.cancelled", {
                runId,
                reason: terminalResponse,
              });
            } else {
              handleTrackedEvent("agent.run.failed", {
                runId,
                error: {
                  code: FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
                  message: terminalResponse,
                },
                durationMs,
                routeId: "agent.execute.run.delegated",
                correlationId: delegated.childRunId,
              });
            }

            await mirrorAssistantResponse(terminalResponse, allToolCalls);

            return await finalizeResult({
              runId,
              status: terminalStatus,
              response: terminalResponse,
              toolCallCount: delegatedToolCallCount,
              durationMs,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
              images: delegatedImages.length > 0 ? delegatedImages : undefined,
              summary: summaryText || undefined,
              artifactDir: persistedArtifacts.artifactDir,
            });
          }
        }

        // 3. Add user message (with optional inline images for vision)
        if (params.images && params.images.length > 0) {
          const userContent: FridayAgentContentBlock[] = [
            { type: "text", text: llmTask },
            ...params.images.map((url): FridayAgentImageBlock => ({
              type: "image",
              source: { type: "url", url },
            })),
          ];
          messages.push({ role: "user", content: userContent });
        } else {
          messages.push({ role: "user", content: llmTask });
        }

        // 4. Transition to executing and enter LLM loop
        db.withWriteTransaction((writer) =>
          repo.update(writer, { id: runId, status: "executing" }),
        );

        // ─── Build system prompt dynamically from current tool set ───
        const promptBuildResult = systemPromptBuilder
          ? await Promise.resolve(systemPromptBuilder({
            userId: principalId,
            toolNames: [...toolMap.keys()],
            nowIso: runTimeContext.nowIso,
            timezone: runTimeContext.timezone,
            localDate: runTimeContext.localDate,
            task: params.task,
            conversationContext,
          }))
          : (staticSystemPrompt ?? "You are an AI assistant.");
        const baseSystemPrompt = typeof promptBuildResult === "string"
          ? promptBuildResult
          : promptBuildResult.prompt;
        latestContextCostSummary = typeof promptBuildResult === "string"
          ? undefined
          : promptBuildResult.contextCostSummary;

        // ─── Enrich system prompt with learned user preferences ───
        let effectiveSystemPrompt = baseSystemPrompt;
        const prefEntries = Object.entries(learnedPreferences);
        if (prefEntries.length > 0) {
          const prefLines = prefEntries.map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
          effectiveSystemPrompt +=
            "\n\n<user-preferences>\n" +
            "The following preferences were learned from past interactions. " +
            "Respect these when generating responses:\n" +
            prefLines.join("\n") +
            "\n</user-preferences>";
        }
        if (learningContextFragment.length > 0) {
          effectiveSystemPrompt += `\n\n${learningContextFragment}`;
        }
        if (communicationPromptBuilder && principalId) {
          try {
            const fragment = communicationPromptBuilder({ userId: principalId, nowIso: nowIso() });
            if (fragment && fragment.trim().length > 0) {
              effectiveSystemPrompt += `\n\n${fragment.trim()}`;
            }
          } catch (err) {
            // Non-fatal: persona enrichment failure should not kill the run
            console.warn("[friday][agent-runtime] persona-enrichment:", err instanceof Error ? err.message : String(err));
            nonFatalWarningCount++;
          }
        }

        // ── Disclose disabled tools so the LLM does not waste turns calling them ──
        if (disabledToolNames.size > 0) {
          effectiveSystemPrompt +=
            "\n\nNote: The following tools are disabled for this run and will fail if called: " +
            [...disabledToolNames].join(", ") +
            ". Do not attempt to use them.";
        }

        let iterations = 0;
        let evidenceEnforcementRetries = 0;
        let timelinessEnforcementRetries = 0;
        let answerAlignmentRetries = 0;
        let desktopInspectionRetries = 0;
        let artifactTruthRetries = 0;
        const fileVersionTracker = createFridayFileVersionTracker();

        while (iterations < FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
          if (runAbortController.signal.aborted) {
            break;
          }

          iterations++;

          // ── Context compaction: layered retention (Plan C) ──
          // Replace old middle messages with a summary to prevent context overflow.
          const preCompactionLen = messages.length;
          const compacted = compactMessagesIfNeeded(
            messages,
            FRIDAY_AGENT_COMPACTION_THRESHOLD,
            FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
          );
          if (compacted.length < preCompactionLen) {
            messages.splice(0, messages.length, ...compacted);
          }

          // Emit executing event per iteration (IMPL-3)
          handleTrackedEvent("agent.run.executing", {
            runId,
            step: iterations,
            description: `LLM turn ${String(iterations)}`,
          });

          // ── Decision Engine short-circuit ──
          // Handles simple intents (greeting, status, help, cancel) locally.
          let localDecisionResponse: string | undefined;
          if (decisionEngine) {
            // Load world state for context-aware decisions (non-fatal if unavailable)
            let worldState: FridayWorldState | undefined;
            if (deps.worldStateManager) {
              try {
                worldState = await deps.worldStateManager.loadState(params.principalId ?? "default");
              } catch {
                // Non-fatal: world state loading failure should not block agent runs.
              }
            }

            const decisionCtx: FridayDecisionContext = {
              task: params.task,
              turnIndex: iterations - 1,
              history: [],
              worldState,
              availableTools: [...toolMap.keys()],
              taskProfile: resolvedTaskProfile.id,
            };
            if (decisionEngine.canDecideLocally(decisionCtx)) {
              const localDecision = await decisionEngine.decideLocally(decisionCtx);
              if (localDecision.action === "respond" && localDecision.response) {
                localDecisionResponse = localDecision.response;
              }
            }

            // Rank tools based on learned patterns (reorder only, never remove)
            if (localDecisionResponse === undefined) {
              tools.splice(0, tools.length, ...decisionEngine.rankTools(decisionCtx, tools));
            }
          }

          let streamResult: Awaited<ReturnType<typeof streamLlmResponse>>;
          if (localDecisionResponse !== undefined) {
            // Synthetic result from decision engine — skip LLM call
            streamResult = {
              assistantText: localDecisionResponse,
              toolUseBlocks: [],
              inputTokens: 0,
              outputTokens: 0,
              turnMeta: undefined,
            };
          } else {
            // Per-turn LLM streaming timeout: abort if no response within 5 minutes.
            // This prevents indefinite hangs when a provider establishes a connection
            // but stops sending tokens (half-open connection).
            const LLM_TURN_TIMEOUT_MS = 5 * 60 * 1000;
            const turnTimeoutController = new AbortController();
            const turnTimeout = setTimeout(
              () => turnTimeoutController.abort(new Error("LLM streaming timeout exceeded (5m)")),
              LLM_TURN_TIMEOUT_MS,
            );
            // Link parent abort signal so user cancellation still works
            const onParentAbort = () => turnTimeoutController.abort(runAbortController.signal.reason);
            runAbortController.signal.addEventListener("abort", onParentAbort, { once: true });

            // OC-009: Validate tool_use/tool_result pairing before sending to LLM.
            // Anthropic API rejects messages where tool_use blocks lack corresponding tool_result blocks.
            repairOrphanedToolUseBlocks(messages);

            try {
              streamResult = await streamLlmResponse({
                llmClient,
                providerId: requestedProviderId,
                tenantContext: params.tenantContext,
                model: resolvedTaskProfile.model ?? requestedModel ?? "default",
                systemPrompt: effectiveSystemPrompt,
                messages,
                tools,
                temperature: resolvedTaskProfile.temperature,
                routingContext: estimateRoutingContext(),
                signal: turnTimeoutController.signal,
                eventEmitter,
                runId,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
              });
            } finally {
              clearTimeout(turnTimeout);
              runAbortController.signal.removeEventListener("abort", onParentAbort);
            }
          }
          const { assistantText, toolUseBlocks, inputTokens, outputTokens, turnMeta } = streamResult;

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          latestFallbackAttempts = turnMeta?.attempts ? [...turnMeta.attempts] : [];
          latestBackendKind = turnMeta?.backendKind ?? latestBackendKind;
          latestActualProviderKind = turnMeta?.actualProviderKind ?? latestActualProviderKind;
          latestActualProviderApi = turnMeta?.actualProviderApi ?? latestActualProviderApi;
          latestRoutingDecisionReason = turnMeta?.routingDecisionReason ?? latestRoutingDecisionReason;
          latestLearningAdjusted = turnMeta?.learningAdjusted ?? latestLearningAdjusted;
          latestRouteDecisionTrace = turnMeta?.routeDecisionTrace ?? latestRouteDecisionTrace;

          if (turnMeta?.actualProviderId || turnMeta?.actualModel) {
            handleTrackedEvent("agent.run.route_selected", {
              runId,
              requestedProviderId,
              requestedModel,
              taskProfileId: resolvedTaskProfile.id,
              taskProfileModel: resolvedTaskProfile.model,
              modelSelectionSource,
              actualProviderId: turnMeta.actualProviderId,
              actualModel: turnMeta.actualModel,
              actualProviderKind: turnMeta.actualProviderKind,
              actualProviderApi: turnMeta.actualProviderApi,
              backendKind: turnMeta.backendKind,
              routingDecisionReason: turnMeta.routingDecisionReason,
              learningAdjusted: turnMeta.learningAdjusted,
              routeDecisionTrace: turnMeta.routeDecisionTrace,
            });
          }
          if (latestFallbackAttempts.length > 0) {
            handleTrackedEvent("agent.run.route_fallback", {
              runId,
              requestedProviderId,
              requestedModel,
              actualProviderId: turnMeta?.actualProviderId,
              actualModel: turnMeta?.actualModel,
              attempts: latestFallbackAttempts,
              fallbackCount: latestFallbackAttempts.length,
            });
          }
          const intendedModelForAudit = explicitRequestedModel ?? taskProfileRequestedModel;
          if (
            intendedModelForAudit
            && turnMeta?.actualModel
            && turnMeta.actualModel !== intendedModelForAudit
          ) {
            handleTrackedEvent("agent.run.route_mismatch", {
              runId,
              requestedProviderId,
              requestedModel,
              taskProfileModel: resolvedTaskProfile.model,
              intendedModel: intendedModelForAudit,
              actualProviderId: turnMeta.actualProviderId,
              actualModel: turnMeta.actualModel,
              reason: latestFallbackAttempts.length > 0
                ? "explicit_fallback"
                : turnMeta.routeDecisionTrace?.reasonCode === "operator_override"
                  ? "operator_override"
                  : turnMeta.routeDecisionTrace?.reasonCode === "historical_bias"
                    || turnMeta.routeDecisionTrace?.reasonCode === "operator_penalty"
                    ? "historical_bias"
                : turnMeta.backendKind === "cli"
                  ? "backend_capability_gating"
                  : "provider_unsupported",
            });
          }

          // Track actual turn metadata (IMPL-2)
          actualTurns.push({
            providerId: turnMeta?.actualProviderId,
            model: turnMeta?.actualModel,
            inputTokens,
            outputTokens,
            costUsd: turnMeta?.costUsd,
          });

          // Record provider usage metrics when execution metadata is available.
          if (usageRecorder && turnMeta?.actualProviderId && turnMeta.actualProviderApi) {
            try {
              await usageRecorder({
                providerId: turnMeta.actualProviderId,
                model: turnMeta.actualModel ?? requestedModel ?? "default",
                providerApi: turnMeta.actualProviderApi,
                inputTokens,
                outputTokens,
                costUsd: turnMeta.costUsd,
              });
            } catch (err) {
              // Non-fatal: usage persistence should not break run execution.
              console.warn("[friday][agent-runtime] usage-persist:", err instanceof Error ? err.message : String(err));
              nonFatalWarningCount++;
            }
          }

          // Build assistant message content
          const assistantContent: FridayAgentContentBlock[] = [];
          if (assistantText) {
            assistantContent.push({ type: "text", text: assistantText });
          }
          for (const toolUse of toolUseBlocks) {
            assistantContent.push(toolUse);
          }

          messages.push({
            role: "assistant",
            content: assistantContent.length === 1 && assistantContent[0].type === "text"
              ? assistantText
              : assistantContent,
          });

          // 5. If no tool calls, we're done
          if (toolUseBlocks.length === 0) {
            let candidateResponse = enforceToolEvidenceForCompletionClaim(
              assistantText,
              allToolCalls,
            );
            candidateResponse = enforceFeedbackPersistenceEvidence(
              candidateResponse,
              allToolCalls,
            );

            if (
              candidateResponse.trim().length > 0 &&
              evidenceEnforcementRetries < 2 &&
              shouldEnforceToolEvidenceForTask({
                task: params.task,
                responseText: candidateResponse,
                toolMap,
                toolCalls: allToolCalls,
                disabledToolNames,
              })
            ) {
              evidenceEnforcementRetries++;
              const verificationPrompt = buildEvidenceRetryPrompt({
                task: params.task,
                toolMap,
                disabledToolNames,
              });
              messages.push({
                role: "user",
                content: verificationPrompt,
              });
              continue;
            }

            const timelinessDecision = evaluateTimeSensitiveResponse({
              required: timeSensitiveNewsRequested,
              responseText: candidateResponse,
              toolCalls: allToolCalls,
              localDate: runTimeContext.localDate,
              timezone: runTimeContext.timezone,
            });
            if (
              timelinessDecision.retryPrompt &&
              candidateResponse.trim().length > 0 &&
              timelinessEnforcementRetries < 1
            ) {
              timelinessEnforcementRetries++;
              messages.push({
                role: "user",
                content: timelinessDecision.retryPrompt,
              });
              continue;
            }

            const alignedResponse = enforceBoundaryClarityResponse({
              task: params.task,
              responseText: timelinessDecision.responseText,
            });
            if (
              taskRequiresReadOnlyDesktopInspection(params.task)
              && hasDesktopContentInspectionCoverageEvidence(allToolCalls)
              && alignedResponse.trim().length > 0
              && !responseAddressesDesktopContentInspection(alignedResponse)
              && desktopInspectionRetries < 1
            ) {
              desktopInspectionRetries++;
              messages.push({
                role: "user",
                content: buildDesktopContentInspectionRetryPrompt({
                  task: params.task,
                  toolCalls: allToolCalls,
                }),
              });
              continue;
            }

            const alignmentDecision = evaluateFridayAnswerAlignment({
              task: params.task,
              responseText: alignedResponse,
              historyMessages: normalizeHistoryMessages(params.historyMessages),
              conversationContext,
            });
            const maxAnswerAlignmentRetries = hasAnchoredAssistantFact ? 2 : 1;
            if (
              alignmentDecision.retryPrompt &&
              alignedResponse.trim().length > 0 &&
              answerAlignmentRetries < maxAnswerAlignmentRetries
            ) {
              answerAlignmentRetries++;
              messages.push({
                role: "user",
                content: alignmentDecision.retryPrompt,
              });
              continue;
            }

            if (
              alignmentDecision.retryPrompt
              && alignedResponse.trim().length > 0
              && hasAnchoredAssistantFact
            ) {
              const anchoredFallback = buildReplyAnchorFallbackResponse({
                task: params.task,
                conversationContext,
              });
              if (anchoredFallback) {
                const artifactTruthGap = detectArtifactTruthGap({
                  task: params.task,
                  responseText: anchoredFallback,
                  toolCalls: allToolCalls,
                });
                if (artifactTruthGap && artifactTruthRetries < 2) {
                  artifactTruthRetries++;
                  messages.push({
                    role: "user",
                    content: buildArtifactTruthRetryPrompt(artifactTruthGap),
                  });
                  continue;
                }

                responseText = anchoredFallback;
                break;
              }
            }

            const artifactTruthGap = detectArtifactTruthGap({
              task: params.task,
              responseText: alignedResponse,
              toolCalls: allToolCalls,
            });
            if (artifactTruthGap && alignedResponse.trim().length > 0 && artifactTruthRetries < 2) {
              artifactTruthRetries++;
              messages.push({
                role: "user",
                content: buildArtifactTruthRetryPrompt(artifactTruthGap),
              });
              continue;
            }

            responseText = alignedResponse;
            break;
          }

          // 6. Execute tool calls and build tool_result blocks
          const toolResultBlocks: FridayAgentToolResultBlock[] = [];
          const toolCallRecordsByIndex = new Map<number, FridayAgentToolCallRecord>();
          const executableToolUses: Array<{ index: number; toolUse: FridayAgentToolUseBlock }> = [];

          for (let toolIndex = 0; toolIndex < toolUseBlocks.length; toolIndex += 1) {
            const toolUse = toolUseBlocks[toolIndex]!;
            if (runAbortController.signal.aborted) {
              break;
            }

            if (disabledToolNames.has(toolUse.name)) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.guard",
                correlationId: runId,
                message: `Tool '${toolUse.name}' is disabled for this run.`,
              }));
              continue;
            }

            if (evaluateRules) {
              const ruleTarget = getRuleTargetForTool(toolUse.name);
              const policyResult = await safeEvaluateRules(evaluateRules, {
                resource: ruleTarget.resource,
                action: ruleTarget.action,
                args: {
                  toolName: toolUse.name,
                  ...toolUse.input,
                },
                source: "agent",
                principalId,
                runId,
                sessionId: sessionKey,
                scopes,
              }, runAbortController.signal);
              if (policyResult === null || (policyResult && !policyResult.allowed)) {
                const message = policyResult?.message
                  ?? (policyResult === null
                    ? `Tool '${toolUse.name}' blocked — policy evaluation temporarily unavailable`
                    : `Tool '${toolUse.name}' blocked by policy`);
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.policy",
                  correlationId: runId,
                  message,
                }));
                continue;
              }
            }

            if (isReadOnly && isMutatingToolCall(toolUse.name, toolUse.input)) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.readonly",
                correlationId: runId,
                message: `Tool '${toolUse.name}' blocked: run has readOnly constraint`,
              }));
              continue;
            }

            const approvalRequiredReason = getApprovalRequiredReasonForToolCall(toolUse.name, toolUse.input);
            if (approvalRequiredReason) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.approval_required",
                correlationId: runId,
                message: `Tool '${toolUse.name}' blocked pending approval. ${approvalRequiredReason}`,
              }));
              continue;
            }

            executableToolUses.push({ index: toolIndex, toolUse });
          }

          if (executableToolUses.length > 0 && !runAbortController.signal.aborted) {
            const executableBlocks = executableToolUses.map(({ toolUse }) => toolUse);
            const groups = classifyToolBatchDependencies(executableBlocks);
            if (executableToolUses.length > 1 && groups.some((group) => group.tools.length > 1)) {
              console.info(
                `[friday][marker] tool_batch_executed runId=${runId} groups=${String(groups.length)} tools=${String(executableToolUses.length)}`,
              );
            }
            const executedRecords = await executeToolBatch(
              groups,
              async (toolUse) =>
                executeToolCall({
                  toolUse: toolUse as FridayAgentToolUseBlock,
                  toolMap,
                  signal: runAbortController.signal,
                  runId,
                  sessionKey,
                  readOnly: isReadOnly,
                  timezone: runTimeContext.timezone,
                  taskPrompt: llmTask,
                  conversationContext,
                  principalId,
                  tenantContext: params.tenantContext,
                  executionContext,
                  fileVersionTracker,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                }),
            );
            for (let recordIndex = 0; recordIndex < executedRecords.length; recordIndex += 1) {
              const planned = executableToolUses[recordIndex];
              if (!planned) continue;
              toolCallRecordsByIndex.set(planned.index, executedRecords[recordIndex]!);
            }
          }

          for (let toolIndex = 0; toolIndex < toolUseBlocks.length; toolIndex += 1) {
            const toolUse = toolUseBlocks[toolIndex]!;
            const toolCallRecord = toolCallRecordsByIndex.get(toolIndex);
            if (!toolCallRecord) {
              continue;
            }
            allToolCalls.push(toolCallRecord);
            if (allToolCalls.length >= FRIDAY_AGENT_MAX_TOOL_CALLS) {
              break;
            }
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: toolCallRecord.result.content,
              is_error: toolCallRecord.result.isError,
            });
          }

          // OC-007: Validate every tool_use has a corresponding tool_result.
          // If execution was interrupted, synthesize error results for missing entries.
          if (toolResultBlocks.length < toolUseBlocks.length) {
            for (let i = toolResultBlocks.length; i < toolUseBlocks.length; i++) {
              const missingUse = toolUseBlocks[i]!;
              const synthesized = {
                content: `Tool result lost for "${missingUse.name}" — execution may have been interrupted.`,
                isError: true,
              };
              allToolCalls.push({
                toolCallId: missingUse.id,
                toolName: missingUse.name,
                args: missingUse.input,
                result: synthesized,
                durationMs: 0,
                startedAt: nowIso(),
              });
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: missingUse.id,
                content: synthesized.content,
                is_error: true,
              });
            }
          }

          const generatorClarificationSignal = extractGeneratorClarificationSignal(allToolCalls);
          // Layer-2 guard: if the original user task is clearly a Q&A / summarization
          // request, do NOT surface generator clarification — the LLM should answer
          // directly instead of routing through the workflow/skill generator.
          const QA_BYPASS_L2 = /\b(summarize|summarise|explain|describe|what is|tell me about|list|show|how does|overview|translate|recap|compare|analyze|analyse)\b/i;
          if (generatorClarificationSignal && !QA_BYPASS_L2.test(params.task)) {
            return await transitionToAwaitingClarification({
              ...generatorClarificationSignal,
              currentPlanReview: planReview,
            });
          }

          // 7. Add tool results as user message and re-prompt
          messages.push({
            role: "user",
            content: toolResultBlocks,
          });
        }

        // Check if we hit the loop limit
        if (iterations >= FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
          throw new FridayDomainError(
            FRIDAY_AGENT_ERROR_CODES.LOOP_LIMIT,
            `Agent exceeded maximum loop iterations (${String(FRIDAY_AGENT_MAX_LOOP_ITERATIONS)})`,
            { httpStatus: 500 },
          );
        }

        // Check if we hit the tool call limit
        if (allToolCalls.length >= FRIDAY_AGENT_MAX_TOOL_CALLS) {
          throw new FridayDomainError(
            FRIDAY_AGENT_ERROR_CODES.TOOL_CALL_LIMIT,
            `Agent exceeded maximum tool calls (${String(FRIDAY_AGENT_MAX_TOOL_CALLS)})`,
            { httpStatus: 500 },
          );
        }

        // Check if cancelled
        if (runAbortController.signal.aborted) {
          const durationMs = Date.now() - startedAt;
          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "cancelled",
              completedAt: nowIso(),
              durationMs,
              actualExecution: buildActualExecution({
                finalFailureReason: "Agent run cancelled",
              }),
              responseText: responseText || undefined,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
            }),
          );

          handleTrackedEvent("agent.run.cancelled", { runId });

          return await finalizeResult({
            runId,
            status: "cancelled",
            response: responseText,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
            summary: deriveSummary(responseText),
          });
        }

        // ─── Build actual execution metadata (IMPL-2) ───
        const totalCostUsd = actualTurns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
        const actualExecution = buildActualExecution();
        latestActualExecution = actualExecution;
        latestCostUsd = totalCostUsd > 0 ? totalCostUsd : undefined;

        // ─── IMPL-5: Validation gate (self-test) ───
        let testsPassed = selfTestService ? false : true;
        let testResults: FridayAgentTestResult[] = [];
        const collectedArtifacts: FridayAgentArtifact[] = deriveArtifactsFromToolCalls(allToolCalls);
        latestArtifacts = collectedArtifacts;

        if (selfTestService) {
          // Transition to testing
          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "testing",
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
            }),
          );
          currentPhase = "testing";
          emitProgressEvent();

          try {
            testResults = await selfTestService.runTests({
              artifacts: collectedArtifacts,
              workdir,
            });
            testsPassed = testResults.every((t) => t.passed);
          } catch (testError) {
            testsPassed = false;
            testResults = [{
              strategy: "llm_eval" as const,
              passed: false,
              errors: [{
                message: testError instanceof Error ? testError.message : String(testError),
                severity: "error",
              }],
              durationMs: 0,
            }];
          }
          latestTestResults = testResults;

          // Criteria: must have a response
          const hasResponse = responseText.trim().length > 0;

          if (!hasResponse) {
            testsPassed = false;
          }

          if (
            !testsPassed
            && hasSafeDiagnosticCompletionEvidence({
              task: params.task,
              responseText,
              toolCalls: allToolCalls,
            })
          ) {
            testsPassed = true;
          }

          if (!testsPassed) {
            const durationMs = Date.now() - startedAt;
            const summaryText = deriveSummary(responseText);
            const completedAt = nowIso();
            const persistedArtifacts = persistRunArtifacts({
              status: "failed",
              response: responseText || "Validation criteria not met",
              durationMs,
              completedAt,
              testResults,
              artifacts: collectedArtifacts,
              costUsd: latestCostUsd,
            });

            db.withWriteTransaction((writer) =>
              repo.update(writer, {
                id: runId,
                status: "failed",
                completedAt,
                durationMs,
                errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                errorMessage: "Validation criteria not met",
                usageInput: totalInputTokens,
                usageOutput: totalOutputTokens,
                costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
                actualExecution: buildActualExecution({
                  finalFailureReason: "Validation criteria not met",
                }),
                testResults: testResults as unknown as FridayAgentTestResult[],
                artifacts: persistedArtifacts.artifacts,
                responseText: responseText || undefined,
                summary: summaryText || undefined,
                artifactDir: persistedArtifacts.artifactDir,
                contextCostSummary: latestContextCostSummary,
                taskProfile: resolvedTaskProfile,
              }),
            );

            handleTrackedEvent("agent.run.failed", {
              runId,
              error: {
                code: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
                message: "Validation criteria not met",
              },
              durationMs,
              routeId: "agent.execute.run.validation",
              correlationId: runCorrelationId,
            });
            await mirrorAssistantResponse(responseText || "Validation criteria not met", allToolCalls);

            return await finalizeResult({
              runId,
              status: "failed",
              response: responseText || "Validation criteria not met",
              toolCallCount: allToolCalls.length,
              durationMs,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
              summary: summaryText || undefined,
              artifactDir: persistedArtifacts.artifactDir,
            });
          }
        }

        const extractedImages = extractImagePathsFromToolCalls(allToolCalls);
        const outputClosureGap = detectOutputClosureGap({
          task: params.task,
          toolCalls: allToolCalls,
          images: extractedImages,
        }) ?? detectEvidenceClosureGap({
          task: params.task,
          responseText,
          toolCalls: allToolCalls,
          toolMap,
          disabledToolNames,
        }) ?? detectArtifactTruthGap({
          task: params.task,
          responseText,
          toolCalls: allToolCalls,
        });

        if (outputClosureGap) {
          const durationMs = Date.now() - startedAt;
          const failureResponse = `${outputClosureGap.userMessage} (${outputClosureGap.errorCode})`;
          const summaryText = deriveSummary(failureResponse);
          const completedAt = nowIso();
          const persistedArtifacts = persistRunArtifacts({
            status: "failed",
            response: failureResponse,
            durationMs,
            completedAt,
            testResults,
            artifacts: collectedArtifacts,
            costUsd: latestCostUsd,
          });

          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "failed",
              completedAt,
              durationMs,
              errorCode: outputClosureGap.errorCode,
              errorMessage: outputClosureGap.developerMessage,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
              costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
              actualExecution: buildActualExecution({
                finalFailureReason: outputClosureGap.developerMessage,
              }),
              testResults: testResults as unknown as FridayAgentTestResult[],
              artifacts: persistedArtifacts.artifacts,
              responseText: failureResponse,
              summary: summaryText || undefined,
              artifactDir: persistedArtifacts.artifactDir,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
            }),
          );

          handleTrackedEvent("agent.run.failed", {
            runId,
            error: {
              code: outputClosureGap.errorCode,
              message: outputClosureGap.developerMessage,
            },
            durationMs,
            outputClosure: {
              attemptedImageToolCalls: outputClosureGap.attemptedImageToolCalls,
              failedImageToolCalls: outputClosureGap.failedImageToolCalls,
            },
            routeId: "agent.execute.run.output_closure",
            correlationId: runCorrelationId,
          });
          await mirrorAssistantResponse(failureResponse, allToolCalls);

          return await finalizeResult({
            runId,
            status: "failed",
            response: failureResponse,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
            summary: summaryText || undefined,
            artifactDir: persistedArtifacts.artifactDir,
          });
        }

        // ─── Derive summary from response (IMPL-6) ───
        const summaryText = deriveSummary(responseText);

        // 8. Finalize — success
        const durationMs = Date.now() - startedAt;
        const completedAt = nowIso();
        const persistedArtifacts = persistRunArtifacts({
          status: "completed",
          response: responseText,
          durationMs,
          completedAt,
          testResults,
          artifacts: collectedArtifacts,
          costUsd: latestCostUsd,
        });
        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "completed",
            completedAt,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
            actualExecution,
            testResults: testResults as unknown as FridayAgentTestResult[],
            artifacts: persistedArtifacts.artifacts,
            responseText: responseText || undefined,
            summary: summaryText || undefined,
            artifactDir: persistedArtifacts.artifactDir,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
          }),
        );

        handleTrackedEvent("agent.run.completed", {
          runId,
          durationMs,
          toolCallCount: allToolCalls.length,
          testsPassed,
          artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
        });

        await mirrorAssistantResponse(responseText, allToolCalls);

        return await finalizeResult({
          runId,
          status: "completed",
          response: responseText,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
          contextCostSummary: latestContextCostSummary,
          taskProfile: resolvedTaskProfile,
          images: extractedImages.length > 0 ? extractedImages : undefined,
          summary: summaryText || undefined,
          artifactDir: persistedArtifacts.artifactDir,
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = error instanceof FridayDomainError
          ? error.code
          : FRIDAY_AGENT_ERROR_CODES.LLM_ERROR;
        const errorFallbackAttempts = error instanceof FridayDomainError &&
            Array.isArray(error.details["attempts"])
          ? error.details["attempts"] as FridayProviderAttempt[]
          : [];
        if (errorFallbackAttempts.length > 0) {
          latestFallbackAttempts = errorFallbackAttempts;
          handleTrackedEvent("agent.run.route_fallback", {
            runId,
            requestedProviderId,
            requestedModel,
            actualProviderId: undefined,
            actualModel: undefined,
            attempts: errorFallbackAttempts,
            fallbackCount: errorFallbackAttempts.length,
          });
        }
        latestActualExecution = latestActualExecution ?? buildActualExecution({
          finalFailureReason: errorMessage,
          fallbackAttempts: errorFallbackAttempts,
        });

        const summaryText = deriveSummary(responseText);
        const completedAt = nowIso();
        const persistedArtifacts = persistRunArtifacts({
          status: "failed",
          response: responseText || errorMessage,
          durationMs,
          completedAt,
          testResults: latestTestResults,
          artifacts: latestArtifacts.length > 0 ? latestArtifacts : deriveArtifactsFromToolCalls(allToolCalls),
          costUsd: latestCostUsd,
        });

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: "failed",
            completedAt,
            durationMs,
            errorCode,
            errorMessage,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: latestCostUsd,
            actualExecution: latestActualExecution,
            testResults: latestTestResults,
            artifacts: persistedArtifacts.artifacts,
            responseText: responseText || undefined,
            summary: summaryText || undefined,
            artifactDir: persistedArtifacts.artifactDir,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
          }),
        );

        handleTrackedEvent("agent.run.failed", {
          runId,
          error: { code: errorCode, message: errorMessage },
          durationMs,
          routeId: "agent.execute.run.unhandled",
          correlationId: runCorrelationId,
        });
        await mirrorAssistantResponse(responseText || errorMessage, allToolCalls);

        return await finalizeResult({
          runId,
          status: "failed",
          response: responseText || errorMessage,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
          contextCostSummary: latestContextCostSummary,
          taskProfile: resolvedTaskProfile,
          summary: summaryText || undefined,
          artifactDir: persistedArtifacts.artifactDir,
        });
      } finally {
        clearTimeout(abortTimer);
        params.signal?.removeEventListener("abort", onExternalAbort);
        clearInterval(progressTimer);
        eventEmitter.off("agent.subagent.spawned", onSubagentSpawned);
        eventEmitter.off("agent.subagent.completed", onSubagentCompleted);
        runSeqCounters.delete(runId);
      }
    },
  };
}

function normalizeScopes(scopes: string[] | undefined): string[] | undefined {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return undefined;
  }
  const normalized = scopes
    .filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0)
    .map((scope) => scope.trim());
  if (normalized.length === 0) {
    return undefined;
  }
  return [...new Set(normalized)];
}

function normalizeToolNameSet(toolNames: string[] | undefined): ReadonlySet<string> {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return new Set<string>();
  }
  const normalized = toolNames
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return new Set<string>(normalized);
}

function withRulesEvaluateScope(scopes: string[] | undefined): string[] {
  const set = new Set<string>(scopes ?? []);
  set.add(RULES_EVALUATE_SCOPE);
  return [...set];
}

function getRuleTargetForTool(
  toolName: string,
): {
  resource: FridayEvaluationContext["resource"];
  action: FridayEvaluationContext["action"];
} {
  if (toolName === "skill_run") {
    return { resource: "skill", action: "execute" };
  }
  if (toolName === "workflow_run") {
    return { resource: "workflow", action: "execute" };
  }
  return { resource: "tool", action: "execute" };
}

async function safeEvaluateRules(
  evaluateRules: (
    context: FridayEvaluationContext,
    signal?: AbortSignal,
  ) => Promise<FridayEvaluationResult>,
  context: FridayEvaluationContext,
  signal?: AbortSignal,
): Promise<FridayEvaluationResult | null> {
  // P1-SEC-006: Retry once on transient failure before falling back to deny (fail-closed).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await evaluateRules(
        {
          ...context,
          scopes: withRulesEvaluateScope(context.scopes),
        },
        signal,
      );
    } catch (err) {
      console.warn(`[friday][SECURITY] Rules evaluation attempt ${String(attempt + 1)} failed:`, err);
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  return null;
}

/**
 * OC-009: Ensure every tool_use block in the messages array has a matching tool_result.
 * Anthropic API requires strict tool_use → tool_result pairing. If a prior loop iteration
 * exited early (abort, generator clarification, etc.), orphaned tool_use blocks may remain.
 * This mutates the messages array in-place by injecting synthetic error tool_results.
 */
function repairOrphanedToolUseBlocks(messages: FridayAgentMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;

    const blocks = msg.content as Array<{ type: string; id?: string; name?: string }>;
    const toolUseIds = blocks
      .filter((b) => b.type === "tool_use" && b.id)
      .map((b) => b.id!);

    if (toolUseIds.length === 0) continue;

    // Check the next message for matching tool_result blocks
    const next = messages[i + 1];
    if (!next || next.role !== "user" || typeof next.content === "string") {
      // No tool_result message follows — inject one
      const syntheticResults = toolUseIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Tool result unavailable — execution was interrupted.",
        is_error: true,
      }));
      messages.splice(i + 1, 0, { role: "user", content: syntheticResults });
      continue;
    }

    // Check for missing individual tool_results
    const resultBlocks = (next.content as Array<{ type: string; tool_use_id?: string }>);
    const resultIds = new Set(
      resultBlocks.filter((b) => b.type === "tool_result" && b.tool_use_id).map((b) => b.tool_use_id!),
    );
    for (const id of toolUseIds) {
      if (!resultIds.has(id)) {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: id,
          content: "Tool result unavailable — execution was interrupted.",
          is_error: true,
        } as typeof resultBlocks[number]);
      }
    }
  }
}

function normalizeHistoryMessages(
  historyMessages: FridayAgentMessage[] | undefined,
): FridayAgentMessage[] {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) {
    return [];
  }

  const normalized: FridayAgentMessage[] = [];
  for (const message of historyMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      const content = message.content.trim();
      if (content.length === 0) {
        continue;
      }
      normalized.push({
        role: message.role,
        content,
      });
      continue;
    }

    if (Array.isArray(message.content) && message.content.length > 0) {
      normalized.push({
        role: message.role,
        content: message.content,
      });
    }
  }

  return normalized;
}

function extractImagePathsFromToolCalls(
  toolCalls: FridayAgentToolCallRecord[],
): string[] {
  const images: string[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    if (call.result.isError) continue;
    if (call.toolName === "browser" || call.toolName === "canvas") {
      try {
        const parsed = JSON.parse(call.result.content);
        if (typeof parsed.path === "string" && isImageFilePath(parsed.path)) {
          if (!seen.has(parsed.path)) {
            seen.add(parsed.path);
            images.push(parsed.path);
          }
        }
      } catch (err) { /* not JSON or no path */ console.warn("[friday][agent-runtime] extract-image-paths:", err instanceof Error ? err.message : String(err)); }
    }
  }
  return images;
}

function isImageFilePath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
    || lower.endsWith(".gif") || lower.endsWith(".webp");
}

// ─── Summary derivation helper ───

function deriveSummary(responseText: string, maxLen = 200): string | undefined {
  if (!responseText || responseText.trim().length === 0) return undefined;
  const firstLine = responseText.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + "...";
}

// ─── LLM streaming helper ───

interface StreamLlmResponseParams {
  llmClient: CreateFridayAgentRuntimeDeps["llmClient"];
  providerId?: string;
  tenantContext?: FridayAgentLlmStreamParams["tenantContext"];
  model: string;
  systemPrompt: string;
  messages: FridayAgentMessage[];
  tools: FridayAgentToolDefinition[];
  temperature?: number;
  routingContext?: FridayAgentLlmStreamParams["routingContext"];
  signal: AbortSignal;
  eventEmitter: CreateFridayAgentRuntimeDeps["eventEmitter"];
  runId: string;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
}

interface TurnMeta {
  actualProviderId?: string;
  actualModel?: string;
  actualProviderKind?: string;
  actualProviderApi?: string;
  backendKind?: FridayProviderBackendKind;
  costUsd?: number;
  attempts?: FridayProviderAttempt[];
  routingDecisionReason?: string;
  learningAdjusted?: boolean;
  routeDecisionTrace?: FridayAgentActualExecution["routeDecisionTrace"];
}

interface StreamLlmResponseResult {
  assistantText: string;
  toolUseBlocks: FridayAgentToolUseBlock[];
  inputTokens: number;
  outputTokens: number;
  turnMeta?: TurnMeta;
}

// ParsedTextToolCall moved to friday-agent-tool-call-recovery.ts

async function streamLlmResponse(
  params: StreamLlmResponseParams,
): Promise<StreamLlmResponseResult> {
  let assistantText = "";
  const toolUseBlocks: FridayAgentToolUseBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turnMeta: TurnMeta | undefined;

  const stream = params.llmClient.stream({
    providerId: params.providerId,
    tenantContext: params.tenantContext,
    model: params.model,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    tools: params.tools,
    temperature: params.temperature,
    routingContext: params.routingContext,
    signal: params.signal,
  });

  for await (const event of stream as AsyncIterable<FridayAgentLlmStreamEvent>) {
    switch (event.type) {
      case "text_delta":
        assistantText += event.text;
        params.emitRunEvent("agent.run.text_delta", {
          runId: params.runId,
          delta: event.text,
        });
        break;

      case "tool_use":
        toolUseBlocks.push({
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;

      case "message_end":
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        // Capture actual execution metadata (IMPL-2)
        if (event.actualProviderId || event.actualModel || event.costUsd !== undefined) {
          turnMeta = {
            actualProviderId: event.actualProviderId,
            actualModel: event.actualModel,
            actualProviderKind: event.actualProviderKind,
            actualProviderApi: event.actualProviderApi,
            backendKind: event.backendKind,
            costUsd: event.costUsd,
            attempts: event.attempts,
            routingDecisionReason: event.routingDecisionReason,
            learningAdjusted: event.learningAdjusted,
            routeDecisionTrace: event.routeDecisionTrace,
          };
        }
        break;
    }
  }

  // Some local models emit pseudo function-call JSON as plain text instead of
  // structured tool_use blocks. Recover these calls so the runtime can execute
  // tools instead of returning raw JSON to users.
  if (toolUseBlocks.length === 0 && assistantText.trim().length > 0) {
    const recovered = recoverToolCallsFromAssistantText(assistantText, params.tools);
    if (recovered.length > 0) {
      for (const call of recovered) {
        toolUseBlocks.push({
          type: "tool_use",
          id: call.id ?? `text-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: call.name,
          input: call.input,
        });
      }
      assistantText = "";
    }
  }

  return { assistantText, toolUseBlocks, inputTokens, outputTokens, turnMeta };
}

// recoverToolCallsFromAssistantText, parseTextToolCall, normalizeToolCallArgs,
// unwrapJsonCodeFence, extractJsonCodeBlocks, looksLikeJson
// → moved to friday-agent-tool-call-recovery.ts

// ─── Artifact derivation from tool calls ───

function deriveArtifactsFromToolCalls(
  toolCalls: FridayAgentToolCallRecord[],
): FridayAgentArtifact[] {
  const artifacts: FridayAgentArtifact[] = [];
  const seen = new Set<string>();

  const add = (artifact: FridayAgentArtifact) => {
    const key = JSON.stringify(artifact);
    if (seen.has(key)) return;
    seen.add(key);
    artifacts.push(artifact);
  };

  for (const call of toolCalls) {
    if (call.result.isError) continue;

    if (call.toolName === "write" || call.toolName === "edit") {
      const filePath = typeof call.args.path === "string" ? call.args.path : undefined;
      if (filePath) add({ type: "file", path: filePath });
      continue;
    }

    if (call.toolName === "skill_run") {
      const skillId = typeof call.args.skillId === "string" ? call.args.skillId : undefined;
      if (skillId) add({ type: "skill", skillId });
      continue;
    }

    if (call.toolName === "workflow_run") {
      const workflowId = typeof call.args.workflowId === "string" ? call.args.workflowId : undefined;
      if (workflowId) add({ type: "workflow", workflowId });
      continue;
    }
  }

  return artifacts;
}

function loadDelegatedToolCalls(
  childRunRecord: FridayAgentRunRecord | null,
): FridayAgentToolCallRecord[] {
  const artifactDir = childRunRecord?.artifactDir;
  if (!artifactDir || artifactDir.trim().length === 0) {
    return [];
  }

  const toolCallsPath = join(artifactDir, "tool-calls.json");
  if (!existsSync(toolCallsPath)) {
    return [];
  }

  try {
    // P1-04: Sync read is acceptable — reading delegation artifacts from local filesystem.
    const parsed = JSON.parse(readFileSync(toolCallsPath, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as FridayAgentToolCallRecord[];
  } catch (err) {
    console.warn("[friday][agent-runtime] load-delegated-tool-calls:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function loadDelegatedToolEvents(input: {
  runId: string;
  db: CreateFridayAgentRuntimeDeps["db"];
  runEventRepository?: CreateFridayAgentRuntimeDeps["runEventRepository"];
}): Array<{ eventName: string; payload: Record<string, unknown> }> {
  if (!input.runEventRepository) {
    return [];
  }

  try {
    const events = input.db.withReadConnection((reader) =>
      input.runEventRepository!.list(reader, input.runId),
    );
    return events
      .filter((event) => event.eventName === "agent.run.tool_start" || event.eventName === "agent.run.tool_end")
      .map((event) => ({
        eventName: event.eventName,
        payload: event.payload,
      }));
  } catch (err) {
    console.warn("[friday][agent-runtime] load-delegated-tool-events:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function countDelegatedToolCalls(input: {
  runId: string;
  fallback: number;
  db: CreateFridayAgentRuntimeDeps["db"];
  runEventRepository?: CreateFridayAgentRuntimeDeps["runEventRepository"];
}): number {
  if (!input.runEventRepository) {
    return input.fallback;
  }

  try {
    const events = input.db.withReadConnection((reader) =>
      input.runEventRepository!.list(reader, input.runId),
    );
    const toolEndCount = events.filter((event) => event.eventName === "agent.run.tool_end").length;
    return toolEndCount > 0 ? toolEndCount : input.fallback;
  } catch (err) {
    console.warn("[friday][agent-runtime] count-delegated-tool-calls:", err instanceof Error ? err.message : String(err));
    return input.fallback;
  }
}

function replayDelegatedToolEvents(input: {
  parentRunId: string;
  parentCorrelationId: string;
  events: Array<{ eventName: string; payload: Record<string, unknown> }>;
  emitRunEvent: (eventName: string, payload: Record<string, unknown>, runId: string) => void;
}): void {
  for (const event of input.events) {
    const payload: Record<string, unknown> = {
      ...event.payload,
      runId: input.parentRunId,
    };
    if (event.eventName === "agent.run.tool_end") {
      payload.correlationId = input.parentCorrelationId;
    }
    input.emitRunEvent(event.eventName, payload, input.parentRunId);
  }
}

// ─── Tool execution helper ───

interface ExecuteToolCallParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  readOnly: boolean;
  timezone?: string;
  taskPrompt?: string;
  conversationContext?: FridayAgentConversationContext;
  principalId?: string;
  tenantContext?: FridayAgentLlmStreamParams["tenantContext"];
  executionContext?: FridayAgentExecutionContext;
  fileVersionTracker?: ReturnType<typeof createFridayFileVersionTracker>;
  nowIso: () => string;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
}

function augmentToolArgsForRuntime(params: {
  toolName: string;
  input: Record<string, unknown>;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
}): Record<string, unknown> {
  if (params.toolName === "memory_search" || params.toolName === "memory_store") {
    return { ...params.input, __sessionId: params.sessionKey };
  }
  if (params.toolName === "feedback") {
    return { ...params.input, __principalId: params.principalId };
  }
  if (params.toolName === "browser") {
    return {
      ...params.input,
      ...(params.executionContext?.browserPresentationMode
        ? { __browserPresentationMode: params.executionContext.browserPresentationMode }
        : {}),
      ...(params.executionContext?.surface
        ? { __browserExecutionSource: params.executionContext.surface }
        : {}),
      ...(typeof params.executionContext?.interactive === "boolean"
        ? { __browserInteractive: params.executionContext.interactive }
        : {}),
    };
  }
  return params.input;
}

function readBrowserPresentationPayload(
  result: FridayAgentToolResult,
): Record<string, unknown> | null {
  const raw = result.metadata?.browserPresentation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function deriveToolEventSummary(result: FridayAgentToolResult): string {
  const browserPayload = readBrowserPresentationPayload(result);
  const browserSummary = typeof browserPayload?.presentationSummary === "string"
    ? browserPayload.presentationSummary.trim()
    : "";
  if (browserSummary.length > 0) {
    return browserSummary.slice(0, 200);
  }
  return result.content.slice(0, 200);
}

function buildToolEndEventPayload(params: {
  runId: string;
  toolName: string;
  toolCallId: string;
  durationMs: number;
  result: FridayAgentToolResult;
  routeId: string;
  correlationId: string;
  toolCallSummary?: ReturnType<typeof summarizeToolCall>;
}): Record<string, unknown> {
  const browserPayload = readBrowserPresentationPayload(params.result);
  return {
    runId: params.runId,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    durationMs: params.durationMs,
    isError: params.result.isError ?? false,
    summary: deriveToolEventSummary(params.result),
    ...(params.result.isError
      ? { errorCode: params.result.errorCode ?? FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR }
      : {}),
    routeId: params.result.routeId ?? params.routeId,
    correlationId: params.result.correlationId ?? params.correlationId,
    ...(params.toolCallSummary ? { toolCallSummary: params.toolCallSummary } : {}),
    ...(typeof browserPayload?.presentationMode === "string"
      ? { presentationMode: browserPayload.presentationMode }
      : {}),
    ...(typeof browserPayload?.targetBrowser === "string"
      ? { targetBrowser: browserPayload.targetBrowser }
      : {}),
    ...(typeof browserPayload?.browserTarget === "string"
      ? { browserTarget: browserPayload.browserTarget }
      : typeof browserPayload?.targetBrowser === "string"
        ? { browserTarget: browserPayload.targetBrowser }
        : {}),
    ...(typeof browserPayload?.sessionId === "string"
      ? { sessionId: browserPayload.sessionId }
      : {}),
    ...(typeof browserPayload?.tabId === "string"
      ? { tabId: browserPayload.tabId }
      : {}),
    ...(typeof browserPayload?.fallbackReason === "string"
      ? { fallbackReason: browserPayload.fallbackReason }
      : {}),
  };
}

function emitImmediateToolCallResult(params: {
  toolUse: FridayAgentToolUseBlock;
  runId: string;
  nowIso: () => string;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  routeId: string;
  correlationId: string;
  message: string;
  errorCode?: string;
}): FridayAgentToolCallRecord {
  const result = {
    content: params.message,
    isError: true,
  };

  params.emitRunEvent("agent.run.tool_start", {
    runId: params.runId,
    toolName: params.toolUse.name,
    toolCallId: params.toolUse.id,
    params: params.toolUse.input,
  });

  params.emitRunEvent("agent.run.tool_end", {
    runId: params.runId,
    toolName: params.toolUse.name,
    toolCallId: params.toolUse.id,
    durationMs: 0,
    isError: true,
    summary: result.content.slice(0, 200),
    errorCode: params.errorCode ?? FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
    routeId: params.routeId,
    correlationId: params.correlationId,
  });

  return {
    toolCallId: params.toolUse.id,
    toolName: params.toolUse.name,
    args: params.toolUse.input,
    result,
    durationMs: 0,
    startedAt: params.nowIso(),
  };
}

async function executeToolCall(
  params: ExecuteToolCallParams,
): Promise<FridayAgentToolCallRecord> {
  const { toolUse, toolMap, signal, runId, sessionKey, nowIso, emitRunEvent } = params;
  const routeId = "agent.execute.tool";
  const correlationId = runId;
  const startedAt = Date.now();
  const toolArgs = augmentToolArgsForRuntime({
    toolName: toolUse.name,
    input: toolUse.input,
    sessionKey,
    principalId: params.principalId,
    executionContext: params.executionContext,
  });

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: toolUse.name,
    toolCallId: toolUse.id,
    params: toolUse.input,
  });

  const touchedPaths = extractFilePaths(toolUse.name, toolUse.input);
  if (params.fileVersionTracker && isMutatingToolCall(toolUse.name, toolUse.input)) {
    for (const filePath of touchedPaths) {
      const conflict = params.fileVersionTracker.checkBeforeWrite(filePath);
      if (conflict.conflict) {
        const result = {
          content:
            `Tool '${toolUse.name}' blocked: file changed since it was last observed in this run ` +
            `(${conflict.reason}) for ${filePath}`,
          isError: true,
        };
        const durationMs = Date.now() - startedAt;

        console.warn(
          `[friday][marker] tool_write_conflict_blocked runId=${runId} tool=${toolUse.name} path=${filePath} reason=${conflict.reason}`,
        );
        emitRunEvent("agent.run.tool_end", {
          runId,
          toolName: toolUse.name,
          toolCallId: toolUse.id,
          durationMs,
          isError: true,
          summary: result.content.slice(0, 200),
          errorCode: FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
          routeId: "agent.execute.tool.file_tracker",
          correlationId,
        });

        return {
          toolCallId: toolUse.id,
          toolName: toolUse.name,
          args: toolUse.input,
          result,
          durationMs,
          startedAt: nowIso(),
        };
      }
    }
  }

  const tool = toolMap.get(toolUse.name);
  if (!tool) {
    const unavailableMessage = buildUnavailableToolMessage(toolUse.name);
    const result = {
      content: unavailableMessage,
      isError: true,
    };
    const durationMs = Date.now() - startedAt;

    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  }

  const taskIntentViolation = toolCallViolatesDesktopInspectionIntent({
    task: params.taskPrompt ?? "",
    toolName: toolUse.name,
    toolArgs,
  });
  if (taskIntentViolation) {
    const result = {
      content: taskIntentViolation,
      isError: true,
    };
    const durationMs = Date.now() - startedAt;

    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  }

  // Create a timeout signal for the tool call
  const toolAbortController = new AbortController();
  const toolTimer = setTimeout(() => {
    toolAbortController.abort(new Error("Tool call timed out"));
  }, FRIDAY_AGENT_TOOL_TIMEOUT_MS);

  // Wire run signal to tool signal
  const onRunAbort = () => {
    toolAbortController.abort(signal.reason);
  };
  if (signal.aborted) {
    toolAbortController.abort(signal.reason);
  } else {
    signal.addEventListener("abort", onRunAbort, { once: true });
  }

  try {
    const toolSignal = attachFridayAgentToolExecutionContext(toolAbortController.signal, {
      runId,
      sessionKey,
      readOnly: params.readOnly,
      timezone: params.timezone,
      taskPrompt: params.taskPrompt,
      conversationContext: params.conversationContext,
      principalId: params.principalId,
      tenantContext: params.tenantContext,
    });
    const rawResult = await tool.execute(toolArgs, toolSignal);
    const durationMs = Date.now() - startedAt;

    // OC-007: Cap oversized tool result content to prevent context bloat
    const toolCap = FRIDAY_AGENT_TOOL_RESULT_CAPS[toolUse.name] ?? FRIDAY_AGENT_TOOL_RESULT_MAX_CHARS;
    let result = capToolResultContent(rawResult, toolCap);
    if (result.isError) {
      result = await maybeRecoverToolInputError({
        toolUse,
        toolMap,
        signal: toolAbortController.signal,
        runId,
        sessionKey,
        principalId: params.principalId,
        executionContext: params.executionContext,
        emitRunEvent,
        maxResultChars: toolCap,
        initialResult: result,
      });
      result = capToolResultContent(result, toolCap);
    }
    if (toolUse.name === "web_fetch" && result.isError) {
      result = await maybeFallbackWebFetchWithBrowser({
        toolUse,
        toolMap,
        signal: toolAbortController.signal,
        runId,
        sessionKey,
        principalId: params.principalId,
        executionContext: params.executionContext,
        emitRunEvent,
        maxResultChars: toolCap,
        initialResult: result,
      });
      result = capToolResultContent(result, toolCap);
    }

    emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      result,
      routeId,
      correlationId,
      toolCallSummary: summarizeToolCall(toolUse.name, toolUse.input, result, 0, 0),
    }));

    if (!result.isError && params.fileVersionTracker && touchedPaths.length > 0) {
      for (const filePath of touchedPaths) {
        params.fileVersionTracker.recordRead(filePath);
      }
    }

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = { content: `Tool error: ${errorMessage}`, isError: true };

    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: toolUse.input,
      result,
      durationMs,
      startedAt: nowIso(),
    };
  } finally {
    clearTimeout(toolTimer);
    signal.removeEventListener("abort", onRunAbort);
  }
}

function buildUnavailableToolMessage(toolName: string): string {
  if (toolName === "desktop") {
    return FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE;
  }
  if (toolName === "system") {
    return FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE;
  }
  if (toolName === "mcp") {
    return FRIDAY_MCP_UNAVAILABLE_MESSAGE;
  }
  return `Unknown tool: ${toolName}`;
}

const FRIDAY_MCP_UNAVAILABLE_MESSAGE =
  'Tool "mcp" is unavailable because MCP servers are not configured. Set FRIDAY_MCP_SERVERS with at least one server and restart Friday.';

interface MaybeRecoverToolInputErrorParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  initialResult: FridayAgentToolResult;
}

interface RecoveryExecutionResult {
  result: FridayAgentToolResult;
  recovered: boolean;
}

async function maybeRecoverToolInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const { toolUse, initialResult } = params;
  if (!initialResult.isError) return initialResult;
  if (!looksLikeToolInputError(initialResult.content)) return initialResult;

  switch (toolUse.name) {
    case "desktop":
      return maybeRecoverDesktopInputError(params);
    case "browser":
      return maybeRecoverBrowserInputError(params);
    case "mcp":
      return maybeRecoverMcpInputError(params);
    default:
      return initialResult;
  }
}

function looksLikeToolInputError(message: string): boolean {
  const normalized = message.trim();
  if (normalized.length === 0) return false;
  return (
    / is required\b/i.test(normalized)
    || /invalid or incomplete/i.test(normalized)
    || /either .+ is required/i.test(normalized)
    || /values array is required/i.test(normalized)
    || /args must be an object/i.test(normalized)
    || /(需要|缺少).{0,16}(参数|字段|策略|选择器)/.test(normalized)
    || /必填/.test(normalized)
  );
}

async function maybeRecoverDesktopInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const desktopTool = toolMap.get("desktop");
  if (!desktopTool) return initialResult;

  const normalizeDesktopActionToken = (value: unknown): string =>
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  const action = normalizeDesktopActionToken(toolUse.input.action);
  const actionType = normalizeDesktopActionToken(toolUse.input.actionType);
  const missingSelector = (
    /strategy is required|selectorvalue is required|selector strategy is required/i.test(initialResult.content)
    || /requires 'selector' field/i.test(initialResult.content)
    || /coordinates or selector/i.test(initialResult.content)
    || /(策略|选择器).{0,8}(必填|需要|缺少)/.test(initialResult.content)
    || /(需要|缺少).{0,8}(策略|选择器)/.test(initialResult.content)
  );
  const missingCoordinates =
    /x is required|y is required|startx is required|starty is required|endx is required|endy is required/i
      .test(initialResult.content);
  const invalidReadElement = /Invalid or incomplete actionType "read_element"/i.test(initialResult.content);

  const shouldFallbackToScreenshot =
    (action === "inspect_element" && missingSelector)
    || (
      action === "execute"
      && (
        missingSelector
        || missingCoordinates
        || (actionType === "read_element" && invalidReadElement)
      )
    );

  if (!shouldFallbackToScreenshot) return initialResult;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "desktop",
    toolUse,
    tool: desktopTool,
    recoveryArgs: { action: "screenshot" },
    recoveryTag: "[auto-recovery:desktop->desktop.screenshot]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:desktop->desktop.screenshot] attempted but failed.",
    isError: true,
  };
}

async function maybeRecoverBrowserInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const browserTool = toolMap.get("browser");
  if (!browserTool) return initialResult;

  const action = typeof toolUse.input.action === "string"
    ? toolUse.input.action.trim().toLowerCase()
    : "";
  const missingTarget = /Either selector or elementId is required for act\./i.test(initialResult.content);
  if (!(action === "act" && missingTarget)) {
    return initialResult;
  }

  const recoveryArgs: Record<string, unknown> = { action: "snapshot" };
  const sessionId = typeof toolUse.input.sessionId === "string" ? toolUse.input.sessionId : undefined;
  const tabId = typeof toolUse.input.tabId === "string" ? toolUse.input.tabId : undefined;
  if (sessionId) recoveryArgs.sessionId = sessionId;
  if (tabId) recoveryArgs.tabId = tabId;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "browser",
    toolUse,
    tool: browserTool,
    recoveryArgs,
    recoveryTag: "[auto-recovery:browser.act->browser.snapshot]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:browser.act->browser.snapshot] attempted but failed.",
    isError: true,
  };
}

async function maybeRecoverMcpInputError(
  params: MaybeRecoverToolInputErrorParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const mcpTool = toolMap.get("mcp");
  if (!mcpTool) return initialResult;

  const errorText = initialResult.content;
  let recoveryArgs: Record<string, unknown> | null = null;
  const serverId = typeof toolUse.input.serverId === "string" ? toolUse.input.serverId : undefined;

  if (/action is required|Invalid action/i.test(errorText)) {
    recoveryArgs = { action: "list_servers" };
  } else if (/toolName is required/i.test(errorText) && serverId) {
    recoveryArgs = { action: "list_tools", serverId };
  } else if (/serverId is required|toolName is required/i.test(errorText)) {
    recoveryArgs = { action: "list_servers" };
  }

  if (!recoveryArgs) return initialResult;

  const recovery = await executeToolRecoveryAttempt({
    toolName: "mcp",
    toolUse,
    tool: mcpTool,
    recoveryArgs,
    recoveryTag: "[auto-recovery:mcp->discovery]",
    recoveryReason: initialResult.content,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId: "agent.execute.tool.input_recovery",
  });

  if (recovery.recovered) {
    return recovery.result;
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      "[auto-recovery:mcp->discovery] attempted but failed.",
    isError: true,
  };
}

async function executeToolRecoveryAttempt(params: {
  toolName: string;
  toolUse: FridayAgentToolUseBlock;
  tool: FridayAgentToolDefinition;
  recoveryArgs: Record<string, unknown>;
  recoveryTag: string;
  recoveryReason: string;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  routeId: string;
}): Promise<RecoveryExecutionResult> {
  const {
    toolName,
    toolUse,
    tool,
    recoveryArgs,
    recoveryTag,
    recoveryReason,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    routeId,
  } = params;
  const correlationId = runId;
  const recoveryCallId = `${toolUse.id}:input-recovery`;

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName,
    toolCallId: recoveryCallId,
    params: {
      ...recoveryArgs,
      fallback: "tool_input_error",
      fallbackReason: recoveryReason,
      parentToolCallId: toolUse.id,
    },
  });

  const startedAt = Date.now();
  let recoveryResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName,
      input: recoveryArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    recoveryResult = capToolResultContent(
      await tool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName,
      toolCallId: recoveryCallId,
      durationMs: Date.now() - startedAt,
      isError: true,
      summary: `${recoveryTag} failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      recovered: false,
      result: {
        content: `${recoveryTag} failed: ${message}`,
        isError: true,
      },
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName,
    toolCallId: recoveryCallId,
    durationMs: Date.now() - startedAt,
    result: recoveryResult,
    routeId,
    correlationId,
  }));

  if (recoveryResult.isError) {
    return { recovered: false, result: recoveryResult };
  }

  return {
    recovered: true,
    result: {
      content:
        `${recoveryTag} recovered from input error (${recoveryReason}).\n` +
        recoveryResult.content,
      isError: false,
      blocks: recoveryResult.blocks,
      metadata: recoveryResult.metadata,
    },
  };
}

interface MaybeFallbackWebFetchWithBrowserParams {
  toolUse: FridayAgentToolUseBlock;
  toolMap: Map<string, FridayAgentToolDefinition>;
  signal: AbortSignal;
  runId: string;
  sessionKey: string;
  principalId?: string;
  executionContext?: FridayAgentExecutionContext;
  emitRunEvent: (name: string, payload: Record<string, unknown>) => void;
  maxResultChars: number;
  initialResult: FridayAgentToolResult;
}

async function maybeFallbackWebFetchWithBrowser(
  params: MaybeFallbackWebFetchWithBrowserParams,
): Promise<FridayAgentToolResult> {
  const {
    toolUse,
    toolMap,
    signal,
    runId,
    sessionKey,
    principalId,
    executionContext,
    emitRunEvent,
    maxResultChars,
    initialResult,
  } = params;
  const routeId = "agent.execute.tool.web_fetch_fallback";
  const correlationId = runId;
  if (!shouldAttemptWebFetchBrowserFallback(initialResult.content)) {
    return initialResult;
  }
  const url = typeof toolUse.input.url === "string" ? toolUse.input.url.trim() : "";
  if (url.length === 0) return initialResult;

  const browserTool = toolMap.get("browser");
  if (!browserTool) return initialResult;

  const fallbackTag = "[auto-fallback:web_fetch->browser]";
  const openArgs: Record<string, unknown> = { action: "open", url };
  const openCallId = `${toolUse.id}:fallback-browser-open`;
  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    params: { ...openArgs, fallback: "web_fetch_error" },
  });

  const openStarted = Date.now();
  let openResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName: "browser",
      input: openArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    openResult = capToolResultContent(
      await browserTool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: openCallId,
      durationMs: Date.now() - openStarted,
      isError: true,
      summary: `${fallbackTag} open failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open failed: ${message}`,
      isError: true,
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    durationMs: Date.now() - openStarted,
    result: openResult,
    routeId,
    correlationId,
  }));

  if (openResult.isError) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open failed: ${openResult.content}`,
      isError: true,
    };
  }

  const openPayload = parseJsonObject(openResult.content);
  const sessionId = typeof openPayload?.sessionId === "string" ? openPayload.sessionId : undefined;
  const tabId = typeof openPayload?.tabId === "string" ? openPayload.tabId : undefined;
  if (!sessionId) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} browser open succeeded but session metadata is unavailable.`,
      isError: false,
    };
  }

  const snapshotArgs: Record<string, unknown> = { action: "snapshot", sessionId };
  if (tabId) snapshotArgs.tabId = tabId;
  const snapshotCallId = `${toolUse.id}:fallback-browser-snapshot`;

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    params: { ...snapshotArgs, fallback: "web_fetch_error" },
  });

  const snapshotStarted = Date.now();
  let snapshotResult: FridayAgentToolResult;
  try {
    const toolArgs = augmentToolArgsForRuntime({
      toolName: "browser",
      input: snapshotArgs,
      sessionKey,
      principalId,
      executionContext,
    });
    snapshotResult = capToolResultContent(
      await browserTool.execute(toolArgs, signal),
      maxResultChars,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: snapshotCallId,
      durationMs: Date.now() - snapshotStarted,
      isError: true,
      summary: `${fallbackTag} snapshot failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
    });
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open succeeded but snapshot failed: ${message}`,
      isError: false,
    };
  }

  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    durationMs: Date.now() - snapshotStarted,
    result: snapshotResult,
    routeId,
    correlationId,
  }));

  if (snapshotResult.isError) {
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open succeeded but snapshot failed: ${snapshotResult.content}`,
      isError: false,
    };
  }

  return {
    content:
      `${initialResult.content}\n\n` +
      `${fallbackTag} browser snapshot succeeded:\n${snapshotResult.content}`,
    isError: false,
  };
}

function shouldAttemptWebFetchBrowserFallback(content: string): boolean {
  const lower = content.toLowerCase();
  // Security block decisions should never be bypassed via browser fallback.
  if (lower.includes("ssrf guard")) return false;
  if (lower.includes("blocked private")) return false;
  if (lower.includes("blocked hostname")) return false;
  if (lower.includes("blocked protocol")) return false;
  if (lower.includes("not in allowlist")) return false;

  if (lower.includes("js-rendered")) return true;
  if (lower.includes("require javascript")) return true;
  if (lower.includes("fetch error:")) return true;
  if (lower.includes("request timed out")) return true;
  return false;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn("[friday][agent-runtime] parse-json-object:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function summarizeTask(task: string, max = 200): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

type FridayPlanningGateKind = NonNullable<FridayAgentPlanReviewPayload["gate"]>["kind"];

function extractGeneratorClarificationSignal(
  toolCalls: FridayAgentToolCallRecord[],
): {
  kind: FridayPlanningGateKind;
  questions: string[];
} | null {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (!call || call.result.isError) continue;
    if (call.toolName !== "workflow_generate" && call.toolName !== "skill_generate") continue;
    const parsed = parseJsonObject(call.result.content);
    if (!parsed || parsed.mode !== "clarification_required") continue;
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (questions.length === 0) continue;
    return {
      kind: call.toolName === "workflow_generate" ? "generate_workflow" : "generate_skill",
      questions,
    };
  }
  return null;
}

function buildGeneratorClarificationResponse(input: {
  kind: FridayPlanningGateKind;
  questions: string[];
}): string {
  const label = input.kind === "generate_workflow" ? "workflow generation" : "skill generation";
  return [
    `I hit a real blocker while continuing ${label}: the downstream generator still needs a few specific details before it can proceed.`,
    "",
    "Please answer these questions in the same thread:",
    ...input.questions.map((question, index) => `${String(index + 1)}. ${question}`),
    "",
    "After you answer them, Friday will update the plan and wait for confirmation again before continuing.",
  ].join("\n");
}

// ─── OC-007: Tool result size capping ───

function capToolResultContent(
  result: FridayAgentToolResult,
  maxChars: number,
): FridayAgentToolResult {
  if (result.content.length <= maxChars) return result;
  const truncated =
    result.content.slice(0, maxChars) +
    `\n\n[truncated: output was ${String(result.content.length)} chars, showing first ${String(maxChars)}]`;
  return { ...result, content: truncated };
}

/**
 * Plan-C context compaction: layered retention.
 *
 * Keeps the first 2 messages (system context + user task) and the last
 * `keepRecent` messages intact. Middle messages are replaced by a single
 * summary line so the LLM retains awareness of earlier work without
 * paying full token cost.  Zero extra LLM calls — pure string operation.
 */
function compactMessagesIfNeeded(
  messages: FridayAgentMessage[],
  threshold: number,
  keepRecent: number,
): FridayAgentMessage[] {
  if (messages.length <= threshold) return messages;

  const keepFirst = 2; // system prompt context + original user task
  if (messages.length <= keepFirst + keepRecent) return messages;

  const head = messages.slice(0, keepFirst);
  const middle = messages.slice(keepFirst, messages.length - keepRecent);
  const tail = messages.slice(messages.length - keepRecent);

  // Build a compact summary of the middle section
  const toolNames = new Set<string>();
  let userMsgCount = 0;
  let assistantMsgCount = 0;
  for (const msg of middle) {
    if (msg.role === "user") {
      userMsgCount++;
      // Scan for tool_result blocks that mention tool names
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
            toolNames.add("tool_result");
          }
        }
      }
    } else if (msg.role === "assistant") {
      assistantMsgCount++;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_use" && "name" in block) {
            toolNames.add(block.name as string);
          }
        }
      }
    }
  }

  const toolList = toolNames.size > 0 ? ` Tools used: ${[...toolNames].join(", ")}.` : "";
  const summaryText =
    `[Context compacted: ${String(middle.length)} earlier messages (${String(userMsgCount)} user, ${String(assistantMsgCount)} assistant) were summarized to save context.${toolList}]`;

  const summaryMessage: FridayAgentMessage = {
    role: "user",
    content: summaryText,
  };

  return [...head, summaryMessage, ...tail];
}
