import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { FridayDomainError } from "#errors";
import type { FridayEvaluationContext, FridayEvaluationResult } from "#rules";
import { buildToolErrorRecoveryHint } from "./friday-agent-tool-error-recovery.js";
import type { ToolErrorContext } from "./friday-agent-tool-error-recovery.js";
import type {
  FridayProviderAttempt,
  FridayProviderBackendKind,
} from "#providers";

import { evaluatePolicyExtensionChain } from "../../security/policy-extension-chain.js";
import type { PolicyExtension } from "../../security/policy-extension-chain.js";
import {
  createFridayMutatingActionGate,
  createFridaySystemIntentMutatingActionRequest,
  signFridayCanonicalApproval,
} from "../../security/friday-mutating-action-gate.js";
import { isFridaySensitiveLearningCandidate } from "../../learning/services/friday-sensitive-learning-guard.js";
import type {
  FridayCanonicalApprovalResolution,
  FridayMutatingActionRequest,
  FridayMutatingActionRisk,
} from "../../security/friday-mutating-action-gate.js";

import {
  FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
  FRIDAY_AGENT_COMPACTION_SOFT_WINDOW_TOKENS,
  FRIDAY_AGENT_COMPACTION_THRESHOLD,
  FRIDAY_AGENT_COMPACTION_USE_PROVIDER,
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
  FridayAgentApiRequestMetadata,
  FridayAgentArtifact,
  FridayAgentContentBlock,
  FridayAgentEtaConfidence,
  FridayAgentImageBlock,
  FridayAgentMessage,
  FridayAgentPlanReviewPayload,
  FridayAgentRunConstraints,
  FridayAgentRunMetadata,
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
  FridayAgentCompactionContextBuildResult,
  FridayAgentContextCostComponent,
  FridayAgentContextCostSummary,
  FridayAgentConversationContext,
  FridayAgentExecutionContext,
  FridayAgentRuntime,
  FridayAgentRuntimeResult,
  FridayAgentSystemPromptBuildResult,
} from "./friday-agent-runtime.types.js";
import { evaluateFridayAnswerAlignment } from "./friday-agent-answer-alignment.js";
import { notifyFridayContextEngineAfterTurn } from "./friday-agent-context-engine.js";
import type { FridayDecisionContext } from "./friday-agent-decision-engine.types.js";
import { createFridayFileVersionTracker } from "./friday-agent-file-version-tracker.js";
import { createFridayRunCheckpoint } from "./friday-agent-run-checkpoint.js";
import type { FridayRunCheckpoint } from "./friday-agent-run-checkpoint.js";
import {
  classifyToolBatchDependencies,
  executeToolBatch,
  extractFilePaths,
} from "./friday-agent-tool-batch-executor.js";
import { attachFridayAgentToolExecutionContext } from "./friday-agent-tool-execution-context.js";
import {
  buildFridayAgentToolPostGuardrailEvidence,
  buildFridayAgentToolPreGuardrailEvidence,
} from "./friday-agent-tool-guardrail.js";
import { shouldDelegateFridayAgentTask } from "./friday-agent-delegation-policy.js";
import { resolveFridayAgentTaskProfile } from "./friday-agent-task-profile.js";
import { isMutatingToolCall } from "./friday-agent-tool-mutation.js";
import {
  classifyShellRisk,
  getApprovalRequiredReasonForToolCall,
  getPolicyDeniedReasonForToolCall,
} from "./friday-agent-tool-risk.js";
import {
  buildFridayStarterSkillRoutingRetryPrompt,
  findFridayStarterSkillRoutingCandidate,
  hasFridayStarterSkillRoutingEvidence,
} from "./friday-agent-starter-skill-routing.js";
import { summarizeToolCall } from "../services/friday-tool-call-summary.js";
import { assessDegradation, getDegradationSystemPrompt } from "./friday-agent-degradation-handler.js";
import { filterToolsByMode, FRIDAY_MODE_CONFIGS, resolveToolCategory } from "./friday-agent-operational-mode.js";
import type { FridayOperationalMode } from "./friday-agent-operational-mode.js";
import {
  createFridayAgentToolPackRequestTool,
  createFridayAgentToolSearchTool,
  resolveFridayAgentToolNamesForPacks,
  resolveFridayAgentToolRouting,
} from "./friday-agent-tool-routing.js";

const RULES_EVALUATE_SCOPE = "rules:evaluate";
const TERMINAL_CONTEXT_ENGINE_STATUSES: ReadonlySet<FridayAgentRunStatus> = new Set([
  "completed",
  "failed",
  "failed_tests",
  "cancelled",
]);
const AGENT_COMPACTION_APPROX_CHARS_PER_TOKEN = 4;
const AGENT_COMPACTION_TRIGGER_RATIO = 0.70;
const AGENT_COMPACTION_SOFT_CHAR_THRESHOLD = Math.floor(
  FRIDAY_AGENT_COMPACTION_SOFT_WINDOW_TOKENS
  * AGENT_COMPACTION_APPROX_CHARS_PER_TOKEN
  * AGENT_COMPACTION_TRIGGER_RATIO,
);

function estimateAgentContextInputTokens(estimatedChars: number): number {
  return Math.max(0, Math.ceil(Math.max(0, estimatedChars) / AGENT_COMPACTION_APPROX_CHARS_PER_TOKEN));
}

function withAgentContextCostComponent(
  summary: FridayAgentContextCostSummary | undefined,
  component: FridayAgentContextCostComponent,
): FridayAgentContextCostSummary {
  const components = [...(summary?.components ?? []), component];
  return {
    totalEstimatedChars: components.reduce((sum, item) => sum + item.estimatedChars, 0),
    totalEstimatedInputTokens: components.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
    components,
  };
}

function buildAgentToolRoutingContextCostSummary(input: {
  toolNames: readonly string[];
  toolRouting: ReturnType<typeof resolveFridayAgentToolRouting>;
}): FridayAgentContextCostSummary {
  const estimatedChars = input.toolNames.join(",").length;
  return withAgentContextCostComponent(undefined, {
    kind: "tool_routing",
    estimatedChars,
    estimatedInputTokens: estimateAgentContextInputTokens(estimatedChars),
    count: input.toolNames.length,
    metadata: {
      profile: input.toolRouting.profile,
      selectedToolPacks: input.toolRouting.selectedToolPacks,
      deferredToolCount: input.toolRouting.deferredToolNames.length,
      workspaceContextPolicy: input.toolRouting.workspaceContextPolicy,
      reason: input.toolRouting.reason,
    },
  });
}

function hasCjkText(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function buildFridayAgentRunMetadata(params: {
  executionContext?: FridayAgentExecutionContext;
  updatedAt: string;
  apiRequestIdempotency?: FridayAgentApiRequestMetadata;
  disabledToolNames?: string[];
}): FridayAgentRunMetadata | undefined {
  const surface = params.executionContext?.surface?.trim();
  const packId = params.executionContext?.packId?.trim();
  const disabledToolNames = [...normalizeToolNameSet(params.disabledToolNames)];
  if (!surface && !packId && !params.apiRequestIdempotency && disabledToolNames.length === 0) {
    return undefined;
  }

  return {
    ...(params.apiRequestIdempotency
      ? {
        apiRequest: {
          ...params.apiRequestIdempotency,
        },
      }
      : {}),
    ...(!packId && surface ? { surface } : {}),
    ...(packId
      ? {
        packContext: {
          packId,
          ...(surface ? { surface } : {}),
          updatedAt: params.updatedAt,
        },
      }
      : {}),
    ...(disabledToolNames.length > 0
      ? {
        executionBoundary: {
          disabledToolNames,
        },
      }
      : {}),
  };
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

function shouldInjectPrivateActiveMemoryContext(
  executionContext?: FridayAgentExecutionContext,
): boolean {
  if (executionContext?.surface !== "channel") {
    return true;
  }
  const chatType = executionContext.channelChatType;
  return chatType === "direct" || chatType === "dm" || chatType === "private";
}

function isPublicIsolatedRun(constraints?: FridayAgentRunConstraints): boolean {
  return constraints?.readOnly === true
    && constraints.operationalMode === "restricted"
    && constraints.dataSensitivity === "public";
}

function normalizeCompactionContextBuildResult(
  result: string | FridayAgentCompactionContextBuildResult | null | undefined,
): FridayAgentCompactionContextBuildResult | null {
  if (typeof result === "string") {
    return result.trim().length > 0 ? { fragment: result } : null;
  }
  if (!result || typeof result.fragment !== "string" || result.fragment.trim().length === 0) {
    return null;
  }
  return result;
}

function isFridayValidationJudgeTask(task: string): boolean {
  return task.trim().startsWith("You are validating a Friday real-world scenario run.");
}

const NATIVE_TOOL_STRONG_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(read|open|inspect|check|search|grep|rg|cat|ls|browse|visit|screenshot|fetch|download|list|find|run|execute|edit|modify|patch|write|create|delete|rename|move)\b[\s\S]{0,48}\b(file|files|filesystem|folder|directory|repo|repository|workspace|shell|terminal|command|browser|desktop|system|mcp)\b/i,
  /\b(file|files|filesystem|folder|directory|repo|repository|workspace|shell|terminal|command|browser|desktop|system|mcp)\b[\s\S]{0,48}\b(read|open|inspect|check|search|grep|rg|cat|ls|browse|visit|screenshot|fetch|download|list|find|run|execute|edit|modify|patch|write|create|delete|rename|move)\b/i,
  /\b(read|open|inspect|cat)\b[\s\S]{0,32}\b[a-z0-9_.-]+\.[a-z0-9]+\b/i,
  /\b(create|update|edit|modify|delete|publish|run|execute|configure|install|import|debug|fix|open|list|inspect)\b[\s\S]{0,48}\b(workflow|workflows|skill|skills|memory|session|sessions|automation|automations|provider|providers|channel|channels)\b/i,
  /\b(workflow|workflows|skill|skills|memory|session|sessions|automation|automations|provider|providers|channel|channels)\b[\s\S]{0,48}\b(create|update|edit|modify|delete|publish|run|execute|configure|install|import|debug|fix|open|list|inspect)\b/i,
];

export function inferFridayTaskRequiresNativeTools(params: {
  task: string;
  historyMessages?: FridayAgentMessage[];
  readOnly: boolean;
}): boolean {
  if (!params.readOnly) {
    return true;
  }

  if (isFridayValidationJudgeTask(params.task)) {
    return false;
  }

  const corpus = [
    params.task,
    ...(params.historyMessages ?? []).map((message) =>
      typeof message.content === "string" ? message.content : ""),
  ]
    .join("\n")
    .toLowerCase();

  return NATIVE_TOOL_STRONG_PATTERNS.some((pattern) => pattern.test(corpus));
}

function describeAbortReason(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message.trim();
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }
  return "Run terminated";
}

function awaitToolApprovalDecision(params: {
  approval: Promise<{
    approved: boolean;
    reason?: string;
    decidedByPrincipalId?: string;
    decidedByPrincipalType?: string;
    approvalSurface?: string;
  }>;
  signal: AbortSignal;
}): Promise<{
  approved: boolean;
  reason?: string;
  decidedByPrincipalId?: string;
  decidedByPrincipalType?: string;
  approvalSurface?: string;
}> {
  if (params.signal.aborted) {
    return Promise.resolve({
      approved: false,
      reason: describeAbortReason(params.signal.reason),
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = <T>(handler: (value: T) => void) => (value: T) => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener("abort", onAbort);
      handler(value);
    };
    const onAbort = finish(() => resolve({
      approved: false,
      reason: describeAbortReason(params.signal.reason),
    }));

    params.signal.addEventListener("abort", onAbort, { once: true });
    params.approval.then(finish(resolve), finish(reject));
  });
}

function rejectOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(describeAbortReason(signal.reason)));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(signal.reason instanceof Error
      ? signal.reason
      : new Error(describeAbortReason(signal.reason)));

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(finishResolve, finishReject);
  });
}

function resolveCanonicalAgentToolRisk(
  toolName: string,
  args: Record<string, unknown>,
  approvalRequiredReason: string | null,
): FridayMutatingActionRisk {
  if (toolName === "exec" && typeof args.command === "string") {
    const shellRisk = classifyShellRisk(args.command).level;
    if (shellRisk === "blocked" || shellRisk === "destructive") return "critical";
    if (shellRisk === "guarded") return "medium";
  }

  if (approvalRequiredReason) {
    return "high";
  }

  if (toolName === "system" || toolName === "desktop" || toolName === "browser") {
    return "medium";
  }

  return "medium";
}

function buildCanonicalAgentToolGateRequest(input: {
  toolUse: FridayAgentToolUseBlock;
  runId: string;
  principalId?: string;
  surface?: string;
  isMutating: boolean;
  approvalRequiredReason: string | null;
}): FridayMutatingActionRequest {
  const actorId = input.principalId ?? "agent-runtime";
  const toolInput = input.toolUse.name === "system"
    ? sanitizeCanonicalSystemToolInput(input.toolUse.input)
    : input.toolUse.input;
  const localClaims = input.approvalRequiredReason
    ? [{
        guardId: "agent-tool-risk",
        decision: "requires_approval" as const,
        risk: "high" as const,
        reason: input.approvalRequiredReason,
      }]
    : [];

  if (input.toolUse.name === "system") {
    return createFridaySystemIntentMutatingActionRequest(
      {
        ...toolInput,
        actorId,
        actorKind: "agent",
        idempotencyKey: `${input.runId}:${input.toolUse.id}`,
      },
      {
        surface: "system",
        defaultActorKind: "agent",
        defaultActorId: actorId,
        localClaims,
      },
    );
  }

  return {
    action: `agent.tool.${input.toolUse.name}`,
    actor: {
      kind: "agent",
      id: actorId,
      principalId: actorId,
    },
    surface: input.surface ?? "agent",
    resource: {
      type: "agent_tool",
      id: input.toolUse.name,
    },
    mutating: input.isMutating,
    risk: resolveCanonicalAgentToolRisk(
      input.toolUse.name,
      toolInput,
      input.approvalRequiredReason,
    ),
    parameters: toolInput,
    idempotencyKey: `${input.runId}:${input.toolUse.id}`,
    localClaims,
  };
}

function attachCanonicalApprovalToToolUse(
  toolUse: FridayAgentToolUseBlock,
  approval: FridayCanonicalApprovalResolution,
  canonicalActorId: string,
  idempotencyKey: string | undefined,
): FridayAgentToolUseBlock {
  if (toolUse.name !== "system") {
    return toolUse;
  }

  const safeInput = sanitizeCanonicalSystemToolInput(toolUse.input);
  return {
    ...toolUse,
    input: {
      ...safeInput,
      canonicalActorId,
      canonicalActorKind: "agent",
      ...(idempotencyKey ? { idempotencyKey } : {}),
      canonicalApproval: approval,
    },
  };
}

function redactCanonicalApprovalForAudit(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const approval = value as Partial<FridayCanonicalApprovalResolution>;
  return {
    redacted: true,
    decision: approval.decision,
    approvalId: approval.approvalId,
    actionDigest: approval.actionDigest,
    issuer: approval.issuer,
  };
}

function redactToolInputForAudit(input: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(input, "canonicalApproval")) {
    return input;
  }

  return {
    ...input,
    canonicalApproval: redactCanonicalApprovalForAudit(input.canonicalApproval),
  };
}

function sanitizeCanonicalSystemToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const key of [
    "action",
    "target",
    "targetKind",
    "appIdentifier",
    "windowId",
    "url",
    "projectPath",
    "query",
    "value",
    "notificationId",
    "notificationAction",
    "deviceId",
    "reason",
    "force",
    "leaseTtlMs",
    "layout",
  ]) {
    if (input[key] !== undefined) {
      sanitized[key] = input[key];
    }
  }
  return sanitized;
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
    selfFixService,
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
    starterSkillRouting,
    compactionBridge,
    compactionContextReplaySink,
  } = deps;
  const canonicalMutatingActionGate = deps.canonicalMutatingActionGate === true
    ? createFridayMutatingActionGate({
        nowIso,
        ticketIdGenerator: () => idGenerator(),
        approvalSignatureSecret: deps.canonicalApprovalSecret,
        requireApprovalSignature: true,
      })
    : null;

  // Clone the tools array so registerTool does not mutate the caller's array.
  const tools = [...depsTools];

  const repo = createFridayAgentRunRepository();
  const toolMap = new Map<string, FridayAgentToolDefinition>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  // ─── Per-run event sequence counter ───
  const runSeqCounters = new Map<string, number>();
  const droppedEventCounters = new Map<string, number>();

  // ─── Per-run file checkpoints (GAP 8) ───
  const runCheckpoints = new Map<string, FridayRunCheckpoint>();

  function loadRunCheckpoint(runId: string): FridayRunCheckpoint | undefined {
    const existing = runCheckpoints.get(runId);
    if (existing) {
      return existing;
    }
    if (!deps.workdir) {
      return undefined;
    }
    const recovered = createFridayRunCheckpoint({
      runId,
      stateDir: deps.workdir,
      db,
      nowIso,
    });
    if (recovered.size === 0) {
      return undefined;
    }
    runCheckpoints.set(runId, recovered);
    return recovered;
  }

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
      let seq = nextSeq(runId);
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
        // On UNIQUE constraint violation (seq collision), refresh from DB and retry once
        if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
          try {
            const existingEvents = db.withReadConnection((reader) =>
              runEventRepository!.list(reader, runId),
            );
            const recoveredSeq = (existingEvents.at(-1)?.seq ?? 0) + 1;
            runSeqCounters.set(runId, recoveredSeq);
            seq = recoveredSeq;
            db.withWriteTransaction((writer) =>
              runEventRepository!.append(writer, {
                eventId: idGenerator(),
                runId,
                seq,
                eventName,
                payload,
                emittedAt: now,
                createdAt: now,
              }),
            );
          } catch (retryErr) {
            droppedEventCounters.set(runId, (droppedEventCounters.get(runId) ?? 0) + 1);
            console.warn("[friday][agent-runtime] event-persist-retry:", retryErr instanceof Error ? retryErr.message : String(retryErr));
          }
        } else {
          // Non-fatal: event persistence failure should not kill the run
          droppedEventCounters.set(runId, (droppedEventCounters.get(runId) ?? 0) + 1);
          console.warn("[friday][agent-runtime] event-persist:", err instanceof Error ? err.message : String(err));
        }
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

    rollbackRun(targetRunId: string) {
      const checkpoint = loadRunCheckpoint(targetRunId);
      if (!checkpoint || checkpoint.size === 0) return null;
      const result = checkpoint.rollback();
      return result;
    },

    hasRollbackCheckpoint(targetRunId: string) {
      const checkpoint = loadRunCheckpoint(targetRunId);
      return Boolean(checkpoint && checkpoint.entries().some((entry) => entry.rollbackAvailable));
    },

    emitRunEvent,

    async executeRun(params) {
      // ─── TS Runtime Retirement: METHOD-level fail-closed guard ───
      // Phase 3b reconciliation: the agent-run retirement was ROUTE-only
      // (POST /v1/agent/runs and POST /v1/sessions/:sessionKey/run). Every
      // non-route caller reaches this method directly via
      // `agentRuntime.executeRun(...)` / child `executeChildRun`, bypassing the
      // HTTP route guards: heartbeat runner, channel entry adapter, cron
      // dynamic-job runner, autonomous engine, planning gate, subagent child
      // runtime, and the agent-sessions tool. Guarding here fails ALL non-route
      // callers closed BEFORE any DB read, run-row creation, provider call, or
      // tool call — unless the explicit test-oracle flag is set. Never default
      // this flag on in production.
      if (deps.allowTestOnlyAgentRunExecution !== true) {
        void params;
        throw new FridayDomainError(
          "TS_RUNTIME_AGENT_RUN_RETIRED",
          "Agent run execution is fail-closed while runtime ownership is being moved out of TypeScript.",
          {
            httpStatus: 503,
            details: {
              classification: "fail_closed",
              replacement: "rust_owned_agent_run_entrypoint_required",
            },
          },
        );
      }
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
      const publicIsolatedRun = isPublicIsolatedRun(constraints);
      const privateActiveMemoryContext = !publicIsolatedRun
        && shouldInjectPrivateActiveMemoryContext(executionContext);
      const runMetadata = buildFridayAgentRunMetadata({
        executionContext,
        updatedAt: nowIso(),
        apiRequestIdempotency: params.apiRequestIdempotency,
        disabledToolNames: params.disabledToolNames,
      });
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
          case "agent.run.fixing":
            currentPhase = "fixing";
            activeToolName = undefined;
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
      let progressTimer: ReturnType<typeof setInterval> | undefined;

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
            metadata: runMetadata,
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
      if (privateActiveMemoryContext && learningContextBuilder && principalId) {
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
      const baseRunTools = [...toolMap.values()];
      const runToolMap = new Map(toolMap);
      const toolRouting = resolveFridayAgentToolRouting({
        task: params.task,
        tools: baseRunTools,
        disabledToolNames,
        images: params.images,
        conversationContext,
        executionContext,
      });
      const effectiveToolRouting = publicIsolatedRun
        ? {
          ...toolRouting,
          workspaceContextPolicy: "skip" as const,
        }
        : toolRouting;
      const requestedToolPacks = new Set<string>();
      const requestedToolNames = new Set<string>();
      const toolPackRequestTool = toolRouting.profile !== "trivial" && toolRouting.deferredToolNames.length > 0
        ? createFridayAgentToolPackRequestTool({
            availableTools: baseRunTools,
            disabledToolNames,
            onRequest: (request) => {
              requestedToolPacks.add(request.pack);
              handleTrackedEvent("agent.run.tool_pack_requested", {
                runId,
                pack: request.pack,
                loadedToolNames: request.loadedToolNames,
                reason: request.reason,
              });
            },
          })
        : undefined;
      const toolSearchTool = toolRouting.profile !== "trivial" && toolRouting.deferredToolNames.length > 0
        ? createFridayAgentToolSearchTool({
            availableTools: baseRunTools,
            deferredToolNames: toolRouting.deferredToolNames,
            disabledToolNames,
            onSearch: (request) => {
              for (const toolName of request.loadedToolNames) {
                requestedToolNames.add(toolName);
              }
              handleTrackedEvent("agent.run.tool_search_requested", {
                runId,
                queryKind: request.query.trim().toLowerCase().startsWith("select:") ? "select" : "keyword",
                queryLength: request.query.length,
                loadedToolNames: request.loadedToolNames,
                matchCount: request.matches.length,
              });
            },
          })
        : undefined;
      if (toolPackRequestTool) {
        runToolMap.set(toolPackRequestTool.name, toolPackRequestTool);
      }
      if (toolSearchTool) {
        runToolMap.set(toolSearchTool.name, toolSearchTool);
      }
      const buildVisibleToolNames = (): string[] => {
        const visible = new Set(toolRouting.selectedToolNames);
        for (const toolName of resolveFridayAgentToolNamesForPacks(
          requestedToolPacks,
          baseRunTools,
          disabledToolNames,
        )) {
          visible.add(toolName);
        }
        for (const toolName of requestedToolNames) {
          visible.add(toolName);
        }
        if (toolPackRequestTool) {
          visible.add(toolPackRequestTool.name);
        }
        if (toolSearchTool) {
          visible.add(toolSearchTool.name);
        }
        return [...visible].filter((toolName) => runToolMap.has(toolName));
      };
      const buildVisibleLlmTools = (): FridayAgentToolDefinition[] => {
        const visibleNames = new Set(buildVisibleToolNames());
        const visibleTools = tools.filter((tool) => visibleNames.has(tool.name));
        if (toolPackRequestTool && visibleNames.has(toolPackRequestTool.name)) {
          visibleTools.push(toolPackRequestTool);
        }
        if (toolSearchTool && visibleNames.has(toolSearchTool.name)) {
          visibleTools.push(toolSearchTool);
        }
        return visibleTools;
      };
      const buildDeferredToolHints = (): Array<{ name: string; description: string }> => {
        const deferred = new Set(toolRouting.deferredToolNames);
        return baseRunTools
          .filter((tool) => deferred.has(tool.name) && !(disabledToolNames.has(tool.name)))
          .slice(0, 12)
          .map((tool) => ({
            name: tool.name,
            description: tool.description.replace(/\s+/gu, " ").trim().slice(0, 180),
          }));
      };
      latestContextCostSummary = buildAgentToolRoutingContextCostSummary({
        toolNames: buildVisibleToolNames(),
        toolRouting: effectiveToolRouting,
      });
      const timeSensitiveNewsRequested = !isAutonomousInternalReasoningSurface(params.executionContext?.surface)
        && hasTimeSensitiveNewsIntent(params.task, messages);
      const allToolCalls: FridayAgentToolCallRecord[] = [];
      let toolErrorRecoveryCount = 0;
      const TOOL_ERROR_RECOVERY_MAX = 2;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let responseText = "";
      let latestNonEmptyAssistantText = "";
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
        const messageEstimatedChars =
          params.task.length
          + messages.reduce((sum, message) => {
            if (typeof message.content === "string") {
              return sum + message.content.length;
            }
            return sum + JSON.stringify(message.content).length;
          }, 0);
        const contextEstimatedChars = latestContextCostSummary?.totalEstimatedChars ?? 0;
        const estimatedChars = messageEstimatedChars + contextEstimatedChars;
        const estimatedInputTokens =
          estimateAgentContextInputTokens(messageEstimatedChars)
          + (latestContextCostSummary?.totalEstimatedInputTokens ?? 0);
        const complexity = resolvedTaskProfile.id === "planning" || resolvedTaskProfile.id === "review"
          ? "complex"
          : estimatedChars < 1200
            ? "simple"
            : "medium";
        return {
          estimatedInputTokens: Math.max(1, estimatedInputTokens),
          complexity,
          requiresNativeTools: inferFridayTaskRequiresNativeTools({
            task: params.task,
            historyMessages: messages,
            readOnly: isReadOnly,
          }),
          taskProfileId: resolvedTaskProfile.id,
          contextWindowTokens: constraints?.contextWindowTokens,
          dataSensitivity: constraints?.dataSensitivity,
          latencyBudgetMs: constraints?.latencyBudgetMs,
          localOnly: constraints?.localOnly,
          noEgress: constraints?.noEgress,
          satelliteAvailable: constraints?.satelliteAvailable,
          ...(params.images && params.images.length > 0
            ? { requiredCapabilities: ["vision"] }
            : {}),
        };
      };

      const summarizeBlockedTools = (): FridayAgentActualExecution["blockedTools"] => {
        const blocked = allToolCalls
          .filter((record) => record.result.isError && (
            record.result.routeId === "agent.execute.tool.guard"
            || record.result.routeId === "agent.execute.tool.policy"
            || record.result.routeId === "agent.execute.tool.readonly"
            || record.result.routeId === "agent.execute.tool.mode"
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
      }): { artifactDir?: string; artifacts: FridayAgentArtifact[]; persistFailed: boolean } => {
        let artifactDir: string | undefined;
        let writtenArtifacts = input.artifacts;
        if (!artifactWriter) {
          // No artifact writer configured: there is no durable-receipt requirement
          // to satisfy, so this is not an evidence-durability failure.
          return { artifactDir, artifacts: writtenArtifacts, persistFailed: false };
        }

        let persistFailed = false;
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
          persistFailed = true;
          console.warn(
            `[friday][W-AG-ARTIFACT-WRITE-001] Failed to persist run artifacts for run ${runId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }

        return { artifactDir, artifacts: writtenArtifacts, persistFailed };
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
        progressTimer = setInterval(() => {
          emitProgressEvent();
        }, 15_000);

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
              ...(conversationContext.turnFrame
                ? { turnFrame: conversationContext.turnFrame }
                : {}),
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
            disabledToolNames: [...disabledToolNames],
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
            const sanitizedTerminalResponseText = sanitizeCustomPackResponseText(
              responseText,
              executionContext,
            );
            const terminalStatus = delegated.outcome.status;
            const sanitizedDelegatedErrorText = sanitizeCustomPackResponseText(
              childRunRecord?.errorMessage?.trim() ?? "",
              executionContext,
            ).trim();
            const terminalResponse = terminalStatus === "failed"
              ? sanitizedDelegatedErrorText || buildDelegatedExecutionFallbackMessage({
                status: terminalStatus,
                task: params.task,
              })
              : sanitizedTerminalResponseText.trim().length > 0
                ? sanitizedTerminalResponseText
                : buildDelegatedExecutionFallbackMessage({
                  status: terminalStatus,
                  task: params.task,
                });
            const summaryText = deriveSummary(terminalResponse);
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
              await mirrorAssistantResponse(terminalResponse, allToolCalls);

              handleTrackedEvent("agent.run.completed", {
                runId,
                durationMs,
                toolCallCount: delegatedToolCallCount,
                testsPassed: latestTestResults.every((result) => result.passed),
                artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
              });

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
        const initialPromptToolNames = buildVisibleToolNames();
        const promptBuildResult = systemPromptBuilder
          ? await Promise.resolve(systemPromptBuilder({
            userId: principalId,
            toolNames: initialPromptToolNames,
            nowIso: runTimeContext.nowIso,
            timezone: runTimeContext.timezone,
            localDate: runTimeContext.localDate,
            task: params.task,
            executionContext,
            conversationContext,
            promptProfile: effectiveToolRouting.promptProfile,
            contextPolicy: {
              workspaceContext: effectiveToolRouting.workspaceContextPolicy,
            },
            toolRouting: effectiveToolRouting,
            deferredToolHints: buildDeferredToolHints(),
          }))
          : (staticSystemPrompt ?? "You are an AI assistant.");
        const baseSystemPrompt = typeof promptBuildResult === "string"
          ? promptBuildResult
          : promptBuildResult.prompt;
        latestContextCostSummary = typeof promptBuildResult === "string"
          ? latestContextCostSummary
          : promptBuildResult.contextCostSummary ?? latestContextCostSummary;

        let effectiveSystemPrompt = baseSystemPrompt;
        const skipSupplementalContext = toolRouting.promptProfile === "minimal";
        if (!skipSupplementalContext && privateActiveMemoryContext && deps.compactionContextBuilder && params.sessionKey) {
          try {
            const loadedContext = normalizeCompactionContextBuildResult(await deps.compactionContextBuilder({
              userId: principalId,
              sessionKey: params.sessionKey,
              nowIso: nowIso(),
            }));
            if (loadedContext) {
              const fragment = loadedContext.fragment.trim();
              effectiveSystemPrompt += `\n\n${fragment}`;
              latestContextCostSummary = withAgentContextCostComponent(latestContextCostSummary, {
                kind: "context_replay",
                estimatedChars: fragment.length,
                estimatedInputTokens: estimateAgentContextInputTokens(fragment.length),
                count: loadedContext.blockCount ?? loadedContext.sources?.length ?? 1,
                metadata: {
                  sourceCount: loadedContext.sources?.length ?? 0,
                  evidenceTier: loadedContext.evidenceTier ?? "audit_replay_evidence",
                  trustLevel: loadedContext.trustLevel ?? "unconfirmed_summary",
                  memoryBoundary: loadedContext.memoryBoundary ?? "not_user_confirmed_memory",
                  redactionApplied: loadedContext.redactionApplied ?? false,
                  redactionCount: loadedContext.redactionCount ?? 0,
                },
              });
              handleTrackedEvent("agent.run.context_replay_loaded", {
                runId,
                sessionKey: loadedContext.sessionKey ?? params.sessionKey,
                evidenceTier: loadedContext.evidenceTier ?? "audit_replay_evidence",
                trustLevel: loadedContext.trustLevel ?? "unconfirmed_summary",
                source: loadedContext.source ?? "context_replay",
                sourceCount: loadedContext.sources?.length ?? 0,
                blockCount: loadedContext.blockCount ?? 0,
                fragmentCharCount: fragment.length,
                memoryBoundary: loadedContext.memoryBoundary ?? "not_user_confirmed_memory",
                redactionApplied: loadedContext.redactionApplied ?? false,
                redactionCount: loadedContext.redactionCount ?? 0,
                replayEntryIds: loadedContext.replayEntryIds ?? [],
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/sqlite read pool is closed/i.test(message)) {
              console.warn("[friday][agent-runtime] compaction-context:", message);
            }
          }
        }
        if (privateActiveMemoryContext && communicationPromptBuilder && principalId) {
          try {
            const fragment = await communicationPromptBuilder({ userId: principalId, nowIso: nowIso() });
            if (fragment && fragment.trim().length > 0) {
              effectiveSystemPrompt += `\n\n${fragment.trim()}`;
            }
          } catch (err) {
            // Non-fatal: persona enrichment failure should not kill the run
            console.warn("[friday][agent-runtime] persona-enrichment:", err instanceof Error ? err.message : String(err));
          }
        }

        // ── Inject learned lessons (GAP 5) ──
        if (!skipSupplementalContext && deps.learnedLessons) {
          try {
            const lessons = deps.learnedLessons();
            if (lessons.length > 0) {
              const recentLessons = lessons.slice(0, 5);
              const lessonBlock = recentLessons
                .map((l, i) => `${i + 1}. **${l.title}**: ${l.cause} → Fix: ${l.fix}`)
                .join("\n");
              effectiveSystemPrompt +=
                "\n\n<learned-lessons>\nLessons from past runs (avoid repeating these mistakes):\n" +
                lessonBlock +
                "\n</learned-lessons>";
            }
          } catch (err) {
            console.warn("[friday][agent-runtime] learned-lessons:", err instanceof Error ? err.message : String(err));
          }
        }

        // ── Disclose disabled tools so the LLM does not waste turns calling them ──
        if (disabledToolNames.size > 0) {
          effectiveSystemPrompt +=
            "\n\nNote: The following tools are disabled for this run and will fail if called: " +
            [...disabledToolNames].join(", ") +
            ". Do not attempt to use them.";
        }

        // ─── Degradation assessment ───
        // Only assess degradation when tools were configured but some are unavailable.
        // Skip when no tools were registered at all (e.g. minimal/test configurations).
        const degradationLevel = toolRouting.promptProfile === "minimal"
          ? "nominal" as const
          : depsTools.length > 0 ? assessDegradation(baseRunTools) : "nominal" as const;
        // Track which configured tools are actually unavailable at runtime.
        const unavailableToolNames = degradationLevel !== "nominal"
          ? depsTools.filter((t) => !toolMap.has(t.name)).map((t) => t.name)
          : [];
        if (degradationLevel !== "nominal") {
          effectiveSystemPrompt += "\n\n[Degradation Notice] " + getDegradationSystemPrompt(degradationLevel);
          eventEmitter.emit("agent.run.degraded", {
            runId,
            level: degradationLevel,
            unavailableTools: unavailableToolNames,
            reason: `Tool availability assessed as ${degradationLevel}`,
          });
        }

        // ─── Operational mode suffix ───
        // Start from explicit constraint, then auto-restrict on severe degradation
        // only when tools are genuinely missing (not just a minimal test config).
        let runOperationalMode: FridayOperationalMode | undefined = constraints?.operationalMode as FridayOperationalMode | undefined;
        if (
          !runOperationalMode &&
          unavailableToolNames.length > 0 &&
          (degradationLevel === "minimal" || degradationLevel === "conversational")
        ) {
          runOperationalMode = "restricted";
          eventEmitter.emit("agent.run.mode_changed", {
            runId,
            previousMode: "execute" as FridayOperationalMode,
            newMode: "restricted" as FridayOperationalMode,
            reason: `Auto-restricted due to degradation level: ${degradationLevel}`,
          });
        }
        if (runOperationalMode && runOperationalMode !== "execute") {
          eventEmitter.emit("agent.run.mode_changed", {
            runId,
            previousMode: "execute" as FridayOperationalMode,
            newMode: runOperationalMode,
            reason: `Operational mode set to ${runOperationalMode}`,
          });
        }
        if (runOperationalMode) {
          const modeConfig = FRIDAY_MODE_CONFIGS[runOperationalMode];
          if (modeConfig?.systemPromptSuffix) {
            effectiveSystemPrompt += `\n\n[Operational Mode] ${modeConfig.systemPromptSuffix}`;
          }
        }

        // ─── Compact deferred tool discovery hint ───
        if (toolPackRequestTool && toolRouting.deferredToolNames.length > 0) {
          effectiveSystemPrompt +=
            "\n\nAdditional Friday tools can be discovered on demand with tool_search, and broader packs can be loaded with request_tool_pack. " +
            "Use one of these before telling the user a browser, desktop, provider/setup, workflow, skill, memory, media, or autonomy capability is missing.";
        }

        let iterations = 0;
        let evidenceEnforcementRetries = 0;
        let feedbackPersistenceRetries = 0;
        let memorySearchEnforcementRetries = 0;
        let memoryRecallAlignmentRetries = 0;
        let timelinessEnforcementRetries = 0;
        let customPackResponseRetries = 0;
        let answerAlignmentRetries = 0;
        let desktopInspectionRetries = 0;
        let artifactTruthRetries = 0;
        let starterSkillRoutingRetries = 0;
        let llmConsecutiveFailures = 0;
        let llmDegraded = false;
        let latestLlmFailureMessage: string | undefined;
        let selfFixAttempt = 0;
        const fileVersionTracker = createFridayFileVersionTracker();
        const runCheckpoint = deps.workdir
          ? createFridayRunCheckpoint({ runId, stateDir: deps.workdir, db, nowIso })
          : undefined;
        if (runCheckpoint) {
          runCheckpoints.set(runId, runCheckpoint);
        }
        selfFixService?.reset();

        selfFixRetryLoop:
        while (true) {
        while (iterations < FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
          if (runAbortController.signal.aborted) {
            break;
          }

          iterations++;

          // ── Context compaction: layered retention ──
          // When the provider bridge is available and the feature flag is on,
          // use semantic block-level compaction (scoring, structured extraction,
          // optional LLM summarization).  Falls back to the legacy one-line
          // text compaction on any error.
          if (FRIDAY_AGENT_COMPACTION_USE_PROVIDER && compactionBridge && shouldAttemptSemanticCompaction(messages)) {
            try {
              handleTrackedEvent("agent.run.compaction_attempted", {
                runId,
                messageCount: messages.length,
              });
              const bridgeResult = await compactionBridge.compact({
                messages,
                systemPrompt: effectiveSystemPrompt,
                task: params.task,
                // Use an agent-loop soft budget instead of the provider's theoretical max window.
                // This keeps long tool/read chains from overflowing before compaction can help.
                contextWindowTokens: FRIDAY_AGENT_COMPACTION_SOFT_WINDOW_TOKENS,
              });
              handleTrackedEvent("agent.run.compaction_result", {
                runId,
                compacted: bridgeResult.compacted,
                summaryPresent: Boolean(bridgeResult.summary),
                blockCount: bridgeResult.blocks?.length ?? 0,
                droppedMessageCount: bridgeResult.droppedMessageCount,
                estimatedTokensBefore: bridgeResult.estimatedTokensBefore,
                estimatedTokensAfter: bridgeResult.estimatedTokensAfter,
              });
              if (bridgeResult.compacted) {
                messages.splice(0, messages.length, ...bridgeResult.messages);

                // Non-blocking: persist structured summary as unconfirmed context replay evidence.
                if (compactionContextReplaySink && bridgeResult.summary) {
                  handleTrackedEvent("agent.run.compaction_persist_scheduled", {
                    runId,
                    sessionKey: params.sessionKey ?? runId,
                    summaryPresent: true,
                    blockCount: bridgeResult.blocks?.length ?? 0,
                    droppedMessageCount: bridgeResult.droppedMessageCount,
                  });
                  void compactionContextReplaySink.persist({
                    sessionKey: params.sessionKey ?? runId,
                    runId,
                    summary: bridgeResult.summary,
                    blocks: bridgeResult.blocks,
                    compactedAt: nowIso(),
                  }).then((result) => {
                    if (result.persisted) {
                      handleTrackedEvent("agent.run.compaction_persisted", {
                        runId,
                        sessionKey: result.sessionKey,
                        entryId: result.entryId,
                        evidenceTier: result.evidenceTier,
                        trustLevel: result.trustLevel,
                        blockCount: result.blockCount,
                        redactionApplied: result.redactionApplied,
                        redactionCount: result.redactionCount,
                      });
                      return;
                    }
                    handleTrackedEvent("agent.run.compaction_persist_skipped", {
                      runId,
                      sessionKey: result.sessionKey,
                      skippedReason: result.skippedReason,
                      evidenceTier: result.evidenceTier,
                      trustLevel: result.trustLevel,
                      blockCount: result.blockCount,
                    });
                  }).catch((err: unknown) => {
                    handleTrackedEvent("agent.run.compaction_persist_failed", {
                      runId,
                      sessionKey: params.sessionKey ?? runId,
                      errorName: err instanceof Error ? err.name : "Error",
                      evidenceTier: "audit_replay_evidence",
                      trustLevel: "unconfirmed_summary",
                    });
                  });
                }
              }
            } catch {
              handleTrackedEvent("agent.run.compaction_failed", { runId });
              // Graceful degradation: fall through to legacy compaction
              const preCompactionLen = messages.length;
              const compacted = compactMessagesIfNeeded(
                messages,
                FRIDAY_AGENT_COMPACTION_THRESHOLD,
                FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
              );
              if (compacted.length < preCompactionLen) {
                messages.splice(0, messages.length, ...compacted);
              }
            }
          } else {
            // Legacy path: simple text-based compaction (Plan C)
            const preCompactionLen = messages.length;
            const compacted = compactMessagesIfNeeded(
              messages,
              FRIDAY_AGENT_COMPACTION_THRESHOLD,
              FRIDAY_AGENT_COMPACTION_KEEP_RECENT,
            );
            if (compacted.length < preCompactionLen) {
              messages.splice(0, messages.length, ...compacted);
            }
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

            // Filter tools based on operational mode so the LLM only sees allowed tools
            const routedTools = buildVisibleLlmTools();
            const llmTools = shouldHideToolsFromLlm({
              executionContext,
              operationalMode: runOperationalMode,
            })
              ? []
              : runOperationalMode && runOperationalMode !== "execute"
                ? filterToolsByMode(routedTools, runOperationalMode)
                : routedTools;

            try {
              streamResult = await rejectOnAbort(
                streamLlmResponse({
                  llmClient,
                  providerId: requestedProviderId,
                  tenantContext: params.tenantContext,
                  model: resolvedTaskProfile.model ?? requestedModel ?? "default",
                  systemPrompt: effectiveSystemPrompt,
                  messages,
                  tools: llmTools,
                  temperature: resolvedTaskProfile.temperature,
                  routingContext: estimateRoutingContext(),
                  signal: turnTimeoutController.signal,
                  eventEmitter,
                  runId,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                }),
                turnTimeoutController.signal,
              );
              // Reset consecutive failure counter on success
              llmConsecutiveFailures = 0;
            } catch (llmError) {
              // If the run itself was cancelled, don't attempt graceful degradation
              if (runAbortController.signal.aborted) {
                throw llmError;
              }

              llmConsecutiveFailures++;

              // First failure: degrade gracefully — switch to restricted mode and synthesize a response
              if (llmConsecutiveFailures <= 1) {
                const llmErrorMsg = llmError instanceof Error ? llmError.message : String(llmError);
                latestLlmFailureMessage = llmErrorMsg;
                console.warn("[friday][agent-runtime] LLM call failed, degrading gracefully: %s", llmErrorMsg);

                if (runOperationalMode !== "restricted") {
                  const previousMode = runOperationalMode ?? "execute";
                  runOperationalMode = "restricted";
                  handleTrackedEvent("agent.run.mode_changed", {
                    runId,
                    previousMode: previousMode as FridayOperationalMode,
                    newMode: "restricted" as FridayOperationalMode,
                    reason: `Auto-restricted after LLM provider error: ${llmErrorMsg}`,
                  });
                }

                handleTrackedEvent("agent.run.degraded", {
                  runId,
                  level: "conversational",
                  unavailableTools: baseRunTools.map((t) => t.name),
                  message: `LLM provider temporarily unavailable: ${llmErrorMsg}`,
                });

                // Synthesize a minimal response so the user sees a message, but mark the run as degraded
                // so it will be recorded as failed (not completed)
                llmDegraded = true;
                const degradedText = hasCjkText(params.task)
                  ? "AI 服务暂时无法连接。请稍后重试，或告诉我你希望如何继续。"
                  : "I'm experiencing a temporary connection issue with my AI service. " +
                    "Please try again in a moment, or let me know how you'd like to proceed.";
                streamResult = {
                  assistantText: degradedText,
                  toolUseBlocks: [],
                  inputTokens: 0,
                  outputTokens: 0,
                  turnMeta: undefined,
                };
                // Continue without re-throwing — the loop will end naturally since there are no tool_use blocks
              } else {
                // Second consecutive failure: let the outer catch handle it as a terminal failure
                throw llmError;
              }
            } finally {
              clearTimeout(turnTimeout);
              runAbortController.signal.removeEventListener("abort", onParentAbort);
            }
          }
          const { assistantText, toolUseBlocks, inputTokens, outputTokens, turnMeta } = streamResult;
          if (assistantText.trim().length > 0) {
            latestNonEmptyAssistantText = assistantText;
          }

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
                cacheReadInputTokens: turnMeta.cacheReadInputTokens,
                cacheCreationInputTokens: turnMeta.cacheCreationInputTokens,
                // Bind the provider's request-id when the turn surfaced one so the
                // usage write is idempotent + receipt-backed. Omitted entirely when
                // absent, preserving the prior (request-id-less) call shape.
                ...(turnMeta.requestId ? { requestId: turnMeta.requestId } : {}),
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
            const starterSkillCandidate = starterSkillRouting?.enabled
              ? findFridayStarterSkillRoutingCandidate({
                task: params.task,
                skills: starterSkillRouting.skills,
              })
              : null;
            if (
              starterSkillCandidate
              && !hasFridayStarterSkillRoutingEvidence(allToolCalls)
              && starterSkillRoutingRetries < 1
            ) {
              starterSkillRoutingRetries++;
              messages.push({
                role: "user",
                content: buildFridayStarterSkillRoutingRetryPrompt({
                  task: params.task,
                  candidate: starterSkillCandidate,
                }),
              });
              continue;
            }

            const baseAssistantResponse = assistantText.trim().length > 0
              ? assistantText
              : latestNonEmptyAssistantText;
            let candidateResponse = enforceToolEvidenceForCompletionClaim(
              baseAssistantResponse,
              allToolCalls,
            );
            candidateResponse = enforceFeedbackPersistenceEvidence(
              candidateResponse,
              allToolCalls,
            );

            if (
              candidateResponse.trim().length > 0 &&
              feedbackPersistenceRetries < 1 &&
              shouldEnforceFeedbackPersistenceForTask({
                task: params.task,
                toolMap,
                toolCalls: allToolCalls,
                disabledToolNames,
              })
            ) {
              feedbackPersistenceRetries++;
              messages.push({
                role: "user",
                content: buildFeedbackPersistenceRetryPrompt({
                  task: params.task,
                }),
              });
              continue;
            }

            if (
              candidateResponse.trim().length > 0 &&
              evidenceEnforcementRetries < 2 &&
              shouldEnforceToolEvidenceForTask({
                task: params.task,
                responseText: candidateResponse,
                toolMap,
                toolCalls: allToolCalls,
                disabledToolNames,
                executionSurface: params.executionContext?.surface,
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

            if (
              candidateResponse.trim().length > 0
              && memorySearchEnforcementRetries < 1
              && shouldEnforceMemorySearchForTask({
                task: params.task,
                responseText: candidateResponse,
                toolMap,
                toolCalls: allToolCalls,
                disabledToolNames,
              })
            ) {
              memorySearchEnforcementRetries++;
              messages.push({
                role: "user",
                content: buildMemorySearchRetryPrompt({
                  task: params.task,
                }),
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
            const customPackRetryPrompt = buildCustomPackInternalDetailsRetryPrompt({
              task: params.task,
              responseText: alignedResponse,
              executionContext,
            });
            if (
              customPackRetryPrompt
              && alignedResponse.trim().length > 0
              && customPackResponseRetries < 2
            ) {
              customPackResponseRetries++;
              messages.push({
                role: "user",
                content: customPackRetryPrompt,
              });
              continue;
            }
            const sanitizedAlignedResponse = sanitizeCustomPackResponseText(
              alignedResponse,
              executionContext,
            );
            const memoryRecallAlignmentDecision = evaluateMemoryRecallAnswerAlignment({
              task: params.task,
              responseText: sanitizedAlignedResponse,
              toolCalls: allToolCalls,
            });
            if (
              memoryRecallAlignmentDecision.retryPrompt
              && sanitizedAlignedResponse.trim().length > 0
              && memoryRecallAlignmentRetries < 1
            ) {
              memoryRecallAlignmentRetries++;
              messages.push({
                role: "user",
                content: memoryRecallAlignmentDecision.retryPrompt,
              });
              continue;
            }

            if (shouldAttemptDeterministicMemoryRecallFallback({
              task: params.task,
              responseText: alignedResponse,
              toolMap,
              toolCalls: allToolCalls,
              disabledToolNames,
            })) {
              const requestedFields = getRequestedMemoryRecallFields(params.task);
              const resolvedFields = new Set(
                collectMemoryRecallExpectations({
                  task: params.task,
                  toolCalls: allToolCalls,
                }).map((expectation) => expectation.field),
              );
              const fallbackSearchFields = !hasSuccessfulMemorySearchEvidence(allToolCalls)
                ? requestedFields
                : requestedFields.filter((field) => !resolvedFields.has(field));

              for (const field of fallbackSearchFields) {
                const fallbackMemorySearchRecord = await executeToolCall({
                  toolUse: {
                    type: "tool_use",
                    id: `auto-memory-recall-${idGenerator()}`,
                    name: "memory_search",
                    input: {
                      query: memoryRecallFieldQuery(field),
                      namespace: "user",
                      limit: 1,
                    },
                  },
                  toolMap: runToolMap,
                  signal: runAbortController.signal,
                  runId,
                  sessionKey,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                  timezone: runTimeContext.timezone,
                  taskPrompt: llmTask,
                  conversationContext,
                  principalId,
                  tenantContext: params.tenantContext,
                  requestedProviderId,
                  requestedModel: resolvedTaskProfile.model ?? requestedModel,
                  executionContext,
                  fileVersionTracker,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                });
                allToolCalls.push(fallbackMemorySearchRecord);
              }

              const fallbackResponse = buildDeterministicMemoryRecallFallbackResponse({
                task: params.task,
                toolCalls: allToolCalls,
              });
              if (fallbackResponse) {
                responseText = fallbackResponse;
                break;
              }
            }

            if (
              taskRequiresReadOnlyDesktopInspection(params.task)
              && hasDesktopContentInspectionCoverageEvidence(allToolCalls)
              && sanitizedAlignedResponse.trim().length > 0
              && !responseAddressesDesktopContentInspection(sanitizedAlignedResponse)
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
              responseText: sanitizedAlignedResponse,
              historyMessages: normalizeHistoryMessages(params.historyMessages),
              conversationContext,
            });
            const maxAnswerAlignmentRetries = hasAnchoredAssistantFact ? 2 : 1;
            if (
              alignmentDecision.retryPrompt &&
              sanitizedAlignedResponse.trim().length > 0 &&
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
              && sanitizedAlignedResponse.trim().length > 0
              && hasAnchoredAssistantFact
            ) {
              const anchoredFallback = buildReplyAnchorFallbackResponse({
                task: params.task,
                conversationContext,
              });
              if (anchoredFallback) {
                const sanitizedAnchoredFallback = sanitizeCustomPackResponseText(
                  anchoredFallback,
                  executionContext,
                );
                const artifactTruthGap = detectArtifactTruthGap({
                  task: params.task,
                  responseText: sanitizedAnchoredFallback,
                  toolCalls: allToolCalls,
                });
                if (artifactTruthGap && (artifactTruthGap.retryable ?? true) && artifactTruthRetries < 2) {
                  artifactTruthRetries++;
                  messages.push({
                    role: "user",
                    content: buildArtifactTruthRetryPrompt(artifactTruthGap),
                  });
                  continue;
                }

                responseText = sanitizedAnchoredFallback;
                break;
              }
            }

            const artifactTruthGap = detectArtifactTruthGap({
              task: params.task,
              responseText: sanitizedAlignedResponse,
              toolCalls: allToolCalls,
            });
            if (
              artifactTruthGap
              && (artifactTruthGap.retryable ?? true)
              && sanitizedAlignedResponse.trim().length > 0
              && artifactTruthRetries < 2
            ) {
              artifactTruthRetries++;
              messages.push({
                role: "user",
                content: buildArtifactTruthRetryPrompt(artifactTruthGap),
              });
              continue;
            }

            responseText = sanitizedAlignedResponse.trim().length > 0
              ? sanitizedAlignedResponse
              : latestNonEmptyAssistantText;
            break;
          }

          // 6. Execute tool calls and build tool_result blocks
          const toolResultBlocks: FridayAgentToolResultBlock[] = [];
          const toolCallRecordsByIndex = new Map<number, FridayAgentToolCallRecord>();
          const executableToolUses: Array<{ index: number; toolUse: FridayAgentToolUseBlock }> = [];
          let autoStartedSkillGenerationThisTurn = false;
          const hasSkillGenerateTool = baseRunTools.some((tool) => tool.name === "skill_generate");
          const skillGenerationTask = isSkillGenerationTask(params.task);
          const explicitAutonomousTask = shouldEnforceExplicitAutonomousTaskRouting(
            params.task,
            runOperationalMode,
            params.executionContext,
          );
          if (skillGenerationTask && process.env.FRIDAY_DEBUG_SKILL_GENERATION === "true") {
            console.warn("[friday][agent-runtime] skill-generation-toolset", {
              runId,
              hasSkillGenerateTool,
              activeSkillTools: baseRunTools
                .map((tool) => tool.name)
                .filter((name) => name.includes("skill")),
              disabledToolNames: [...disabledToolNames].filter((name) => name.includes("skill")),
              operationalMode: runOperationalMode ?? "execute",
            });
          }

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
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            const localWorkspaceFileIntentViolation = toolCallViolatesLocalWorkspaceFileIntent({
              task: params.task,
              toolName: toolUse.name,
              toolArgs: toolUse.input ?? {},
            });
            if (localWorkspaceFileIntentViolation) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.local_workspace_file",
                correlationId: runId,
                errorCode: "WRONG_TOOL_FOR_TASK",
                message: localWorkspaceFileIntentViolation,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            const execBoundaryIntentViolation = toolCallViolatesExecBoundaryIntent({
              task: params.task,
              toolName: toolUse.name,
            });
            if (execBoundaryIntentViolation) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.exec_boundary",
                correlationId: runId,
                errorCode: "WRONG_TOOL_FOR_TASK",
                message: execBoundaryIntentViolation,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            if (explicitAutonomousTask && isAutonomousTaskBypassTool(toolUse.name)) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.guard",
                correlationId: runId,
                errorCode: "WRONG_TOOL_FOR_TASK",
                message: buildAutonomousWrongToolMessage(toolUse.name, params.task),
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            const misroutedSkillGenerationAlias =
              toolUse.name === "skill_run" && isSkillGenerationAlias(toolUse.input?.skillId);
            const manualSkillAuthoringAttempt =
              (toolUse.name === "write" || toolUse.name === "edit")
              && isRuntimeSkillAuthoringPath(toolUse.input);

            if (
              hasSkillGenerateTool
              && skillGenerationTask
              && !autoStartedSkillGenerationThisTurn
              && (misroutedSkillGenerationAlias || manualSkillAuthoringAttempt)
            ) {
                autoStartedSkillGenerationThisTurn = true;
                executableToolUses.push({
                  index: toolIndex,
                  toolUse: {
                    ...toolUse,
                    name: "skill_generate",
                    input: {
                      action: "start",
                      goal: params.task,
                    },
                  },
                });
                continue;
            }

            if (misroutedSkillGenerationAlias) {
              const requestedSkillId = typeof toolUse.input?.skillId === "string"
                ? toolUse.input.skillId
                : "unknown";
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.guard",
                correlationId: runId,
                errorCode: "WRONG_TOOL_FOR_TASK",
                message: `Skill generation requests must use tool 'skill_generate', not skill_run on '${requestedSkillId}'. Start skill_generate with action=\"start\", continue with generate/approve to stage a candidate, then use the skill lifecycle shadow/canary/promote path before attempting to run it.`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            if (manualSkillAuthoringAttempt && hasSkillGenerateTool && skillGenerationTask) {
              const targetPath = resolveToolPathArg(toolUse.input) ?? "managed-skills";
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.guard",
                correlationId: runId,
                errorCode: "WRONG_TOOL_FOR_TASK",
                message: `Skill authoring requests must use tool 'skill_generate', not manual ${toolUse.name} calls against '${targetPath}'. Continue through skill_generate generate/approve to stage a candidate, then complete skill lifecycle promotion before execution.`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
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
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                }));
                continue;
              }
            }

            // ─── Operational mode tool guard ───
            if (runOperationalMode && runOperationalMode !== "execute") {
              const toolCategory = resolveToolCategory(toolUse.name);
              const allowedCategories = new Set(FRIDAY_MODE_CONFIGS[runOperationalMode].enabledToolCategories);
              if (!allowedCategories.has(toolCategory)) {
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.mode",
                  correlationId: runId,
                  errorCode: "TOOL_UNAVAILABLE",
                  message: `Tool '${toolUse.name}' blocked: not available in ${runOperationalMode} mode`,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                }));
                continue;
              }
            }

            const toolCallIsMutating = isMutatingToolCall(toolUse.name, toolUse.input);

            if (isReadOnly && toolCallIsMutating) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.readonly",
                correlationId: runId,
                message: `Tool '${toolUse.name}' blocked: run has readOnly constraint`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            const policyDeniedReason = getPolicyDeniedReasonForToolCall(
              params.task,
              toolUse.name,
              toolUse.input,
            );
            if (policyDeniedReason) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.policy",
                correlationId: runId,
                message: `Tool '${toolUse.name}' denied by policy. ${policyDeniedReason}`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
              }));
              continue;
            }

            // PolicyExtensionChain gate: extensions run AFTER core policy gates, so they
            // only ever see core-allowed tools and can only tighten (deny), never loosen.
            // On deny we must remove the tool from execution (not merely emit telemetry):
            // synthesize a typed denied record and `continue` so the tool is never pushed
            // to executableToolUses and therefore never executes (SEC-POLICY-DENY-ZERO).
            const policyExtensions: PolicyExtension[] = deps.policyExtensions ?? [];
            if (policyExtensions.length > 0) {
              const policyResult = evaluatePolicyExtensionChain(
                "allow",
                policyExtensions,
                { principalId: principalId ?? "system", resource: "tool", action: "execute", resourceId: toolUse.name },
              );
              if (policyResult.decision === "deny") {
                handleTrackedEvent("agent.run.capability_grant_denied", {
                  runId,
                  grantId: `policy-deny-${toolUse.id}`,
                  toolCallId: toolUse.id,
                  toolName: toolUse.name,
                  reason: `Policy extension "${policyResult.decidedBy ?? "unknown"}" denied tool execution`,
                  principalId,
                  sessionKey,
                });
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.policy_extension",
                  correlationId: runId,
                  message: `Tool '${toolUse.name}' denied by policy extension "${policyResult.decidedBy ?? "unknown"}".`,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                }));
                continue;
              }
            }

            const approvalRequiredReason = getApprovalRequiredReasonForToolCall(toolUse.name, toolUse.input);
            if (toolCallIsMutating && !canonicalMutatingActionGate) {
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.canonical_gate",
                correlationId: runId,
                message: `Tool '${toolUse.name}' blocked: canonical mutating action gate is required for mutating tool calls`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
                approvalRequiredReason: approvalRequiredReason ?? "Canonical mutating action gate is required for mutating tool calls.",
                guardrailDecision: "block",
              }));
              continue;
            }
            if (canonicalMutatingActionGate) {
              const gateRequest = buildCanonicalAgentToolGateRequest({
                toolUse,
                runId,
                principalId,
                surface: executionContext?.surface,
                isMutating: toolCallIsMutating,
                approvalRequiredReason,
              });
              const gateResult = canonicalMutatingActionGate.evaluate(gateRequest);
              if (gateResult.decision === "deny") {
                handleTrackedEvent("agent.run.capability_grant_denied", {
                  runId,
                  grantId: `canonical-deny-${toolUse.id}`,
                  toolCallId: toolUse.id,
                  toolName: toolUse.name,
                  reason: gateResult.reason,
                  deniedBy: gateResult.deniedBy,
                  actionDigest: gateResult.actionDigest,
                  riskLevel: gateResult.risk,
                  principalId,
                  sessionKey,
                });
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.canonical_gate",
                  correlationId: runId,
                  message: `Tool '${toolUse.name}' denied by canonical gate. ${gateResult.reason}`,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                }));
                continue;
              }

              if (gateResult.decision === "requires_approval") {
                const grantId = `capgrant:${runId}:${toolUse.id}`;
                const expiresAt = new Date(Date.parse(nowIso()) + 15 * 60 * 1000).toISOString();
                const approvalScopes = scopes ?? [];
                const reason = approvalRequiredReason
                  ?? `Canonical approval required for ${gateRequest.action}`;
                if (deps.toolApprovalResolver) {
                  handleTrackedEvent("agent.run.awaiting_tool_approval", {
                    runId,
                    status: "awaiting_tool_approval" as const,
                    grantId,
                    toolName: toolUse.name,
                    toolCallId: toolUse.id,
                    params: redactToolInputForAudit(toolUse.input),
                    reason,
                    expiresAt,
                    actionDigest: gateResult.actionDigest,
                    riskLevel: gateResult.risk,
                    canonicalAction: gateRequest.action,
                    guardrail: buildFridayAgentToolPreGuardrailEvidence({
                      toolCallId: toolUse.id,
                      toolName: toolUse.name,
                      toolInput: redactToolInputForAudit(toolUse.input),
                      mutating: toolCallIsMutating,
                      readOnly: isReadOnly,
                      operationalMode: runOperationalMode,
                      approvalRequiredReason: reason,
                      decision: "requires_approval",
                      routeId: "agent.execute.tool.canonical_gate",
                      correlationId: runId,
                      checks: ["canonical_mutating_action_gate"],
                    }),
                    ...(principalId ? { principalId } : {}),
                    ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                    ...(sessionKey ? { sessionKey } : {}),
                    ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                  });
                  const decision = await awaitToolApprovalDecision({
                    approval: deps.toolApprovalResolver({
                      runId,
                      ...(sessionKey ? { sessionKey } : {}),
                      ...(principalId ? { principalId } : {}),
                      ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                      ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                      grantId,
                      expiresAt,
                      toolName: toolUse.name,
                      toolCallId: toolUse.id,
                      params: redactToolInputForAudit(toolUse.input),
                      reason,
                      canonicalActionDigest: gateResult.actionDigest,
                      canonicalAction: gateRequest.action,
                      canonicalRisk: gateResult.risk,
                      canonicalMutating: gateRequest.mutating,
                      canonicalResourceType: gateRequest.resource.type,
                      canonicalResourceId: gateRequest.resource.id,
                    }),
                    signal: runAbortController.signal,
                  });
                  if (runAbortController.signal.aborted) {
                    break;
                  }
                  if (decision.approved && !decision.decidedByPrincipalId) {
                    toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                      toolUse,
                      runId,
                      nowIso,
                      emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                      routeId: "agent.execute.tool.canonical_gate",
                      correlationId: runId,
                      message: `Tool '${toolUse.name}' rejected by canonical gate. approver principal is required`,
                      readOnly: isReadOnly,
                      operationalMode: runOperationalMode,
                      approvalRequiredReason: reason,
                    }));
                    continue;
                  }
                  const unsignedCanonicalApproval: FridayCanonicalApprovalResolution = {
                    decision: decision.approved ? "approved" : "denied",
                    approvalId: grantId,
                    decidedByPrincipalId: decision.decidedByPrincipalId ?? principalId ?? "operator",
                    actionDigest: gateResult.actionDigest,
                    ...(decision.reason ? { reason: decision.reason } : {}),
                    expiresAt,
                  };
                  const canonicalApproval = decision.approved && deps.canonicalApprovalSecret
                    ? signFridayCanonicalApproval(unsignedCanonicalApproval, deps.canonicalApprovalSecret)
                    : unsignedCanonicalApproval;
                  const approvedGateResult = canonicalMutatingActionGate.evaluate({
                    ...gateRequest,
                    canonicalApproval,
                  });
                  if (approvedGateResult.decision === "allow" && approvedGateResult.ticket) {
                    handleTrackedEvent("agent.run.capability_grant_used", {
                      runId,
                      grantId,
                      toolCallId: toolUse.id,
                      toolName: toolUse.name,
                      actionDigest: approvedGateResult.actionDigest,
                      ticketId: approvedGateResult.ticket.ticketId,
                      riskLevel: approvedGateResult.risk,
                      ...(principalId ? { principalId } : {}),
                      ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                      ...(sessionKey ? { sessionKey } : {}),
                      ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                    });
                    executableToolUses.push({
                      index: toolIndex,
                      toolUse: attachCanonicalApprovalToToolUse(
                        toolUse,
                        canonicalApproval,
                        gateRequest.actor.id,
                        gateRequest.idempotencyKey,
                      ),
                    });
                    continue;
                  }
                  toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                    toolUse,
                    runId,
                    nowIso,
                    emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                    routeId: "agent.execute.tool.canonical_gate",
                    correlationId: runId,
                    message: `Tool '${toolUse.name}' rejected by canonical gate. ${approvedGateResult.reason}`,
                    readOnly: isReadOnly,
                    operationalMode: runOperationalMode,
                    approvalRequiredReason: reason,
                  }));
                  continue;
                }
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.canonical_gate",
                  correlationId: runId,
                  message: `Tool '${toolUse.name}' blocked pending canonical approval. ${reason}`,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                  approvalRequiredReason: reason,
                  guardrailDecision: "requires_approval",
                }));
                continue;
              }

              executableToolUses.push({ index: toolIndex, toolUse });
              continue;
            }

            if (approvalRequiredReason) {
              const grantId = `capgrant:${runId}:${toolUse.id}`;
              const expiresAt = new Date(Date.parse(nowIso()) + 15 * 60 * 1000).toISOString();
              const approvalScopes = scopes ?? [];
              if (deps.toolApprovalResolver) {
                const shellRisk = toolUse.name === "exec" && typeof toolUse.input?.command === "string"
                  ? classifyShellRisk(toolUse.input.command as string).level
                  : undefined;
                // Pause and ask the user for approval via the resolver callback.
                handleTrackedEvent("agent.run.awaiting_tool_approval", {
                  runId,
                  status: "awaiting_tool_approval" as const,
                  grantId,
                  toolName: toolUse.name,
                  toolCallId: toolUse.id,
                  params: redactToolInputForAudit(toolUse.input),
                  reason: approvalRequiredReason,
                  expiresAt,
                  ...(shellRisk ? { riskLevel: shellRisk } : {}),
                  guardrail: buildFridayAgentToolPreGuardrailEvidence({
                    toolCallId: toolUse.id,
                    toolName: toolUse.name,
                    toolInput: redactToolInputForAudit(toolUse.input),
                    mutating: toolCallIsMutating,
                    readOnly: isReadOnly,
                    operationalMode: runOperationalMode,
                    approvalRequiredReason,
                    decision: "requires_approval",
                    routeId: "agent.execute.tool.approval_required",
                    correlationId: runId,
                    checks: ["tool_approval_gate"],
                  }),
                  ...(principalId ? { principalId } : {}),
                  ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                  ...(sessionKey ? { sessionKey } : {}),
                  ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                });
                const decision = await awaitToolApprovalDecision({
                  approval: deps.toolApprovalResolver({
                    runId,
                    ...(sessionKey ? { sessionKey } : {}),
                    ...(principalId ? { principalId } : {}),
                    ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                    ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                    grantId,
                    expiresAt,
                    toolName: toolUse.name,
                    toolCallId: toolUse.id,
                    params: redactToolInputForAudit(toolUse.input),
                    reason: approvalRequiredReason,
                  }),
                  signal: runAbortController.signal,
                });
                if (runAbortController.signal.aborted) {
                  break;
                }
                if (decision.approved) {
                  handleTrackedEvent("agent.run.capability_grant_used", {
                    runId,
                    grantId,
                    toolCallId: toolUse.id,
                    toolName: toolUse.name,
                    ...(principalId ? { principalId } : {}),
                    ...(approvalScopes.length > 0 ? { scopes: approvalScopes } : {}),
                    ...(sessionKey ? { sessionKey } : {}),
                    ...(executionContext?.surface ? { surface: executionContext.surface } : {}),
                  });
                  executableToolUses.push({ index: toolIndex, toolUse });
                  continue;
                }
                // User rejected — block with their reason
                toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                  toolUse,
                  runId,
                  nowIso,
                  emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                  routeId: "agent.execute.tool.approval_required",
                  correlationId: runId,
                  message: `Tool '${toolUse.name}' rejected by user. ${decision.reason ?? approvalRequiredReason}`,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                  approvalRequiredReason,
                }));
                continue;
              }
              // No resolver — block immediately (backwards-compatible default)
              toolCallRecordsByIndex.set(toolIndex, emitImmediateToolCallResult({
                toolUse,
                runId,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
                routeId: "agent.execute.tool.approval_required",
                correlationId: runId,
                message: `Tool '${toolUse.name}' blocked pending approval. ${approvalRequiredReason}`,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
                approvalRequiredReason,
                guardrailDecision: "requires_approval",
              }));
              continue;
            }

            executableToolUses.push({ index: toolIndex, toolUse });
          }

          if (executableToolUses.length > 0 && !runAbortController.signal.aborted) {
            // GAP 8: Snapshot files before mutating tool calls for rollback safety
            if (runCheckpoint) {
              const WRITE_TOOLS = new Set(["write", "edit", "file_write", "file_delete"]);
              for (const { toolUse } of executableToolUses) {
                if (WRITE_TOOLS.has(toolUse.name)) {
                  const filePath = typeof toolUse.input?.file_path === "string"
                    ? toolUse.input.file_path
                    : typeof toolUse.input?.path === "string"
                      ? toolUse.input.path
                      : undefined;
                  if (filePath) {
                    try { runCheckpoint.snapshotBeforeWrite(filePath); } catch { /* best-effort */ }
                  }
                }
              }
            }
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
                  toolMap: runToolMap,
                  signal: runAbortController.signal,
                  runId,
                  sessionKey,
                  readOnly: isReadOnly,
                  operationalMode: runOperationalMode,
                  timezone: runTimeContext.timezone,
                  taskPrompt: llmTask,
                  conversationContext,
                  principalId,
                  tenantContext: params.tenantContext,
                  requestedProviderId,
                  requestedModel: resolvedTaskProfile.model ?? requestedModel,
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

          if (hasSkillGenerateTool && skillGenerationTask) {
            const iterationRecords = [...toolCallRecordsByIndex.values()];
            const executedSkillGenerateThisIteration = iterationRecords.some((record) =>
              record.toolName === "skill_generate" && !record.result.isError);
            const onlySkillsListThisIteration = iterationRecords.length > 0
              && iterationRecords.every((record) => record.toolName === "skills_list");
            if (!executedSkillGenerateThisIteration && onlySkillsListThisIteration) {
              const autoSkillGenerateUse: FridayAgentToolUseBlock = {
                type: "tool_use",
                id: `auto-skill-generate-start-${idGenerator()}`,
                name: "skill_generate",
                input: {
                  action: "start",
                  goal: params.task,
                },
              };
              const autoSkillGenerateRecord = await executeToolCall({
                toolUse: autoSkillGenerateUse,
                toolMap: runToolMap,
                signal: runAbortController.signal,
                runId,
                sessionKey,
                readOnly: isReadOnly,
                operationalMode: runOperationalMode,
                timezone: runTimeContext.timezone,
                taskPrompt: llmTask,
                conversationContext,
                principalId,
                tenantContext: params.tenantContext,
                requestedProviderId,
                requestedModel: resolvedTaskProfile.model ?? requestedModel,
                executionContext,
                fileVersionTracker,
                nowIso,
                emitRunEvent: (name, payload) => handleTrackedEvent(name, payload),
              });
              allToolCalls.push(autoSkillGenerateRecord);
              toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: autoSkillGenerateUse.id,
                content: autoSkillGenerateRecord.result.content,
                is_error: autoSkillGenerateRecord.result.isError,
              });
            }
          }

          const missingWorkspaceFileResponse = buildMissingWorkspaceFileUnverifiedResponse({
            task: params.task,
            toolCalls: allToolCalls,
          });
          if (missingWorkspaceFileResponse) {
            responseText = missingWorkspaceFileResponse;
            break;
          }

          const outsideWorkspaceExecBoundaryResponse = buildOutsideWorkspaceExecBoundaryUnverifiedResponse({
            task: params.task,
            toolCalls: allToolCalls,
          });
          if (outsideWorkspaceExecBoundaryResponse) {
            responseText = outsideWorkspaceExecBoundaryResponse;
            break;
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

          // 7b. Tool error recovery: inject mandatory retry hint for recoverable errors.
          // This forces the LLM to attempt alternatives instead of immediately reporting failure.
          if (toolErrorRecoveryCount < TOOL_ERROR_RECOVERY_MAX) {
            const iterationStartIndex = allToolCalls.length - toolResultBlocks.length;
            const currentErrors: ToolErrorContext[] = [];
            for (let i = Math.max(0, iterationStartIndex); i < allToolCalls.length; i++) {
              const call = allToolCalls[i];
              if (call?.result.isError) {
                currentErrors.push({
                  toolName: call.toolName,
                  errorContent: call.result.content,
                  errorCode: call.result.errorCode,
                  args: call.args,
                });
              }
            }
            if (currentErrors.length > 0) {
              const hint = buildToolErrorRecoveryHint(currentErrors);
              if (hint) {
                toolErrorRecoveryCount++;
                messages.push({ role: "user", content: hint.text });
              }
            }
          }

          // Tool outputs require another model turn so the assistant can synthesize
          // a final answer from the newly appended tool_result messages.
          if (iterations >= FRIDAY_AGENT_MAX_LOOP_ITERATIONS) {
            throw new FridayDomainError(
              FRIDAY_AGENT_ERROR_CODES.LOOP_LIMIT,
              `Agent exceeded maximum loop iterations (${String(FRIDAY_AGENT_MAX_LOOP_ITERATIONS)})`,
              { httpStatus: 500 },
            );
          }
          if (allToolCalls.length >= FRIDAY_AGENT_MAX_TOOL_CALLS) {
            throw new FridayDomainError(
              FRIDAY_AGENT_ERROR_CODES.TOOL_CALL_LIMIT,
              `Agent exceeded maximum tool calls (${String(FRIDAY_AGENT_MAX_TOOL_CALLS)})`,
              { httpStatus: 500 },
            );
          }
          continue;
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
          const cancelMessage = runAbortController.signal.reason instanceof Error
            ? runAbortController.signal.reason.message
            : "Agent run cancelled";
          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "cancelled",
              completedAt: nowIso(),
              durationMs,
              actualExecution: buildActualExecution({
                finalFailureReason: "Agent run cancelled",
              }),
              responseText: responseText || cancelMessage,
              summary: deriveSummary(responseText || cancelMessage) || undefined,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
            }),
          );

          handleTrackedEvent("agent.run.cancelled", { runId, reason: cancelMessage });

          return await finalizeResult({
            runId,
            status: "cancelled",
            response: responseText || cancelMessage,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
            summary: deriveSummary(responseText || cancelMessage),
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
            const selfFixDecision = selfFixService?.evaluate({
              testResults,
              task: params.task,
              attempt: selfFixAttempt,
              maxAttempts,
            });
            if (selfFixDecision?.shouldRetry && selfFixDecision.fixPrompt) {
              selfFixAttempt++;
              iterations = 0;
              responseText = "";
              latestNonEmptyAssistantText = "";
              latestTestResults = testResults;
              const fixingMessage = selfFixDecision.reason
                ?? `Validation failed; retrying with self-fix attempt ${String(selfFixAttempt)} of ${String(maxAttempts - 1)}`;
              db.withWriteTransaction((writer) =>
                repo.update(writer, {
                  id: runId,
                  status: "fixing",
                  attempt: selfFixAttempt,
                  usageInput: totalInputTokens,
                  usageOutput: totalOutputTokens,
                  costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
                  actualExecution: buildActualExecution({
                    finalFailureReason: "Validation criteria not met; self-fix retry scheduled",
                  }),
                  testResults: testResults as unknown as FridayAgentTestResult[],
                  artifacts: collectedArtifacts,
                  responseText: undefined,
                  contextCostSummary: latestContextCostSummary,
                  taskProfile: resolvedTaskProfile,
                }),
              );
              handleTrackedEvent("agent.run.fixing", {
                runId,
                attempt: selfFixAttempt,
                maxAttempts,
                message: fixingMessage,
                failures: testResults
                  .filter((result) => !result.passed)
                  .map((result) => ({
                    strategy: result.strategy,
                    errors: result.errors.map((error) => ({
                      message: error.message,
                      severity: error.severity,
                      file: error.file,
                      line: error.line,
                    })),
                  })),
                routeId: "agent.execute.run.self_fix",
                correlationId: runCorrelationId,
              });
              messages.push({
                role: "user",
                content: selfFixDecision.fixPrompt,
              });
              continue selfFixRetryLoop;
            }

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
          executionSurface: params.executionContext?.surface,
        }) ?? detectArtifactTruthGap({
          task: params.task,
          responseText,
          toolCalls: allToolCalls,
        }) ?? detectSideEffectEvidenceGap({
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
        responseText = sanitizeCustomPackResponseText(responseText, executionContext);
        const summaryText = deriveSummary(responseText);

        // 8. Finalize — success or degraded-as-failed
        let finalStatus: "completed" | "failed" = llmDegraded ? "failed" : "completed";
        const durationMs = Date.now() - startedAt;
        const completedAt = nowIso();
        const persistedArtifacts = persistRunArtifacts({
          status: finalStatus,
          response: responseText,
          durationMs,
          completedAt,
          testResults,
          artifacts: collectedArtifacts,
          costUsd: latestCostUsd,
        });

        // ─── Evidence durability (locked decision: fail closed) ───
        // If this run produced a side-effect completion claim or a successful
        // mutating tool call, its durable replay receipt MUST persist. If the
        // artifact write failed, the run cannot be a clean `completed` proof —
        // downgrade to failed so we never report success without durable evidence.
        const runRequiresDurableEvidence =
          !llmDegraded
          && (responseClaimsSideEffectCompleted(responseText)
            || allToolCalls.some(
              (call) => !call.result.isError && isMutatingToolCall(call.toolName, call.args),
            ));
        const evidenceDurabilityFailClosed =
          finalStatus === "completed"
          && persistedArtifacts.persistFailed
          && runRequiresDurableEvidence;
        if (evidenceDurabilityFailClosed) {
          finalStatus = "failed";
        }
        const durabilityErrorMessage =
          `${FRIDAY_AGENT_ERROR_CODES.EVIDENCE_DURABILITY_ERROR}: evidence-bearing run could not persist its `
          + "durable replay receipt (artifact write failed); failing closed — not a clean completed proof.";
        // On fail-closed, surface the honest durability outcome to the user
        // instead of the model's (now-unverifiable) completion text.
        const reportedResponse = evidenceDurabilityFailClosed
          ? "I completed the work but could not save a durable, verifiable record of it, so I am not reporting "
            + "this as a verified completion. Please retry; if this persists, check storage space/permissions. "
            + `(${FRIDAY_AGENT_ERROR_CODES.EVIDENCE_DURABILITY_ERROR})`
          : responseText;
        const reportedSummary = evidenceDurabilityFailClosed
          ? deriveSummary(reportedResponse)
          : summaryText;

        db.withWriteTransaction((writer) =>
          repo.update(writer, {
            id: runId,
            status: finalStatus,
            completedAt,
            durationMs,
            ...(llmDegraded
              ? {
                  errorCode: FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
                  errorMessage: latestLlmFailureMessage
                    ?? "LLM provider temporarily unavailable — run degraded with synthetic response",
                }
              : evidenceDurabilityFailClosed
                ? {
                    errorCode: FRIDAY_AGENT_ERROR_CODES.EVIDENCE_DURABILITY_ERROR,
                    errorMessage: durabilityErrorMessage,
                  }
                : {}),
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
            actualExecution: llmDegraded
              ? buildActualExecution({
                  finalFailureReason: latestLlmFailureMessage,
                })
              : evidenceDurabilityFailClosed
                ? buildActualExecution({ finalFailureReason: durabilityErrorMessage })
                : actualExecution,
            testResults: testResults as unknown as FridayAgentTestResult[],
            artifacts: persistedArtifacts.artifacts,
            responseText: reportedResponse || undefined,
            summary: reportedSummary || undefined,
            artifactDir: persistedArtifacts.artifactDir,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
          }),
        );

        await mirrorAssistantResponse(reportedResponse, allToolCalls);

        if (finalStatus === "failed") {
          handleTrackedEvent("agent.run.failed", {
            runId,
            error: llmDegraded
              ? {
                  code: FRIDAY_AGENT_ERROR_CODES.LLM_ERROR,
                  message: latestLlmFailureMessage
                    ?? "LLM provider temporarily unavailable — run degraded with synthetic response",
                }
              : {
                  code: FRIDAY_AGENT_ERROR_CODES.EVIDENCE_DURABILITY_ERROR,
                  message: durabilityErrorMessage,
                },
            durationMs,
            routeId: llmDegraded
              ? "agent.execute.run.llm_degraded"
              : "agent.execute.run.evidence_durability",
            correlationId: runCorrelationId,
          });
        } else {
          handleTrackedEvent("agent.run.completed", {
            runId,
            durationMs,
            toolCallCount: allToolCalls.length,
            testsPassed,
            artifacts: persistedArtifacts.artifacts.map((a) => ({ type: a.type, path: a.path })),
          });
        }

        return await finalizeResult({
          runId,
          status: finalStatus,
          response: reportedResponse,
          toolCallCount: allToolCalls.length,
          durationMs,
          usageInput: totalInputTokens,
          usageOutput: totalOutputTokens,
          contextCostSummary: latestContextCostSummary,
          taskProfile: resolvedTaskProfile,
          images: extractedImages.length > 0 ? extractedImages : undefined,
          summary: reportedSummary || undefined,
          artifactDir: persistedArtifacts.artifactDir,
        });
        }
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (runAbortController.signal.aborted) {
          const completedAt = nowIso();
          const cancelMessage = runAbortController.signal.reason instanceof Error
            ? runAbortController.signal.reason.message
            : "Agent run cancelled";
          responseText = sanitizeCustomPackResponseText(responseText, executionContext);
          latestActualExecution = latestActualExecution ?? buildActualExecution({
            finalFailureReason: "Agent run cancelled",
          });
          const persistedArtifacts = persistRunArtifacts({
            status: "cancelled",
            response: responseText || cancelMessage,
            durationMs,
            completedAt,
            testResults: latestTestResults,
            artifacts: latestArtifacts.length > 0 ? latestArtifacts : deriveArtifactsFromToolCalls(allToolCalls),
            costUsd: latestCostUsd,
          });

          db.withWriteTransaction((writer) =>
            repo.update(writer, {
              id: runId,
              status: "cancelled",
              completedAt,
              durationMs,
              usageInput: totalInputTokens,
              usageOutput: totalOutputTokens,
              costUsd: latestCostUsd,
              actualExecution: latestActualExecution,
              testResults: latestTestResults,
              artifacts: persistedArtifacts.artifacts,
              responseText: responseText || cancelMessage,
              summary: deriveSummary(responseText || cancelMessage) || undefined,
              artifactDir: persistedArtifacts.artifactDir,
              contextCostSummary: latestContextCostSummary,
              taskProfile: resolvedTaskProfile,
            }),
          );

          handleTrackedEvent("agent.run.cancelled", {
            runId,
            reason: cancelMessage,
          });
          await mirrorAssistantResponse(responseText || cancelMessage, allToolCalls);

          return await finalizeResult({
            runId,
            status: "cancelled",
            response: responseText || cancelMessage,
            toolCallCount: allToolCalls.length,
            durationMs,
            usageInput: totalInputTokens,
            usageOutput: totalOutputTokens,
            contextCostSummary: latestContextCostSummary,
            taskProfile: resolvedTaskProfile,
            summary: deriveSummary(responseText || cancelMessage) || undefined,
            artifactDir: persistedArtifacts.artifactDir,
          });
        }
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

        responseText = sanitizeCustomPackResponseText(responseText, executionContext);
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
        if (progressTimer) clearInterval(progressTimer);
        eventEmitter.off("agent.subagent.spawned", onSubagentSpawned);
        eventEmitter.off("agent.subagent.completed", onSubagentCompleted);
        const droppedEvents = droppedEventCounters.get(runId) ?? 0;
        if (droppedEvents > 0) {
          console.warn(`[friday][agent-runtime] run ${runId} dropped ${droppedEvents} event(s) due to persistence failures`);
        }
        runSeqCounters.delete(runId);
        droppedEventCounters.delete(runId);
        // Prevent unbounded growth of the per-run checkpoint map on a
        // long-lived hub process (snapshot content is persisted to disk; only
        // this in-memory index entry needs releasing once the run is terminal).
        runCheckpoints.delete(runId);
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

function isSkillGenerationAlias(skillId: unknown): skillId is string {
  return typeof skillId === "string"
    && /(^|[-_\s])(skill[-_\s]?generator|generate[-_\s]?skill|skill[-_\s]?generate)([-_\s]|$)/i.test(skillId.trim());
}

function isSkillGenerationTask(task: string): boolean {
  return /\b(?:generate|create|build)\s+(?:a\s+)?(?:new\s+)?(?:friday\s+)?skill\b|\bskill generator\b/i.test(task);
}

function isExplicitAutonomousExecutionTask(task: string): boolean {
  const normalized = task.trim();
  return /\b(?:must|mandatory|required|explicitly|use|call|invoke|run|start|trigger|launch|resume|continue)\b[\s\S]{0,64}\bautonomous\b/i.test(normalized)
    || /\bautonomous\b[\s\S]{0,64}\b(?:tool|goal|execute_goal|resume_goal|get_goal|list_goals|cancel_goal)\b/i.test(normalized)
    || /(?:必须|务必|强制|调用|使用|运行|启动|恢复).{0,24}autonomous/i.test(normalized)
    || /autonomous.{0,24}(?:工具|目标|goal|execute_goal|resume_goal|get_goal|list_goals|cancel_goal)/i.test(normalized);
}

function isAutonomousInternalReasoningSurface(surface: string | undefined): boolean {
  return typeof surface === "string" && surface.startsWith("autonomous_internal_");
}

function shouldEnforceExplicitAutonomousTaskRouting(
  task: string,
  operationalMode: FridayOperationalMode | undefined,
  executionContext?: FridayAgentExecutionContext,
): boolean {
  // Internal autonomous planning/decision prompts run in plan mode and mention
  // "autonomous" and "goal" as instructions to the model, not as a user
  // request to invoke the autonomous tool directly.
  if (operationalMode === "plan" || isAutonomousInternalReasoningSurface(executionContext?.surface)) {
    return false;
  }
  return isExplicitAutonomousExecutionTask(task);
}

function shouldHideToolsFromLlm(params: {
  executionContext?: FridayAgentExecutionContext;
  operationalMode: FridayOperationalMode | undefined;
}): boolean {
  return params.operationalMode === "plan"
    && isAutonomousInternalReasoningSurface(params.executionContext?.surface);
}

const AUTONOMOUS_ALLOWED_AUX_TOOLS: ReadonlySet<string> = new Set([
  "autonomous",
  "feedback",
  "memory_get",
  "memory_query",
  "memory_search",
  "memory_store",
  "task_status",
  "capabilities",
]);

function isAutonomousTaskBypassTool(toolName: string): boolean {
  return !AUTONOMOUS_ALLOWED_AUX_TOOLS.has(toolName);
}

function inferAutonomousActionHint(task: string): string {
  if (/\bresume_goal\b|\bresume\b[\s\S]{0,24}\bgoal\b/i.test(task)) {
    return "resume_goal";
  }
  if (/\bcancel_goal\b|\b(cancel|stop)\b[\s\S]{0,24}\bgoal\b/i.test(task)) {
    return "cancel_goal";
  }
  if (/\bget_goal\b|\b(check|get|inspect|show)\b[\s\S]{0,24}\bgoal\b/i.test(task)) {
    return "get_goal";
  }
  if (/\blist_goals\b|\b(list|show)\b[\s\S]{0,24}\bgoals\b/i.test(task)) {
    return "list_goals";
  }
  return "execute_goal";
}

function buildAutonomousWrongToolMessage(toolName: string, task: string): string {
  const suggestedAction = inferAutonomousActionHint(task);
  return `This task explicitly requires tool 'autonomous'. Do not use '${toolName}' as a direct bypass. Call autonomous with action="${suggestedAction}" first, then rely on autonomous goal status/result instead of direct browser/desktop/exec/file/system tools.`;
}

function resolveToolPathArg(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const pathArg = typeof input.path === "string"
    ? input.path
    : typeof input.file_path === "string"
      ? input.file_path
      : undefined;
  return pathArg?.trim().length ? pathArg.trim() : undefined;
}

function normalizeLocalWorkspacePathForMatch(pathArg: string): string {
  return pathArg.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function localWorkspacePathMatchesRequested(pathArg: string, requested: string): boolean {
  const normalizedPath = normalizeLocalWorkspacePathForMatch(pathArg);
  const normalizedRequested = normalizeLocalWorkspacePathForMatch(requested);
  const pathBase = basename(normalizedPath);
  if (normalizedRequested.includes("/")) {
    return normalizedPath === normalizedRequested || normalizedPath.endsWith(`/${normalizedRequested}`);
  }
  return normalizedPath === normalizedRequested
    || normalizedPath.endsWith(`/${normalizedRequested}`)
    || pathBase === normalizedRequested;
}

function taskExplicitlyRequiresReadToolForWorkspaceFile(task: string): boolean {
  return taskLooksLikeLocalWorkspaceFileInspection(task)
    && (
      /\bcall\s+the\s+`?read`?\s+tool\b/i.test(task)
      || /\buse\s+the\s+`?read`?\s+tool\b/i.test(task)
      || /\buse\s+`?read`?\s+for\s+the\s+requested\s+workspace\s+path\b/i.test(task)
      || /`read`\s+tool/u.test(task)
    );
}

function taskLooksLikeOutsideWorkspaceExecBoundaryProbe(task: string): boolean {
  const requiresExec =
    /\bcall\s+the\s+`?exec`?\s+tool\b/i.test(task)
    || /\buse\s+the\s+`?exec`?\s+tool\b/i.test(task)
    || /`exec`\s+tool/u.test(task);
  if (!requiresExec) {
    return false;
  }
  return /\boutside\b[\s\S]{0,96}\b(?:workspace|workspace root|allowed workspace root|workspace boundary)\b/i.test(task)
    || /\b(?:workspace|workspace root|allowed workspace root|workspace boundary)\b[\s\S]{0,96}\boutside\b/i.test(task)
    || /(?:工作区|workspace).{0,32}(?:之外|外部|边界外)/iu.test(task);
}

function toolCallViolatesLocalWorkspaceFileIntent(params: {
  task: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): string | null {
  if (!taskExplicitlyRequiresReadToolForWorkspaceFile(params.task)) {
    return null;
  }
  const requestedPath = extractLocalWorkspaceFileMentions(params.task)[0];
  const requestedLabel = requestedPath ?? "the requested workspace file";
  if (params.toolName !== "read") {
    return `This task explicitly requires tool 'read' for local workspace file '${requestedLabel}'. Do not use '${params.toolName}', web, browser, search, capabilities, or tool-pack detours for this workspace file. Call read with path="${requestedLabel}" next.`;
  }

  if (!requestedPath) {
    return null;
  }
  const actualPath = resolveToolPathArg(params.toolArgs);
  if (!actualPath) {
    return `The read tool call is missing the requested local workspace path. Call read with path="${requestedLabel}".`;
  }
  if (!localWorkspacePathMatchesRequested(actualPath, requestedPath)) {
    return `The read tool path '${actualPath}' does not match the requested local workspace file '${requestedLabel}'. Call read with path="${requestedLabel}".`;
  }
  return null;
}

function toolCallViolatesExecBoundaryIntent(params: {
  task: string;
  toolName: string;
}): string | null {
  if (!taskLooksLikeOutsideWorkspaceExecBoundaryProbe(params.task) || params.toolName === "exec") {
    return null;
  }
  return `This task explicitly requires tool 'exec' for an outside-workspace boundary check. Do not use '${params.toolName}', web, browser, search, or file-url detours for this boundary check. Call exec with the requested command next and report the exec boundary result.`;
}

function isRuntimeSkillAuthoringPath(input: Record<string, unknown> | undefined): boolean {
  const pathArg = resolveToolPathArg(input);
  if (!pathArg) return false;
  const normalizedPath = pathArg.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalizedPath.startsWith("managed-skills/")
    || normalizedPath.startsWith("skills/")
    || normalizedPath.includes("/managed-skills/")
    || normalizedPath.includes("/skills/")
    || pathArg.endsWith("skill.manifest.json")
    || pathArg.endsWith("manifest.json")
    || pathArg.endsWith("/SKILL.md")
    || pathArg.endsWith("/run.sh");
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
  retryable?: boolean;
}

// ─── Side-effect completion-truth gate (locked decision: side-effect claims
// require real tool evidence) ───
// The discriminator is the model's COMPLETION CLAIM, not the task text: a run
// may only assert it performed a side-effect (send/post/save/schedule/pay/…) if
// a successful *mutating* tool call backs it. This intentionally does NOT gate
// on task keywords (which saturate benign Q&A like "explain how to send email").

const SIDE_EFFECT_REFUSAL_EN =
  /\b(i (?:can(?:'|no)t|cannot|am unable to|was unable to|won'?t|will not|do(?:n'?t| not) have|couldn'?t|could not|am not able to))\b/i;
const SIDE_EFFECT_REFUSAL_CN = /(无法|不能|没有权限|我不会|尚不支持|暂不支持|抱歉[，,].{0,12}(不能|无法))/u;

const SIDE_EFFECT_COMPLETION_CLAIM_EN =
  /\b(?:i(?:'ve| have)?\s+(?:sent|emailed|e-mailed|messaged|texted|posted|published|shared|scheduled|booked|paid|ordered|submitted|transferred|deleted|removed|cancell?ed|created|added|updated|installed|configured|uploaded|filed|saved|stored|wrote|written|moved|renamed|recorded|set\s+up)\b|(?:your |the )?(?:email|message|payment|order|post|event|booking|file|invite|reservation)\s+(?:has been|was|is now)\s+(?:sent|posted|created|scheduled|booked|made|placed|published|cancell?ed|deleted|saved|uploaded)\b|successfully\s+(?:sent|posted|created|updated|deleted|scheduled|booked|paid|published|installed|configured|submitted|transferred|uploaded|saved))/i;
const SIDE_EFFECT_COMPLETION_CLAIM_CN =
  /(已(?:成功)?(?:发送|发出|发了|发布|分享|预订|安排|支付|付款|下单|提交|转账|删除|移除|取消|创建|新建|更新|安装|配置|上传)|我(?:已(?:经)?)?(?:发送了|发了|发出了|发布了|创建了|新建了|更新了|删除了|取消了|安排好了|安排了|预订了|提交了|支付了|安装了|配置了|上传了))/u;

function responseClaimsSideEffectCompleted(responseText: string): boolean {
  const t = responseText.trim();
  if (t.length === 0) return false;
  // Explicit refusal / inability is not a completion claim.
  if (SIDE_EFFECT_REFUSAL_EN.test(t) || SIDE_EFFECT_REFUSAL_CN.test(t)) return false;
  return SIDE_EFFECT_COMPLETION_CLAIM_EN.test(t) || SIDE_EFFECT_COMPLETION_CLAIM_CN.test(t);
}

function detectSideEffectEvidenceGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (!responseClaimsSideEffectCompleted(params.responseText)) {
    return null;
  }
  // A successful *mutating* tool call is the evidence floor. isMutatingToolCall
  // treats unknown/side-effect tools (message, write, edit, exec, provider, …)
  // as mutating, so a real send/save/mutation satisfies this.
  const hasMutatingEvidence = params.toolCalls.some(
    (call) => !call.result.isError && isMutatingToolCall(call.toolName, call.args),
  );
  if (hasMutatingEvidence) {
    return null;
  }
  const failedCalls = params.toolCalls.filter((call) => call.result.isError);
  const responseSummary = params.responseText.trim().slice(0, 200);
  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "This run claimed a side-effect action (e.g. send/post/save/schedule) was completed, " +
      "but no successful tool action backs that claim, so it cannot be marked completed. " +
      "Retry once the required tool/integration is available, or I can confirm the action is unsupported.",
    developerMessage:
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
      `Side-effect completion claim without successful mutating tool evidence for task "${params.task.slice(0, 120)}": ` +
      `${String(params.toolCalls.length)} tool call(s), 0 successful mutating, ${String(failedCalls.length)} failed. ` +
      `Final response: ${responseSummary}`,
    attemptedImageToolCalls: params.toolCalls.length,
    failedImageToolCalls: failedCalls.length,
    retryable: false,
  };
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
  executionSurface?: string;
}): OutputClosureGap | null {
  if (isAutonomousInternalReasoningSurface(params.executionSurface)) {
    return null;
  }
  const normalizedTask = params.task.trim();
  if (normalizedTask.length === 0) return null;

  const category = classifyEvidenceTask(normalizedTask);
  if (!category) return null;

  if (taskLooksLikeLocalWorkspaceFileInspection(normalizedTask)) {
    const hasReadEvidence = hasSuccessfulLocalWorkspaceReadEvidence(normalizedTask, params.toolCalls);
    const failedReadEvidence = findFailedLocalWorkspaceReadEvidence(normalizedTask, params.toolCalls);
    if (
      !hasReadEvidence
      && taskLooksLikeOutsideWorkspaceExecBoundaryProbe(normalizedTask)
      && hasFailedExecOutsideWorkspaceBoundaryEvidence(params.toolCalls, normalizedTask)
      && responseAcknowledgesWorkspaceFileUnverified(params.responseText)
    ) {
      return null;
    }
    if (
      !hasReadEvidence
      && failedReadEvidence
      && taskAllowsMissingWorkspaceFileRefusal(normalizedTask)
      && responseAcknowledgesWorkspaceFileUnverified(params.responseText)
    ) {
      return null;
    }
    const refusalAfterRead = hasReadEvidence && responseLooksLikeLocalFileAccessRefusal(params.responseText);
    const missingRequestedHeading = hasReadEvidence
      && taskRequestsTopWorkspaceHeading(normalizedTask)
      && !hasSuccessfulLocalWorkspaceReadEvidenceWithHeading(normalizedTask, params.toolCalls);
    if (!hasReadEvidence || refusalAfterRead || missingRequestedHeading) {
      const failedCalls = params.toolCalls.filter((call) => call.result.isError);
      const latestFailure = failedCalls[failedCalls.length - 1];
      const failureDetail = latestFailure?.result.content
        ? latestFailure.result.content.replace(/\s+/g, " ").trim()
        : missingRequestedHeading
        ? "read tool evidence did not include the requested top heading"
        : "no successful read tool evidence for the requested workspace file";
      const closureReason = missingRequestedHeading
        ? "read result did not include the requested top heading"
        : hasReadEvidence
        ? "successful read was followed by a file-access refusal"
        : "no matching successful read tool call";
      return {
        errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
        userMessage:
          "Workspace file task could not be completed with verifiable read evidence. " +
          "Retry after checking the requested path and file tool availability.",
        developerMessage:
          `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
          `Workspace file evidence closure failed for task "${normalizedTask.slice(0, 120)}": ` +
          `${String(params.toolCalls.length)} tool call(s), ` +
          `${closureReason}. ` +
          `Last failure: ${failureDetail}. Final response: ${params.responseText.trim().slice(0, 200)}`,
        attemptedImageToolCalls: params.toolCalls.length,
        failedImageToolCalls: failedCalls.length,
      };
    }
  }

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
        `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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
  return detectUnfulfilledFileMutationGap(params)
    ?? detectRequiredBlockerArtifactGap(params)
    ?? detectApprovalBoundaryArtifactGap(params)
    ?? detectSourceArtifactCompletionGap(params);
}

function detectUnfulfilledFileMutationGap(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): OutputClosureGap | null {
  if (taskRequiresApprovalBoundary(params.task) || !taskRequiresVerifiedFileMutation(params.task)) {
    return null;
  }

  const fileMutationCalls = params.toolCalls.filter((call) =>
    isMutatingToolCall(call.toolName, call.args) && extractFilePaths(call.toolName, call.args).length > 0
  );
  if (fileMutationCalls.length === 0 || fileMutationCalls.some((call) => !call.result.isError)) {
    return null;
  }

  const lastFailure = fileMutationCalls[fileMutationCalls.length - 1];
  const touchedPaths = [...new Set(fileMutationCalls.flatMap((call) => extractFilePaths(call.toolName, call.args)))];
  const failureDetail = lastFailure?.result.content.replace(/\s+/g, " ").trim() ?? "file mutation failed";

  return {
    errorCode: FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR,
    userMessage:
      "Requested file mutation was not completed. The target path was not changed, so this run cannot be marked successful.",
    developerMessage:
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
      `File mutation closure failed for task "${params.task.slice(0, 160)}": ` +
      `all ${String(fileMutationCalls.length)} file mutation tool call(s) failed for ` +
      `${touchedPaths.join(", ")}. Last failure: ${failureDetail}`,
    attemptedImageToolCalls: 0,
    failedImageToolCalls: 0,
    retryable: false,
  };
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
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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
        `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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
      `${FRIDAY_AGENT_ERROR_CODES.OUTPUT_CLOSURE_ERROR}: ` +
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

function taskRequiresVerifiedFileMutation(task: string): boolean {
  if (taskRequestsGuidanceOnly(task)) {
    return false;
  }

  return (
    (
      /\b(write|create|update|edit|modify|delete|remove|rename|move|save|patch|fix)\b/i.test(task)
      && (
        /\b(file|files|folder|directory|repo|repository|workspace|project|path)\b/i.test(task)
        || /\b[\w./-]+\.[A-Za-z0-9]+\b/.test(task)
      )
    )
    || (
      /(写|创建|新建|更新|编辑|修改|删除|移除|重命名|移动|保存|修复)/.test(task)
      && (
        /(文件|目录|文件夹|仓库|项目|工作区|路径)/.test(task)
        || /\b[\w./-]+\.[A-Za-z0-9]+\b/.test(task)
      )
    )
  );
}

function taskRequestsGuidanceOnly(task: string): boolean {
  return /\b(how do i|how to|guide me|walk me through|show me how|step by step|steps?|explain)\b/i.test(task)
    || /(怎么|如何|请指导|一步一步|步骤|解释|说明|教我)/.test(task);
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

function extractLocalWorkspaceFileMentions(task: string): string[] {
  const mentions = new Set<string>();
  const fileMatches = task.match(/\b(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]+\b/giu) ?? [];
  for (const match of fileMatches) {
    mentions.add(stripTrailingPunctuation(match).toLowerCase());
  }
  if (mentions.size === 0 && /\breadme\b/i.test(task)) {
    mentions.add("readme.md");
  }
  return [...mentions];
}

function hasSuccessfulLocalWorkspaceReadEvidence(
  task: string,
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  const requestedFiles = extractLocalWorkspaceFileMentions(task);
  return toolCalls.some((call) => {
    if (call.toolName !== "read" || call.result.isError) {
      return false;
    }
    const rawPath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (rawPath.length === 0) {
      return false;
    }
    if (requestedFiles.length === 0) {
      return true;
    }
    return requestedFiles.some((requested) => {
      return localWorkspacePathMatchesRequested(rawPath, requested);
    });
  });
}

function findFailedLocalWorkspaceReadEvidence(
  task: string,
  toolCalls: FridayAgentToolCallRecord[],
): FridayAgentToolCallRecord | undefined {
  const requestedFiles = extractLocalWorkspaceFileMentions(task);
  return toolCalls.find((call) => {
    if (call.toolName !== "read" || !call.result.isError) {
      return false;
    }
    const rawPath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (rawPath.length === 0) {
      return false;
    }
    if (requestedFiles.length === 0) {
      return true;
    }
    return requestedFiles.some((requested) => localWorkspacePathMatchesRequested(rawPath, requested));
  });
}

function getFailedExecOutsideWorkspaceBoundaryEvidence(
  toolCalls: FridayAgentToolCallRecord[],
  task?: string,
): FridayAgentToolCallRecord[] {
  const boundaryProbeTask = task ? taskLooksLikeOutsideWorkspaceExecBoundaryProbe(task) : false;
  const requestedFiles = task ? extractLocalWorkspaceFileMentions(task) : [];
  return toolCalls.filter((call) => {
    if (call.toolName !== "exec" || !call.result.isError) {
      return false;
    }
    if (/outside the allowed workspace root|outside(?: the)? workspace|outside(?: the)? workspace boundary|workspace boundary/i.test(
      call.result.content,
    )) {
      return true;
    }
    if (!boundaryProbeTask || !/readOnly constraint/i.test(call.result.content)) {
      return false;
    }
    const argsText = JSON.stringify(call.args ?? {}).toLowerCase();
    return /\/tmp\/|outside-marker|friday-rgg-agent-file/i.test(argsText)
      || requestedFiles.some((requested) =>
        requested.length > 0 && argsText.includes(requested.toLowerCase()));
  });
}

function hasFailedExecOutsideWorkspaceBoundaryEvidence(
  toolCalls: FridayAgentToolCallRecord[],
  task?: string,
): boolean {
  return getFailedExecOutsideWorkspaceBoundaryEvidence(toolCalls, task).length > 0;
}

function taskAllowsMissingWorkspaceFileRefusal(task: string): boolean {
  return /\bif\b[\s\S]{0,80}\b(?:missing|cannot be read|can't be read|could not be read|unreadable|not found|does not exist)\b/i.test(task)
    || /\b(?:missing|cannot be read|can't be read|could not be read|unreadable|not found|does not exist)\b[\s\S]{0,80}\b(?:cannot|can't|could not|unable to|not able to)\s+(?:verify|confirm|read|access)\b/i.test(task)
    || /\b(?:cannot|can't|could not|unable to|not able to)\s+(?:verify|confirm|read|access)\b[\s\S]{0,80}\b(?:missing|cannot be read|can't be read|could not be read|unreadable|not found|does not exist)\b/i.test(task)
    || /(?:如果|若).{0,40}(缺失|不存在|无法读取|不能读取|读不到).{0,40}(无法|不能|未能).{0,20}(验证|确认|读取|访问)/u.test(task);
}

function responseAcknowledgesWorkspaceFileUnverified(responseText: string): boolean {
  return /\b(?:cannot|can't|could not|unable to|not able to|failed to)\b.{0,80}\b(?:verify|confirm|read|access)\b/i.test(responseText)
    || /\b(?:not verified|unverified|cannot be verified|could not be verified)\b/i.test(responseText)
    || /(?:无法|不能|未能|没法).{0,30}(?:验证|确认|读取|访问|证明)/u.test(responseText)
    || /(?:不能确认|无法确认|无法验证|未验证|无法读取|无法访问)/u.test(responseText)
    || /\b(?:cannot|can't|could not|unable to|not able to|failed to)\b.{0,80}\b(?:execute|run)\b.{0,120}\b(?:outside|workspace boundary|workspace root)\b/i.test(responseText)
    || /(?:无法|不能|未能|没法).{0,30}(?:执行|运行).{0,80}(?:工作区|workspace).{0,30}(?:之外|外部|边界外|边界)/iu.test(responseText);
}

function buildMissingWorkspaceFileUnverifiedResponse(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): string | null {
  if (!taskAllowsMissingWorkspaceFileRefusal(params.task)) {
    return null;
  }
  if (hasSuccessfulLocalWorkspaceReadEvidence(params.task, params.toolCalls)) {
    return null;
  }
  const failedRead = findFailedLocalWorkspaceReadEvidence(params.task, params.toolCalls);
  if (!failedRead) {
    return null;
  }
  const rawPath = typeof failedRead.args.path === "string" ? failedRead.args.path.trim() : "the requested workspace file";
  const failureDetail = failedRead.result.content.replace(/\s+/g, " ").trim().slice(0, 240);
  return [
    `I cannot verify ${rawPath}: the read tool reported that the requested workspace file could not be read.`,
    `Tool evidence: ${failureDetail}`,
    "Treat the requested marker or claim as unverified until the file is available and can be read.",
  ].join("\n");
}

function buildOutsideWorkspaceExecBoundaryUnverifiedResponse(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): string | null {
  if (!taskLooksLikeOutsideWorkspaceExecBoundaryProbe(params.task)) {
    return null;
  }
  if (hasSuccessfulLocalWorkspaceReadEvidence(params.task, params.toolCalls)) {
    return null;
  }
  const failedExecBoundaryCalls = getFailedExecOutsideWorkspaceBoundaryEvidence(params.toolCalls, params.task);
  if (failedExecBoundaryCalls.length < 2) {
    return null;
  }
  const evidence = failedExecBoundaryCalls
    .slice(0, 2)
    .map((call) => call.result.content.replace(/\s+/g, " ").trim().slice(0, 200));
  return [
    "I cannot verify or read the outside file: the exec tool rejected the requested commands at the workspace boundary.",
    `Tool evidence: ${evidence.join(" | ")}`,
    "Treat the outside marker or claim as unverified until it can be checked through an approved in-workspace evidence path.",
  ].join("\n");
}

function taskRequestsTopWorkspaceHeading(task: string): boolean {
  return /\btop\s+(?:h1|heading)\b/i.test(task)
    || /\b(?:h1|heading)\b[\s\S]{0,32}\bonly\b/i.test(task);
}

function readContentIncludesWorkspaceHeading(content: string): boolean {
  return /(^|\n)\s*#\s+\S/u.test(content)
    || /<h1\b[^>]*>[\s\S]*?<\/h1>/iu.test(content);
}

function hasSuccessfulLocalWorkspaceReadEvidenceWithHeading(
  task: string,
  toolCalls: FridayAgentToolCallRecord[],
): boolean {
  const requestedFiles = extractLocalWorkspaceFileMentions(task);
  return toolCalls.some((call) => {
    if (call.toolName !== "read" || call.result.isError) {
      return false;
    }
    const rawPath = typeof call.args.path === "string" ? call.args.path.trim() : "";
    if (rawPath.length === 0) {
      return false;
    }
    const matchesRequestedPath = requestedFiles.length === 0
      || requestedFiles.some((requested) => localWorkspacePathMatchesRequested(rawPath, requested));
    return matchesRequestedPath && readContentIncludesWorkspaceHeading(call.result.content);
  });
}

function responseLooksLikeLocalFileAccessRefusal(responseText: string): boolean {
  return /\b(?:cannot|can't|unable to|not able to|could not|couldn't)\s+(?:directly\s+)?(?:access|read|open)\b/i.test(responseText)
    || /\b(?:cannot|can't|unable to|not able to|could not|couldn't)\s+(?:extract|inspect)\b/i.test(responseText)
    || /(无法直接访问|无法访问|无法读取|不能读取|不能访问|无法打开|无法提取|未能读取|没能读取|未能访问|没能访问|未能打开|没能打开|未能提取|没能提取)/u.test(responseText);
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
  executionSurface?: string;
}): boolean {
  const {
    task,
    responseText,
    toolMap,
    toolCalls,
    disabledToolNames,
    executionSurface,
  } = params;
  if (isAutonomousInternalReasoningSurface(executionSurface)) {
    return false;
  }

  const normalizedTask = task.trim();
  if (normalizedTask.length === 0) return false;
  const taskCategory = classifyEvidenceTask(normalizedTask);
  if (taskLooksLikeLocalWorkspaceFileInspection(normalizedTask)) {
    const hasReadEvidence = hasSuccessfulLocalWorkspaceReadEvidence(normalizedTask, toolCalls);
    if (!hasReadEvidence) {
      if (
        taskAllowsMissingWorkspaceFileRefusal(normalizedTask)
        && findFailedLocalWorkspaceReadEvidence(normalizedTask, toolCalls)
        && responseAcknowledgesWorkspaceFileUnverified(responseText)
      ) {
        return false;
      }
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    const missingRequestedHeading = taskRequestsTopWorkspaceHeading(normalizedTask)
      && !hasSuccessfulLocalWorkspaceReadEvidenceWithHeading(normalizedTask, toolCalls);
    if (missingRequestedHeading) {
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    if (responseLooksLikeLocalFileAccessRefusal(responseText)) {
      return hasEvidenceCapableTools(toolMap, disabledToolNames, "desktop");
    }
    return false;
  }
  if (hasSuccessfulToolEvidence(toolCalls)) return false;
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

function taskLooksLikeLocalWorkspaceFileInspection(task: string): boolean {
  const englishLocal =
    /\b(local|workspace|repo|repository|project|current workspace|current repo|filesystem)\b/i;
  const englishFileAction =
    /\b(read|open|inspect|check|cat|show)\b[\s\S]{0,64}\b(file|files|filesystem|folder|directory|path|readme|(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]+)\b/i;
  const englishFileFirst =
    /\b(file|files|filesystem|folder|directory|path|readme|(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.[a-z0-9]+)\b[\s\S]{0,64}\b(read|open|inspect|check|cat|show)\b/i;
  const chineseLocal = /(本地|工作区|仓库|项目|文件系统)/u;
  const chineseFileAction = /(读取|查看|检查|打开).{0,32}(文件|目录|路径|工作区|仓库)/u;
  return (
    (englishLocal.test(task) && (englishFileAction.test(task) || englishFileFirst.test(task)))
    || (chineseLocal.test(task) && chineseFileAction.test(task))
  );
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
  if (taskLooksLikeLocalWorkspaceFileInspection(task)) return "desktop";
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
  const task = params.task.trim();
  const localWorkspaceFileInspection = taskLooksLikeLocalWorkspaceFileInspection(task);
  const explicitWorkspaceReadToolTask = taskExplicitlyRequiresReadToolForWorkspaceFile(task);
  const requestedWorkspacePath = explicitWorkspaceReadToolTask
    ? extractLocalWorkspaceFileMentions(task)[0]
    : undefined;
  const category = classifyEvidenceTask(task) ?? "web";
  const isEnabled = (name: string) => !(params.disabledToolNames?.has(name) ?? false);
  const preferredTools = explicitWorkspaceReadToolTask
    ? ["read"]
    : localWorkspaceFileInspection
    ? ["read", "exec"]
    : category === "desktop"
    ? ["system", "desktop", "exec", "read", "browser"]
    : ["web_fetch", "web_search", "browser"];
  const enabledPreferred = preferredTools.filter((name) => params.toolMap.has(name) && isEnabled(name));
  const toolHint = enabledPreferred.length > 0 ? enabledPreferred.join("/") : "available tools";
  const taskLabel = localWorkspaceFileInspection
    ? "this local workspace file task"
    : category === "desktop" ? "this local desktop/device task" : "this external task";
  const headingRetryHint = taskRequestsTopWorkspaceHeading(task)
    ? "If a previous read used offset/limit and did not include the H1, call read again without offset/limit or with enough lines so the read result includes the requested top H1 before answering."
    : "";
  const approachHint = explicitWorkspaceReadToolTask
    ? [
        `Call read with path="${requestedWorkspacePath ?? "the requested workspace path"}"; do not use web, browser, search, capabilities, or tool-pack detours because they cannot satisfy local file read evidence.`,
        headingRetryHint,
      ].filter((part) => part.length > 0).join(" ")
    : localWorkspaceFileInspection
    ? [
        "Use read for the requested workspace path; do not use web_search or web_fetch because they cannot inspect local workspace files.",
        headingRetryHint,
      ].filter((part) => part.length > 0).join(" ")
    : category === "desktop"
    ? "Start with system snapshot, then use system intents before falling back to desktop session_info or desktop screenshot for visible evidence."
    : "Use web tools to gather evidence before concluding.";

  return (
    `System verification: your previous reply has no successful tool evidence for ${taskLabel}. ` +
    `You must use available tools (${toolHint}) and provide an evidence-backed answer. ` +
    `${approachHint} If all attempts fail, report exact tool errors and what you retried.`
  );
}

function taskRequiresPreferencePersistence(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (isFridaySensitiveLearningCandidate(task)) {
    return false;
  }
  return (
    /^\s*call me\b/.test(normalized)
    || /\bplease call me\b/.test(normalized)
    || /\bi prefer\b/.test(normalized)
    || /\bplease use\b/.test(normalized)
    || /\bmy name is\b/.test(normalized)
    || /^(叫我|称呼我为|把我叫做|被称为|请叫我|我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为)/u.test(task.trim())
    || /(请用中文|请用英文)/u.test(task)
  );
}

function extractTaskDeclaredDisplayName(task: string): string | null {
  const patterns = [
    /\bcall me\s+(.+?)\s*[.!?]?$/i,
    /\bmy name is\s+(.+?)\s*[.!?]?$/i,
    /\brefer to me as\s+(.+?)\s*[.!?]?$/i,
    /(叫我|称呼我为|把我叫做|被称为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
    /(我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
  ] as const;
  for (const pattern of patterns) {
    const match = task.match(pattern);
    const rawValue = match?.[2] ?? match?.[1];
    if (typeof rawValue === "string" && rawValue.trim().length > 0) {
      return rawValue.trim().replace(/^["“']+|["”']+$/gu, "");
    }
  }
  return null;
}

function shouldEnforceFeedbackPersistenceForTask(params: {
  task: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  if (!taskRequiresPreferencePersistence(params.task)) {
    return false;
  }
  const feedbackAvailable = params.toolMap.has("feedback") && !(params.disabledToolNames?.has("feedback") ?? false);
  const memoryStoreAvailable = params.toolMap.has("memory_store") && !(params.disabledToolNames?.has("memory_store") ?? false);
  if (!feedbackAvailable && !memoryStoreAvailable) {
    return false;
  }
  return !hasFeedbackPersistenceEvidence(params.toolCalls);
}

function buildFeedbackPersistenceRetryPrompt(params: { task: string }): string {
  const declaredDisplayName = extractTaskDeclaredDisplayName(params.task);
  if (declaredDisplayName) {
    return (
      `System verification: the user explicitly set a preferred name in "${params.task.trim()}". ` +
      `Before replying, persist that preference with feedback using kind="preference", field="user_name", value="${declaredDisplayName}". ` +
      `Only use memory_store as a fallback if feedback is unavailable. After the tool succeeds, acknowledge the preference.`
    );
  }
  return (
    `System verification: the user explicitly stated a preference or correction in "${params.task.trim()}". ` +
    `Before replying, persist it with feedback. Only use memory_store as a fallback if feedback is unavailable, then acknowledge the saved preference.`
  );
}

function taskRequiresMemorySearch(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\buse memory[_ ]search\b/.test(normalized)
    || /\bwhat(?:'s| is)\s+my\s+(?:codename|code phrase|passphrase|preferred name)\b/.test(normalized)
    || /\bwhat should you call me\b/.test(normalized)
    || /\bwhat should i call you\b/.test(normalized)
    || taskRequestsDirectNameRecall(task)
    || /\bwhat(?:\s+\S+){0,6}\s+(?:do\s+)?i\s+(?:like|prefer)\b/.test(normalized)
    || /\b(?:my|user)\s+(?:preferred|stored)\s+(?:name|preference|preferences)\b/.test(normalized)
    || /\b(?:do you remember|what do you remember|recall|stored fact|stored facts|previous conversation|past decision|past decisions)\b/.test(normalized)
  );
}

function taskRequestsDirectNameRecall(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\bwhat should you call me\b/.test(normalized)
    || /\bwhat should i call you\b/.test(normalized)
    || /\bwhat (?:name|nickname) (?:should|do) you (?:use|call me with)\b/.test(normalized)
    || /(我叫什么名字|我的名字是什么|我叫啥|我叫什[么麼]|你记得我叫什么|还记得我叫什么|怎么称呼我|该怎么叫我|应该怎么称呼我|应该叫我什么|你该怎么称呼我|你应该怎么叫我|怎么称呼您|该怎么叫您|应该怎么称呼您|应该叫您什么)/u.test(task)
  );
}

function taskRequestsCodenameRecall(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\b(?:what(?:'s| is)?|which|tell me|remind me|do you remember)\b(?:\s+\S+){0,8}\s+\b(?:codename|code phrase|passphrase)\b/.test(normalized)
    || /\b(?:codename|code phrase|passphrase)\b(?:\s+\S+){0,8}\s+\b(?:what(?:'s| is)?|was|again|remember)\b/.test(normalized)
    || /(?:什么|啥).*(?:代号|口令|暗号)/u.test(task)
    || /(?:代号|口令|暗号).*(?:是什么|是啥|告诉我|还记得|再说一遍|叫什么)/u.test(task)
  );
}

function taskRequestsReleaseNoteStyleRecall(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\b(?:what(?:'s| is)?|which|tell me|remind me|do you remember)\b(?:\s+\S+){0,10}\s+\brelease(?:[- ]note)? style\b/.test(normalized)
    || /\b(?:what(?:'s| is)?|which|tell me|remind me|do you remember)\b(?:\s+\S+){0,10}\s+\brelease notes?\b/.test(normalized)
    || /\brelease(?:[- ]note)? style\b(?:\s+\S+){0,8}\s+\b(?:what(?:'s| is)?|again|remember)\b/.test(normalized)
    || /(?:什么|怎样).*(?:发布说明|release[- ]note|release note).*(?:风格|偏好)/iu.test(task)
    || /(?:发布说明|release[- ]note|release note).*(?:风格|偏好).*(?:是什么|怎样|告诉我|还记得)/iu.test(task)
  );
}

function getRequestedMemoryRecallFields(task: string): FridayMemoryRecallExpectation["field"][] {
  const fields: FridayMemoryRecallExpectation["field"][] = [];
  if (taskRequestsDirectNameRecall(task)) {
    fields.push("preferred_name");
  }
  if (taskRequestsCodenameRecall(task)) {
    fields.push("codename");
  }
  if (taskRequestsReleaseNoteStyleRecall(task)) {
    fields.push("release_note_style");
  }
  return fields;
}

function responseClaimsStoredFactMissing(responseText: string): boolean {
  const normalized = responseText.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return (
    /\bi (?:do not|don't)(?:\s+\w+){0,3}\s+have\b/.test(normalized)
    || /\bi (?:did not|didn't) find\b/.test(normalized)
    || /\bnot stored\b/.test(normalized)
    || /\bno (?:stored|specific|saved)\b/.test(normalized)
    || /\bcould you please tell me\b/.test(normalized)
    || /(没有找到|没找到|不知道该怎么称呼|请告诉我|请您告诉我|还不知道)/u.test(responseText)
  );
}

function hasSuccessfulMemorySearchEvidence(toolCalls: FridayAgentToolCallRecord[]): boolean {
  return toolCalls.some((call) => call.toolName === "memory_search" && !call.result.isError);
}

function parseMemorySearchResults(toolCall: FridayAgentToolCallRecord): Array<Record<string, unknown>> {
  if (toolCall.toolName !== "memory_search" || toolCall.result.isError) {
    return [];
  }
  try {
    const parsed = JSON.parse(toolCall.result.content);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

function taskLooksLikeLocalConversationRecall(task: string): boolean {
  return /(?:刚刚|刚才|方才|上文|上面|前面|前文|刚说|刚提到|那个|那条|那件|刚才那个|刚刚那个)/u.test(task)
    || /\b(?:that|this|previous|earlier|above|last)\b/i.test(task);
}

interface FridayMemoryRecallExpectation {
  field: "codename" | "release_note_style" | "preferred_name";
  query: string;
  value: string;
  content: string;
}

function normalizeMemoryRecallValue(raw: string): string {
  return raw.trim().replace(/^["'“”]+|["'“”.]+$/gu, "");
}

function canUseWholeMemoryContentForField(field: FridayMemoryRecallExpectation["field"], content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return false;
  }
  if (field === "release_note_style") {
    return trimmed.length <= 500;
  }

  const compact = trimmed.length <= 80
    && !/[。！？!?；;：:，,]/u.test(trimmed)
    && trimmed.split(/\s+/).length <= 6;
  if (!compact) {
    return false;
  }

  if (field === "codename") {
    return /[A-Za-z0-9][A-Za-z0-9_-]{1,}|[\p{Script=Han}]{1,12}(?:[-_][A-Za-z0-9]{1,12})?/u.test(trimmed);
  }
  return true;
}

function extractMemoryRecallValue(field: FridayMemoryRecallExpectation["field"], content: string): string | undefined {
  if (field === "codename") {
    const match = content.match(/\b(?:codename|code phrase|passphrase)\s+is\s+["'“”]?([^"'“”.\n]+)["'“”]?/i);
    return match?.[1] ? normalizeMemoryRecallValue(match[1]) : undefined;
  }
  if (field === "preferred_name") {
    const match = content.match(/\b(?:preferred name|name)\s+is\s+["'“”]?([^"'“”.\n]+)["'“”]?/i);
    return match?.[1] ? normalizeMemoryRecallValue(match[1]) : undefined;
  }
  const releaseStyleMatch = content.match(
    /\b(?:prefers?|likes?|wants?)\s+(?:a\s+release-note style\s+that\s+)?(.+?)(?:[.]\s*|$)/i,
  );
  if (releaseStyleMatch?.[1]) {
    return normalizeMemoryRecallValue(releaseStyleMatch[1]);
  }
  const genericMatch = content.match(/\brelease[- ]note style(?: is|:)?\s+(.+?)(?:[.]\s*|$)/i);
  return genericMatch?.[1] ? normalizeMemoryRecallValue(genericMatch[1]) : undefined;
}

function collectMemoryRecallExpectations(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): FridayMemoryRecallExpectation[] {
  const requestedFields = getRequestedMemoryRecallFields(params.task);
  if (requestedFields.length === 0) {
    return [];
  }
  const expectations = new Map<FridayMemoryRecallExpectation["field"], FridayMemoryRecallExpectation>();

  const trySetExpectation = (
    field: FridayMemoryRecallExpectation["field"],
    query: string,
    content: string,
    allowWholeContentFallback = false,
  ): void => {
    if (expectations.has(field) || content.length === 0) {
      return;
    }
    const value = extractMemoryRecallValue(field, content);
    const canUseWholeContent = allowWholeContentFallback && canUseWholeMemoryContentForField(field, content);
    if (!value && !canUseWholeContent) {
      return;
    }
    expectations.set(field, {
      field,
      query,
      value: value ?? content,
      content,
    });
  };

  for (const toolCall of params.toolCalls) {
    if (toolCall.toolName !== "memory_search" || toolCall.result.isError) {
      continue;
    }
    const query = typeof toolCall.args.query === "string" ? toolCall.args.query.trim() : "";
    if (query.length === 0) {
      continue;
    }

    const results = parseMemorySearchResults(toolCall);
    for (const result of results) {
      const content = typeof result.content === "string" ? result.content.trim() : "";
      for (const field of requestedFields) {
        trySetExpectation(field, query, content);
      }
    }

    const [topResult] = results;
    const topContent = typeof topResult?.content === "string" ? topResult.content.trim() : "";
    if (topContent.length === 0) {
      continue;
    }

    const queryRequestsCodename = taskRequestsCodenameRecall(query) || /\b(?:codename|code phrase|passphrase)\b/i.test(query);
    const queryRequestsReleaseStyle = /\b(?:release[- ]note style|release notes?)\b/i.test(query);
    const queryRequestsPreferredName = taskRequestsDirectNameRecall(query) || /\b(?:name|preferred name|user name)\b/i.test(query);

    if (
      requestedFields.includes("codename")
      && queryRequestsCodename
      && !queryRequestsReleaseStyle
      && !queryRequestsPreferredName
    ) {
      trySetExpectation("codename", query, topContent, true);
    }
    if (
      requestedFields.includes("release_note_style")
      && queryRequestsReleaseStyle
      && !queryRequestsCodename
      && !queryRequestsPreferredName
    ) {
      trySetExpectation("release_note_style", query, topContent, true);
    }
    if (
      requestedFields.includes("preferred_name")
      && queryRequestsPreferredName
      && !queryRequestsCodename
      && !queryRequestsReleaseStyle
    ) {
      trySetExpectation("preferred_name", query, topContent, true);
    }
  }

  return [...expectations.values()];
}

function responseMatchesAnyMemoryRecallValue(
  responseText: string,
  expectedValues: string[],
): boolean {
  const normalizedResponse = responseText.trim().toLowerCase();
  if (normalizedResponse.length === 0) {
    return false;
  }
  return expectedValues.some((value) => normalizedResponse.includes(value.trim().toLowerCase()));
}

function memoryRecallFieldQuery(field: FridayMemoryRecallExpectation["field"]): string {
  switch (field) {
    case "preferred_name":
      return "user name";
    case "codename":
      return "codename";
    case "release_note_style":
      return "release-note style";
  }
}

function buildDeterministicMemoryRecallFallbackResponse(params: {
  task: string;
  toolCalls: FridayAgentToolCallRecord[];
}): string | undefined {
  const requestedFields = getRequestedMemoryRecallFields(params.task);
  if (requestedFields.length === 0) {
    return undefined;
  }

  const expectationMap = new Map(
    collectMemoryRecallExpectations(params).map((expectation) => [expectation.field, expectation.value] as const),
  );

  if (requestedFields.length === 1 && requestedFields[0] === "preferred_name") {
    return expectationMap.get("preferred_name");
  }

  const clauses: string[] = [];
  if (requestedFields.includes("preferred_name")) {
    const preferredName = expectationMap.get("preferred_name");
    if (preferredName) {
      clauses.push(`Your preferred name is ${preferredName}`);
    }
  }
  if (requestedFields.includes("codename")) {
    const codename = expectationMap.get("codename");
    if (codename) {
      clauses.push(`Your codename is ${codename}`);
    }
  }
  if (requestedFields.includes("release_note_style")) {
    const releaseStyle = expectationMap.get("release_note_style");
    if (releaseStyle) {
      clauses.push(`you prefer ${releaseStyle}`);
    }
  }

  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return `${clauses[0]}.`;
  }
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}.`;
}

function responseClaimsNewMemoryPersistence(responseText: string): boolean {
  const normalized = responseText.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return /\b(?:i have saved|i've saved|i saved|i recorded|saved your|recorded your)\b/.test(normalized)
    || /(已保存|已经保存|我保存了|我记住了|我已经记住)/u.test(responseText);
}

function evaluateMemoryRecallAnswerAlignment(params: {
  task: string;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
}): { retryPrompt?: string } {
  const requestedFields = getRequestedMemoryRecallFields(params.task);
  if (requestedFields.length === 0) {
    return {};
  }
  if (!hasSuccessfulMemorySearchEvidence(params.toolCalls)) {
    return {};
  }
  const expectations = collectMemoryRecallExpectations(params);
  const expectedFields = new Set(expectations.map((expectation) => expectation.field));
  const missingRequestedFields = requestedFields.filter((field) => !expectedFields.has(field));
  if (expectations.length === 0 && missingRequestedFields.length === 0) {
    return {};
  }
  const missingExpectations = expectations.filter((expectation) =>
    !responseMatchesAnyMemoryRecallValue(params.responseText, [expectation.value, expectation.content]),
  );
  const claimsNewPersistence = responseClaimsNewMemoryPersistence(params.responseText);
  if (missingExpectations.length === 0 && missingRequestedFields.length === 0 && !claimsNewPersistence) {
    return {};
  }

  return {
    retryPrompt: [
      "System verification: memory_search already returned stored user facts for this task, but your answer did not use the top result for every requested field.",
      `Current task: ${params.task.trim()}`,
      ...missingRequestedFields.map((field) =>
        `Requested ${field.replace(/_/g, " ")} is still missing. Rerun memory_search with a field-specific query for that field before answering.`,
      ),
      ...missingExpectations.map((expectation) =>
        `Stored ${expectation.field.replace(/_/g, " ")} from memory_search: ${expectation.value}`,
      ),
      "Reply using those stored values directly.",
      "Prefer the top memory_search result for the current session when multiple memories conflict.",
      "This is a recall task, not a new save task.",
      "Do not call feedback or memory_store, and do not say you saved or recorded anything new.",
      "Do not say the value is unknown and do not ask the user again unless the tool result was empty.",
    ].join(" "),
  };
}

function shouldAttemptDeterministicMemoryRecallFallback(params: {
  task: string;
  responseText: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  const requestedFields = getRequestedMemoryRecallFields(params.task);
  const expectations = collectMemoryRecallExpectations({
    task: params.task,
    toolCalls: params.toolCalls,
  });
  if (expectations.length === 0 && requestedFields.length === 0) {
    return false;
  }
  if (!params.toolMap.has("memory_search")) {
    return false;
  }
  if (params.disabledToolNames?.has("memory_search")) {
    return false;
  }

  if (
    !hasSuccessfulMemorySearchEvidence(params.toolCalls)
    && params.responseText.trim().length > 0
    && taskLooksLikeLocalConversationRecall(params.task)
    && !responseClaimsStoredFactMissing(params.responseText)
  ) {
    return false;
  }

  const expectedFields = new Set(expectations.map((expectation) => expectation.field));
  if (requestedFields.some((field) => !expectedFields.has(field))) {
    return true;
  }

  if (expectations.length > 0) {
    return expectations.some((expectation) =>
      !responseMatchesAnyMemoryRecallValue(params.responseText, [expectation.value, expectation.content]),
    );
  }

  return true;
}

function shouldEnforceMemorySearchForTask(params: {
  task: string;
  responseText: string;
  toolMap: Map<string, FridayAgentToolDefinition>;
  toolCalls: FridayAgentToolCallRecord[];
  disabledToolNames?: ReadonlySet<string>;
}): boolean {
  if (
    !taskRequiresMemorySearch(params.task)
    && !(
      taskRequestsDirectNameRecall(params.task)
      && responseClaimsStoredFactMissing(params.responseText)
    )
  ) {
    return false;
  }
  if (!params.toolMap.has("memory_search")) {
    return false;
  }
  if (params.disabledToolNames?.has("memory_search")) {
    return false;
  }
  return !hasSuccessfulMemorySearchEvidence(params.toolCalls);
}

function buildMemorySearchRetryPrompt(params: { task: string }): string {
  return (
    `System verification: this task asks about stored user facts or prior conversation state. ` +
    `Before answering "${params.task.trim()}", you must call memory_search. ` +
    `Search without a namespace first, then use preference or user if you need narrower recall. ` +
    `If memory_search finds relevant results, answer from that evidence only. ` +
    `If it returns no relevant result, explicitly say the information is not stored.`
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

const CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /[（(]?\s*ID\s*[:：]/i,
  /\b(?:readOnly|skills_list|memory_search|agents_list|sub-?agent|sessionKey|session key|childRunId|tool[_ ]call|tool name|pack_id|pack id|memory system|memory item|memory namespace)\b/i,
  /\b(?:run id|session id|subagent id)\b/i,
  /(?:任务包\s*id|只读模式|内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|工作流目录|workflow catalog|子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
];

const CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:只读模式|read[- ]?only mode)/i,
  /(?:内存(?:系统|持久化|记录)|记忆(?:系统|条目|检索)|memory system|memory item|memory namespace|memory search)/i,
  /(?:skills_list|memory_search|agents_list|sub-?agent|tool[_ ]call|tool name)/i,
  /(?:子代理|会话键|父会话|父子会话|运行深度|元数据)/i,
  /(?:当前运行.*正在执行中)/i,
];

const CUSTOM_PACK_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function isCustomPackExecutionContext(
  executionContext?: FridayAgentExecutionContext,
): boolean {
  return Boolean(executionContext?.packId?.trim().startsWith("custom-"));
}

function customPackResponseLeaksInternalDetails(responseText: string): boolean {
  const normalized = responseText.trim();
  if (normalized.length === 0) {
    return false;
  }
  return CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildCustomPackInternalDetailsRetryPrompt(params: {
  task: string;
  responseText: string;
  executionContext?: FridayAgentExecutionContext;
}): string | undefined {
  if (!isCustomPackExecutionContext(params.executionContext)) {
    return undefined;
  }
  if (!customPackResponseLeaksInternalDetails(params.responseText)) {
    return undefined;
  }
  return [
    "System verification: this is a persisted custom-pack run, but your draft answer still exposes internal runtime details.",
    `Current task: ${params.task.trim()}`,
    "Rewrite the answer for the user using only the real pack brief and real live-run evidence.",
    "Do not mention run IDs, session keys, sub-agent IDs, tool names, pack_id fields, readOnly flags, or internal debugging notes.",
    "Keep the answer concrete and action-oriented.",
  ].join(" ");
}

function sanitizeCustomPackResponseText(
  responseText: string,
  executionContext?: FridayAgentExecutionContext,
): string {
  if (!isCustomPackExecutionContext(executionContext)) {
    return responseText;
  }

  const filteredLines = responseText
    .split("\n")
    .map((line) =>
      line
        .replace(/(?:任务包\s*id|pack(?:\s|_)?id|run(?:\s|_)?id|session(?:\s|_)?id|session(?:\s|_)?key)\s*[:：=]\s*[^\s,，;；)）]+/giu, "")
        .replace(/\b(?:readOnly|readonly)\b\s*(?:[:=]\s*(?:true|false))?/giu, "")
        .replace(/\b(?:skills_list|memory_search|agents_list|sub-agent|subagent|sessionKey|childRunId|tool[_ ]call|tool name)\b/giu, "")
        .replace(CUSTOM_PACK_UUID_RE, "")
        .replace(/[（(]\s*ID\s*[:：]\s*[）)]/giu, "")
        .replace(/\bID\s*[:：]\s*/giu, "")
        .replace(/[（(]\s*[）)]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:[-*•]\s*|(?:\d+[.)]\s*))$/u.test(line))
    .filter((line) => !CUSTOM_PACK_INTERNAL_LINE_DROP_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !CUSTOM_PACK_INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(line)));

  const sanitized = filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return sanitized.length > 0
    ? sanitized
    : "这次自创任务已经完成，结果已按真实任务定义和真实运行记录整理。";
}

function buildDelegatedExecutionFallbackMessage(params: {
  status: FridayAgentRunStatus;
  task: string;
}): string {
  const useChinese = hasCjkText(params.task);
  if (params.status === "failed") {
    return useChinese
      ? "这次任务在执行过程中遇到阻塞，暂时没有形成可用结果。"
      : "This task hit a blocker before it produced a usable result.";
  }
  if (params.status === "completed") {
    return useChinese
      ? "这次任务已经执行完成，但没有留下可展示的最终回复。"
      : "This task completed without a user-facing final response.";
  }
  return useChinese
    ? `这次任务目前处于 ${params.status} 状态，还没有形成可展示的最终回复。`
    : `This task is currently ${params.status} and has not produced a user-facing final response yet.`;
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
    if (evidence.latestnessVerified) {
      return {
        responseText: params.responseText,
        retryPrompt:
          "System verification: your tools already produced date-backed, freshness-applied evidence for this time-sensitive request. " +
          "Do not say latestness is unverified. Use the verified tool evidence and answer with absolute publication dates and direct source URLs for each item.",
      };
    }
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

function estimateAgentMessageChars(message: FridayAgentMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) {
    return 0;
  }

  let total = 0;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || !("type" in block)) {
      continue;
    }
    switch (block.type) {
      case "text":
        total += typeof block.text === "string" ? block.text.length : 0;
        break;
      case "tool_result":
        total += typeof block.content === "string" ? block.content.length : String(block.content ?? "").length;
        break;
      case "tool_use":
        total += (typeof block.name === "string" ? block.name.length : 0)
          + JSON.stringify(block.input ?? {}).length;
        break;
      case "image":
        total += 256;
        break;
      default:
        total += JSON.stringify(block).length;
        break;
    }
  }
  return total;
}

function shouldAttemptSemanticCompaction(messages: FridayAgentMessage[]): boolean {
  if (messages.length > FRIDAY_AGENT_COMPACTION_THRESHOLD) {
    return true;
  }
  let totalChars = 0;
  for (const message of messages) {
    totalChars += estimateAgentMessageChars(message);
    if (totalChars > AGENT_COMPACTION_SOFT_CHAR_THRESHOLD) {
      return true;
    }
  }
  return false;
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
  requestId?: string | null;
  attempts?: FridayProviderAttempt[];
  routingDecisionReason?: string;
  learningAdjusted?: boolean;
  routeDecisionTrace?: FridayAgentActualExecution["routeDecisionTrace"];
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
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
            requestId: event.requestId,
            attempts: event.attempts,
            routingDecisionReason: event.routingDecisionReason,
            learningAdjusted: event.learningAdjusted,
            routeDecisionTrace: event.routeDecisionTrace,
            cacheReadInputTokens: event.cacheReadInputTokens,
            cacheCreationInputTokens: event.cacheCreationInputTokens,
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

  const extractedValues = extractJsonValueCandidates(normalized);
  const candidates: string[] = extractedValues.length > 1
    ? [...extractedValues, normalized]
    : [normalized];
  const fenced = unwrapJsonCodeFence(normalized);
  if (fenced) candidates.push(fenced);
  for (const block of extractJsonCodeBlocks(normalized)) {
    candidates.push(block);
  }
  for (const block of extractedValues) {
    candidates.push(block);
  }

  const seenCandidates = new Set<string>();
  const recoveredCalls: ParsedTextToolCall[] = [];
  for (const candidate of candidates) {
    if (candidate === normalized && extractedValues.length > 1 && recoveredCalls.length > 0) continue;
    if (seenCandidates.has(candidate)) continue;
    seenCandidates.add(candidate);
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
      recoveredCalls.push(...calls);
      continue;
    }

    const single = parseTextToolCall(parsed, validToolNames);
    if (single) recoveredCalls.push(single);
  }

  return recoveredCalls;
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

function extractJsonValueCandidates(value: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if ((char === "}" || char === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1).trim());
        start = -1;
      }
    }
  }

  return candidates;
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

    let parsedResultContent: Record<string, unknown> | null = null;
    if (typeof call.result.content === "string" && call.result.content.trim().startsWith("{")) {
      try {
        parsedResultContent = JSON.parse(call.result.content) as Record<string, unknown>;
      } catch {
        parsedResultContent = null;
      }
    }

    if (call.toolName === "write" || call.toolName === "edit") {
      const filePath = typeof call.args.path === "string" ? call.args.path : undefined;
      if (filePath) add({ type: "file", path: filePath });
      continue;
    }

    if (call.toolName === "skill_generate" && call.args.action === "approve") {
      const skillId = typeof parsedResultContent?.skillId === "string"
        ? parsedResultContent.skillId
        : undefined;
      const skillDir = typeof parsedResultContent?.skillDir === "string"
        ? parsedResultContent.skillDir
        : undefined;
      if (skillId && skillDir) {
        add({
          type: "skill",
          skillId,
          path: join(skillDir, "skill.manifest.json"),
        });
        continue;
      }
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
  operationalMode?: "plan" | "execute" | "restricted";
  timezone?: string;
  taskPrompt?: string;
  conversationContext?: FridayAgentConversationContext;
  principalId?: string;
  tenantContext?: FridayAgentLlmStreamParams["tenantContext"];
  requestedProviderId?: string;
  requestedModel?: string;
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
    return {
      ...params.input,
      __sessionId: params.sessionKey,
      ...(params.principalId ? { __principalId: params.principalId } : {}),
    };
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

function resolveToolExecutionTimeoutMs(
  tool: FridayAgentToolDefinition | undefined,
  args: Record<string, unknown>,
): number {
  if (!tool?.timeoutMs) {
    return FRIDAY_AGENT_TOOL_TIMEOUT_MS;
  }

  const candidate = typeof tool.timeoutMs === "function"
    ? tool.timeoutMs(args)
    : tool.timeoutMs;
  if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) {
    return FRIDAY_AGENT_TOOL_TIMEOUT_MS;
  }
  return Math.trunc(candidate);
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
  toolGuardrail?: ReturnType<typeof buildFridayAgentToolPostGuardrailEvidence>;
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
    ...(params.toolGuardrail ? { guardrail: params.toolGuardrail } : {}),
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
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
  approvalRequiredReason?: string | null;
  guardrailDecision?: "block" | "requires_approval";
}): FridayAgentToolCallRecord {
  const auditInput = redactToolInputForAudit(params.toolUse.input);
  const isMutating = isMutatingToolCall(params.toolUse.name, params.toolUse.input);
  const approvalRequiredReason = params.approvalRequiredReason
    ?? getApprovalRequiredReasonForToolCall(params.toolUse.name, params.toolUse.input);
  const preGuardrail = buildFridayAgentToolPreGuardrailEvidence({
    toolCallId: params.toolUse.id,
    toolName: params.toolUse.name,
    toolInput: auditInput,
    mutating: isMutating,
    readOnly: params.readOnly,
    operationalMode: params.operationalMode,
    approvalRequiredReason,
    decision: params.guardrailDecision ?? "block",
    routeId: params.routeId,
    correlationId: params.correlationId,
    checks: ["immediate_guardrail_block"],
  });
  const result = {
    content: params.message,
    isError: true,
  };
  const postGuardrail = buildFridayAgentToolPostGuardrailEvidence({
    toolCallId: params.toolUse.id,
    toolName: params.toolUse.name,
    durationMs: 0,
    isError: true,
    routeId: params.routeId,
    correlationId: params.correlationId,
    summary: result.content.slice(0, 200),
    errorCode: params.errorCode ?? FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
    status: "blocked",
  });

  params.emitRunEvent("agent.run.tool_start", {
    runId: params.runId,
    toolName: params.toolUse.name,
    toolCallId: params.toolUse.id,
    params: auditInput,
    guardrail: preGuardrail,
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
    guardrail: postGuardrail,
  });

  return {
    toolCallId: params.toolUse.id,
    toolName: params.toolUse.name,
    args: auditInput,
    result,
    durationMs: 0,
    startedAt: params.nowIso(),
    guardrail: {
      pre: preGuardrail,
      post: postGuardrail,
    },
  };
}

async function executeToolCall(
  params: ExecuteToolCallParams,
): Promise<FridayAgentToolCallRecord> {
  const { toolUse, toolMap, signal, runId, sessionKey, nowIso, emitRunEvent } = params;
  const routeId = "agent.execute.tool";
  const correlationId = runId;
  const startedAt = Date.now();
  const auditInput = redactToolInputForAudit(toolUse.input);
  const isMutating = isMutatingToolCall(toolUse.name, toolUse.input);
  const approvalRequiredReason = getApprovalRequiredReasonForToolCall(toolUse.name, toolUse.input);
  const preGuardrail = buildFridayAgentToolPreGuardrailEvidence({
    toolCallId: toolUse.id,
    toolName: toolUse.name,
    toolInput: auditInput,
    mutating: isMutating,
    readOnly: params.readOnly,
    operationalMode: params.operationalMode,
    approvalRequiredReason,
    decision: "allow",
    routeId,
    correlationId,
    checks: ["runtime_tool_execution_entry"],
  });
  const buildPostGuardrail = (input: {
    durationMs: number;
    result: FridayAgentToolResult;
    routeId?: string;
    correlationId?: string;
    status?: "completed" | "failed" | "blocked";
  }) => buildFridayAgentToolPostGuardrailEvidence({
    toolCallId: toolUse.id,
    toolName: toolUse.name,
    durationMs: input.durationMs,
    isError: input.result.isError ?? false,
    routeId: input.result.routeId ?? input.routeId ?? routeId,
    correlationId: input.result.correlationId ?? input.correlationId ?? correlationId,
    summary: input.result.content.slice(0, 200),
    errorCode: input.result.errorCode,
    status: input.status,
  });
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
    params: auditInput,
    guardrail: preGuardrail,
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
        const postGuardrail = buildPostGuardrail({
          durationMs,
          result,
          routeId: "agent.execute.tool.file_tracker",
          status: "blocked",
        });

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
          guardrail: postGuardrail,
        });

        return {
          toolCallId: toolUse.id,
          toolName: toolUse.name,
          args: auditInput,
          result,
          durationMs,
          startedAt: nowIso(),
          guardrail: {
            pre: preGuardrail,
            post: postGuardrail,
          },
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
    const postGuardrail = buildPostGuardrail({
      durationMs,
      result,
      status: "failed",
    });

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
      guardrail: postGuardrail,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: auditInput,
      result,
      durationMs,
      startedAt: nowIso(),
      guardrail: {
        pre: preGuardrail,
        post: postGuardrail,
      },
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
    const postGuardrail = buildPostGuardrail({
      durationMs,
      result,
      status: "blocked",
    });

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
      guardrail: postGuardrail,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: auditInput,
      result,
      durationMs,
      startedAt: nowIso(),
      guardrail: {
        pre: preGuardrail,
        post: postGuardrail,
      },
    };
  }

  // Create a timeout signal for the tool call
  const toolAbortController = new AbortController();
  const resolvedToolTimeoutMs = resolveToolExecutionTimeoutMs(tool, toolArgs);
  const toolTimer = setTimeout(() => {
    toolAbortController.abort(new Error("Tool call timed out"));
  }, resolvedToolTimeoutMs);

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
      operationalMode: params.operationalMode,
      timezone: params.timezone,
      taskPrompt: params.taskPrompt,
      conversationContext: params.conversationContext,
      principalId: params.principalId,
      tenantContext: params.tenantContext,
      requestedProviderId: params.requestedProviderId,
      requestedModel: params.requestedModel,
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
        readOnly: params.readOnly,
        operationalMode: params.operationalMode,
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
        readOnly: params.readOnly,
        operationalMode: params.operationalMode,
      });
      result = capToolResultContent(result, toolCap);
    }

    const postGuardrail = buildPostGuardrail({ durationMs, result });

    emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
      runId,
      toolName: toolUse.name,
      toolCallId: toolUse.id,
      durationMs,
      result,
      routeId,
      correlationId,
      toolCallSummary: summarizeToolCall(toolUse.name, auditInput, result, 0, 0),
      toolGuardrail: postGuardrail,
    }));

    if (!result.isError && params.fileVersionTracker && touchedPaths.length > 0) {
      for (const filePath of touchedPaths) {
        params.fileVersionTracker.recordRead(filePath);
      }
    }

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: auditInput,
      result,
      durationMs,
      startedAt: nowIso(),
      guardrail: {
        pre: preGuardrail,
        post: postGuardrail,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = { content: `Tool error: ${errorMessage}`, isError: true };
    const postGuardrail = buildPostGuardrail({
      durationMs,
      result,
      status: "failed",
    });

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
      guardrail: postGuardrail,
    });

    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      args: auditInput,
      result,
      durationMs,
      startedAt: nowIso(),
      guardrail: {
        pre: preGuardrail,
        post: postGuardrail,
      },
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
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
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
    readOnly,
    operationalMode,
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
    readOnly,
    operationalMode,
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
    readOnly,
    operationalMode,
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
    readOnly,
    operationalMode,
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
    readOnly,
    operationalMode,
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
    readOnly,
    operationalMode,
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
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
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
    readOnly,
    operationalMode,
  } = params;
  const correlationId = runId;
  const recoveryCallId = `${toolUse.id}:input-recovery`;
  const recoveryAuditInput = {
    ...recoveryArgs,
    fallback: "tool_input_error",
    fallbackReason: recoveryReason,
    parentToolCallId: toolUse.id,
  };
  const recoveryPreGuardrail = buildFridayAgentToolPreGuardrailEvidence({
    toolCallId: recoveryCallId,
    toolName,
    toolInput: recoveryAuditInput,
    mutating: isMutatingToolCall(toolName, recoveryArgs),
    readOnly,
    operationalMode,
    approvalRequiredReason: getApprovalRequiredReasonForToolCall(toolName, recoveryArgs),
    decision: "allow",
    routeId,
    correlationId,
    checks: ["auto_recovery_tool_guardrail"],
  });

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName,
    toolCallId: recoveryCallId,
    params: recoveryAuditInput,
    guardrail: recoveryPreGuardrail,
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
    const durationMs = Date.now() - startedAt;
    const result = {
      content: `${recoveryTag} failed: ${message}`,
      isError: true,
    };
    const recoveryPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
      toolCallId: recoveryCallId,
      toolName,
      durationMs,
      isError: true,
      routeId,
      correlationId,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      status: "failed",
    });
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName,
      toolCallId: recoveryCallId,
      durationMs,
      isError: true,
      summary: result.content.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
      guardrail: recoveryPostGuardrail,
    });
    return {
      recovered: false,
      result,
    };
  }

  const recoveryDurationMs = Date.now() - startedAt;
  const recoveryPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
    toolCallId: recoveryCallId,
    toolName,
    durationMs: recoveryDurationMs,
    isError: recoveryResult.isError ?? false,
    routeId,
    correlationId,
    summary: recoveryResult.content.slice(0, 200),
    errorCode: recoveryResult.errorCode,
  });
  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName,
    toolCallId: recoveryCallId,
    durationMs: recoveryDurationMs,
    result: recoveryResult,
    routeId,
    correlationId,
    toolGuardrail: recoveryPostGuardrail,
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
  readOnly: boolean;
  operationalMode?: "plan" | "execute" | "restricted";
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
    readOnly,
    operationalMode,
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
  const openAuditInput = { ...openArgs, fallback: "web_fetch_error" };
  const openPreGuardrail = buildFridayAgentToolPreGuardrailEvidence({
    toolCallId: openCallId,
    toolName: "browser",
    toolInput: openAuditInput,
    mutating: isMutatingToolCall("browser", openArgs),
    readOnly,
    operationalMode,
    approvalRequiredReason: getApprovalRequiredReasonForToolCall("browser", openArgs),
    decision: "allow",
    routeId,
    correlationId,
    checks: ["web_fetch_browser_fallback_guardrail"],
  });
  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    params: openAuditInput,
    guardrail: openPreGuardrail,
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
    const durationMs = Date.now() - openStarted;
    const result = {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open failed: ${message}`,
      isError: true,
    };
    const openPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
      toolCallId: openCallId,
      toolName: "browser",
      durationMs,
      isError: true,
      routeId,
      correlationId,
      summary: `${fallbackTag} open failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      status: "failed",
    });
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: openCallId,
      durationMs,
      isError: true,
      summary: `${fallbackTag} open failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
      guardrail: openPostGuardrail,
    });
    return result;
  }

  const openDurationMs = Date.now() - openStarted;
  const openPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
    toolCallId: openCallId,
    toolName: "browser",
    durationMs: openDurationMs,
    isError: openResult.isError ?? false,
    routeId,
    correlationId,
    summary: openResult.content.slice(0, 200),
    errorCode: openResult.errorCode,
  });
  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: openCallId,
    durationMs: openDurationMs,
    result: openResult,
    routeId,
    correlationId,
    toolGuardrail: openPostGuardrail,
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
  const snapshotAuditInput = { ...snapshotArgs, fallback: "web_fetch_error" };
  const snapshotPreGuardrail = buildFridayAgentToolPreGuardrailEvidence({
    toolCallId: snapshotCallId,
    toolName: "browser",
    toolInput: snapshotAuditInput,
    mutating: isMutatingToolCall("browser", snapshotArgs),
    readOnly,
    operationalMode,
    approvalRequiredReason: getApprovalRequiredReasonForToolCall("browser", snapshotArgs),
    decision: "allow",
    routeId,
    correlationId,
    checks: ["web_fetch_browser_fallback_guardrail"],
  });

  emitRunEvent("agent.run.tool_start", {
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    params: snapshotAuditInput,
    guardrail: snapshotPreGuardrail,
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
    const durationMs = Date.now() - snapshotStarted;
    const snapshotPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
      toolCallId: snapshotCallId,
      toolName: "browser",
      durationMs,
      isError: true,
      routeId,
      correlationId,
      summary: `${fallbackTag} snapshot failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      status: "failed",
    });
    emitRunEvent("agent.run.tool_end", {
      runId,
      toolName: "browser",
      toolCallId: snapshotCallId,
      durationMs,
      isError: true,
      summary: `${fallbackTag} snapshot failed: ${message}`.slice(0, 200),
      errorCode: FRIDAY_AGENT_ERROR_CODES.TOOL_ERROR,
      routeId,
      correlationId,
      guardrail: snapshotPostGuardrail,
    });
    return {
      content:
        `${initialResult.content}\n\n` +
        `${fallbackTag} open succeeded but snapshot failed: ${message}`,
      isError: false,
    };
  }

  const snapshotDurationMs = Date.now() - snapshotStarted;
  const snapshotPostGuardrail = buildFridayAgentToolPostGuardrailEvidence({
    toolCallId: snapshotCallId,
    toolName: "browser",
    durationMs: snapshotDurationMs,
    isError: snapshotResult.isError ?? false,
    routeId,
    correlationId,
    summary: snapshotResult.content.slice(0, 200),
    errorCode: snapshotResult.errorCode,
  });
  emitRunEvent("agent.run.tool_end", buildToolEndEventPayload({
    runId,
    toolName: "browser",
    toolCallId: snapshotCallId,
    durationMs: snapshotDurationMs,
    result: snapshotResult,
    routeId,
    correlationId,
    toolGuardrail: snapshotPostGuardrail,
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
