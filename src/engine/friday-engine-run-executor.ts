/**
 * Engine Run Executor — Initiative A.3
 *
 * Extracts the dispatch-and-execute logic that was previously inlined
 * in `executeAgentRunWithSessionContext()` (lines ~1802-2085) into a
 * composable, testable function.
 *
 * Responsibilities:
 * 1. Try sync_immediate (deterministic) dispatch
 * 2. Try managed_async dispatch
 * 3. Run planning gate (if applicable)
 * 4. Fall through to agent runtime executeRun()
 * 5. Finalize conversation focus after the run
 *
 * The caller provides a prepared context (from the turn preparer)
 * and receives a unified engine run result.
 */

import type { FridayAgentRuntimeResult } from "../agent/runtime/friday-agent-runtime.types.js";
import type { FridayAgentRunStatus } from "../agent/model/friday-agent.types.js";
import type { FridaySessionConversationFocusState } from "../sessions/model/friday-session.types.js";
import type {
  FridayEngineRunInput,
  FridayEngineRunResult,
  FridayRunError,
  FridayRunTerminalStatus,
} from "./friday-orchestration-engine.types.js";
import type {
  FridayEngineTurnPreparerSessionDeps,
  FridayExecutionClassification,
  FridayPreparedEngineContext,
} from "./friday-engine-turn-preparer.js";

// ─── Dependency interfaces (narrow) ───

export interface FridayEngineRunExecutorAgentRuntime {
  executeRun(params: {
    task: string;
    taskPrompt?: string;
    conversationContext?: FridayPreparedEngineContext["conversationContext"];
    sessionKey?: string;
    runId?: string;
    providerId?: string;
    tenantContext?: FridayEngineRunInput["tenantContext"];
    model?: string;
    timezone?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    reviewRequired?: boolean;
    constraints?: { readOnly?: boolean };
    principalId?: string;
    scopes?: string[];
    executionContext?: FridayEngineRunInput["executionContext"];
    historyMessages?: FridayPreparedEngineContext["historyMessages"];
    taskProfile?: FridayEngineRunInput["taskProfile"];
  }): Promise<FridayAgentRuntimeResult>;
}

export interface FridayEnginePlanningGate {
  handleTurn(input: {
    runId: string;
    task: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    constraints?: { readOnly?: boolean };
    reviewRequired?: boolean;
    conversationContext?: FridayPreparedEngineContext["conversationContext"];
    focusState?: { pendingPlanRunId?: string } | null;
  }): FridayEnginePlanningDecision;

  approvePlan(input: {
    runId: string;
    sessionKey?: string;
    providerId?: string;
    tenantContext?: FridayEngineRunInput["tenantContext"];
    model?: string;
    timezone?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    constraints?: { readOnly?: boolean };
    principalId?: string;
    scopes?: string[];
    executionContext?: FridayEngineRunInput["executionContext"];
    historyMessages?: FridayPreparedEngineContext["historyMessages"];
    conversationContext?: FridayPreparedEngineContext["conversationContext"];
    taskProfile?: FridayEngineRunInput["taskProfile"];
  }): Promise<FridayAgentRuntimeResult>;

  rejectPlan(input: { runId: string }): FridayAgentRuntimeResult;
}

export type FridayEnginePlanningDecision =
  | { action: "pass_through"; pendingPlanRunId?: string | null }
  | { action: "return"; result: FridayAgentRuntimeResult; pendingPlanRunId?: string | null }
  | { action: "approve"; runId: string; pendingPlanRunId?: null }
  | { action: "reject"; runId: string; pendingPlanRunId?: null };

export interface FridayEngineDeterministicDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayEngineManagedAsyncDispatchResult {
  readonly handled: boolean;
  readonly response?: string;
}

export interface FridayFinalizeFocusInput {
  task: string;
  responseText: string;
  runId: string;
  turnKind: string;
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
  pendingPlanRunId?: string | null;
  nowIso: string;
}

// ─── Factory deps ───

export interface CreateFridayEngineRunExecutorDeps {
  agentRuntime: FridayEngineRunExecutorAgentRuntime;
  sessionDeps?: FridayEngineTurnPreparerSessionDeps;
  planningGate?: FridayEnginePlanningGate;
  nowIso: () => string;
  persistImmediateRunResult?: (input: {
    runId: string;
    task: string;
    sessionKey?: string;
    providerId?: string;
    model?: string;
    constraints?: { readOnly?: boolean };
    responseText: string;
  }) => void | Promise<void>;

  // Dispatch functions injected for testability
  dispatchDeterministic: (
    input: { classification: FridayExecutionClassification; sessionKey?: string; runId?: string; actorId?: string },
    deps: Record<string, unknown>,
  ) => Promise<FridayEngineDeterministicDispatchResult>;
  dispatchManagedAsync: (
    input: { classification: FridayExecutionClassification },
    deps: Record<string, unknown>,
  ) => Promise<FridayEngineManagedAsyncDispatchResult>;
  finalizeFocus: (input: FridayFinalizeFocusInput) => FridaySessionConversationFocusState;

  /** Dependencies bag passed through to deterministic dispatch. */
  deterministicDispatchDeps: Record<string, unknown>;
  /** Dependencies bag passed through to managed async dispatch. */
  managedAsyncDispatchDeps: Record<string, unknown>;

  /** Resolves an idempotency key for session message mirroring. */
  resolveIdempotencyKey: (input: {
    runId: string;
    kind: "planning" | "assistant" | "planning-reject" | "deterministic";
    status?: FridayAgentRunStatus;
  }) => string;
}

// ─── Status mapping ───

function toTerminalStatus(status: FridayAgentRunStatus): FridayRunTerminalStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "awaiting_clarification":
      return "awaiting_clarification";
    case "awaiting_plan_approval":
      return "awaiting_plan_approval";
    case "failed_tests":
      return "failed_tests";
    default:
      // Transient states should not reach here, but map to failed as a safety net.
      return "failed";
  }
}

function toRunError(status: FridayAgentRunStatus, message?: string): FridayRunError | undefined {
  switch (status) {
    case "failed":
      return { category: "internal_error", message: message ?? "Run failed", retryable: false };
    case "failed_tests":
      return { category: "task_error", message: message ?? "Tests failed", retryable: true };
    case "cancelled":
      return { category: "internal_error", message: message ?? "Run cancelled", retryable: false };
    default:
      return undefined;
  }
}

// ─── Factory ───

export function createFridayEngineRunExecutor(deps: CreateFridayEngineRunExecutorDeps) {
  const {
    agentRuntime,
    sessionDeps,
    planningGate,
    nowIso,
    dispatchDeterministic,
    dispatchManagedAsync,
    finalizeFocus,
    deterministicDispatchDeps,
    managedAsyncDispatchDeps,
    resolveIdempotencyKey,
    persistImmediateRunResult,
  } = deps;

  /**
   * Persist an assistant message into the session and finalize focus.
   */
  async function finalizeControlPlane(
    input: FridayEngineRunInput,
    prepared: FridayPreparedEngineContext,
    responseText: string,
    kind: "deterministic" | "planning" | "planning-reject",
    pendingPlanRunId?: string | null,
  ): Promise<FridayEngineRunResult> {
    const result: FridayEngineRunResult = {
      runId: input.runId,
      status: "completed",
      response: responseText,
      toolCallCount: 0,
      durationMs: 0,
      turnKind: prepared.conversationContext?.turnKind,
    };

    await persistImmediateRunResult?.({
      runId: input.runId,
      task: input.task,
      sessionKey: input.sessionKey,
      providerId: input.providerId,
      model: input.model,
      constraints: input.constraints,
      responseText,
    });

    if (input.sessionKey && sessionDeps) {
      await sessionDeps
        .addMessage(input.sessionKey, {
          role: "assistant",
          content: responseText,
          contentText: responseText,
          idempotencyKey: resolveIdempotencyKey({ runId: input.runId, kind }),
        })
        .catch((err) => { console.warn("[friday][run-executor] addMessage:", err instanceof Error ? err.message : String(err)); return undefined; });
      await sessionDeps
        .setConversationFocus(
          input.sessionKey,
          finalizeFocus({
            task: input.task,
            responseText,
            runId: input.runId,
            turnKind: prepared.conversationContext?.turnKind ?? "new_topic",
            focusState: prepared.focusState,
            currentUserSequence: prepared.currentUserSequence,
            replyAnchorMessageId: prepared.replyAnchorMessageId,
            replyAnchorSequence: prepared.replyAnchorSequence,
            pendingPlanRunId: pendingPlanRunId ?? null,
            nowIso: nowIso(),
          }),
        )
        .catch((err) => { console.warn("[friday][run-executor] setConversationFocus:", err instanceof Error ? err.message : String(err)); return undefined; });
    }

    return result;
  }

  /**
   * Convert an `FridayAgentRuntimeResult` to `FridayEngineRunResult`.
   */
  function fromRuntimeResult(
    r: FridayAgentRuntimeResult,
    turnKind?: FridayEngineRunResult["turnKind"],
  ): FridayEngineRunResult {
    return {
      runId: r.runId,
      status: toTerminalStatus(r.status),
      response: r.finalResponse ?? r.response,
      toolCallCount: r.toolCallCount,
      durationMs: r.durationMs,
      turnKind: turnKind as FridayEngineRunResult["turnKind"],
      usageInput: r.usageInput,
      usageOutput: r.usageOutput,
      images: r.images,
      contextCostSummary: r.contextCostSummary,
      taskProfile: r.taskProfile,
      error: toRunError(r.status),
    };
  }

  /**
   * Execute a run given already-prepared context.
   */
  async function execute(
    input: FridayEngineRunInput,
    prepared: FridayPreparedEngineContext,
  ): Promise<FridayEngineRunResult> {
    const task = input.task.trim();
    const turnKind = prepared.conversationContext?.turnKind ?? "new_topic";

    // ── 1. Deterministic (sync_immediate) dispatch ──
    if (prepared.executionClassification.category === "sync_immediate") {
      const result = await dispatchDeterministic(
        {
          classification: prepared.executionClassification,
          sessionKey: input.sessionKey,
          runId: input.runId,
          actorId: input.principalId,
        },
        deterministicDispatchDeps,
      );
      if (result.handled && result.response) {
        return finalizeControlPlane(input, prepared, result.response, "deterministic");
      }
    }

    // ── 2. Managed async dispatch ──
    if (prepared.executionClassification.category === "managed_async") {
      const result = await dispatchManagedAsync(
        { classification: prepared.executionClassification },
        managedAsyncDispatchDeps,
      );
      if (result.handled && result.response) {
        return finalizeControlPlane(input, prepared, result.response, "deterministic");
      }
    }

    // ── 3. Planning gate ──
    if (planningGate) {
      const decision = planningGate.handleTurn({
        runId: input.runId,
        task,
        sessionKey: input.sessionKey,
        providerId: input.providerId,
        model: input.model,
        constraints: input.constraints,
        reviewRequired: input.reviewRequired,
        conversationContext: prepared.conversationContext,
        focusState: prepared.focusState,
      });

      if (decision.action === "return") {
        if (input.sessionKey && sessionDeps) {
          await sessionDeps
            .addMessage(input.sessionKey, {
              role: "assistant",
              content: decision.result.response,
              contentText: decision.result.response,
              idempotencyKey: resolveIdempotencyKey({
                runId: decision.result.runId,
                kind: "planning",
                status: decision.result.status,
              }),
            })
            .catch((err) => { console.warn("[friday][run-executor] addMessage (planning):", err instanceof Error ? err.message : String(err)); return undefined; });
          await sessionDeps
            .setConversationFocus(
              input.sessionKey,
              finalizeFocus({
                task,
                responseText: decision.result.response,
                runId: decision.result.runId,
                turnKind,
                focusState: prepared.focusState,
                currentUserSequence: prepared.currentUserSequence,
                replyAnchorMessageId: prepared.replyAnchorMessageId,
                replyAnchorSequence: prepared.replyAnchorSequence,
                pendingPlanRunId: decision.pendingPlanRunId ?? null,
                nowIso: nowIso(),
              }),
            )
            .catch((err) => { console.warn("[friday][run-executor] setConversationFocus (planning):", err instanceof Error ? err.message : String(err)); return undefined; });
        }
        return fromRuntimeResult(decision.result, turnKind);
      }

      if (decision.action === "approve") {
        const approved = await planningGate.approvePlan({
          runId: decision.runId,
          sessionKey: input.sessionKey,
          providerId: input.providerId,
          tenantContext: input.tenantContext,
          model: input.model,
          timezone: input.timezone,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          constraints: input.constraints,
          principalId: input.principalId,
          scopes: input.scopes,
          executionContext: input.executionContext,
          historyMessages: prepared.historyMessages,
          conversationContext: prepared.conversationContext,
          taskProfile: input.taskProfile,
        });
        if (input.sessionKey && sessionDeps) {
          const latestFocus = await sessionDeps
            .getConversationFocus(input.sessionKey)
            .catch((err) => { console.warn("[friday][run-executor] getConversationFocus (approve):", err instanceof Error ? err.message : String(err)); return prepared.focusState; });
          await sessionDeps
            .setConversationFocus(
              input.sessionKey,
              finalizeFocus({
                task,
                responseText: approved.response,
                runId: approved.runId,
                turnKind,
                focusState: latestFocus,
                currentUserSequence: prepared.currentUserSequence,
                replyAnchorMessageId: prepared.replyAnchorMessageId,
                replyAnchorSequence: prepared.replyAnchorSequence,
                pendingPlanRunId:
                  approved.status === "awaiting_clarification" || approved.status === "awaiting_plan_approval"
                    ? approved.runId
                    : null,
                nowIso: nowIso(),
              }),
            )
            .catch((err) => { console.warn("[friday][run-executor] setConversationFocus (approve):", err instanceof Error ? err.message : String(err)); return undefined; });
        }
        return fromRuntimeResult(approved, turnKind);
      }

      if (decision.action === "reject") {
        const rejected = planningGate.rejectPlan({ runId: decision.runId });
        if (input.sessionKey && sessionDeps) {
          await sessionDeps
            .addMessage(input.sessionKey, {
              role: "assistant",
              content: rejected.response,
              contentText: rejected.response,
              idempotencyKey: resolveIdempotencyKey({ runId: rejected.runId, kind: "planning-reject" }),
            })
            .catch((err) => { console.warn("[friday][run-executor] addMessage (reject):", err instanceof Error ? err.message : String(err)); return undefined; });
          await sessionDeps
            .setConversationFocus(
              input.sessionKey,
              finalizeFocus({
                task,
                responseText: rejected.response,
                runId: rejected.runId,
                turnKind,
                focusState: prepared.focusState,
                currentUserSequence: prepared.currentUserSequence,
                replyAnchorMessageId: prepared.replyAnchorMessageId,
                replyAnchorSequence: prepared.replyAnchorSequence,
                pendingPlanRunId: null,
                nowIso: nowIso(),
              }),
            )
            .catch((err) => { console.warn("[friday][run-executor] setConversationFocus (reject):", err instanceof Error ? err.message : String(err)); return undefined; });
        }
        return fromRuntimeResult(rejected, turnKind);
      }
    }

    // ── 4. Full agent runtime execution ──
    const runtimeResult = await agentRuntime.executeRun({
      task,
      taskPrompt: prepared.taskPrompt,
      conversationContext: prepared.conversationContext,
      sessionKey: input.sessionKey,
      runId: input.runId,
      providerId: input.providerId,
      tenantContext: input.tenantContext,
      model: input.model,
      timezone: input.timezone,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      reviewRequired: input.reviewRequired,
      constraints:
        turnKind === "status_check"
          ? { ...(input.constraints ?? {}), readOnly: true }
          : input.constraints,
      principalId: input.principalId,
      scopes: input.scopes,
      executionContext: input.executionContext,
      historyMessages: prepared.historyMessages,
      taskProfile: input.taskProfile,
    });

    // ── 5. Finalize focus after agent run ──
    if (input.sessionKey && sessionDeps && turnKind) {
      const latestFocus = await sessionDeps
        .getConversationFocus(input.sessionKey)
        .catch((err) => { console.warn("[friday][run-executor] getConversationFocus (finalize):", err instanceof Error ? err.message : String(err)); return prepared.focusState; });
      const pendingPlanRunId =
        runtimeResult.status === "awaiting_clarification" || runtimeResult.status === "awaiting_plan_approval"
          ? runtimeResult.runId
          : turnKind === "status_check"
            ? undefined
            : null;
      await sessionDeps
        .setConversationFocus(
          input.sessionKey,
          finalizeFocus({
            task,
            responseText: runtimeResult.response,
            runId: runtimeResult.runId,
            turnKind,
            focusState: latestFocus,
            currentUserSequence: prepared.currentUserSequence,
            replyAnchorMessageId: prepared.replyAnchorMessageId,
            replyAnchorSequence: prepared.replyAnchorSequence,
            pendingPlanRunId,
            nowIso: nowIso(),
          }),
        )
        .catch((err) => { console.warn("[friday][run-executor] setConversationFocus (finalize):", err instanceof Error ? err.message : String(err)); return undefined; });
    }

    return fromRuntimeResult(runtimeResult, turnKind);
  }

  return { execute };
}
