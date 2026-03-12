/**
 * Backoff computation utilities — deterministic exponential backoff with jitter.
 *
 * All inputs are normalized/clamped so the returned delay is always a
 * non-negative finite integer — never NaN, Infinity, or negative.
 */

// ─── Types ───

export interface FridayBackoffOptions {
  /** Base delay in ms. Default: 1000. Must be ≥ 0. */
  baseMs?: number;
  /** Maximum delay in ms. Default: 60_000. Clamped to ≥ baseMs. */
  maxMs?: number;
  /** Jitter factor (0–1). Default: 0.25 (±25%). Clamped to [0, 1]. */
  jitterFactor?: number;
}

// ─── Helpers ───

/** Return `value` if it is a finite number, otherwise `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ─── Backoff Computation ───

/**
 * Compute an exponential backoff delay with jitter.
 *
 * @param attempt - Zero-based attempt number (0 = first retry).
 *   Normalised to a non-negative integer.
 * @param options - Backoff configuration.
 * @returns Delay in milliseconds (non-negative integer, never NaN).
 */
export function computeFridayBackoff(
  attempt: number,
  options?: FridayBackoffOptions,
): number {
  // Normalize attempt to non-negative integer
  const safeAttempt = Math.max(0, Math.floor(finiteOr(attempt, 0)));

  // Clamp baseMs to non-negative
  const baseMs = Math.max(0, finiteOr(options?.baseMs, 1000));

  // Clamp maxMs: non-negative AND >= baseMs
  const rawMaxMs = Math.max(0, finiteOr(options?.maxMs, 60_000));
  const maxMs = Math.max(baseMs, rawMaxMs);

  // Clamp jitterFactor to [0, 1]
  const jitterFactor = Math.min(1, Math.max(0, finiteOr(options?.jitterFactor, 0.25)));

  // Exponential: base * 2^attempt, capped at max
  const exponential = Math.min(baseMs * Math.pow(2, safeAttempt), maxMs);

  // Apply jitter: value ± (jitterFactor * value)
  const jitterRange = exponential * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.round(exponential + jitter));
}

// ─── Abort-aware sleep ───

/**
 * Sleep for `ms` milliseconds, aborting early if the signal fires.
 *
 * If `ms <= 0`, resolves immediately with `true` (no timer scheduled).
 *
 * @returns Promise that resolves to `true` if the sleep completed, `false` if aborted.
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
