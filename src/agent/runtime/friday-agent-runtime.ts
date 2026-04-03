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
  FridayAgentContextCostComponent,
  FridayAgentContextCostSummary,
  FridayAgentExecutionContext,
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
  FridayAgentSystemPromptBuildResult,
} from "./friday-agent-runtime.types.js";
import { evaluateFridayAnswerAlignment } from "./friday-agent-answer-alignment.js";
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

function estimateSerializedContentChars(content: FridayAgentMessage["content"]): number {
  if (typeof content === "string") {
    return content.length;
  }
  return JSON.stringify(content).length;
}

function estimateConversationInputChars(messages: FridayAgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateSerializedContentChars(message.content), 0);
}

function estimateToolSchemaChars(tools: FridayAgentToolDefinition[]): number {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  ).length;
}

function upsertContextCostComponent(
  components: FridayAgentContextCostComponent[],
  component: FridayAgentContextCostComponent,
): void {
  const existingIndex = components.findIndex((entry) => entry.kind === component.kind);
  if (existingIndex >= 0) {
    components[existingIndex] = component;
  } else {
    components.push(component);
  }
}

function buildRuntimeContextCostSummary(input: {
  baseSummary?: FridayAgentContextCostSummary;
  conversationInputChars: number;
  systemPromptChars: number;
  toolSchemaChars: number;
  toolCount: number;
  learnedPreferenceCount: number;
  learnedPreferenceChars: number;
  communicationPolicyChars: number;
  disabledToolCount: number;
  disabledToolChars: number;
}): FridayAgentContextCostSummary {
  const components = (input.baseSummary?.components ?? []).map((component) => ({
    ...component,
    includedInTotal: false,
  }));
  upsertContextCostComponent(components, {
    kind: "conversation_input",
    estimatedChars: input.conversationInputChars,
  });
  upsertContextCostComponent(components, {
    kind: "system_prompt",
    estimatedChars: input.systemPromptChars,
  });
  upsertContextCostComponent(components, {
    kind: "tool_schema",
    estimatedChars: input.toolSchemaChars,
    count: input.toolCount,
  });
  if (input.learnedPreferenceCount > 0 && input.learnedPreferenceChars > 0) {
    upsertContextCostComponent(components, {
      kind: "learned_preferences",
      estimatedChars: input.learnedPreferenceChars,
      count: input.learnedPreferenceCount,
      includedInTotal: false,
    });
  }
  if (input.communicationPolicyChars > 0) {
    upsertContextCostComponent(components, {
      kind: "communication_policy",
      estimatedChars: input.communicationPolicyChars,
      includedInTotal: false,
    });
  }
  if (input.disabledToolCount > 0) {
    upsertContextCostComponent(components, {
      kind: "disabled_tools",
      estimatedChars: input.disabledToolChars,
      count: input.disabledToolCount,
      includedInTotal: false,
    });
  }

  const totalEstimatedChars = components.reduce((sum, component) =>
    component.includedInTotal === false ? sum : sum + component.estimatedChars, 0);
  return {
    totalEstimatedChars,
    totalEstimatedInputTokens: Math.max(1, Math.ceil(totalEstimatedChars / 4)),
    components,
    actualUsage: input.baseSummary?.actualUsage,
  };
}

function attachActualUsageToContextCostSummary(
  summary: FridayAgentContextCostSummary | undefined,
  inputTokens: number,
  outputTokens: number,
): FridayAgentContextCostSummary | undefined {
  if (!summary) {
    return undefined;
  }
  return {
    ...summary,
    actualUsage: {
      inputTokens: inputTokens > 0 ? inputTokens : undefined,
      outputTokens: outputTokens > 0 ? outputTokens : undefined,
      deltaInputTokens: inputTokens > 0 && summary.totalEstimatedInputTokens !== undefined
        ? inputTokens - summary.totalEstimatedInputTokens
        : undefined,
    },
  };
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
          ...(input.contextCostSummary ? { contextCostSummary: input.contextCostSummary } : {}),
          ...(input.taskProfile ? { taskProfile: input.taskProfile } : {}),
          ...(input.images ? { images: input.images } : {}),
          ...(input.finalResponse ? { finalResponse: input.finalResponse } : {}),
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
      if (learningContextBuilder && principalId) {
        try {
          const learningCtx = learningContextBuilder({ userId: principalId, nowIso: nowIso() });
          if (learningCtx.preferences && typeof learningCtx.preferences === "object") {
            learnedPreferences = learningCtx.preferences;
          }
        } catch (err) {
          // Non-fatal: preference enrichment failure should not kill the run.
          console.warn("[friday][agent-runtime] preference-enrichment:", err instanceof Error ? err.message : String(err));
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
      let currentSystemPromptChars = 0;
      let currentToolSchemaChars = 0;

      const estimateRoutingContext = (): NonNullable<FridayAgentLlmStreamParams["routingContext"]> => {
        const estimatedChars =
          estimateConversationInputChars(messages)
          + currentSystemPromptChars
          + currentToolSchemaChars;
        const estimatedInputTokens = Math.max(1, Math.ceil(estimatedChars / 4));
        const complexity = resolvedTaskProfile.id === "planning" || resolvedTaskProfile.id === "review"
          ? "complex"
          : estimatedInputTokens < 300
            ? "simple"
            : estimatedInputTokens < 1200
              ? "medium"
              : "complex";
        return {
          estimatedInputTokens,
          complexity,
          requiresNativeTools: true,
          taskProfileId: resolvedTaskProfile.id,
        };
      };

      const refreshContextCostSummaryUsage = (): void => {
        latestContextCostSummary = attachActualUsageToContextCostSummary(
          latestContextCostSummary,
          totalInputTokens,
          totalOutputTokens,
        );
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
            latestContextCostSummary = childRunRecord?.contextCostSummary ?? latestContextCostSummary;
            refreshContextCostSummaryUsage();
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
        let learnedPreferenceChars = 0;
        let communicationPolicyChars = 0;
        if (prefEntries.length > 0) {
          const prefLines = prefEntries.map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
          const preferenceFragment =
            "\n\n<user-preferences>\n" +
            "The following preferences were learned from past interactions. " +
            "Respect these when generating responses:\n" +
            prefLines.join("\n") +
            "\n</user-preferences>";
          learnedPreferenceChars = preferenceFragment.length;
          effectiveSystemPrompt += preferenceFragment;
        }
        if (communicationPromptBuilder && principalId) {
          try {
            const fragment = communicationPromptBuilder({
              userId: principalId,
              nowIso: nowIso(),
              learnedPreferences,
            });
            if (fragment && fragment.trim().length > 0) {
              const trimmedFragment = fragment.trim();
              communicationPolicyChars = trimmedFragment.length;
              effectiveSystemPrompt += `\n\n${trimmedFragment}`;
            }
          } catch (err) {
            // Non-fatal: persona enrichment failure should not kill the run
            console.warn("[friday][agent-runtime] persona-enrichment:", err instanceof Error ? err.message : String(err));
          }
        }

        // ── Disclose disabled tools so the LLM does not waste turns calling them ──
        let disabledToolChars = 0;
        if (disabledToolNames.size > 0) {
          const disabledToolNotice =
            "Note: The following tools are disabled for this run and will fail if called: " +
            [...disabledToolNames].join(", ") +
            ". Do not attempt to use them.";
          disabledToolChars = disabledToolNotice.length;
          effectiveSystemPrompt += `\n\n${disabledToolNotice}`;
        }
        currentSystemPromptChars = effectiveSystemPrompt.length;
        currentToolSchemaChars = estimateToolSchemaChars(tools);
        latestContextCostSummary = buildRuntimeContextCostSummary({
          baseSummary: latestContextCostSummary,
          conversationInputChars: estimateConversationInputChars(messages),
          systemPromptChars: currentSystemPromptChars,
          toolSchemaChars: currentToolSchemaChars,
          toolCount: tools.length,
          learnedPreferenceCount: prefEntries.length,
          learnedPreferenceChars,
          communicationPolicyChars,
          disabledToolCount: disabledToolNames.size,
          disabledToolChars,
        });
        refreshContextCostSummaryUsage();

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
          refreshContextCostSummaryUsage();
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

interface OutputClosureGap {
  errorCode: string;
  userMessage: string;
  developerMessage: string;
  attemptedImageToolCalls: number;
  failedImageToolCalls: number;
}

const READ_ONLY_DIAGNOSTIC_SKILL_IDS = new Set([
  "repo-health-check",
  "workspace-change-risk-review",
  "release-readiness-check",
  "log-error-triage",
  "local-service-diagnose",
  "incident-brief-generator",
  "system-health-snapshot",
  "review-open-issues",
  "autofix-readiness-review",
  "failed-deploy-recovery-brief",
  "idea-clarifier",
  "implementation-plan-review",
  "browser-qa-report",
  "workspace-diff-review",
  "page-benchmark-report",
  "release-canary-check",
  "engineering-retro",
  "product-scope-review",
  "design-plan-review",
  "security-review",
]);

function normalizeDefaultRouteSentinel(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized === "default") {
    return undefined;
  }
  return normalized;
}

function hasSafeDiagnosticCompletionEvidence(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): boolean {
  if (params.responseText.trim().length === 0) {
    return false;
  }

  return params.toolCalls.some((call) => {
    if (call.result.isError) {
      return false;
    }
    if (call.toolName === "skill_run") {
      const skillId = typeof call.args.skillId === "string" ? call.args.skillId : "";
      return READ_ONLY_DIAGNOSTIC_SKILL_IDS.has(skillId);
    }
    if (call.toolName === "system") {
      return call.args.action === "snapshot";
    }
    if (call.toolName === "skills_list") {
      return true;
    }
    return false;
  });
}

function detectOutputClosureGap(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
  images: string[];
}): OutputClosureGap | null {
  if (params.images.length > 0) return null;

  const imageArtifactCalls = params.toolCalls.filter(isImageArtifactCall);
  if (imageArtifactCalls.length === 0) return null;

  const failedImageCalls = imageArtifactCalls.filter((call) => call.result.isError);
  const failedCount = failedImageCalls.length;
  const attemptedCount = imageArtifactCalls.length;

  // Only enforce hard failure for explicit screenshot artifact routes.
  const requestedScreenshot = imageArtifactCalls.some((call) => isBrowserScreenshotCall(call.args));
  if (!requestedScreenshot) return null;

  const latestFailure = failedImageCalls[failedImageCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "unknown screenshot tool failure";

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Output delivery failed: screenshot artifact was not produced. " +
      "Please retry after browser runtime is available.",
    developerMessage:
      `Screenshot closure failed for task "${params.task.slice(0, 120)}": ` +
      `${String(attemptedCount)} screenshot tool call(s), ${String(failedCount)} failed, ` +
      "0 image artifact paths extracted. " +
      `Last failure: ${failureDetail}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

function detectEvidenceClosureGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): OutputClosureGap | null {
  const normalizedTask = params.task.trim();
  if (normalizedTask.length === 0) return null;

  const category = classifyEvidenceTask(normalizedTask);
  if (!category) return null;

  const hasAttemptedEvidenceTool = params.toolCalls.some((call) => {
    if (category === "desktop") {
      return call.toolName === "system"
        || call.toolName === "desktop"
        || call.toolName === "exec"
        || call.toolName === "read"
        || call.toolName === "browser";
    }
    return call.toolName === "web_fetch"
      || call.toolName === "web_search"
      || call.toolName === "browser";
  });

  if (
    !hasAttemptedEvidenceTool
    && !hasEvidenceCapableTools(params.toolMap, params.disabledToolNames, category)
  ) {
    return null;
  }

  if (hasSuccessfulToolEvidence(params.toolCalls)) return null;

  if (category === "web" && !taskLooksLikeExternalAction(normalizedTask)) {
    return null;
  }

  const failedCalls = params.toolCalls.filter((call) => call.result.isError);
  const latestFailure = failedCalls[failedCalls.length - 1];
  const failureDetail = latestFailure?.result.content
    ? latestFailure.result.content.replace(/\s+/g, " ").trim()
    : "LLM produced no successful evidence-capable tool result";
  const attemptedCount = params.toolCalls.length;
  const failedCount = failedCalls.length;
  const responseSummary = params.responseText.trim().slice(0, 200);

  if (category === "desktop") {
    const desktopUnavailable = hasDesktopRuntimeUnavailableFailure(params.toolCalls);
    const userMessage = desktopUnavailable
      ? "Desktop or system orchestration runtime is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and/or FRIDAY_DESKTOP_ENABLED=true, then restart Friday."
      : "Desktop action could not be completed with verifiable output. " +
        "Retry after checking desktop permissions, then provide selector details only if needed.";

    return {
      errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
      userMessage,
      developerMessage:
        `Desktop evidence closure failed for task "${normalizedTask.slice(0, 120)}": ` +
        `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
        `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
      attemptedImageToolCalls: attemptedCount,
      failedImageToolCalls: failedCount,
    };
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "External task could not be completed with verifiable tool output. " +
      "Please retry after checking network/tool availability.",
    developerMessage:
      `Evidence closure failed for web task "${normalizedTask.slice(0, 120)}": ` +
      `${String(attemptedCount)} tool call(s), ${String(failedCount)} failed, no successful evidence. ` +
      `Last failure: ${failureDetail}. Final response: ${responseSummary}`,
    attemptedImageToolCalls: attemptedCount,
    failedImageToolCalls: failedCount,
  };
}

function detectArtifactTruthGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  return detectRequiredBlockerArtifactGap(params)
    ?? detectApprovalBoundaryArtifactGap(params)
    ?? detectSourceArtifactCompletionGap(params);
}

function detectRequiredBlockerArtifactGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (!taskRequiresExplicitBlockerRecord(params.task)) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  if (writtenArtifacts.length === 0) {
    return null;
  }

  const missingFiles = extractMissingFileMentions(params.task);
  const hasRecordedBlocker = writtenArtifacts.some((artifact) =>
    contentHasExplicitBlockerRecord(artifact.content, missingFiles)
  );
  if (hasRecordedBlocker) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: the required blocker was not recorded in the written artifact.",
    developerMessage:
      `Task "${params.task.slice(0, 160)}" required a recorded blocker, but written artifacts ` +
      `(${writtenArtifacts.map((artifact) => artifact.path).join(", ")}) did not contain a clear blocker section.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function detectApprovalBoundaryArtifactGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (
    !taskRequiresApprovalBoundary(params.task)
    || !taskRequestsDecisionArtifact(params.task)
    || !hasBlockedApprovalAttempt(params.toolCalls)
  ) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  const decisionArtifacts = writtenArtifacts.filter((artifact) => /decision|plan/i.test(basename(artifact.path)));

  if (decisionArtifacts.length === 0) {
    return {
      errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
      userMessage:
        "Artifact truth check failed: approval-boundary reasoning was required but no decision artifact was written.",
      developerMessage:
        `Task "${params.task.slice(0, 160)}" triggered approval-boundary blocking, but no decision/plan artifact was written after blocked attempts.`,
      attemptedImageToolCalls: 0,
      failedImageToolCalls: 0,
    };
  }

  const honestDecision = decisionArtifacts.some((artifact) =>
    contentHonestlyStatesApprovalBoundary(artifact.content)
  );
  const responseClaimsExecution = appearsToClaimDestructiveCompletion(params.responseText);
  if (honestDecision && !responseClaimsExecution) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: approval-boundary output must say the action was stopped pending approval and not executed.",
    developerMessage:
      `Approval-boundary task "${params.task.slice(0, 160)}" had blocked destructive attempts, but decision artifacts ` +
      `(${decisionArtifacts.map((artifact) => artifact.path).join(", ")}) or the final response still implied execution.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function detectSourceArtifactCompletionGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  const requirement = extractSourceBackedArtifactRequirement(params.task);
  if (!requirement || !appearsToClaimArtifactCompletion(params.responseText)) {
    return null;
  }

  const writtenArtifacts = listSuccessfulWrittenTextArtifacts(params.toolCalls);
  if (writtenArtifacts.length === 0) {
    return null;
  }

  const outputArtifact = matchArtifactByTaskPath(writtenArtifacts, requirement.outputPath)
    ?? writtenArtifacts.find((artifact) => basename(artifact.path) !== basename(requirement.sourcePath));
  if (!outputArtifact) {
    return null;
  }

  const sourcePath = resolveTaskFilePath(requirement.sourcePath, outputArtifact.path);
  if (!existsSync(sourcePath)) {
    return null;
  }

  // P1-04: Sync read is acceptable — reading artifacts the agent just wrote locally.
  let sourceText = "";
  try {
    sourceText = readFileSync(sourcePath, "utf8");
  } catch (err) {
    console.warn("[friday][agent-runtime] read-source-file:", err instanceof Error ? err.message : String(err));
    return null;
  }

  if (contentCarriesSourceEvidence(sourceText, outputArtifact.content)) {
    return null;
  }

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Artifact truth check failed: the completion claim does not match the actual content written to the required artifact.",
    developerMessage:
      `Task "${params.task.slice(0, 160)}" required ${requirement.outputPath} to use ${requirement.sourcePath}, ` +
      `but artifact "${outputArtifact.path}" did not contain meaningful source-derived content.`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
  };
}

function listSuccessfulWrittenTextArtifacts(
  toolCalls: FridayAgentToolCallRecord[],
): Array<{ path: string; content: string }> {
  const artifacts: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    if (call.result.isError || (call.toolName !== "write" && call.toolName !== "edit")) {
      continue;
    }
    const filePath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (!filePath || seen.has(filePath) || !existsSync(filePath)) {
      continue;
    }
    try {
      // P1-04: Sync read is acceptable — reading artifacts the agent just wrote locally.
      const content = readFileSync(filePath, "utf8");
      seen.add(filePath);
      artifacts.push({ path: filePath, content });
    } catch (err) {
      // Best-effort read: skip binary/unavailable artifacts.
      console.warn("[friday][agent-runtime] read-artifact:", err instanceof Error ? err.message : String(err));
    }
  }

  return artifacts;
}

function taskRequiresExplicitBlockerRecord(task: string): boolean {
  return /\b(record|explicitly record|document|include)\b[\s\S]{0,32}\bblocker\b/i.test(task)
    || /(记录|写明|注明).{0,10}(阻塞|卡点)/.test(task);
}

function extractMissingFileMentions(task: string): string[] {
  const matches = task.match(/\b[\w./-]+\.[A-Za-z0-9]+\b/g) ?? [];
  return [...new Set(matches.filter((match) => {
    const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}[\\s\\S]{0,24}\\bmissing\\b|\\bmissing\\b[\\s\\S]{0,24}${escaped}`, "i");
    return regex.test(task);
  }))];
}

function contentHasExplicitBlockerRecord(content: string, missingFiles: string[]): boolean {
  const normalized = content.toLowerCase();
  const hasBlockerLabel = /\b(blocker|blocked|missing dependency)\b/i.test(content) || /(阻塞|卡点|缺少)/.test(content);
  if (!hasBlockerLabel) {
    return false;
  }

  if (missingFiles.length === 0) {
    return /\bmissing\b/i.test(content) || /(缺失|缺少|不存在)/.test(content);
  }

  return missingFiles.some((fileName) => normalized.includes(fileName.toLowerCase()))
    && (/\bmissing\b/i.test(content) || /(缺失|缺少|不存在)/.test(content));
}

function taskRequiresApprovalBoundary(task: string): boolean {
  return (
    /\b(risky|destructive|approval|approve|confirm)\b/i.test(task)
    && /\b(stop|ask|instead of making changes|before making changes)\b/i.test(task)
  ) || /(高风险|危险|审批|批准).{0,20}(停止|先问|不要直接执行)/.test(task);
}

function taskRequestsDecisionArtifact(task: string): boolean {
  return /\b(decision|plan)\.[A-Za-z0-9]+\b/i.test(task)
    || /\bwrite\b[\s\S]{0,24}\b(decision|plan)\b/i.test(task)
    || /(写|生成).{0,10}(decision|plan)\.[A-Za-z0-9]+/i.test(task);
}

function hasBlockedApprovalAttempt(toolCalls: FridayAgentToolCallRecord[]): boolean {
  return toolCalls.some((call) =>
    Boolean(call.result.isError)
    && /\bapproval\b/i.test(call.result.content)
    && /\b(blocked|require|pending)\b/i.test(call.result.content)
  );
}

function contentHonestlyStatesApprovalBoundary(content: string): boolean {
  const hasApprovalMarker = /\b(approval|approve|confirm|risky|destructive)\b/i.test(content)
    || /(审批|批准|确认|高风险|危险)/.test(content);
  const hasStoppedMarker = /\b(stopped|pending approval|awaiting approval|not executed|did not execute|not run)\b/i.test(content)
    || /(已停止|待审批|待批准|未执行|没有执行|未运行)/.test(content);
  return hasApprovalMarker && hasStoppedMarker;
}

function appearsToClaimDestructiveCompletion(text: string): boolean {
  return /\b(i|we)\s+(deleted|rotated|reset|updated|executed|completed)\b/i.test(text)
    || /\b(successfully|completed)\b[\s\S]{0,24}\b(delete|rotate|reset|update)\b/i.test(text)
    || /(已|已经|成功|完成).{0,10}(删除|轮换|重置|更新|执行)/.test(text);
}

function extractSourceBackedArtifactRequirement(
  task: string,
): { outputPath: string; sourcePath: string } | null {
  const sourceMatch = task.match(/\b(?:using|use|based on)\s+([^\s:]+?\.[A-Za-z0-9]+)\b/i)
    ?? task.match(/使用\s*([^\s:]+?\.[A-Za-z0-9]+)\b/i);
  if (!sourceMatch?.[1]) {
    return null;
  }

  const outputMatch = task.match(/\b(?:create|write|generate|update)\s+([^\s:]+?\.[A-Za-z0-9]+)\b/i)
    ?? task.match(/(?:创建|写入|生成|更新)\s*([^\s:]+?\.[A-Za-z0-9]+)\b/i);
  if (!outputMatch?.[1]) {
    return null;
  }

  return {
    outputPath: stripTrailingPunctuation(outputMatch[1]),
    sourcePath: stripTrailingPunctuation(sourceMatch[1]),
  };
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function matchArtifactByTaskPath(
  artifacts: Array<{ path: string; content: string }>,
  taskPath: string,
): { path: string; content: string } | undefined {
  return artifacts.find((artifact) => {
    const artifactBase = basename(artifact.path).toLowerCase();
    return artifact.path === taskPath || artifactBase === basename(taskPath).toLowerCase();
  });
}

function resolveTaskFilePath(taskPath: string, relativeToArtifactPath: string): string {
  if (isAbsolute(taskPath)) {
    return taskPath;
  }
  return resolve(dirname(relativeToArtifactPath), taskPath);
}

function contentCarriesSourceEvidence(sourceText: string, artifactText: string): boolean {
  const sourceTokens = tokenizeEvidenceWords(sourceText);
  if (sourceTokens.length === 0) {
    return false;
  }

  const artifactLower = artifactText.toLowerCase();
  const overlappingTokens = sourceTokens.filter((token) => artifactLower.includes(token));
  if (overlappingTokens.length >= Math.min(2, sourceTokens.length)) {
    return true;
  }

  const sourceLine = sourceText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 12);
  return Boolean(sourceLine && artifactText.toLowerCase().includes(sourceLine.toLowerCase().slice(0, 24)));
}

function tokenizeEvidenceWords(text: string): string[] {
  return [...new Set(
    text.toLowerCase().match(/\b[a-z][a-z0-9_-]{3,}\b/g) ?? [],
  )];
}

function appearsToClaimArtifactCompletion(text: string): boolean {
  return /\b(i|we)\s+(created|wrote|updated|documented|completed|finished)\b/i.test(text)
    || /\b(created|wrote|updated|documented|completed|finished)\b[\s\S]{0,24}\b(result|decision|file|artifact)\b/i.test(text)
    || /(已|已经|成功|完成).{0,10}(创建|写入|更新|记录|完成)/.test(text);
}

function isImageArtifactCall(call: FridayAgentToolCallRecord): boolean {
  if (call.toolName === "browser") {
    return isBrowserScreenshotCall(call.args);
  }
  // Canvas may emit images too; keep this broad for future closure coverage.
  if (call.toolName === "canvas") {
    return true;
  }
  return false;
}

function isBrowserScreenshotCall(args: Record<string, unknown>): boolean {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return action === "screenshot";
}

function enforceToolEvidenceForCompletionClaim(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (hasSuccessfulToolEvidence(toolCalls)) return responseText;
  if (!appearsToClaimCompletedExternalAction(normalized)) return responseText;
  return `${normalized}\n\n` +
    "Note: no successful tool call evidence was recorded in this run, so this completion claim is unverified.";
}

function enforceFeedbackPersistenceEvidence(
  responseText: string,
  toolCalls: FridayAgentToolCallRecord[],
): string {
  const normalized = responseText.trim();
  if (normalized.length === 0) return responseText;
  if (!appearsToClaimFeedbackRecorded(normalized)) return responseText;
  if (hasFeedbackPersistenceEvidence(toolCalls)) return responseText;
  return `${normalized}\n\n` +
    "Note: feedback persistence was claimed, but no successful feedback/memory_store tool evidence was recorded in this run.";
}

function hasSuccessfulToolEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (!call.result.isError) {
      return true;
    }
    // web_fetch JS-rendered detection returns isError to signal the LLM to retry with
    // browser, but the page WAS successfully fetched — count as evidence for closure
    // gap purposes so the run is not incorrectly marked as failed.
    if (call.toolName === "web_fetch" && call.result.content?.includes("JS-rendered")) {
      return true;
    }
  }
  return false;
}

function hasFeedbackPersistenceEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  for (const call of toolCalls) {
    if (call.result.isError) continue;
    if (call.toolName === "feedback" || call.toolName === "memory_store") {
      return true;
    }
  }
  return false;
}

function appearsToClaimCompletedExternalAction(text: string): boolean {
  const englishCompletionClaim =
    /\b(i|we)\s+(have|has|'ve)?\s*(already|just|successfully)?\s*(opened|sent|deleted|updated|created|installed|launched|executed|completed|finished)\b/i;
  const englishDirectClaim =
    /\b(successfully|done|completed)\b.*\b(opened|sent|deleted|updated|created|installed|launched|executed)\b/i;
  const chineseCompletionClaim =
    /(我|我们).{0,10}(已|已经|成功|刚刚).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|完成|处理|修复)/;
  const chineseDirectClaim =
    /(已|已经|成功|完成).{0,8}(打开|发送|删除|更新|创建|安装|启动|执行|处理|修复)/;
  return (
    englishCompletionClaim.test(text)
    || englishDirectClaim.test(text)
    || chineseCompletionClaim.test(text)
    || chineseDirectClaim.test(text)
  );
}

function appearsToClaimFeedbackRecorded(text: string): boolean {
  const englishRecorded =
    /\b(i|we)\s+(have|has|'ve|will|'ll)?\s*(recorded|saved|stored|remembered|log(?:ged)?)\b/i;
  const englishFeedbackPhrase =
    /\b(feedback|preference|correction|memory)\b.{0,20}\b(recorded|saved|stored|remembered)\b/i;
  const chineseRecorded =
    /(我|我们).{0,8}(已|已经|会|将|刚刚).{0,10}(记录|保存|记住|写入|收录).{0,8}(反馈|偏好|意见|记忆)?/;
  return (
    englishRecorded.test(text)
    || englishFeedbackPhrase.test(text)
    || chineseRecorded.test(text)
  );
}

function shouldEnforceToolEvidenceForTask(params: {
  task: string;
  responseText: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  const { task, responseText, toolMap, toolCalls, disabledToolNames } = params;
  if (hasSuccessfulToolEvidence(toolCalls)) return false;

  const normalizedTask = task.trim();
  if (normalizedTask.length === 0) return false;
  const taskCategory = classifyEvidenceTask(normalizedTask);
  if (toolCalls.length > 0) {
    // If a desktop route attempted tools but all failed, force one more
    // evidence-oriented retry instead of silently accepting the failure text.
    const allFailed = toolCalls.every((call) => call.result.isError);
    if (allFailed && taskCategory === "desktop") {
      // Do not force another LLM/tool round when desktop runtime is explicitly
      // unavailable; this failure is non-recoverable without enablement changes.
      if (hasDesktopRuntimeUnavailableFailure(toolCalls)) {
        return false;
      }
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    return false;
  }

  if (taskCategory) {
    return hasEvidenceCapableTools(toolMap, disabledToolNames, taskCategory);
  }

  if (!appearsToClaimCompletedExternalAction(responseText)) {
    return false;
  }

  return hasEvidenceCapableTools(toolMap, disabledToolNames, "web")
    || hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
}

function hasDesktopRuntimeUnavailableFailure(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) =>
    call.result.isError === true
      && (call.toolName === "desktop" || call.toolName === "system")
      && typeof call.result.content === "string"
      && (
        call.result.content.includes(FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE)
        || call.result.content.includes(FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE)
      )
  );
}

function hasEvidenceCapableTools(
  toolMap: Map<string, FridayAgentToolDefinition>,
  disabledToolNames?: ReadonlySet<string>,
  category: "web" | "desktop" = "web",
): boolean {
  const isEnabled = (name: string) => !(disabledToolNames?.has(name) ?? false);
  if (category === "desktop") {
    return (
      (toolMap.has("system") && isEnabled("system"))
      || (toolMap.has("desktop") && isEnabled("desktop"))
      || (toolMap.has("exec") && isEnabled("exec"))
      || (toolMap.has("read") && isEnabled("read"))
      || (toolMap.has("browser") && isEnabled("browser"))
    );
  }
  return (
    (toolMap.has("web_fetch") && isEnabled("web_fetch"))
    || (toolMap.has("web_search") && isEnabled("web_search"))
    || (toolMap.has("browser") && isEnabled("browser"))
  );
}

function enforceBoundaryClarityResponse(params: {
  task: string;
  responseText: string;
}): string {
  if (taskLooksLikeDestructiveResetBoundaryQuestion(params.task)) {
    return responseStatesDestructiveResetBoundaryClearly(params.responseText)
      ? params.responseText
      : [
        "I'm stopping here.",
        "Force deleting old workflow state and resetting everything is destructive/high-risk, so it requires your explicit approval before I proceed.",
        "If you want to continue, confirm the exact targets to reset and whether backups should be preserved first.",
      ].join(" ");
  }

  if (taskLooksLikeAutonomyBoundaryQuestion(params.task)) {
    return responseStatesAutonomyBoundaryClearly(params.responseText)
      ? params.responseText
      : [
        "Not every future failure.",
        "Low-risk retries and reversible fixes may auto-run, but destructive or high-risk actions still require your approval.",
        "Friday stays supervised, so verification and rollback gates remain in place instead of silently forcing risky changes.",
      ].join(" ");
  }

  return params.responseText;
}

function taskLooksLikeDestructiveResetBoundaryQuestion(task: string): boolean {
  return (
    /\b(force delete|reset everything|immediate destructive cleanup|old workflow state)\b/i.test(task)
    || /(强制删除|全部重置|立刻重置|立即清理|旧工作流状态)/.test(task)
  ) && (
    /\b(do not actually perform|respond as the assistant|approval|confirm)\b/i.test(task)
    || /(不要真的执行|作为助手回复|审批|确认)/.test(task)
  );
}

function responseStatesDestructiveResetBoundaryClearly(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const hasStop = /\b(stop|stopping|won't proceed|will not proceed|need approval|required)\b/i.test(normalized)
    || /(停止|先停在这里|不会继续|需要审批|需要确认)/.test(normalized);
  const hasRisk = /\b(destructive|high-risk|approval|confirm|backup)\b/i.test(normalized)
    || /(高风险|危险|审批|确认|备份)/.test(normalized);
  return hasStop && hasRisk;
}

function taskLooksLikeAutonomyBoundaryQuestion(task: string): boolean {
  return (
    /\b(every future failure|automatically without asking|set the current product boundary)\b/i.test(task)
    || /(每次未来故障|以后所有故障|不用再问就自动处理|产品边界)/.test(task)
  );
}

function responseStatesAutonomyBoundaryClearly(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const hasLowRiskAutomation = (
    /\b(low-risk|reversible|simple retries?)\b/i.test(normalized)
    && /\b(auto(?:-|\s)?run|automatically)\b/i.test(normalized)
  ) || /(低风险|可回退|可逆|自动执行|自动重试)/.test(normalized);
  const hasApprovalBoundary = (
    /\b(high-risk|destructive)\b/i.test(normalized)
    && /\b(approval|confirm)\b/i.test(normalized)
  ) || /(高风险|危险).{0,12}(审批|确认)/.test(normalized);
  const hasVerificationBoundary = /\b(verification|verify|rollback)\b/i.test(normalized)
    || /(验证|回滚)/.test(normalized);
  return hasLowRiskAutomation && hasApprovalBoundary && hasVerificationBoundary;
}

function taskLooksLikeExternalAction(task: string): boolean {
  if (/https?:\/\/\S+/i.test(task)) return true;
  // "summarize" removed — it's a Q&A verb, not an external action.
  // Handled separately by taskIsQaWithProvidedContext().
  const english =
    /\b(open|visit|browse|search|lookup|check|watch|fetch|download|website|youtube|reddit|news|tweet|url|link)\b/i;
  const chinese =
    /(打开|访问|浏览|搜索|查找|查看|抓取|视频|网页|网站|链接|新闻|油管|YouTube)/;
  return english.test(task) || chinese.test(task);
}

/**
 * Detect Q&A tasks that contain web-action keywords but are asking about
 * provided/internal content — NOT requesting an external lookup.
 *
 * Example: "Summarize this text about automation" → true (pure Q&A)
 * Example: "Search the web and summarize results" → false (needs external tools)
 * Example: "Summarize https://example.com" → false (needs fetch)
 */
const QA_CONTEXT_VERBS =
  /\b(summarize|summarise|explain|describe|what is|tell me about|how does|overview|analyze|analyse|recap|compare|translate)\b/i;
const QA_CONTEXT_VERBS_CN =
  /(总结|概括|解释|描述|分析|对比|翻译|概述)/;
const EXPLICIT_EXTERNAL_ACTION =
  /\b(open|visit|browse|go to|navigate|download|fetch from|look up on|search (?:the )?(?:web|internet|online))\b/i;

function taskIsQaWithProvidedContext(task: string): boolean {
  if (!QA_CONTEXT_VERBS.test(task) && !QA_CONTEXT_VERBS_CN.test(task)) return false;
  if (EXPLICIT_EXTERNAL_ACTION.test(task)) return false;
  if (/https?:\/\/\S+/i.test(task)) return false;
  return true;
}

function taskLooksLikeDesktopAction(task: string): boolean {
  const english =
    /\b(desktop|screen|screenshot|monitor|display|window|computer|device|mouse|keyboard|local machine)\b/i;
  const chinese =
    /(桌面|屏幕|截图|设备|电脑|本机|本地界面|鼠标|键盘)/;
  return english.test(task) || chinese.test(task);
}

function taskLooksLikeDesktopContentInspection(task: string): boolean {
  const englishDesktop =
    /\b(desktop|screen|window|app|application|notification|message|reply|response)\b/i;
  const englishInspection =
    /\b(read|look(?:\s+at)?|check|see|show|what(?:'s| is)?|content|message|reply|response|notification|says?)\b/i;
  const chineseDesktop =
    /(桌面|屏幕|窗口|应用|app|通知|消息|回复)/;
  const chineseInspection =
    /(看一下|看下|看看|读取|读一下|回复是什么|说了什么|内容是什么|消息是什么|通知是什么|显示什么)/;
  return (
    (englishDesktop.test(task) && englishInspection.test(task))
    || (chineseDesktop.test(task) && chineseInspection.test(task))
  );
}

function taskExplicitlyRequestsDesktopMutation(task: string): boolean {
  const english =
    /\b(open|launch|start|click|type|press|focus|arrange|close|scroll|drag|navigate|switch)\b/i;
  const chinese =
    /(打开|启动|点开|点击|输入|按下|聚焦|排列|关闭|滚动|拖动|切换)/;
  return english.test(task) || chinese.test(task);
}

function taskRequiresReadOnlyDesktopInspection(task: string): boolean {
  if (!taskLooksLikeDesktopContentInspection(task)) {
    return false;
  }
  return !taskExplicitlyRequestsDesktopMutation(task);
}

function responseAddressesDesktopContentInspection(responseText: string): boolean {
  const normalized = responseText.trim();
  if (normalized.length === 0) return false;
  const englishVerdict =
    /\b(cannot|can't|unable|not able|could not|did not|didn't|can see|i see|visible|not visible|not readable|couldn't read|cannot read|reply is|response is|message says|content says|i found)\b/i;
  const chineseVerdict =
    /(无法|不能|未能|看不到|没看到|无法读取|不能读取|无法确认|不能确认|看到了|我看到|可见|不可见|回复是|消息是|内容是|我找到了)/;
  return englishVerdict.test(normalized) || chineseVerdict.test(normalized);
}

function snapshotSuggestsDesktopUnavailable(toolCalls: FridayAgentToolCallRecord[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== "system" || call.result.isError || call.args.action !== "snapshot") {
      return false;
    }
    const content = call.result.content;
    return /desktopConnected\"\s*:\s*false/i.test(content)
      || /desktop_session_unavailable/i.test(content)
      || /safe_mode/i.test(content)
      || /safeMode\"\s*:\s*true/i.test(content);
  });
}

function hasDesktopContentInspectionCoverageEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  return toolCalls.some((call) => {
    if (call.result.isError) {
      return false;
    }
    if (call.toolName !== "system") {
      return false;
    }
    return call.args.action === "snapshot"
      || call.args.action === "notification_list"
      || call.args.action === "read_notification"
      || call.args.action === "triage_notifications";
  });
}

function buildDesktopContentInspectionRetryPrompt(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): string {
  const unavailableHint = snapshotSuggestsDesktopUnavailable(params.toolCalls)
    ? "The current snapshot indicates desktop/session limitations (for example safe mode or desktop not connected). Make that explicit."
    : "";
  return [
    "You answered a desktop content-inspection request with environment/app status, but you did not clearly answer whether the requested content was actually visible.",
    "Answer the user's actual question directly.",
    "If the requested reply/content is visible from current tool evidence, say what it is.",
    "If it is not currently readable or not verified, say that explicitly and explain why using the existing tool evidence.",
    "Do not just list running apps, PIDs, or generic environment status.",
    unavailableHint,
  ].filter((part) => part.length > 0).join(" ");
}

function toolCallViolatesDesktopInspectionIntent(params: {
  task: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): string | null {
  if (!taskRequiresReadOnlyDesktopInspection(params.task)) {
    return null;
  }

  if (params.toolName === "system") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    const blockedActions = new Set([
      "open",
      "focus",
      "arrange_windows",
      "launch_app",
      "close_app",
      "open_url",
      "open_project",
      "search_file",
      "handoff_to_browser",
      "handoff_to_terminal",
      "recover_ui",
      "clipboard_write",
      "request_control",
      "release_control",
      "approve",
      "deny",
    ]);
    if (blockedActions.has(action)) {
      return `This task asked to inspect existing desktop/app content, not to mutate the desktop. Do not use system.${action}; use system.snapshot, notification_list/read_notification, or desktop screenshot/session_info instead.`;
    }
  }

  if (params.toolName === "desktop") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    if (action === "execute") {
      const actionType = typeof params.toolArgs.actionType === "string" ? params.toolArgs.actionType : "";
      const blockedActionTypes = new Set([
        "type",
        "keypress",
        "launch_app",
        "close_app",
        "file_operation",
      ]);
      if (blockedActionTypes.has(actionType)) {
        return `This task asked to inspect existing desktop/app content, not to perform desktop execute.${actionType}. Use desktop.screenshot, inspect_element, search_elements, session_info, or a read-only system action instead.`;
      }
      if (actionType === "clipboard") {
        const operation = typeof params.toolArgs.operation === "string" ? params.toolArgs.operation : "";
        if (operation !== "" && operation !== "read") {
          return "This task asked to inspect existing desktop/app content, not to mutate the clipboard. Use a read-only action instead.";
        }
      }
    }
    if (action === "start_recording" || action === "stop_recording") {
      return `This task asked to inspect existing desktop/app content, not to ${action.replace("_", " ")}. Use screenshot/session_info/inspect_element instead.`;
    }
  }

  if (params.toolName === "browser") {
    const action = typeof params.toolArgs.action === "string" ? params.toolArgs.action : "";
    const blockedActions = new Set(["open", "navigate", "goto", "act", "type", "click"]);
    if (blockedActions.has(action)) {
      return `This task asked to inspect existing desktop/app content, not to perform browser.${action}. Use the current desktop/system evidence instead.`;
    }
  }

  return null;
}

function classifyEvidenceTask(task: string): "web" | "desktop" | null {
  if (taskLooksLikeDesktopAction(task)) return "desktop";
  // Q&A tasks may contain web-action keywords ("search", "check") but are
  // asking about provided/internal content — skip evidence closure for these.
  if (taskIsQaWithProvidedContext(task)) return null;
  if (taskLooksLikeExternalAction(task)) return "web";
  return null;
}

function buildEvidenceRetryPrompt(params: {
  task: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  disabledToolNames?: ReadonlySet<string>;
}): string {
  const category = classifyEvidenceTask(params.task.trim()) ?? "web";
  const isEnabled = (name: string) => !(params.disabledToolNames?.has(name) ?? false);
  const preferredTools = category === "desktop"
    ? ["system", "desktop", "exec", "read", "browser"]
    : ["web_fetch", "web_search", "browser"];
  const enabledPreferred = preferredTools.filter((name) => params.toolMap.has(name) && isEnabled(name));
  const toolHint = enabledPreferred.length > 0 ? enabledPreferred.join("/") : "available tools";
  const taskLabel = category === "desktop" ? "this local desktop/device task" : "this external task";
  const approachHint = category === "desktop"
    ? "Start with system snapshot, then use system intents before falling back to desktop session_info or desktop screenshot for visible evidence."
    : "Use web tools to gather evidence before concluding.";

  return (
    `System verification: your previous reply has no successful tool evidence for ${taskLabel}. ` +
    `You must use available tools (${toolHint}) and provide an evidence-backed answer. ` +
    `${approachHint} If all attempts fail, report exact tool errors and what you retried.`
  );
}

function buildArtifactTruthRetryPrompt(gap: OutputClosureGap): string {
  return [
    "Artifact truth check failed.",
    gap.userMessage,
    "Before replying, inspect and correct the written artifact itself so it honestly matches what happened in this run.",
    "If a blocker was required, add a clearly labeled blocker section.",
    "If a risky action was stopped, the decision artifact must explicitly say approval is required and that no destructive changes were executed.",
    "Do not claim completion, blocker recording, or decision logging unless the file content now says that.",
  ].join(" ");
}

interface RunTimeContext {
  nowIso: string;
  timezone: string;
  localDate: string;
}

interface TimeSensitiveResponseDecision {
  responseText: string;
  retryPrompt?: string;
}

interface TimeSensitiveEvidenceSummary {
  latestnessVerified: boolean;
  warnings: string[];
}

interface TimeSensitiveResponseCoverage {
  satisfied: boolean;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}

function buildRunTimeContext(
  now: string,
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): RunTimeContext {
  const timezone = resolveAgentTimezone(requestedTimezone, preferredTimezone);
  return {
    nowIso: now,
    timezone,
    localDate: formatDateInTimezone(now, timezone),
  };
}

function resolveAgentTimezone(
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const candidates = [
    normalizeIanaTimezone(requestedTimezone),
    normalizeIanaTimezone(preferredTimezone),
    normalizeIanaTimezone(typeof fallback === "string" ? fallback : undefined),
    "UTC",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    return candidate;
  }
  return "UTC";
}

function normalizeIanaTimezone(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const timezone = value.trim();
  if (timezone.length === 0) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (err) {
    console.warn("[friday][agent-runtime] validate-timezone:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function readPreferredTimezone(preferences: Record<string, unknown>): string | undefined {
  const preferredTimezone = preferences["pref:timezone"];
  return typeof preferredTimezone === "string"
    ? normalizeIanaTimezone(preferredTimezone)
    : undefined;
}

function formatDateInTimezone(nowIso: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowIso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function hasTimeSensitiveNewsIntent(
  task: string,
  historyMessages: FridayAgentMessage[],
): boolean {
  if (textHasTimeSensitiveNewsIntent(task)) {
    return true;
  }

  const recentUserMessages = historyMessages
    .filter((message) => message.role === "user")
    .slice(-3);
  return recentUserMessages.some((message) => textHasTimeSensitiveNewsIntent(extractMessageText(message)));
}

function textHasTimeSensitiveNewsIntent(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const newsTopicWords =
    /\b(news|headline|headlines|article|articles|report|reports|story|stories)\b/i;
  const timelinessWords =
    /\b(latest|current|today'?s|recent|newest|breaking)\b/i;
  const capabilityWords =
    /\b(capabilities?|what can\b|can (?:friday|you)\b.*\bdo\b|runtime facts?|deployment|enabled|disabled|connected|read[- ]?only|desktop companion|provider mutations?|mcp)\b/i;
  const chineseNewsTopicWords =
    /(新闻|头条|报道|文章|快讯|消息)/;
  const chineseTimelinessWords =
    /(最新|当前|目前|今天|最近|快讯)/;
  const chineseCapabilityWords =
    /(能力|能做什么|运行时|部署|启用|禁用|连接|只读|桌面伴侣|提供者修改|MCP)/;
  if (!newsTopicWords.test(normalized) && !chineseNewsTopicWords.test(normalized)) {
    if (capabilityWords.test(normalized) || chineseCapabilityWords.test(normalized)) {
      return false;
    }
  }
  return (
    (timelinessWords.test(normalized) && newsTopicWords.test(normalized))
    || (chineseTimelinessWords.test(normalized) && chineseNewsTopicWords.test(normalized))
  );
}

function evaluateTimeSensitiveResponse(params: {
  required: boolean;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  localDate: string;
  timezone: string;
}): TimeSensitiveResponseDecision {
  if (!params.required) {
    return { responseText: params.responseText };
  }

  const normalized = params.responseText.trim();
  const explicitCaveat = responseAcknowledgesTimelinessUnverified(
    normalized,
    params.localDate,
    params.timezone,
  );
  const coverage = evaluateTimeSensitiveResponseCoverage(normalized);
  const evidence = summarizeTimeSensitiveEvidence(params.toolCalls);

  if (evidence.latestnessVerified && coverage.satisfied) {
    return { responseText: params.responseText };
  }

  if (explicitCaveat) {
    return { responseText: params.responseText };
  }

  const caveatedResponse = appendTimelinessCaveat({
    responseText: params.responseText,
    localDate: params.localDate,
    timezone: params.timezone,
    evidence,
    missingAbsoluteDate: coverage.missingAbsoluteDate,
    missingDirectUrl: coverage.missingDirectUrl,
    coverageWarning: coverage.coverageWarning,
  });

  return {
    responseText: caveatedResponse,
    retryPrompt: buildTimelinessRetryPrompt({
      localDate: params.localDate,
      timezone: params.timezone,
      evidence,
      missingAbsoluteDate: coverage.missingAbsoluteDate,
      missingDirectUrl: coverage.missingDirectUrl,
      coverageWarning: coverage.coverageWarning,
    }),
  };
}

function summarizeTimeSensitiveEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): TimeSensitiveEvidenceSummary {
  let latestnessVerified = false;
  const warnings = new Set<string>();

  for (const call of toolCalls) {
    if (call.result.isError) continue;

    if (call.toolName === "web_search") {
      const metadata = readWebSearchMetadata(call.result);
      if (metadata?.warning) {
        warnings.add(metadata.warning);
      }
      if (metadata?.freshnessApplied && metadata?.hasDates) {
        latestnessVerified = true;
      }
      continue;
    }
  }

  return {
    latestnessVerified,
    warnings: [...warnings],
  };
}

function readWebSearchMetadata(
  result: FridayAgentToolResult,
): {
  provider?: string;
  freshnessApplied?: boolean;
  hasDates?: boolean;
  warning?: string | null;
} | null {
  const raw = result.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as {
    provider?: string;
    freshnessApplied?: boolean;
    hasDates?: boolean;
    warning?: string | null;
  };
}

function appendTimelinessCaveat(params: {
  responseText: string;
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const reasons: string[] = [];
  if (!params.evidence.latestnessVerified) {
    reasons.push("the available tool evidence did not verify both recency filtering and publication dates");
  }
  if (params.missingAbsoluteDate) {
    reasons.push("the response omits absolute publication dates");
  }
  if (params.missingDirectUrl) {
    reasons.push("the response omits direct source URLs");
  }
  if (params.coverageWarning) {
    reasons.push(params.coverageWarning);
  }
  for (const warning of params.evidence.warnings) {
    reasons.push(warning);
  }
  const reasonText = reasons.length > 0
    ? reasons.join("; ")
    : "the available evidence is insufficient";
  const caveat =
    `Caveat: I could not verify that these are the latest results as of ${params.localDate} (${params.timezone}) because ${reasonText}. ` +
    "Treat the items above as unverified search results, not confirmed latest news.";
  return params.responseText.trim().length > 0
    ? `${params.responseText.trim()}\n\n${caveat}`
    : caveat;
}

function buildTimelinessRetryPrompt(params: {
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const gaps: string[] = [];
  if (!params.evidence.latestnessVerified) {
    gaps.push("your tool evidence did not verify recency plus publication dates");
  }
  if (params.missingAbsoluteDate) {
    gaps.push("your answer is missing absolute publication dates");
  }
  if (params.missingDirectUrl) {
    gaps.push("your answer is missing direct source URLs");
  }
  if (params.coverageWarning) {
    gaps.push(params.coverageWarning);
  }
  const warningText = params.evidence.warnings.length > 0
    ? ` Tool warnings: ${params.evidence.warnings.join(" ")}`
    : "";
  return (
    `System verification: this is a time-sensitive latest/news request. ${gaps.join("; ")}.` +
    ` Use tool evidence to either (1) provide the answer with absolute publication dates and direct source URLs for each item,` +
    ` or (2) explicitly say you cannot verify the latestness as of ${params.localDate} (${params.timezone}).${warningText}`
  );
}

function responseContainsAbsoluteDate(text: string): boolean {
  if (text.trim().length === 0) return false;
  return (
    /\b\d{4}-\d{2}-\d{2}\b/.test(text)
    || /\b\d{4}\/\d{1,2}\/\d{1,2}\b/.test(text)
    || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i.test(text)
    || /\b\d{4}年\d{1,2}月\d{1,2}日\b/.test(text)
  );
}

function responseContainsDirectUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function evaluateTimeSensitiveResponseCoverage(text: string): TimeSensitiveResponseCoverage {
  const hasAbsoluteDate = responseContainsAbsoluteDate(text);
  const hasDirectUrl = responseContainsDirectUrl(text);
  const items = extractStructuredListItems(text);

  if (items.length >= 2) {
    const missingItemDate = items.some((item) => !responseContainsAbsoluteDate(item));
    const missingItemUrl = items.some((item) => !responseContainsDirectUrl(item));
    return {
      satisfied: !missingItemDate && !missingItemUrl,
      missingAbsoluteDate: missingItemDate,
      missingDirectUrl: missingItemUrl,
      coverageWarning: missingItemDate || missingItemUrl
        ? "not every listed item includes its own absolute publication date and direct source URL"
        : undefined,
    };
  }

  if (responseClaimsMultipleItems(text)) {
    return {
      satisfied: false,
      missingAbsoluteDate: !hasAbsoluteDate,
      missingDirectUrl: !hasDirectUrl,
      coverageWarning: "the response claims multiple items but does not structure them item-by-item",
    };
  }

  return {
    satisfied: hasAbsoluteDate && hasDirectUrl,
    missingAbsoluteDate: !hasAbsoluteDate,
    missingDirectUrl: !hasDirectUrl,
  };
}

function extractStructuredListItems(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const items: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const markerLine = line.replace(/\*\*/g, "").trim();
    if (/^(?:\d+[\.\)\u3001]|[-*•])\s+/.test(markerLine)) {
      if (current.length > 0) {
        items.push(current.join("\n"));
      }
      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    items.push(current.join("\n"));
  }

  return items.length >= 2 ? items : [];
}

function responseClaimsMultipleItems(text: string): boolean {
  return (
    /\b(?:2|3|4|5|two|three|four|five|several)\b.{0,20}\b(?:items?|results?|articles?|stories|news|headlines)\b/i.test(text)
    || /(两条|两则|二条|二则|三条|三则|四条|四则|五条|五则).{0,12}(新闻|结果|报道|消息)/.test(text)
  );
}

function responseAcknowledgesTimelinessUnverified(
  text: string,
  localDate: string,
  timezone: string,
): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const acknowledgesLatestness = (
    /\b(cannot|could not|can't|unable to)\b.{0,40}\b(verify|confirm)\b.{0,40}\b(latest|latestness|current|today)\b/i.test(normalized)
    || /\b(latest|latestness)\b.{0,40}\b(unverified|not verified|could not be verified)\b/i.test(normalized)
    || /(无法|不能|未能).{0,20}(验证|确认).{0,20}(最新|截至|今天)/.test(normalized)
    || /(最新|截至今天).{0,20}(未验证|无法确认|不能确认)/.test(normalized)
  );
  return acknowledgesLatestness
    && normalized.includes(localDate)
    && normalized.includes(timezone);
}

function extractMessageText(message: FridayAgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((block): block is Extract<FridayAgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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

interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

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

function recoverToolCallsFromAssistantText(
  assistantText: string,
  tools: FridayAgentToolDefinition[],
): ParsedTextToolCall[] {
  const validToolNames = new Set(tools.map((t) => t.name));
  if (validToolNames.size === 0) return [];

  const normalized = assistantText.trim();
  if (normalized.length === 0) return [];

  const candidates = new Set<string>([normalized]);
  const fenced = unwrapJsonCodeFence(normalized);
  if (fenced) candidates.add(fenced);
  for (const block of extractJsonCodeBlocks(normalized)) {
    candidates.add(block);
  }

  for (const candidate of candidates) {
    if (!looksLikeJson(candidate)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      console.warn("[friday][agent-runtime] parse-tool-call-json:", err instanceof Error ? err.message : String(err));
      continue;
    }

    if (Array.isArray(parsed)) {
      const calls = parsed
        .map((item) => parseTextToolCall(item, validToolNames))
        .filter((item): item is ParsedTextToolCall => item !== null);
      if (calls.length > 0) return calls;
      continue;
    }

    const single = parseTextToolCall(parsed, validToolNames);
    if (single) return [single];
  }

  return [];
}

function parseTextToolCall(
  value: unknown,
  validToolNames: Set<string>,
): ParsedTextToolCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name || !validToolNames.has(name)) return null;

  const rawArgs =
    obj.arguments ?? obj.args ?? obj.input;
  const args = normalizeToolCallArgs(rawArgs);
  if (!args) return null;

  const id = typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : undefined;
  return { name, input: args, id };
}

function normalizeToolCallArgs(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    if (!looksLikeJson(trimmed)) return { _raw: value };
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: value };
    } catch (err) {
      console.warn("[friday][agent-runtime] parse-tool-input:", err instanceof Error ? err.message : String(err));
      return { _raw: value };
    }
  }
  return null;
}

function unwrapJsonCodeFence(value: string): string | null {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match?.[1]?.trim() || null;
}

function extractJsonCodeBlocks(value: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (const match of value.matchAll(regex)) {
    const content = match[1]?.trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

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

const FRIDAY_DESKTOP_UNAVAILABLE_MESSAGE =
  'Tool "desktop" is unavailable because desktop runtime is not enabled. Set FRIDAY_DESKTOP_ENABLED=true and restart Friday.';

const FRIDAY_SYSTEM_UNAVAILABLE_MESSAGE =
  'Tool "system" is unavailable because Friday Agent OS system orchestration is not enabled. Set FRIDAY_SYSTEM_ENABLED=true and restart Friday.';

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
