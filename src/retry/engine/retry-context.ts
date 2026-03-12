/**
 * Retry Context Tracker — Tracks retry history, attempt counts, and timing
 * for active retry sequences.
 *
 * Each retry context is keyed by a composite scope: `(runId, nodeId)`.
 * The tracker maintains in-memory state for all active retry sequences
 * and provides methods to record attempts, query history, and compute
 * aggregated cost summaries.
 *
 * This module does NOT handle persistence — it is a runtime state container.
 * Persistence is handled by the repository layer (future phase).
 *
 * @module retry/engine
 */

import type {
  FridayClassifiedFailure,
  FridayFailureCategory,
  FridayRetryAttemptOutcome,
  FridayRetryCostDimensions,
  FridayRetryDecision,
  FridayRetryTraceStatus,
} from "../model/friday-retry-engine.types.js";

import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";

// ─── Types ───

/** Internal lifecycle states used to enforce valid retry context transitions. */
type RetryLifecycleState =
  | "pending"
  | "retrying"
  | "exhausted"
  | "escalated"
  | "recovered";

const ALLOWED_TRANSITIONS: Readonly<Record<RetryLifecycleState, readonly RetryLifecycleState[]>> =
  {
    pending: ["retrying"],
    retrying: ["retrying", "exhausted", "escalated", "recovered"],
    exhausted: [],
    escalated: [],
    recovered: [],
  };

const TERMINAL_STATES = new Set<RetryLifecycleState>([
  "exhausted",
  "escalated",
  "recovered",
]);

/** Composite key for a retry context scope. */
export interface RetryContextKey {
  runId: UUID;
  nodeId: string;
}

/** A recorded retry attempt within a context. */
export interface RetryAttemptRecord {
  /** Attempt number (1-based). */
  attemptNumber: number;
  /** Classified failure that triggered the attempt. */
  classifiedFailure: FridayClassifiedFailure;
  /** Decision that authorized the attempt. */
  decision: FridayRetryDecision;
  /** Actual delay waited before the attempt in milliseconds. */
  delayMs: number;
  /** Outcome of the attempt. */
  outcome: FridayRetryAttemptOutcome;
  /** Cost consumed by the attempt. */
  cost: FridayRetryCostDimensions;
  /** When the attempt started. */
  startedAt: ISODateTime;
  /** When the attempt completed. */
  completedAt: ISODateTime;
  /** Error code (if the attempt failed). */
  errorCode?: string;
  /** Error message (if the attempt failed). */
  errorMessage?: string;
}

/** Full retry context for a (runId, nodeId) pair. */
export interface RetryContextState {
  /** Composite key. */
  key: RetryContextKey;
  /** Workflow definition ID. */
  workflowId: UUID;
  /** Current status. */
  status: FridayRetryTraceStatus;
  /** Original failure category. */
  originalFailureCategory: FridayFailureCategory;
  /** All recorded attempts in order. */
  attempts: RetryAttemptRecord[];
  /** Accumulated cost across all attempts. */
  accumulatedCost: FridayRetryCostDimensions;
  /** When the first failure was recorded. */
  firstFailureAt: ISODateTime;
  /** When the context was last updated. */
  lastUpdatedAt: ISODateTime;
  /** When the context was resolved (if applicable). */
  resolvedAt?: ISODateTime;
}

/** Configuration for the retry context tracker. */
export interface RetryContextTrackerConfig {
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
}

/** Parameters to initialize a new retry context. */
export interface InitContextParams {
  runId: UUID;
  workflowId: UUID;
  nodeId: string;
  originalFailureCategory: FridayFailureCategory;
}

/** Parameters to record a retry attempt. */
export interface RecordAttemptParams {
  classifiedFailure: FridayClassifiedFailure;
  decision: FridayRetryDecision;
  delayMs: number;
  outcome: FridayRetryAttemptOutcome;
  cost: FridayRetryCostDimensions;
  startedAt: ISODateTime;
  completedAt: ISODateTime;
  errorCode?: string;
  errorMessage?: string;
}

// ─── Helpers ───

/**
 * Build a string key from a composite key for Map lookups.
 */
function toMapKey(key: RetryContextKey): string {
  return `${key.runId}::${key.nodeId}`;
}

/**
 * Add two cost dimension objects.
 */
function addCosts(
  a: FridayRetryCostDimensions,
  b: FridayRetryCostDimensions,
): FridayRetryCostDimensions {
  return {
    tokens: a.tokens + b.tokens,
    apiCalls: a.apiCalls + b.apiCalls,
    computeMs: a.computeMs + b.computeMs,
  };
}

/** Zero cost dimensions. */
export const ZERO_COST: Readonly<FridayRetryCostDimensions> = {
  tokens: 0,
  apiCalls: 0,
  computeMs: 0,
};

/**
 * Deep-freeze a plain object/array tree.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    deepFreeze(child);
  }

  return Object.freeze(value);
}

/**
 * Clone and freeze value for immutable read APIs.
 */
function createSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * Convert public trace status to internal lifecycle state.
 */
function toLifecycleState(ctx: RetryContextState): RetryLifecycleState {
  switch (ctx.status) {
    case "in_progress":
      return ctx.attempts.length === 0 ? "pending" : "retrying";
    case "resolved":
      return "recovered";
    case "exhausted":
      return "exhausted";
    case "escalated":
    case "cancelled":
      return "escalated";
    case "budget_exceeded":
      return "exhausted";
  }
}

/**
 * Convert internal lifecycle state back to public trace status.
 */
function toTraceStatus(state: RetryLifecycleState): FridayRetryTraceStatus {
  switch (state) {
    case "pending":
    case "retrying":
      return "in_progress";
    case "recovered":
      return "resolved";
    case "exhausted":
      return "exhausted";
    case "escalated":
      return "escalated";
  }
}

// ─── Retry Context Tracker ───

/**
 * Creates an in-memory retry context tracker.
 *
 * @param config - Tracker configuration.
 * @returns A tracker instance with methods to manage retry contexts.
 */
export function createRetryContextTracker(config: RetryContextTrackerConfig) {
  const contexts = new Map<string, RetryContextState>();

  /**
   * Transition context lifecycle with strict transition validation.
   *
   * Supports synthesized `pending -> retrying -> terminal` transitions
   * in a single mutation when the first recorded attempt is terminal.
   */
  function transitionContext(
    ctx: RetryContextState,
    target: RetryLifecycleState,
    mutation: string,
  ): void {
    let current = toLifecycleState(ctx);
    const path: RetryLifecycleState[] =
      current === "pending" && target !== "retrying" ? ["retrying", target] : [target];

    for (const next of path) {
      if (!ALLOWED_TRANSITIONS[current].includes(next)) {
        throw new Error(
          `Invalid retry context transition (${current} -> ${next}) during ${mutation}`,
        );
      }

      current = next;
      ctx.status = toTraceStatus(next);
    }

    const now = config.nowIso();
    ctx.lastUpdatedAt = now;
    ctx.resolvedAt = TERMINAL_STATES.has(current) ? now : undefined;
  }

  /**
   * Ensure a context is mutable (not terminal).
   */
  function assertMutable(ctx: RetryContextState, mutation: string): void {
    const lifecycle = toLifecycleState(ctx);
    if (TERMINAL_STATES.has(lifecycle)) {
      throw new Error(
        `Cannot mutate terminal retry context (${lifecycle}) during ${mutation}`,
      );
    }
  }

  /**
   * Initialize a new retry context for a (runId, nodeId) pair.
   * If a context already exists and is still in-progress, returns the existing one.
   *
   * @param params - Initialization parameters.
   * @returns The new or existing retry context.
   */
  function initContext(params: InitContextParams): RetryContextState {
    const key: RetryContextKey = { runId: params.runId, nodeId: params.nodeId };
    const mapKey = toMapKey(key);

    const existing = contexts.get(mapKey);
    if (existing && existing.status === "in_progress") {
      return createSnapshot(existing);
    }

    const ctx: RetryContextState = {
      key,
      workflowId: params.workflowId,
      status: "in_progress",
      originalFailureCategory: params.originalFailureCategory,
      attempts: [],
      accumulatedCost: { ...ZERO_COST },
      firstFailureAt: config.nowIso(),
      lastUpdatedAt: config.nowIso(),
    };

    contexts.set(mapKey, ctx);
    return createSnapshot(ctx);
  }

  /**
   * Record a retry attempt on an existing context.
   *
   * @param key - Context key.
   * @param params - Attempt parameters.
   * @returns The updated context, or undefined if no context exists.
   */
  function recordAttempt(
    key: RetryContextKey,
    params: RecordAttemptParams,
  ): RetryContextState | undefined {
    const mapKey = toMapKey(key);
    const ctx = contexts.get(mapKey);
    if (!ctx) return undefined;
    assertMutable(ctx, "recordAttempt");

    const attemptNumber = ctx.attempts.length + 1;

    ctx.attempts.push({
      attemptNumber,
      classifiedFailure: params.classifiedFailure,
      decision: params.decision,
      delayMs: params.delayMs,
      outcome: params.outcome,
      cost: params.cost,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
    });

    ctx.accumulatedCost = addCosts(ctx.accumulatedCost, params.cost);

    const targetState: RetryLifecycleState = (() => {
      switch (params.outcome) {
        case "failure":
        case "timeout":
          return "retrying";
        case "success":
          return "recovered";
        case "cancelled":
        case "rules_denied":
          return "escalated";
        case "budget_exceeded":
          return "exhausted";
      }
    })();

    transitionContext(ctx, targetState, "recordAttempt");
    return createSnapshot(ctx);
  }

  /**
   * Mark a context as exhausted (all retries consumed without success).
   */
  function markExhausted(key: RetryContextKey): RetryContextState | undefined {
    const ctx = contexts.get(toMapKey(key));
    if (!ctx) return undefined;
    assertMutable(ctx, "markExhausted");
    transitionContext(ctx, "exhausted", "markExhausted");
    return createSnapshot(ctx);
  }

  /**
   * Mark a context as escalated.
   */
  function markEscalated(key: RetryContextKey): RetryContextState | undefined {
    const ctx = contexts.get(toMapKey(key));
    if (!ctx) return undefined;
    assertMutable(ctx, "markEscalated");
    transitionContext(ctx, "escalated", "markEscalated");
    return createSnapshot(ctx);
  }

  /**
   * Get the retry context for a (runId, nodeId) pair.
   */
  function getContext(key: RetryContextKey): RetryContextState | undefined {
    const ctx = contexts.get(toMapKey(key));
    return ctx ? createSnapshot(ctx) : undefined;
  }

  /**
   * Get the current attempt count for a context.
   */
  function getAttemptCount(key: RetryContextKey): number {
    return contexts.get(toMapKey(key))?.attempts.length ?? 0;
  }

  /**
   * Get the accumulated cost for a context.
   */
  function getAccumulatedCost(key: RetryContextKey): FridayRetryCostDimensions {
    return createSnapshot(contexts.get(toMapKey(key))?.accumulatedCost ?? { ...ZERO_COST });
  }

  /**
   * Get all active (in-progress) contexts.
   */
  function getActiveContexts(): readonly RetryContextState[] {
    return createSnapshot(
      [...contexts.values()].filter((ctx) => ctx.status === "in_progress"),
    );
  }

  /**
   * Get all contexts (all statuses).
   */
  function getAllContexts(): readonly RetryContextState[] {
    return createSnapshot([...contexts.values()]);
  }

  /**
   * Remove a context by key.
   */
  function removeContext(key: RetryContextKey): boolean {
    return contexts.delete(toMapKey(key));
  }

  /**
   * Clear all contexts.
   */
  function clear(): void {
    contexts.clear();
  }

  /**
   * Get a summary of all contexts by status.
   */
  function getSummary(): Record<FridayRetryTraceStatus, number> {
    const summary: Record<FridayRetryTraceStatus, number> = {
      in_progress: 0,
      resolved: 0,
      exhausted: 0,
      escalated: 0,
      cancelled: 0,
      budget_exceeded: 0,
    };

    for (const ctx of contexts.values()) {
      summary[ctx.status]++;
    }

    return createSnapshot(summary);
  }

  return {
    initContext,
    recordAttempt,
    markExhausted,
    markEscalated,
    getContext,
    getAttemptCount,
    getAccumulatedCost,
    getActiveContexts,
    getAllContexts,
    removeContext,
    clear,
    getSummary,
  };
}

/** Type of the retry context tracker returned by {@link createRetryContextTracker}. */
export type RetryContextTrackerInstance = ReturnType<typeof createRetryContextTracker>;
