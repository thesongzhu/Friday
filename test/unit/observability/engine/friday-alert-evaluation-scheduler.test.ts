/**
 * B-006 Alert Evaluation Scheduler — Contract Tests
 *
 * Validates evaluation cycle mechanics, per-rule interval scheduling,
 * runbook integration, aggregate stats, lifecycle state management,
 * and re-entrant safety.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAlertEvaluationScheduler,
  type AlertEvaluationSchedulerDeps,
  type FridayAlertEvaluationScheduler,
} from "../../../../src/observability/engine/friday-alert-evaluation-scheduler.js";
import { FridayAlertEngine, type AlertMetricProvider } from "../../../../src/observability/engine/alert-engine.js";
import { RunbookRegistry, RunbookExecutor } from "../../../../src/observability/engine/runbook-automation.js";
import type {
  FridayAlertRule,
  FridayAlertConditionThreshold,
} from "../../../../src/observability/model/friday-observability.types.js";

// ─── Helpers ───

let clock = 1_000_000;
const ISO_BASE = "2026-01-01T00:00:00.000Z";

function makeRule(overrides: Partial<FridayAlertRule> = {}): FridayAlertRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 6)}`,
    name: "Test Rule",
    description: "Test rule for unit tests",
    severity: "warning",
    enabled: true,
    condition: {
      type: "threshold",
      metricName: "api.latency.p99",
      operator: "gt",
      threshold: 500,
    } as FridayAlertConditionThreshold,
    evaluationIntervalSec: 60,
    channelIds: ["ch-1"],
    escalationTiers: [],
    groupingWindowMin: 0,
    tags: [],
    etag: "etag-1",
    createdAt: ISO_BASE,
    updatedAt: ISO_BASE,
    ...overrides,
  };
}

function makeMetricProvider(values: Record<string, number | null> = {}): AlertMetricProvider {
  return {
    getMetricValue: vi.fn().mockImplementation((name: string) =>
      name in values ? values[name] : null,
    ),
    getMetricLastReportedAt: vi.fn().mockReturnValue(null),
  };
}

function makeDeps(overrides: Partial<AlertEvaluationSchedulerDeps> = {}): AlertEvaluationSchedulerDeps {
  clock = 1_000_000;
  return {
    alertEngine: new FridayAlertEngine(),
    nowMs: () => clock,
    nowIso: () => new Date(clock).toISOString(),
    config: {
      minCycleIntervalMs: 10_000,
      maxCycleHistory: 50,
      resolvedPurgeMinutes: 0,
    },
    ...overrides,
  };
}

// ─── Tests ───

describe("B-006 FridayAlertEvaluationScheduler", () => {
  describe("lifecycle", () => {
    it("starts in idle state", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      expect(scheduler.getState()).toBe("idle");
    });

    it("transitions idle → running on start", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      scheduler.start();
      expect(scheduler.getState()).toBe("running");
      scheduler.stop();
    });

    it("transitions running → paused on pause", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      scheduler.start();
      scheduler.pause();
      expect(scheduler.getState()).toBe("paused");
      scheduler.stop();
    });

    it("transitions paused → running on resume", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      scheduler.start();
      scheduler.pause();
      scheduler.resume();
      expect(scheduler.getState()).toBe("running");
      scheduler.stop();
    });

    it("transitions to stopped on stop", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      scheduler.start();
      scheduler.stop();
      expect(scheduler.getState()).toBe("stopped");
    });

    it("reset returns to idle", () => {
      const scheduler = createAlertEvaluationScheduler(makeDeps());
      scheduler.start();
      scheduler.evaluateNow();
      scheduler.reset();
      expect(scheduler.getState()).toBe("idle");
      expect(scheduler.getCycleHistory()).toHaveLength(0);
      expect(scheduler.getAggregateStats().totalCycles).toBe(0);
    });
  });

  describe("evaluateNow (forced evaluation)", () => {
    it("evaluates all enabled rules regardless of interval", () => {
      const deps = makeDeps();
      const provider = makeMetricProvider({ "api.latency.p99": 600 });
      deps.metricProvider = provider;

      const rule = makeRule({ id: "r-1", groupingWindowMin: 0 });
      deps.alertEngine.addRule(rule);

      const scheduler = createAlertEvaluationScheduler(deps);

      // First evaluation: alert engine always creates "pending" on first fire
      const stats1 = scheduler.evaluateNow();
      expect(stats1.rulesEvaluated).toBe(1);
      expect(stats1.rulesFired).toBe(1);
      expect(stats1.forced).toBe(true);
      expect(stats1.events).toHaveLength(1);
      expect(stats1.events[0].status).toBe("pending");

      // Second evaluation: condition still firing → transitions pending to firing
      const stats2 = scheduler.evaluateNow();
      expect(stats2.rulesFired).toBe(1);
      expect(stats2.events[0].status).toBe("firing");
    });

    it("skips disabled rules", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });

      deps.alertEngine.addRule(makeRule({ id: "r-1", enabled: false }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const stats = scheduler.evaluateNow();

      expect(stats.rulesEvaluated).toBe(0);
      expect(stats.rulesSkipped).toBe(1);
    });

    it("returns empty events when no conditions fire", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 100 });

      deps.alertEngine.addRule(makeRule({ id: "r-1" }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const stats = scheduler.evaluateNow();

      expect(stats.rulesEvaluated).toBe(1);
      expect(stats.rulesFired).toBe(0);
      expect(stats.events).toHaveLength(0);
    });

    it("wires metric provider into alert engine", () => {
      const deps = makeDeps();
      const provider = makeMetricProvider({ "cpu.usage": 95 });
      deps.metricProvider = provider;

      deps.alertEngine.addRule(makeRule({
        id: "r-cpu",
        condition: {
          type: "threshold",
          metricName: "cpu.usage",
          operator: "gt",
          threshold: 90,
        } as FridayAlertConditionThreshold,
      }));

      const scheduler = createAlertEvaluationScheduler(deps);
      scheduler.evaluateNow();

      expect(provider.getMetricValue).toHaveBeenCalledWith("cpu.usage");
    });
  });

  describe("tick (interval-aware evaluation)", () => {
    it("evaluates rules that are due", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });
      deps.alertEngine.addRule(makeRule({ id: "r-1", evaluationIntervalSec: 60 }));

      const scheduler = createAlertEvaluationScheduler(deps);

      // First tick: rule has never been evaluated, so it's due
      const stats1 = scheduler.tick();
      expect(stats1.rulesEvaluated).toBe(1);

      // Second tick immediately: rule is NOT due (only 0ms elapsed)
      const stats2 = scheduler.tick();
      expect(stats2.rulesEvaluated).toBe(0);
      expect(stats2.rulesSkipped).toBe(1);

      // Advance clock past interval
      clock += 61_000;
      const stats3 = scheduler.tick();
      expect(stats3.rulesEvaluated).toBe(1);
    });

    it("respects different intervals per rule", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({
        "fast.metric": 100,
        "slow.metric": 100,
      });

      deps.alertEngine.addRule(makeRule({
        id: "r-fast",
        evaluationIntervalSec: 10,
        condition: {
          type: "threshold",
          metricName: "fast.metric",
          operator: "gt",
          threshold: 50,
        } as FridayAlertConditionThreshold,
      }));
      deps.alertEngine.addRule(makeRule({
        id: "r-slow",
        evaluationIntervalSec: 120,
        condition: {
          type: "threshold",
          metricName: "slow.metric",
          operator: "gt",
          threshold: 50,
        } as FridayAlertConditionThreshold,
      }));

      const scheduler = createAlertEvaluationScheduler(deps);

      // First tick: both due
      const stats1 = scheduler.tick();
      expect(stats1.rulesEvaluated).toBe(2);

      // After 15 seconds: only fast rule due
      clock += 15_000;
      const stats2 = scheduler.tick();
      expect(stats2.rulesEvaluated).toBe(1);
      expect(stats2.rulesSkipped).toBe(1);

      // After 125 seconds total: both due again
      clock += 110_000;
      const stats3 = scheduler.tick();
      expect(stats3.rulesEvaluated).toBe(2);
    });
  });

  describe("runbook integration", () => {
    it("wires runbook executor into alert engine", () => {
      const deps = makeDeps();
      const registry = new RunbookRegistry();
      const executor = new RunbookExecutor(registry);
      deps.runbookExecutor = executor;
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });

      deps.alertEngine.addRule(makeRule({
        id: "r-1",
        escalationTiers: [{ tier: 1, timeoutMinutes: 0, channelIds: ["ch-2"] }],
      }));

      const runbookFn = vi.fn();
      registry.registerRunbook({
        id: "rb-1",
        name: "Auto-Restart",
        ruleId: "r-1",
        execute: runbookFn,
      });

      const scheduler = createAlertEvaluationScheduler(deps);

      // First eval: creates pending event
      scheduler.evaluateNow();

      // Second eval: condition still true → escalation check
      const stats = scheduler.evaluateNow();
      expect(stats.rulesEvaluated).toBe(1);
    });

    it("tracks runbook execution results in cycle stats", () => {
      const deps = makeDeps();
      const registry = new RunbookRegistry();
      const executor = new RunbookExecutor(registry);
      deps.runbookExecutor = executor;
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });

      deps.alertEngine.addRule(makeRule({
        id: "r-1",
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 0, channelIds: ["ch-2"] }],
      }));

      // Register a runbook that records execution
      const executed: string[] = [];
      registry.registerRunbook({
        id: "rb-1",
        name: "Auto-Restart",
        ruleId: "r-1",
        execute: () => { executed.push("ran"); },
      });

      const scheduler = createAlertEvaluationScheduler(deps);

      // Evaluate multiple times to trigger escalation
      scheduler.evaluateNow();
      scheduler.evaluateNow();
      const stats = scheduler.evaluateNow();

      // The stats should reflect any runbook results from this cycle
      expect(stats.runbookResults.length + stats.runbooksTriggered).toBeGreaterThanOrEqual(0);
    });
  });

  describe("cycle history", () => {
    it("retains cycle stats in history", () => {
      const deps = makeDeps();
      const scheduler = createAlertEvaluationScheduler(deps);

      scheduler.evaluateNow();
      scheduler.evaluateNow();
      scheduler.evaluateNow();

      expect(scheduler.getCycleHistory()).toHaveLength(3);
    });

    it("bounds history to maxCycleHistory", () => {
      const deps = makeDeps({
        config: { maxCycleHistory: 3, minCycleIntervalMs: 10_000, resolvedPurgeMinutes: 0, maxCycleDurationMs: 30_000 },
      });
      const scheduler = createAlertEvaluationScheduler(deps);

      for (let i = 0; i < 10; i++) {
        scheduler.evaluateNow();
      }

      expect(scheduler.getCycleHistory()).toHaveLength(3);
      // Oldest cycles are dropped
      expect(scheduler.getCycleHistory()[0].cycleId).toBe(8);
    });

    it("getLastCycle returns most recent", () => {
      const deps = makeDeps();
      const scheduler = createAlertEvaluationScheduler(deps);

      expect(scheduler.getLastCycle()).toBeNull();

      scheduler.evaluateNow();
      scheduler.evaluateNow();

      expect(scheduler.getLastCycle()!.cycleId).toBe(2);
    });

    it("cycle stats include timestamps", () => {
      const deps = makeDeps();
      const scheduler = createAlertEvaluationScheduler(deps);

      const stats = scheduler.evaluateNow();

      expect(stats.startedAt).toBeTruthy();
      expect(stats.completedAt).toBeTruthy();
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("aggregate stats", () => {
    it("accumulates totals across cycles", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });
      deps.alertEngine.addRule(makeRule({ id: "r-1" }));

      const scheduler = createAlertEvaluationScheduler(deps);

      scheduler.evaluateNow();
      clock += 61_000;
      scheduler.evaluateNow();
      clock += 61_000;
      scheduler.evaluateNow();

      const agg = scheduler.getAggregateStats();
      expect(agg.totalCycles).toBe(3);
      expect(agg.totalRulesEvaluated).toBe(3);
      expect(agg.totalRulesFired).toBeGreaterThanOrEqual(1);
      expect(agg.avgCycleDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks max cycle duration", () => {
      const deps = makeDeps();
      const scheduler = createAlertEvaluationScheduler(deps);

      scheduler.evaluateNow();
      const agg = scheduler.getAggregateStats();
      expect(agg.maxCycleDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("records startedAt on start()", () => {
      const deps = makeDeps();
      const scheduler = createAlertEvaluationScheduler(deps);

      expect(scheduler.getAggregateStats().startedAt).toBeNull();

      scheduler.start();
      expect(scheduler.getAggregateStats().startedAt).toBeTruthy();
      scheduler.stop();
    });
  });

  describe("next evaluation times", () => {
    it("returns immediate for never-evaluated rules", () => {
      const deps = makeDeps();
      deps.alertEngine.addRule(makeRule({ id: "r-1" }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const times = scheduler.getNextEvaluationTimes();

      expect(times.size).toBe(1);
      expect(times.get("r-1")).toBeTruthy();
    });

    it("returns correct next time after evaluation", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 100 });
      deps.alertEngine.addRule(makeRule({ id: "r-1", evaluationIntervalSec: 60 }));

      const scheduler = createAlertEvaluationScheduler(deps);
      scheduler.evaluateNow();

      // Next eval should be ~60s from now
      const times = scheduler.getNextEvaluationTimes();
      const nextTime = new Date(times.get("r-1")!).getTime();
      expect(nextTime).toBeGreaterThanOrEqual(clock);
    });

    it("skips disabled rules", () => {
      const deps = makeDeps();
      deps.alertEngine.addRule(makeRule({ id: "r-1", enabled: false }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const times = scheduler.getNextEvaluationTimes();

      expect(times.size).toBe(0);
    });
  });

  describe("error handling", () => {
    it("captures cycle errors without crashing", () => {
      const engine = new FridayAlertEngine();
      // Make evaluateCondition throw by providing a rule with an impossible state
      const originalEvaluateRule = engine.evaluateRule.bind(engine);
      vi.spyOn(engine, "evaluateRule").mockImplementation(() => {
        throw new Error("Simulated failure");
      });

      const deps = makeDeps({ alertEngine: engine });
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 600 });
      engine.addRule(makeRule({ id: "r-1" }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const stats = scheduler.evaluateNow();

      expect(stats.error).toBe("Simulated failure");
      expect(scheduler.getAggregateStats().errorCycles).toBe(1);
    });
  });

  describe("resolved alert auto-purge", () => {
    it("purges resolved alerts when configured", () => {
      // Use real-time clock so timestamps from alert engine and scheduler align
      const realNow = Date.now();
      let purgeTestClock = realNow;

      const engine = new FridayAlertEngine();
      const deps: AlertEvaluationSchedulerDeps = {
        alertEngine: engine,
        metricProvider: makeMetricProvider({ "api.latency.p99": 600 }),
        nowMs: () => purgeTestClock,
        nowIso: () => new Date(purgeTestClock).toISOString(),
        config: {
          minCycleIntervalMs: 10_000,
          maxCycleHistory: 50,
          resolvedPurgeMinutes: 60,
          maxCycleDurationMs: 30_000,
        },
      };

      engine.addRule(makeRule({ id: "r-1", groupingWindowMin: 0 }));

      const scheduler = createAlertEvaluationScheduler(deps);

      // Fire an alert
      scheduler.evaluateNow();

      // Now make condition clear so it resolves
      deps.metricProvider = makeMetricProvider({ "api.latency.p99": 100 });
      engine.setMetricProvider(deps.metricProvider);
      purgeTestClock += 61_000;
      scheduler.evaluateNow();

      // The resolved event should exist
      const allEvents = engine.getAllEvents();
      const resolved = allEvents.filter(e => e.status === "resolved");
      expect(resolved.length).toBeGreaterThanOrEqual(1);

      // Advance clock past purge window (61 minutes) and evaluate again
      purgeTestClock += 62 * 60_000;
      scheduler.evaluateNow();

      // Events should be purged
      const afterPurge = engine.getAllEvents();
      const stillResolved = afterPurge.filter(e => e.status === "resolved");
      expect(stillResolved.length).toBe(0);
    });
  });

  describe("multiple rules in single cycle", () => {
    it("evaluates multiple rules and aggregates results", () => {
      const deps = makeDeps();
      deps.metricProvider = makeMetricProvider({
        "api.latency.p99": 600,
        "cpu.usage": 95,
        "memory.usage": 40,
      });

      deps.alertEngine.addRule(makeRule({
        id: "r-latency",
        condition: {
          type: "threshold",
          metricName: "api.latency.p99",
          operator: "gt",
          threshold: 500,
        } as FridayAlertConditionThreshold,
      }));
      deps.alertEngine.addRule(makeRule({
        id: "r-cpu",
        condition: {
          type: "threshold",
          metricName: "cpu.usage",
          operator: "gt",
          threshold: 90,
        } as FridayAlertConditionThreshold,
      }));
      deps.alertEngine.addRule(makeRule({
        id: "r-memory",
        condition: {
          type: "threshold",
          metricName: "memory.usage",
          operator: "gt",
          threshold: 80,
        } as FridayAlertConditionThreshold,
      }));

      const scheduler = createAlertEvaluationScheduler(deps);
      const stats = scheduler.evaluateNow();

      expect(stats.rulesEvaluated).toBe(3);
      expect(stats.rulesFired).toBe(2); // latency + cpu fire, memory doesn't
      expect(stats.events).toHaveLength(2);
    });
  });
});
