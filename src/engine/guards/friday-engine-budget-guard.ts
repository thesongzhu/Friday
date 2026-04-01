/**
 * Budget Guard — Initiative F.2
 *
 * Enforces per-run and per-session token usage limits.
 * Checks are advisory: the engine can gracefully terminate
 * a run that exceeds budget rather than hard-killing it.
 */

// ─── Types ───

export interface FridayBudgetPolicy {
  /** Max input tokens per run. Default: 500,000. */
  maxInputTokensPerRun?: number;
  /** Max output tokens per run. Default: 100,000. */
  maxOutputTokensPerRun?: number;
  /** Max total (input+output) tokens per session window. Default: 2,000,000. */
  maxTotalTokensPerSession?: number;
  /** Session window duration in ms. Default: 3,600,000 (1 hour). */
  sessionWindowMs?: number;
}

export type FridayBudgetCheckResult =
  | { exceeded: false }
  | { exceeded: true; reason: string; limit: number; actual: number };

export interface FridayBudgetUsage {
  inputTokens: number;
  outputTokens: number;
}

// ─── Guard ───

export interface FridayBudgetGuard {
  /** Check if a run's usage exceeds the budget. */
  checkRunBudget(runId: string, usage: FridayBudgetUsage): FridayBudgetCheckResult;
  /** Record usage for session-level tracking. */
  recordSessionUsage(sessionKey: string, usage: FridayBudgetUsage): void;
  /** Check if a session's cumulative usage exceeds budget. */
  checkSessionBudget(sessionKey: string): FridayBudgetCheckResult;
  /** Clear all tracked state (e.g. for testing). */
  clear(): void;
}

interface SessionWindow {
  totalTokens: number;
  windowStart: number;
}

const DEFAULT_POLICY: Required<FridayBudgetPolicy> = {
  maxInputTokensPerRun: 500_000,
  maxOutputTokensPerRun: 100_000,
  maxTotalTokensPerSession: 2_000_000,
  sessionWindowMs: 3_600_000,
};

export function createFridayBudgetGuard(
  policy?: FridayBudgetPolicy,
): FridayBudgetGuard {
  const p = { ...DEFAULT_POLICY, ...policy };
  const sessionWindows = new Map<string, SessionWindow>();

  function checkRunBudget(runId: string, usage: FridayBudgetUsage): FridayBudgetCheckResult {
    if (usage.inputTokens > p.maxInputTokensPerRun) {
      return {
        exceeded: true,
        reason: `Run ${runId} input tokens exceeded`,
        limit: p.maxInputTokensPerRun,
        actual: usage.inputTokens,
      };
    }
    if (usage.outputTokens > p.maxOutputTokensPerRun) {
      return {
        exceeded: true,
        reason: `Run ${runId} output tokens exceeded`,
        limit: p.maxOutputTokensPerRun,
        actual: usage.outputTokens,
      };
    }
    return { exceeded: false };
  }

  function recordSessionUsage(sessionKey: string, usage: FridayBudgetUsage): void {
    const now = Date.now();
    let window = sessionWindows.get(sessionKey);
    if (!window || now - window.windowStart > p.sessionWindowMs) {
      window = { totalTokens: 0, windowStart: now };
    }
    window.totalTokens += usage.inputTokens + usage.outputTokens;
    sessionWindows.set(sessionKey, window);
  }

  function checkSessionBudget(sessionKey: string): FridayBudgetCheckResult {
    const window = sessionWindows.get(sessionKey);
    if (!window) return { exceeded: false };

    // Expired window — reset
    if (Date.now() - window.windowStart > p.sessionWindowMs) {
      sessionWindows.delete(sessionKey);
      return { exceeded: false };
    }

    if (window.totalTokens > p.maxTotalTokensPerSession) {
      return {
        exceeded: true,
        reason: `Session ${sessionKey} total tokens exceeded in window`,
        limit: p.maxTotalTokensPerSession,
        actual: window.totalTokens,
      };
    }
    return { exceeded: false };
  }

  function clear(): void {
    sessionWindows.clear();
  }

  return { checkRunBudget, recordSessionUsage, checkSessionBudget, clear };
}
