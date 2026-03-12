/**
 * B-006 Alert Evaluation Scheduler — Operationalize alert evaluation and runbook automation.
 *
 * Provides a periodic evaluation loop that:
 * - Evaluates alert rules on their configured intervals
 * - Connects the alert engine lifecycle with runbook execution
 * - Tracks evaluation cycle metrics (rules evaluated, fired, duration)
 * - Guards against re-entrant evaluation and provides clean shutdown
 *
 * @module observability/engine
 */

import type {
  FridayAlertEvent,
  FridayAlertRule,
  ISODateTime,
  UUID,
} from "../model/friday-observability.types.js";
import type { AlertBurnRateProvider, AlertMetricProvider, FridayAlertEngine } from "./alert-engine.js";
import type { RunbookExecutionResult, RunbookExecutor } from "./runbook-automation.js";

// ─── Evaluation Cycle Types ───

/** Stats for a single evaluation cycle. */
export interface EvaluationCycleStats {
  /** Unique cycle identifier. */
  readonly cycleId: number;
  /** When the cycle started. */
  readonly startedAt: ISODateTime;
  /** When the cycle completed (null if still running). */
  readonly completedAt: ISODateTime | null;
  /** Duration in milliseconds. */
  readonly durationMs: number;
  /** Number of rules evaluated. */
  readonly rulesEvaluated: number;
  /** Number of rules that produced a new or updated event. */
  readonly rulesFired: number;
  /** Number of rules skipped (not yet due for evaluation). */
  readonly rulesSkipped: number;
  /** Number of runbook executions triggered by escalation. */
  readonly runbooksTriggered: number;
  /** Number of runbook execution failures. */
  readonly runbookFailures: number;
  /** Resulting alert events from this cycle. */
  readonly events: readonly FridayAlertEvent[];
  /** Runbook execution results from this cycle. */
  readonly runbookResults: readonly RunbookExecutionResult[];
  /** Whether the cycle was forced (ignoring rule intervals). */
  readonly forced: boolean;
  /** Error message if the cycle failed. */
  readonly error?: string;
}

/** Configuration for the evaluation scheduler. */
export interface AlertEvaluationSchedulerConfig {
  /** Minimum interval between evaluation cycles in milliseconds. @default 10_000 */
  readonly minCycleIntervalMs: number;
  /** Maximum evaluation duration before the cycle is considered hung. @default 30_000 */
  readonly maxCycleDurationMs: number;
  /** Maximum number of cycle stats to retain in memory. @default 100 */
  readonly maxCycleHistory: number;
  /** Whether to auto-purge resolved alerts older than this many minutes. 0 = disabled. @default 1440 (24h) */
  readonly resolvedPurgeMinutes: number;
}

const DEFAULT_CONFIG: AlertEvaluationSchedulerConfig = {
  minCycleIntervalMs: 10_000,
  maxCycleDurationMs: 30_000,
  maxCycleHistory: 100,
  resolvedPurgeMinutes: 1440,
};

/** Current state of the evaluation scheduler. */
export type SchedulerState = "idle" | "running" | "paused" | "stopped";

// ─── Dependencies ───

export interface AlertEvaluationSchedulerDeps {
  /** The alert engine to evaluate. */
  alertEngine: FridayAlertEngine;
  /** Optional runbook executor for escalation-triggered automation. */
  runbookExecutor?: RunbookExecutor | null;
  /** Optional metric provider (injected into alert engine). */
  metricProvider?: AlertMetricProvider | null;
  /** Optional burn rate provider (injected into alert engine). */
  burnRateProvider?: AlertBurnRateProvider | null;
  /** Clock function for testability. */
  nowMs?: () => number;
  /** ISO clock function for testability. */
  nowIso?: () => ISODateTime;
  /** Scheduler configuration overrides. */
  config?: Partial<AlertEvaluationSchedulerConfig>;
}

// ─── Interface ───

export interface FridayAlertEvaluationScheduler {
  /** Start the evaluation loop. */
  start(): void;
  /** Stop the evaluation loop and clean up. */
  stop(): void;
  /** Pause the evaluation loop (retains state, no new cycles). */
  pause(): void;
  /** Resume the evaluation loop after pausing. */
  resume(): void;
  /** Force an immediate evaluation cycle, ignoring rule intervals. */
  evaluateNow(): EvaluationCycleStats;
  /** Run a single evaluation cycle respecting rule intervals. */
  tick(): EvaluationCycleStats;
  /** Get the current scheduler state. */
  getState(): SchedulerState;
  /** Get evaluation cycle history. */
  getCycleHistory(): readonly EvaluationCycleStats[];
  /** Get the most recent cycle stats. */
  getLastCycle(): EvaluationCycleStats | null;
  /** Get aggregate stats since the scheduler started. */
  getAggregateStats(): AggregateEvaluationStats;
  /** Get the next scheduled evaluation time per rule. */
  getNextEvaluationTimes(): ReadonlyMap<UUID, ISODateTime>;
  /** Reset all internal state. */
  reset(): void;
}

/** Aggregate stats across all evaluation cycles since startup. */
export interface AggregateEvaluationStats {
  /** Total number of evaluation cycles. */
  readonly totalCycles: number;
  /** Total number of rules evaluated across all cycles. */
  readonly totalRulesEvaluated: number;
  /** Total number of rules fired across all cycles. */
  readonly totalRulesFired: number;
  /** Total number of runbooks triggered. */
  readonly totalRunbooksTriggered: number;
  /** Total number of runbook failures. */
  readonly totalRunbookFailures: number;
  /** Average cycle duration in milliseconds. */
  readonly avgCycleDurationMs: number;
  /** Maximum cycle duration in milliseconds. */
  readonly maxCycleDurationMs: number;
  /** When the scheduler was started. */
  readonly startedAt: ISODateTime | null;
  /** Number of cycles with errors. */
  readonly errorCycles: number;
}

// ─── Factory ───

export function createAlertEvaluationScheduler(
  deps: AlertEvaluationSchedulerDeps,
): FridayAlertEvaluationScheduler {
  const config: AlertEvaluationSchedulerConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const nowIso = deps.nowIso ?? (() => new Date(nowMs()).toISOString());

  // ─── Internal state ───
  let state: SchedulerState = "idle";
  let cycleCounter = 0;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  let running = false; // Re-entrant guard
  let startedAt: ISODateTime | null = null;

  // Per-rule last evaluation timestamps
  const lastEvaluatedAt = new Map<UUID, number>();
  // Cycle history
  const cycleHistory: EvaluationCycleStats[] = [];
  // Aggregate counters
  let totalCycles = 0;
  let totalRulesEvaluated = 0;
  let totalRulesFired = 0;
  let totalRunbooksTriggered = 0;
  let totalRunbookFailures = 0;
  let totalDurationMs = 0;
  let maxCycleDuration = 0;
  let errorCycles = 0;

  // ─── Wire providers ───

  function wireProviders(): void {
    if (deps.metricProvider) {
      deps.alertEngine.setMetricProvider(deps.metricProvider);
    }
    if (deps.burnRateProvider) {
      deps.alertEngine.setBurnRateProvider(deps.burnRateProvider);
    }
    if (deps.runbookExecutor) {
      deps.alertEngine.setRunbookExecutor(deps.runbookExecutor);
    }
  }

  // ─── Rule interval check ───

  function isRuleDue(rule: FridayAlertRule, now: number): boolean {
    const lastEval = lastEvaluatedAt.get(rule.id);
    if (lastEval === undefined) return true;
    const intervalMs = Math.max(1, rule.evaluationIntervalSec) * 1000;
    return (now - lastEval) >= intervalMs;
  }

  // ─── Core evaluation ───

  function runEvaluationCycle(forced: boolean): EvaluationCycleStats {
    const cycleId = ++cycleCounter;
    const cycleStart = nowMs();
    const cycleStartIso = nowIso();

    let rulesEvaluated = 0;
    let rulesFired = 0;
    let rulesSkipped = 0;
    let runbooksTriggered = 0;
    let runbookFailures = 0;
    const events: FridayAlertEvent[] = [];
    const runbookResults: RunbookExecutionResult[] = [];
    let error: string | undefined;

    try {
      const rules = deps.alertEngine.getRules();

      for (const rule of rules) {
        if (!rule.enabled) {
          rulesSkipped++;
          continue;
        }

        if (!forced && !isRuleDue(rule, cycleStart)) {
          rulesSkipped++;
          continue;
        }

        // Evaluate rule
        const event = deps.alertEngine.evaluateRule(rule.id);
        lastEvaluatedAt.set(rule.id, cycleStart);
        rulesEvaluated++;

        if (event) {
          rulesFired++;
          events.push(event);
        }
      }

      // Collect runbook execution results from the executor
      if (deps.runbookExecutor) {
        const history = deps.runbookExecutor.getExecutionHistory();
        // Only take results that were generated during this cycle
        for (const result of history) {
          const executedAtMs = new Date(result.executedAt).getTime();
          if (executedAtMs >= cycleStart) {
            runbookResults.push(result);
            runbooksTriggered++;
            if (result.status === "failed") {
              runbookFailures++;
            }
          }
        }
      }

      // Auto-purge resolved alerts
      if (config.resolvedPurgeMinutes > 0) {
        const cutoffMs = cycleStart - config.resolvedPurgeMinutes * 60_000;
        deps.alertEngine.purgeResolvedBefore(new Date(cutoffMs).toISOString());
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Evaluation cycle failed";
    }

    const cycleDuration = nowMs() - cycleStart;
    const stats: EvaluationCycleStats = {
      cycleId,
      startedAt: cycleStartIso,
      completedAt: nowIso(),
      durationMs: cycleDuration,
      rulesEvaluated,
      rulesFired,
      rulesSkipped,
      runbooksTriggered,
      runbookFailures,
      events,
      runbookResults,
      forced,
      error,
    };

    // Update aggregates
    totalCycles++;
    totalRulesEvaluated += rulesEvaluated;
    totalRulesFired += rulesFired;
    totalRunbooksTriggered += runbooksTriggered;
    totalRunbookFailures += runbookFailures;
    totalDurationMs += cycleDuration;
    if (cycleDuration > maxCycleDuration) maxCycleDuration = cycleDuration;
    if (error) errorCycles++;

    // Retain history (bounded)
    cycleHistory.push(stats);
    while (cycleHistory.length > config.maxCycleHistory) {
      cycleHistory.shift();
    }

    return stats;
  }

  // ─── Timer management ───

  function scheduleNextCycle(): void {
    if (state !== "running") return;
    if (timerHandle !== null) return;

    timerHandle = setTimeout(() => {
      timerHandle = null;
      if (state !== "running") return;
      if (running) return; // Re-entrant guard

      running = true;
      try {
        runEvaluationCycle(false);
      } finally {
        running = false;
      }

      scheduleNextCycle();
    }, config.minCycleIntervalMs);
  }

  function clearTimer(): void {
    if (timerHandle !== null) {
      clearTimeout(timerHandle);
      timerHandle = null;
    }
  }

  // ─── Public interface ───

  return {
    start() {
      if (state === "running") return;
      wireProviders();
      state = "running";
      startedAt = nowIso();
      scheduleNextCycle();
    },

    stop() {
      clearTimer();
      state = "stopped";
    },

    pause() {
      if (state !== "running") return;
      clearTimer();
      state = "paused";
    },

    resume() {
      if (state !== "paused") return;
      state = "running";
      scheduleNextCycle();
    },

    evaluateNow() {
      wireProviders();
      return runEvaluationCycle(true);
    },

    tick() {
      wireProviders();
      return runEvaluationCycle(false);
    },

    getState() {
      return state;
    },

    getCycleHistory() {
      return [...cycleHistory];
    },

    getLastCycle() {
      return cycleHistory.length > 0 ? cycleHistory[cycleHistory.length - 1] : null;
    },

    getAggregateStats(): AggregateEvaluationStats {
      return {
        totalCycles,
        totalRulesEvaluated,
        totalRulesFired,
        totalRunbooksTriggered,
        totalRunbookFailures,
        avgCycleDurationMs: totalCycles > 0 ? Math.round(totalDurationMs / totalCycles) : 0,
        maxCycleDurationMs: maxCycleDuration,
        startedAt,
        errorCycles,
      };
    },

    getNextEvaluationTimes() {
      const result = new Map<UUID, ISODateTime>();
      const rules = deps.alertEngine.getRules();
      const now = nowMs();

      for (const rule of rules) {
        if (!rule.enabled) continue;
        const lastEval = lastEvaluatedAt.get(rule.id);
        const intervalMs = Math.max(1, rule.evaluationIntervalSec) * 1000;

        if (lastEval === undefined) {
          result.set(rule.id, nowIso());
        } else {
          const nextMs = lastEval + intervalMs;
          result.set(rule.id, new Date(Math.max(nextMs, now)).toISOString());
        }
      }

      return result;
    },

    reset() {
      clearTimer();
      state = "idle";
      cycleCounter = 0;
      startedAt = null;
      running = false;
      lastEvaluatedAt.clear();
      cycleHistory.length = 0;
      totalCycles = 0;
      totalRulesEvaluated = 0;
      totalRulesFired = 0;
      totalRunbooksTriggered = 0;
      totalRunbookFailures = 0;
      totalDurationMs = 0;
      maxCycleDuration = 0;
      errorCycles = 0;
    },
  };
}
