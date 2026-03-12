/**
 * Retry Budget — Rate limiter for retries to prevent thundering herd.
 *
 * The retry budget enforces two complementary limits:
 *
 *   1. **Token bucket**: Limits the rate of retry attempts across all targets.
 *      Each retry consumes one token; tokens refill at a steady rate.
 *
 *   2. **Concurrent retry cap**: Limits how many retries can be in-flight
 *      simultaneously to prevent resource exhaustion.
 *
 * Both limits are applied globally (across all failure categories and targets).
 * Per-target or per-category budgets should be layered on top via separate
 * budget instances keyed by scope.
 *
 * @module retry/engine
 */

// ─── Types ───

/** Configuration for the retry budget. */
export interface RetryBudgetConfig {
  /**
   * Maximum number of tokens in the bucket.
   * This is the burst capacity — the maximum retries that can be issued
   * in a short window before refill kicks in.
   * @default 20
   */
  maxTokens: number;

  /**
   * Token refill rate: tokens added per second.
   * @default 2
   */
  refillRatePerSecond: number;

  /**
   * Maximum concurrent retries allowed.
   * @default 10
   */
  maxConcurrent: number;
}

/** Snapshot of the retry budget state. */
export interface RetryBudgetSnapshot {
  /** Current available tokens. */
  availableTokens: number;
  /** Maximum tokens (burst capacity). */
  maxTokens: number;
  /** Currently in-flight retries. */
  activeRetries: number;
  /** Maximum concurrent retries allowed. */
  maxConcurrent: number;
  /** Total retries granted since creation or last reset. */
  totalGranted: number;
  /** Total retries denied since creation or last reset. */
  totalDenied: number;
}

/** Default retry budget configuration. */
export const DEFAULT_RETRY_BUDGET_CONFIG: Readonly<RetryBudgetConfig> = {
  maxTokens: 20,
  refillRatePerSecond: 2,
  maxConcurrent: 10,
};

// ─── Token Bucket Implementation ───

/**
 * Creates a retry budget (token-bucket rate limiter + concurrency limiter).
 *
 * @param config - Budget configuration.
 * @param nowMs - Clock function returning current time in ms. Defaults to Date.now.
 * @returns A retry budget instance with acquire/release/query methods.
 */
export function createRetryBudget(
  config: RetryBudgetConfig = DEFAULT_RETRY_BUDGET_CONFIG,
  nowMs: () => number = Date.now,
) {
  let tokens = config.maxTokens;
  let lastRefillAt = nowMs();
  let activeRetries = 0;
  let totalGranted = 0;
  let totalDenied = 0;

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  function refill(): void {
    const now = nowMs();
    const elapsedMs = now - lastRefillAt;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 1000) * config.refillRatePerSecond;
    tokens = Math.min(config.maxTokens, tokens + tokensToAdd);
    lastRefillAt = now;
  }

  /**
   * Attempt to acquire a retry permit.
   *
   * Returns true if both conditions are met:
   *   1. At least one token is available in the bucket.
   *   2. The concurrent retry count is below the cap.
   *
   * On success, one token is consumed and the active retry counter increments.
   * The caller MUST call {@link release} when the retry completes.
   *
   * @returns True if the retry is permitted, false if denied.
   */
  function acquire(): boolean {
    refill();

    if (tokens < 1 || activeRetries >= config.maxConcurrent) {
      totalDenied++;
      return false;
    }

    tokens -= 1;
    activeRetries++;
    totalGranted++;
    return true;
  }

  /**
   * Release a retry permit after the retry completes (success or failure).
   * Must be called exactly once for each successful {@link acquire}.
   */
  function release(): void {
    if (activeRetries > 0) {
      activeRetries--;
    }
  }

  /**
   * Check whether a retry would be permitted without consuming a token.
   * Useful for dry-run decisions.
   *
   * @returns True if a retry would currently be permitted.
   */
  function canAcquire(): boolean {
    refill();
    return tokens >= 1 && activeRetries < config.maxConcurrent;
  }

  /**
   * Get a snapshot of the current budget state.
   */
  function getSnapshot(): RetryBudgetSnapshot {
    refill();
    return {
      availableTokens: Math.floor(tokens),
      maxTokens: config.maxTokens,
      activeRetries,
      maxConcurrent: config.maxConcurrent,
      totalGranted,
      totalDenied,
    };
  }

  /**
   * Reset the budget to its initial state.
   */
  function reset(): void {
    tokens = config.maxTokens;
    lastRefillAt = nowMs();
    activeRetries = 0;
    totalGranted = 0;
    totalDenied = 0;
  }

  return {
    acquire,
    release,
    canAcquire,
    getSnapshot,
    reset,
  };
}

/** Type of the retry budget returned by {@link createRetryBudget}. */
export type RetryBudgetInstance = ReturnType<typeof createRetryBudget>;
