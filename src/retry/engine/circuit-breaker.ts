/**
 * Circuit Breaker — Per-target circuit breaker for retry protection.
 *
 * Implements the classic three-state circuit breaker pattern:
 *   - **closed**: Normal operation. Failures are counted.
 *   - **open**: Circuit is tripped. All requests are rejected immediately.
 *   - **half-open**: A single probe request is allowed through to test recovery.
 *
 * State transitions:
 *   closed → open:     When consecutive failures reach the threshold.
 *   open → half-open:  After the reset timeout elapses.
 *   half-open → closed: When the probe request succeeds.
 *   half-open → open:   When the probe request fails.
 *
 * Each circuit breaker is keyed by a target identifier (e.g., provider name,
 * endpoint URL, nodeId) so failures to one target do not affect others.
 *
 * @module retry/engine
 */

// ─── Types ───

/** The three states of a circuit breaker. */
export type CircuitBreakerState = "closed" | "open" | "half_open";

/** Configuration for a circuit breaker instance. */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures to trip the circuit. Default: 5. */
  failureThreshold: number;
  /** Duration in milliseconds to keep the circuit open before transitioning to half-open. Default: 30000. */
  resetTimeoutMs: number;
  /** Number of successes in half-open state to fully close the circuit. Default: 1. */
  halfOpenSuccessThreshold: number;
}

/** Snapshot of a circuit breaker's current state. */
export interface CircuitBreakerSnapshot {
  /** Target identifier. */
  target: string;
  /** Current state. */
  state: CircuitBreakerState;
  /** Number of consecutive failures in the current window. */
  consecutiveFailures: number;
  /** Number of consecutive successes in half-open state. */
  halfOpenSuccesses: number;
  /** Timestamp (ms since epoch) when the circuit was last opened. */
  lastOpenedAt: number | undefined;
  /** Timestamp (ms since epoch) of the last state transition. */
  lastTransitionAt: number;
  /** Total number of times this circuit has been tripped. */
  totalTrips: number;
}

/** Internal mutable state for a single circuit breaker. */
interface CircuitBreakerEntry {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  halfOpenProbeInFlight: boolean;
  lastOpenedAt: number | undefined;
  lastTransitionAt: number;
  totalTrips: number;
}

/** Default circuit breaker configuration. */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: Readonly<CircuitBreakerConfig> = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenSuccessThreshold: 1,
};

// ─── Circuit Breaker Manager ───

/**
 * Creates a circuit breaker manager that tracks per-target circuit breakers.
 *
 * @param config - Circuit breaker configuration. Applies to all targets.
 * @param nowMs - Clock function returning current time in ms. Defaults to Date.now.
 * @returns A circuit breaker manager with methods to record outcomes and query state.
 */
export function createCircuitBreakerManager(
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
  nowMs: () => number = Date.now,
) {
  const breakers = new Map<string, CircuitBreakerEntry>();

  /**
   * Get or create a circuit breaker entry for a target.
   */
  function getEntry(target: string): CircuitBreakerEntry {
    let entry = breakers.get(target);
    if (!entry) {
      entry = {
        state: "closed",
        consecutiveFailures: 0,
        halfOpenSuccesses: 0,
        halfOpenProbeInFlight: false,
        lastOpenedAt: undefined,
        lastTransitionAt: nowMs(),
        totalTrips: 0,
      };
      breakers.set(target, entry);
    }
    return entry;
  }

  /**
   * Transition an entry from open to half-open if the reset timeout has elapsed.
   */
  function maybeTransitionToHalfOpen(entry: CircuitBreakerEntry): void {
    if (
      entry.state === "open" &&
      entry.lastOpenedAt !== undefined &&
      nowMs() - entry.lastOpenedAt >= config.resetTimeoutMs
    ) {
      entry.state = "half_open";
      entry.halfOpenSuccesses = 0;
      entry.halfOpenProbeInFlight = false;
      entry.lastTransitionAt = nowMs();
    }
  }

  /**
   * Check whether a request to the target is allowed.
   *
   * - **closed**: Always allowed.
   * - **open**: Rejected unless reset timeout has elapsed (transitions to half-open).
   * - **half_open**: Allowed (probe request).
   *
   * @param target - Target identifier.
   * @returns True if the request is allowed, false if the circuit is open.
   */
  function isAllowed(target: string): boolean {
    const entry = getEntry(target);
    maybeTransitionToHalfOpen(entry);

    if (entry.state === "open") {
      return false;
    }

    if (entry.state === "half_open") {
      if (entry.halfOpenProbeInFlight) {
        return false;
      }
      entry.halfOpenProbeInFlight = true;
    }

    return true;
  }

  /**
   * Record a successful outcome for a target.
   *
   * - **closed**: Resets the consecutive failure counter.
   * - **half_open**: Increments success count; closes the circuit if threshold is met.
   * - **open**: No-op (should not happen if caller checks isAllowed first).
   *
   * @param target - Target identifier.
   */
  function recordSuccess(target: string): void {
    const entry = getEntry(target);
    maybeTransitionToHalfOpen(entry);

    switch (entry.state) {
      case "closed":
        entry.consecutiveFailures = 0;
        break;
      case "half_open":
        entry.halfOpenProbeInFlight = false;
        entry.halfOpenSuccesses++;
        if (entry.halfOpenSuccesses >= config.halfOpenSuccessThreshold) {
          entry.state = "closed";
          entry.consecutiveFailures = 0;
          entry.halfOpenSuccesses = 0;
          entry.halfOpenProbeInFlight = false;
          entry.lastTransitionAt = nowMs();
        }
        break;
      case "open":
        // Should not happen; no-op.
        break;
    }
  }

  /**
   * Record a failure outcome for a target.
   *
   * - **closed**: Increments failure count; trips the circuit if threshold is reached.
   * - **half_open**: Immediately trips back to open.
   * - **open**: No-op.
   *
   * @param target - Target identifier.
   */
  function recordFailure(target: string): void {
    const entry = getEntry(target);
    maybeTransitionToHalfOpen(entry);

    switch (entry.state) {
      case "closed":
        entry.consecutiveFailures++;
        if (entry.consecutiveFailures >= config.failureThreshold) {
          entry.state = "open";
          entry.lastOpenedAt = nowMs();
          entry.lastTransitionAt = nowMs();
          entry.totalTrips++;
        }
        break;
      case "half_open":
        // Probe failed — re-open the circuit.
        entry.state = "open";
        entry.lastOpenedAt = nowMs();
        entry.lastTransitionAt = nowMs();
        entry.totalTrips++;
        entry.halfOpenSuccesses = 0;
        entry.halfOpenProbeInFlight = false;
        break;
      case "open":
        // Already open; no-op.
        break;
    }
  }

  /**
   * Get a snapshot of the current state for a target.
   *
   * @param target - Target identifier.
   * @returns Immutable snapshot of the circuit breaker state.
   */
  function getSnapshot(target: string): CircuitBreakerSnapshot {
    const entry = getEntry(target);
    maybeTransitionToHalfOpen(entry);

    return {
      target,
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      halfOpenSuccesses: entry.halfOpenSuccesses,
      lastOpenedAt: entry.lastOpenedAt,
      lastTransitionAt: entry.lastTransitionAt,
      totalTrips: entry.totalTrips,
    };
  }

  /**
   * Reset a single target's circuit breaker to the closed state.
   *
   * @param target - Target identifier.
   */
  function reset(target: string): void {
    breakers.delete(target);
  }

  /**
   * Reset all circuit breakers.
   */
  function resetAll(): void {
    breakers.clear();
  }

  /**
   * Get snapshots of all tracked targets.
   */
  function getAllSnapshots(): CircuitBreakerSnapshot[] {
    const snapshots: CircuitBreakerSnapshot[] = [];
    for (const target of breakers.keys()) {
      snapshots.push(getSnapshot(target));
    }
    return snapshots;
  }

  return {
    isAllowed,
    recordSuccess,
    recordFailure,
    getSnapshot,
    reset,
    resetAll,
    getAllSnapshots,
  };
}

/** Type of the circuit breaker manager returned by {@link createCircuitBreakerManager}. */
export type CircuitBreakerManagerInstance = ReturnType<typeof createCircuitBreakerManager>;
