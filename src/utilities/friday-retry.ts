/**
 * Retry utility — generic async retry with configurable backoff and abort support.
 */

import { computeFridayBackoff, sleepWithAbort } from "./friday-backoff.js";
import type { FridayBackoffOptions } from "./friday-backoff.js";

// ─── Types ───

/** Structured info passed to the `onRetry` callback. */
export interface FridayRetryInfo {
  /** Zero-based attempt number that just failed. */
  attempt: number;
  /** Total max attempts configured. */
  maxAttempts: number;
  /** Delay in ms before the next attempt. */
  delayMs: number;
  /** The error from the failed attempt. */
  err: unknown;
  /** Optional label for logging / diagnostics. */
  label?: string;
}

export interface FridayRetryOptions<T> extends FridayBackoffOptions {
  /** Maximum number of attempts (including the initial one). Default: 3. Clamped to ≥ 1. */
  maxAttempts?: number;
  /** Called after each failed attempt. Return false to stop retrying. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before sleeping between retries. Receives structured info. */
  onRetry?: (info: FridayRetryInfo) => void;
  /** If the failed attempt returns a retryAfterMs hint, use it instead of backoff. Non-finite hints are ignored. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** AbortSignal to cancel retries. */
  signal?: AbortSignal;
  /** Optional label for diagnostics (passed through to onRetry). */
  label?: string;
}

// ─── Helpers ───

/** Return `value` if it is a finite number, otherwise `undefined`. */
function finiteOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─── Retry ───

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - The async function to retry. Receives the zero-based attempt number.
 * @param options - Retry configuration.
 * @returns The result of a successful attempt.
 * @throws The error from the last failed attempt.
 */
/**
 * @deprecated Use RetryOrchestrator from `src/retry/engine/` instead.
 */
export async function retryFridayAsync<T>(
  fn: (attempt: number) => Promise<T>,
  options?: FridayRetryOptions<T>,
): Promise<T> {
  // Clamp maxAttempts to at least 1
  const rawMax = finiteOrUndef(options?.maxAttempts) ?? 3;
  const maxAttempts = Math.max(1, Math.round(rawMax));
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Last attempt — don't sleep, just throw
      if (attempt >= maxAttempts - 1) break;

      // Check if we should retry
      if (options?.shouldRetry && !options.shouldRetry(error, attempt)) break;

      // Check for abort
      if (options?.signal?.aborted) break;

      // Compute delay: retryAfterMs hint takes precedence (ignore non-finite)
      const rawHint = options?.retryAfterMs?.(error);
      const hintMs = finiteOrUndef(rawHint);

      // Compute backoff delay
      const backoffMs = computeFridayBackoff(attempt, options);

      // Use hint if present, but clamp to [0, maxMs] bounds
      let delayMs: number;
      if (hintMs !== undefined) {
        const rawMax = finiteOrUndef(options?.maxMs) ?? 60_000;
        const maxBound = Math.max(0, rawMax);
        delayMs = Math.max(0, Math.min(hintMs, maxBound));
      } else {
        delayMs = backoffMs;
      }

      // Notify caller with structured info
      options?.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        err: error,
        label: options?.label,
      });

      // Sleep (abort-aware)
      const completed = await sleepWithAbort(delayMs, options?.signal);
      if (!completed) break;
    }
  }

  throw lastError;
}
