import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FridayAlertEngine } from "../../../../src/observability/engine/alert-engine.js";
import { FridayAuditTrail } from "../../../../src/observability/engine/audit-trail.js";
import { RunbookExecutor, RunbookRegistry } from "../../../../src/observability/engine/runbook-automation.js";
import { FridayTraceManager } from "../../../../src/observability/engine/trace-manager.js";
import type {
  AlertMetricProvider,
  AlertBurnRateProvider,
} from "../../../../src/observability/engine/alert-engine.js";
import type {
  FridayAlertEvent,
  FridayAlertRule,
  FridayBurnRate,
  ISODateTime,
} from "../../../../src/observability/model/friday-observability.types.js";

// ─── Test Helpers ───

function makeRule(overrides: Partial<FridayAlertRule> = {}): FridayAlertRule {
  return {
    id: "rule-1",
    name: "Test Alert",
    description: "Test description",
    severity: "warning",
    enabled: true,
    condition: {
      type: "threshold",
      metricName: "api.error_rate",
      threshold: 5,
      operator: "gt",
    },
    evaluationIntervalSec: 60,
    channelIds: ["ch-1"],
    escalationTiers: [],
    groupingWindowMin: 1,
    tags: [],
    etag: "etag-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMetricProvider(values: Record<string, number | null> = {}, timestamps: Record<string, ISODateTime | null> = {}): AlertMetricProvider {
  return {
    getMetricValue(name: string) {
      return values[name] ?? null;
    },
    getMetricLastReportedAt(name: string) {
      return timestamps[name] ?? null;
    },
  };
}

function makeBurnRateProvider(rates: Record<string, FridayBurnRate[]> = {}): AlertBurnRateProvider {
  return {
    getBurnRates(sloId: string) {
      return rates[sloId] ?? [];
    },
  };
}

function makeBurnRate(windowMinutes: number, rate: number): FridayBurnRate {
  return {
    sloId: "slo-1",
    windowLabel: `${windowMinutes}m`,
    windowMinutes,
    rate,
    errorRateInWindow: 0.01,
    errorBudgetRate: 0.001,
    exceedsThreshold: rate > 1,
    threshold: 1,
    computedAt: new Date().toISOString(),
  };
}

function promoteToFiring(engine: FridayAlertEngine, ruleId: string): FridayAlertEvent {
  const first = engine.evaluateRule(ruleId);
  expect(first).not.toBeNull();

  if (first!.status === "firing" || first!.status === "escalated") {
    return first!;
  }

  const second = engine.evaluateRule(ruleId);
  expect(second).not.toBeNull();
  expect(second!.status).toBe("firing");
  return second!;
}

describe("FridayAlertEngine", () => {
  let engine: FridayAlertEngine;

  beforeEach(() => {
    engine = new FridayAlertEngine();
  });

  // ─── Rule Management ───

  describe("rule management", () => {
    it("adds and retrieves a rule", () => {
      const rule = makeRule();
      engine.addRule(rule);

      const fetched = engine.getRule("rule-1");
      expect(fetched).toEqual(rule);
      expect(fetched).not.toBe(rule);
    });

    it("removes a rule", () => {
      engine.addRule(makeRule());
      expect(engine.removeRule("rule-1")).toBe(true);
      expect(engine.getRule("rule-1")).toBeNull();
    });

    it("returns false when removing non-existent rule", () => {
      expect(engine.removeRule("nonexistent")).toBe(false);
    });

    it("lists all rules", () => {
      engine.addRule(makeRule({ id: "r1" }));
      engine.addRule(makeRule({ id: "r2" }));
      expect(engine.getRules()).toHaveLength(2);
    });
  });

  // ─── Condition Evaluation ───

  describe("condition evaluation", () => {
    it("evaluates threshold operators correctly", () => {
      engine.setMetricProvider(makeMetricProvider({
        gt: 10,
        gte: 5,
        lt: 3,
        lte: 5,
        eq: 7,
      }));

      expect(engine.evaluateCondition({ type: "threshold", metricName: "gt", threshold: 5, operator: "gt" }).fired).toBe(true);
      expect(engine.evaluateCondition({ type: "threshold", metricName: "gte", threshold: 5, operator: "gte" }).fired).toBe(true);
      expect(engine.evaluateCondition({ type: "threshold", metricName: "lt", threshold: 5, operator: "lt" }).fired).toBe(true);
      expect(engine.evaluateCondition({ type: "threshold", metricName: "lte", threshold: 5, operator: "lte" }).fired).toBe(true);
      expect(engine.evaluateCondition({ type: "threshold", metricName: "eq", threshold: 7, operator: "eq" }).fired).toBe(true);
    });

    it("evaluates absence condition", () => {
      const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
      engine.setMetricProvider(makeMetricProvider({}, { m: oldTime }));
      expect(engine.evaluateCondition({ type: "absence", metricName: "m", absenceMinutes: 5 }).fired).toBe(true);
    });

    it("evaluates anomaly condition after baseline", () => {
      const values = [100, 101, 99, 100, 100, 101, 99, 100, 100, 101];
      for (const value of values) {
        engine.setMetricProvider(makeMetricProvider({ m: value }));
        engine.evaluateCondition({ type: "anomaly", metricName: "m", sensitivity: 2 });
      }

      engine.setMetricProvider(makeMetricProvider({ m: 200 }));
      expect(engine.evaluateCondition({ type: "anomaly", metricName: "m", sensitivity: 2 }).fired).toBe(true);
    });

    it("evaluates burn-rate condition requiring both windows", () => {
      engine.setBurnRateProvider(makeBurnRateProvider({
        "slo-1": [makeBurnRate(5, 15), makeBurnRate(60, 15)],
      }));

      expect(engine.evaluateCondition({
        type: "slo_burn_rate",
        sloId: "slo-1",
        burnRateThreshold: 14.4,
        shortWindowMinutes: 5,
        longWindowMinutes: 60,
      }).fired).toBe(true);
    });
  });

  // ─── State Machine ───

  describe("alert state machine", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("creates pending on first detection", () => {
      engine.addRule(makeRule({ groupingWindowMin: 5 }));

      const event = engine.evaluateRule("rule-1");
      expect(event).not.toBeNull();
      expect(event!.status).toBe("pending");
      expect(event!.firedAt).toBeUndefined();
      expect(event!.notifiedChannelIds).toHaveLength(0);
    });

    it("stays pending until grouping window is sustained", () => {
      engine.addRule(makeRule({ groupingWindowMin: 5 }));

      engine.evaluateRule("rule-1");
      vi.advanceTimersByTime(4 * 60_000);
      const event = engine.evaluateRule("rule-1");

      expect(event).not.toBeNull();
      expect(event!.status).toBe("pending");
      expect(event!.firedAt).toBeUndefined();
    });

    it("transitions pending to firing after grouping window", () => {
      engine.addRule(makeRule({ groupingWindowMin: 5 }));

      engine.evaluateRule("rule-1");
      vi.advanceTimersByTime(5 * 60_000);
      const event = engine.evaluateRule("rule-1");

      expect(event).not.toBeNull();
      expect(event!.status).toBe("firing");
      expect(event!.firedAt).toBeDefined();
      expect(event!.notifiedChannelIds).toEqual(["ch-1"]);
    });

    it("resolves when condition clears from pending", () => {
      engine.addRule(makeRule({ groupingWindowMin: 5 }));

      const pending = engine.evaluateRule("rule-1");
      expect(pending!.status).toBe("pending");

      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 1 }));
      const resolved = engine.evaluateRule("rule-1");

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("resolved");
    });

    it("escalates from firing after tier timeout", () => {
      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 2, channelIds: ["ch-2"] }],
      }));

      const firing = promoteToFiring(engine, "rule-1");
      expect(firing.status).toBe("firing");

      vi.advanceTimersByTime(2 * 60_000);
      const escalated = engine.evaluateRule("rule-1");

      expect(escalated).not.toBeNull();
      expect(escalated!.status).toBe("escalated");
      expect(escalated!.currentEscalationTier).toBe(1);
      expect(escalated!.notifiedChannelIds).toEqual(["ch-1", "ch-2"]);
    });

    it("does not escalate before timeout", () => {
      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 2, channelIds: ["ch-2"] }],
      }));

      promoteToFiring(engine, "rule-1");
      vi.advanceTimersByTime((2 * 60_000) - 1);

      const unchanged = engine.evaluateRule("rule-1");
      expect(unchanged).not.toBeNull();
      expect(unchanged!.status).toBe("firing");
      expect(unchanged!.currentEscalationTier).toBe(0);
    });

    it("supports multiple escalation tiers", () => {
      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [
          { tier: 1, timeoutMinutes: 1, channelIds: ["ch-2"] },
          { tier: 2, timeoutMinutes: 2, channelIds: ["ch-3"] },
        ],
      }));

      promoteToFiring(engine, "rule-1");

      vi.advanceTimersByTime(60_000);
      const tier1 = engine.evaluateRule("rule-1");
      expect(tier1!.status).toBe("escalated");
      expect(tier1!.currentEscalationTier).toBe(1);

      vi.advanceTimersByTime(2 * 60_000);
      const tier2 = engine.evaluateRule("rule-1");
      expect(tier2!.status).toBe("escalated");
      expect(tier2!.currentEscalationTier).toBe(2);
      expect(tier2!.notifiedChannelIds).toEqual(["ch-1", "ch-2", "ch-3"]);
    });

    it("guards against invalid time ordering during escalation", () => {
      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 0, channelIds: ["ch-2"] }],
      }));

      const firing = promoteToFiring(engine, "rule-1");
      const state = engine as unknown as { activeEvents: Map<string, FridayAlertEvent> };
      state.activeEvents.set(firing.id, {
        ...firing,
        firedAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const unchanged = engine.evaluateRule("rule-1");
      expect(unchanged).not.toBeNull();
      expect(unchanged!.status).toBe("firing");
    });

    it("resolves active alerts when condition clears", () => {
      engine.addRule(makeRule({ groupingWindowMin: 0 }));
      const firing = promoteToFiring(engine, "rule-1");
      expect(firing.status).toBe("firing");

      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 1 }));
      const resolved = engine.evaluateRule("rule-1");

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("resolved");
      expect(resolved!.resolvedAt).toBeDefined();
    });

    it("creates a new pending event after a resolved alert re-fires", () => {
      engine.addRule(makeRule({ groupingWindowMin: 0 }));

      const firstCycle = promoteToFiring(engine, "rule-1");
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 1 }));
      engine.evaluateRule("rule-1");

      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      const secondCycle = engine.evaluateRule("rule-1");

      expect(secondCycle).not.toBeNull();
      expect(secondCycle!.status).toBe("pending");
      expect(secondCycle!.id).not.toBe(firstCycle.id);
    });

    it("triggers runbook automation when escalation occurs", () => {
      const registry = new RunbookRegistry();
      const executor = new RunbookExecutor(registry);
      engine.setRunbookExecutor(executor);

      const runbookSpy = vi.fn();
      registry.registerRunbook({
        id: "rb-1",
        name: "Restart API",
        ruleId: "rule-1",
        execute: runbookSpy,
      });

      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 1, channelIds: ["ch-2"] }],
      }));

      promoteToFiring(engine, "rule-1");
      vi.advanceTimersByTime(60_000);

      const escalated = engine.evaluateRule("rule-1");
      expect(escalated!.status).toBe("escalated");
      expect(runbookSpy).toHaveBeenCalledTimes(1);

      const history = executor.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("success");
      expect(history[0].tier).toBe(1);
    });
  });

  // ─── Alert Actions ───

  describe("alert actions", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.addRule(makeRule({ groupingWindowMin: 0 }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("acknowledges a firing alert", () => {
      const event = promoteToFiring(engine, "rule-1");

      const acked = engine.acknowledgeAlert(event.id, "admin", "Investigating");
      expect(acked).not.toBeNull();
      expect(acked!.status).toBe("acknowledged");
      expect(acked!.acknowledgedBy).toBe("admin");
      expect(acked!.acknowledgeNote).toBe("Investigating");
    });

    it("rejects acknowledge transition for pending alerts", () => {
      const pending = engine.evaluateRule("rule-1")!;
      expect(pending.status).toBe("pending");
      expect(engine.acknowledgeAlert(pending.id, "admin")).toBeNull();
    });

    it("prevents escalation after acknowledgement", () => {
      const rule = makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 1, channelIds: ["ch-2"] }],
      });
      engine.reset();
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.addRule(rule);

      const firing = promoteToFiring(engine, "rule-1");
      const acknowledged = engine.acknowledgeAlert(firing.id, "admin")!;
      expect(acknowledged.status).toBe("acknowledged");

      vi.advanceTimersByTime(60_000);
      const unchanged = engine.evaluateRule("rule-1");

      expect(unchanged).not.toBeNull();
      expect(unchanged!.status).toBe("acknowledged");
      expect(unchanged!.currentEscalationTier).toBe(0);
    });

    it("resolves alerts explicitly", () => {
      const event = promoteToFiring(engine, "rule-1");

      const resolved = engine.resolveAlert(event.id);
      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe("resolved");
      expect(resolved!.resolvedAt).toBeDefined();
    });

    it("returns null for non-existent events", () => {
      expect(engine.acknowledgeAlert("fake", "admin")).toBeNull();
      expect(engine.resolveAlert("fake")).toBeNull();
    });
  });

  // ─── Query Methods ───

  describe("query methods", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("getActiveEvents excludes resolved events", () => {
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.addRule(makeRule({ groupingWindowMin: 0 }));
      const event = promoteToFiring(engine, "rule-1");

      expect(engine.getActiveEvents()).toHaveLength(1);
      engine.resolveAlert(event.id);
      expect(engine.getActiveEvents()).toHaveLength(0);
    });

    it("getHighestActiveSeverity returns the most severe active alert", () => {
      engine.setMetricProvider(makeMetricProvider({ m1: 10, m2: 10 }));
      engine.addRule(makeRule({
        id: "r1",
        severity: "warning",
        condition: { type: "threshold", metricName: "m1", threshold: 5, operator: "gt" },
        groupingWindowMin: 0,
      }));
      engine.addRule(makeRule({
        id: "r2",
        severity: "critical",
        condition: { type: "threshold", metricName: "m2", threshold: 5, operator: "gt" },
        groupingWindowMin: 0,
      }));

      promoteToFiring(engine, "r1");
      promoteToFiring(engine, "r2");

      expect(engine.getHighestActiveSeverity()).toBe("critical");
    });

    it("evaluateAll evaluates enabled rules", () => {
      engine.setMetricProvider(makeMetricProvider({ m1: 10, m2: 10 }));
      engine.addRule(makeRule({
        id: "r1",
        condition: { type: "threshold", metricName: "m1", threshold: 5, operator: "gt" },
      }));
      engine.addRule(makeRule({
        id: "r2",
        condition: { type: "threshold", metricName: "m2", threshold: 5, operator: "gt" },
      }));
      engine.addRule(makeRule({ id: "r3", enabled: false }));

      const events = engine.evaluateAll();
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.status === "pending")).toBe(true);
    });

    it("purges resolved events before cutoff", () => {
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.addRule(makeRule({ groupingWindowMin: 0 }));
      const event = promoteToFiring(engine, "rule-1");
      const resolved = engine.resolveAlert(event.id)!;

      const cutoff = new Date(new Date(resolved.resolvedAt!).getTime() + 1).toISOString();
      const purged = engine.purgeResolvedBefore(cutoff);

      expect(purged).toBe(1);
      expect(engine.getAllEvents()).toHaveLength(0);
    });

    it("returns deep-frozen snapshots from all public alert getters", () => {
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.addRule(makeRule({
        groupingWindowMin: 0,
        escalationTiers: [{ tier: 1, timeoutMinutes: 1, channelIds: ["ch-2"] }],
      }));
      const event = promoteToFiring(engine, "rule-1");

      const singleRule = engine.getRule("rule-1")!;
      const allRules = engine.getRules();
      const singleEvent = engine.getEvent(event.id)!;
      const activeEvents = engine.getActiveEvents();
      const allEvents = engine.getAllEvents();

      expect(Object.isFrozen(singleRule)).toBe(true);
      expect(Object.isFrozen(singleRule.condition)).toBe(true);
      expect(Object.isFrozen(singleRule.channelIds)).toBe(true);
      expect(Object.isFrozen(singleRule.escalationTiers)).toBe(true);
      expect(Object.isFrozen(singleRule.escalationTiers[0].channelIds)).toBe(true);
      expect(Object.isFrozen(allRules)).toBe(true);

      expect(Object.isFrozen(singleEvent)).toBe(true);
      expect(Object.isFrozen(singleEvent.notifiedChannelIds)).toBe(true);
      expect(Object.isFrozen(activeEvents)).toBe(true);
      expect(Object.isFrozen(activeEvents[0])).toBe(true);
      expect(Object.isFrozen(allEvents)).toBe(true);

      expect(() => {
        singleRule.name = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        singleRule.channelIds.push("ch-x");
      }).toThrow(TypeError);
      expect(() => {
        singleRule.escalationTiers[0].channelIds[0] = "hijacked";
      }).toThrow(TypeError);
      expect(() => {
        singleEvent.status = "resolved";
      }).toThrow(TypeError);
      expect(() => {
        activeEvents[0].notifiedChannelIds.push("ch-x");
      }).toThrow(TypeError);

      expect(engine.getRule("rule-1")!.name).toBe("Test Alert");
      expect(engine.getEvent(event.id)!.status).toBe("firing");
    });
  });

  // ─── KPI Validation ───

  describe("kpi validation", () => {
    it("validates trace completeness >99%", () => {
      const traces = new FridayTraceManager();
      const total = 200;
      let validCompleted = 0;

      for (let i = 0; i < total; i++) {
        const { traceId, rootSpanContext } = traces.startTrace({
          name: `kpi-trace-${i}`,
          module: "api",
          operationName: "request",
          attributes: { "trace.index": i },
        });

        const child = traces.startSpan({
          operationName: "child-op",
          module: "rules",
          parentContext: rootSpanContext,
          attributes: { "child.index": i },
        });

        traces.addSpanEvent(child.spanContext, { name: "checkpoint" });
        traces.endSpan(child.spanContext, "ok");
        traces.endSpan(rootSpanContext, "ok");

        const trace = traces.getTrace(traceId);
        if (
          trace
          && trace.spans.length > 0
          && trace.spans.every((span) => span.endedAt !== undefined && typeof span.durationMs === "number")
        ) {
          validCompleted++;
        }
      }

      const completeness = validCompleted / total;
      expect(completeness).toBeGreaterThan(0.99);
    });

    it("validates alert MTTD <5 minutes", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
        engine.addRule(makeRule({
          id: "mttd-rule",
          groupingWindowMin: 4,
        }));

        const breachDetectedAt = Date.now();
        const pending = engine.evaluateRule("mttd-rule");
        expect(pending).not.toBeNull();
        expect(pending!.status).toBe("pending");

        vi.advanceTimersByTime(4 * 60_000);
        const firing = engine.evaluateRule("mttd-rule");
        expect(firing).not.toBeNull();
        expect(firing!.status).toBe("firing");

        const mttdMs = new Date(firing!.firedAt!).getTime() - breachDetectedAt;
        expect(mttdMs).toBeLessThan(5 * 60_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("validates audit query p95 latency <500ms", async () => {
      const trail = new FridayAuditTrail();
      for (let i = 0; i < 150; i++) {
        await trail.append({
          actor: { type: "user", id: `user-${i % 5}` },
          actionCategory: i % 2 === 0 ? "create" : "update",
          action: i % 2 === 0 ? "rules.create" : "rules.update",
          resource: { type: "rule", id: `rule-${i % 20}` },
          outcome: "success",
          description: `Audit entry ${i}`,
          module: i % 2 === 0 ? "rules" : "api",
          metadata: { batch: i % 10 },
        });
      }

      const latenciesMs: number[] = [];
      for (let i = 0; i < 200; i++) {
        const startMs = Date.now();
        trail.query({
          actorId: `user-${i % 5}`,
          actionCategory: i % 2 === 0 ? "create" : "update",
          module: i % 2 === 0 ? "rules" : "api",
        });
        latenciesMs.push(Date.now() - startMs);
      }

      const sorted = [...latenciesMs].sort((a, b) => a - b);
      const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
      const p95Ms = sorted[p95Index];
      expect(p95Ms).toBeLessThan(500);
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("clears all state", () => {
      engine.addRule(makeRule());
      engine.setMetricProvider(makeMetricProvider({ "api.error_rate": 10 }));
      engine.evaluateAll();
      engine.reset();

      expect(engine.getRules()).toHaveLength(0);
      expect(engine.getAllEvents()).toHaveLength(0);
    });
  });
});
