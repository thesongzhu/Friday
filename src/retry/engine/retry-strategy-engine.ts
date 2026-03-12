/**
 * Retry Strategy Engine — Computes retry delays from policy strategies.
 *
 * Supports five backoff models:
 *   - **exponential**: delay = baseDelay × 2^(attempt-1), capped at maxDelay
 *   - **linear**: delay = baseDelay × attempt, capped at maxDelay
 *   - **fixed**: delay = baseDelay (constant)
 *   - **immediate**: delay = 0
 *   - **none**: no retry (escalate immediately)
 *
 * All backoff variants (exponential, linear, fixed) apply configurable
 * jitter to prevent thundering herd on retry storms.
 *
 * The engine also resolves strategy selection from a policy's strategy
 * list based on failure category, respecting `Retry-After` headers
 * and timeout multipliers.
 *
 * @module retry/engine
 */

import type {
  FridayClassifiedFailure,
  FridayFailureCategory,
  FridayRetryCostBudget,
  FridayRetryCostDimensions,
  FridayRetryDecision,
  FridayRetryDecisionContext,
  FridayRetryPolicy,
  FridayRetryStrategy,
  FridayRetryStrategyType,
} from "../model/friday-retry-engine.types.js";

import type { ISODateTime, UUID } from "../../rules/model/friday-rules-engine.types.js";

// ─── Configuration ───

/** Configuration for the retry strategy engine. */
export interface RetryStrategyEngineConfig {
  /** Generate a new UUID. */
  generateId: () => UUID;
  /** Get current ISO timestamp. */
  nowIso: () => ISODateTime;
}

const ZERO_COST: Readonly<FridayRetryCostDimensions> = {
  tokens: 0,
  apiCalls: 0,
  computeMs: 0,
};

// ─── Delay Computation ───

/**
 * Compute the raw delay for a given strategy and attempt number.
 * Does not apply jitter — call {@link applyJitter} separately.
 *
 * @param strategy - The retry strategy variant.
 * @param attemptNumber - Current attempt number (1-based, first retry = 1).
 * @returns Delay in milliseconds before the next attempt.
 */
export function computeRawDelay(
  strategy: FridayRetryStrategy,
  attemptNumber: number,
): number {
  switch (strategy.strategy) {
    case "exponential": {
      const delay = strategy.baseDelayMs * Math.pow(2, attemptNumber - 1);
      return Math.min(delay, strategy.maxDelayMs);
    }
    case "linear": {
      const delay = strategy.baseDelayMs * attemptNumber;
      return Math.min(delay, strategy.maxDelayMs);
    }
    case "fixed": {
      return Math.min(strategy.baseDelayMs, strategy.maxDelayMs);
    }
    case "immediate":
      return 0;
    case "custom": {
      // Custom strategies fall back to base delay if provided, otherwise 0.
      const base = strategy.baseDelayMs ?? 0;
      const max = strategy.maxDelayMs ?? base;
      return Math.min(base, max);
    }
    case "none":
      return 0;
  }
}

/**
 * Apply jitter to a computed delay.
 *
 * Jitter is applied as a random deviation within ±jitterPercent of the delay.
 * The result is clamped to a minimum of 0.
 *
 * @param delayMs - Base delay in milliseconds.
 * @param jitterPercent - Jitter range as a percentage (0–100).
 * @param random - Random number source (0–1). Defaults to Math.random().
 * @returns Delay with jitter applied.
 */
export function applyJitter(
  delayMs: number,
  jitterPercent: number,
  random: number = Math.random(),
): number {
  if (jitterPercent <= 0 || delayMs <= 0) return delayMs;
  const jitterFraction = jitterPercent / 100;
  // Map random [0, 1) to [-1, 1) for bidirectional jitter.
  const jitterMultiplier = (random * 2 - 1) * jitterFraction;
  return Math.max(0, Math.round(delayMs * (1 + jitterMultiplier)));
}

/**
 * Get the jitter percent from a strategy (0 for strategies without jitter).
 */
function getJitterPercent(strategy: FridayRetryStrategy): number {
  switch (strategy.strategy) {
    case "exponential":
    case "linear":
    case "fixed":
      return strategy.jitterPercent;
    case "custom":
      return strategy.jitterPercent ?? 0;
    case "immediate":
    case "none":
      return 0;
  }
}

/**
 * Compute the full delay for a strategy including jitter.
 *
 * @param strategy - The retry strategy variant.
 * @param attemptNumber - Current attempt number (1-based).
 * @param random - Optional random number source for deterministic tests.
 * @returns Final delay in milliseconds.
 */
export function computeDelay(
  strategy: FridayRetryStrategy,
  attemptNumber: number,
  random?: number,
): number {
  const raw = computeRawDelay(strategy, attemptNumber);
  return applyJitter(raw, getJitterPercent(strategy), random);
}

// ─── Strategy Resolution ───

/**
 * Find the matching strategy for a failure category within a policy.
 * Returns undefined if no strategy is defined for the category.
 */
export function findStrategyForCategory(
  strategies: FridayRetryStrategy[],
  category: FridayFailureCategory,
): FridayRetryStrategy | undefined {
  return strategies.find((s) => s.failureCategory === category);
}

// ─── Budget Check ───

/**
 * Check whether a retry is within the cost budget.
 *
 * @param accumulated - Cost accumulated so far.
 * @param budget - Budget limits to enforce.
 * @returns True if all dimensions are within budget.
 */
export function isWithinBudget(
  accumulated: FridayRetryCostDimensions,
  budget: FridayRetryCostBudget,
): boolean {
  return (
    accumulated.tokens <= budget.maxTotalTokens &&
    accumulated.apiCalls <= budget.maxTotalApiCalls &&
    accumulated.computeMs <= budget.maxTotalComputeMs
  );
}

/**
 * Check whether a single attempt is within the per-attempt budget.
 */
function isWithinPerAttemptBudget(
  attemptCost: FridayRetryCostDimensions,
  perAttemptBudget: FridayRetryCostDimensions,
): boolean {
  return (
    attemptCost.tokens <= perAttemptBudget.tokens &&
    attemptCost.apiCalls <= perAttemptBudget.apiCalls &&
    attemptCost.computeMs <= perAttemptBudget.computeMs
  );
}

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

// ─── Retry Decision Builder ───

/**
 * Build a retry decision from a classified failure and context.
 *
 * This is a pure, synchronous decision function. It does NOT consult the
 * Rules Engine (that integration is layered on top). It produces a decision
 * based solely on the strategy, budget, and attempt count.
 *
 * @param classifiedFailure - The classified failure.
 * @param context - Decision context (attempt number, budget, etc.).
 * @param strategies - Available retry strategies from the policy.
 * @param config - Engine configuration for ID generation and timestamps.
 * @returns A retry decision.
 */
export function buildRetryDecision(
  classifiedFailure: FridayClassifiedFailure,
  context: FridayRetryDecisionContext,
  strategies: FridayRetryStrategy[],
  config: RetryStrategyEngineConfig,
): FridayRetryDecision {
  const category = classifiedFailure.category;
  const strategy = findStrategyForCategory(strategies, category);

  // No strategy found — default to no retry with escalation.
  if (!strategy) {
    return createNoRetryDecision(
      classifiedFailure,
      context,
      "none",
      "No retry strategy defined for failure category",
      true,
      config,
    );
  }

  // Strategy is 'none' — escalate immediately.
  if (strategy.strategy === "none") {
    return createNoRetryDecision(
      classifiedFailure,
      context,
      "none",
      `Failure category '${category}' is configured to escalate immediately`,
      true,
      config,
      strategy.escalationChannel,
    );
  }

  // Check attempt count.
  if (context.currentAttemptNumber >= strategy.maxAttempts) {
    return createNoRetryDecision(
      classifiedFailure,
      context,
      strategy.strategy,
      `Retry attempts exhausted (${context.currentAttemptNumber}/${strategy.maxAttempts})`,
      strategy.escalateOnExhaustion,
      config,
      strategy.escalationChannel,
    );
  }

  const attemptCost = context.currentAttemptCost ?? ZERO_COST;

  // Check per-attempt cost budget.
  if (context.costBudget.maxCostPerAttempt) {
    if (!isWithinPerAttemptBudget(attemptCost, context.costBudget.maxCostPerAttempt)) {
      return createNoRetryDecision(
        classifiedFailure,
        context,
        strategy.strategy,
        "Per-attempt retry cost budget exceeded",
        true,
        config,
        strategy.escalationChannel,
      );
    }
  }

  // Check cumulative budget including the current attempt projection.
  const projectedAccumulatedCost = addCosts(context.accumulatedCost, attemptCost);
  if (!isWithinBudget(projectedAccumulatedCost, context.costBudget)) {
    return createNoRetryDecision(
      classifiedFailure,
      context,
      strategy.strategy,
      "Retry cost budget exceeded",
      true,
      config,
      strategy.escalationChannel,
    );
  }

  // Compute delay.
  const nextAttempt = context.currentAttemptNumber + 1;
  let delayMs = computeDelay(strategy, nextAttempt);

  // Respect Retry-After header if configured and available.
  if (strategy.respectRetryAfter && classifiedFailure.retryAfterMs !== undefined) {
    delayMs = Math.max(delayMs, classifiedFailure.retryAfterMs);
  }

  // Compute timeout override if applicable.
  const nextTimeoutMs =
    strategy.timeoutMultiplier > 1.0
      ? Math.round(
          (context.nodeRetryPolicy?.maxDelayMs ?? 30_000) * strategy.timeoutMultiplier,
        )
      : undefined;

  const idempotencyKey = `retry:${context.runId}:${context.nodeId}:${nextAttempt}`;

  return {
    shouldRetry: true,
    nextAttemptNumber: nextAttempt,
    delayMs,
    reason: `Retrying '${category}' failure with ${strategy.strategy} strategy (attempt ${nextAttempt}/${strategy.maxAttempts})`,
    failureCategory: category,
    strategyType: strategy.strategy,
    rulesOverride: false,
    budgetConstrained: false,
    escalate: false,
    nextTimeoutMs,
    idempotencyKey,
    decidedAt: config.nowIso(),
  };
}

/**
 * Build a no-retry decision.
 */
function createNoRetryDecision(
  classifiedFailure: FridayClassifiedFailure,
  context: FridayRetryDecisionContext,
  strategyType: FridayRetryStrategyType,
  reason: string,
  escalate: boolean,
  config: RetryStrategyEngineConfig,
  escalationChannel?: string,
): FridayRetryDecision {
  const idempotencyKey = `retry:${context.runId}:${context.nodeId}:${context.currentAttemptNumber}:no-retry`;

  return {
    shouldRetry: false,
    nextAttemptNumber: context.currentAttemptNumber,
    delayMs: 0,
    reason,
    failureCategory: classifiedFailure.category,
    strategyType,
    rulesOverride: false,
    budgetConstrained: reason.includes("budget"),
    escalate,
    escalationChannel: escalationChannel ?? (escalate ? "operator" : undefined),
    idempotencyKey,
    decidedAt: config.nowIso(),
  };
}

// ─── Factory ───

/**
 * Creates a retry strategy engine instance.
 *
 * The engine provides stateless strategy resolution and delay computation.
 * It does not manage state — that is handled by the retry context tracker.
 *
 * @param config - Engine configuration.
 */
export function createRetryStrategyEngine(config: RetryStrategyEngineConfig) {
  return {
    /**
     * Compute the delay for a strategy and attempt number.
     */
    computeDelay(
      strategy: FridayRetryStrategy,
      attemptNumber: number,
      random?: number,
    ): number {
      return computeDelay(strategy, attemptNumber, random);
    },

    /**
     * Find the matching strategy for a failure category.
     */
    findStrategy(
      strategies: FridayRetryStrategy[],
      category: FridayFailureCategory,
    ): FridayRetryStrategy | undefined {
      return findStrategyForCategory(strategies, category);
    },

    /**
     * Check whether accumulated cost is within budget.
     */
    isWithinBudget(
      accumulated: FridayRetryCostDimensions,
      budget: FridayRetryCostBudget,
    ): boolean {
      return isWithinBudget(accumulated, budget);
    },

    /**
     * Build a complete retry decision.
     */
    buildDecision(
      classifiedFailure: FridayClassifiedFailure,
      context: FridayRetryDecisionContext,
      strategies: FridayRetryStrategy[],
    ): FridayRetryDecision {
      return buildRetryDecision(classifiedFailure, context, strategies, config);
    },
  };
}

/** Type of the retry strategy engine returned by {@link createRetryStrategyEngine}. */
export type RetryStrategyEngineInstance = ReturnType<typeof createRetryStrategyEngine>;
