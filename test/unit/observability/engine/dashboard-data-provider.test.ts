import { describe, it, expect, beforeEach } from "vitest";
import {
  FridayDashboardDataProvider,
  FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC,
} from "../../../../src/observability/engine/dashboard-data-provider.js";
import { FridayMetricsCollector } from "../../../../src/observability/engine/metrics-collector.js";
import { FridayTraceManager } from "../../../../src/observability/engine/trace-manager.js";
import { FridayAuditTrail } from "../../../../src/observability/engine/audit-trail.js";
import { FridayAlertEngine } from "../../../../src/observability/engine/alert-engine.js";
import { FridayHealthCheckManager } from "../../../../src/observability/engine/health-check-manager.js";
import type { ComponentHealth } from "../../../../src/observability/engine/health-check-manager.js";

// ─── Test Helpers ───

function createFullProvider() {
  const metrics = new FridayMetricsCollector();
  const traces = new FridayTraceManager();
  const audit = new FridayAuditTrail();
  const alerts = new FridayAlertEngine();
  const health = new FridayHealthCheckManager();

  const provider = new FridayDashboardDataProvider({
    metrics,
    traces,
    audit,
    alerts,
    health,
  });

  return { provider, metrics, traces, audit, alerts, health };
}

describe("FridayDashboardDataProvider", () => {
  // ─── Time Series ───

  describe("time series", () => {
    it("records and queries time series data", () => {
      const { provider } = createFullProvider();
      const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

      provider.recordDataPoint("cpu.usage", 50, new Date(baseTime).toISOString());
      provider.recordDataPoint("cpu.usage", 60, new Date(baseTime + 30_000).toISOString());
      provider.recordDataPoint("cpu.usage", 70, new Date(baseTime + 90_000).toISOString());

      const result = provider.queryTimeSeries({
        metricName: "cpu.usage",
        startTime: new Date(baseTime).toISOString(),
        endTime: new Date(baseTime + 120_000).toISOString(),
        bucketSize: "1m",
      });

      expect(result.metricName).toBe("cpu.usage");
      expect(result.points).toHaveLength(2); // 2 one-minute buckets
      expect(result.points[0].value).toBe(55); // avg(50, 60)
      expect(result.points[1].value).toBe(70); // avg(70)
    });

    it("BOUNDS retained points per metric under high-frequency recording (ring buffer, newest survive)", () => {
      const { provider } = createFullProvider();
      const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

      // Record far more points than the cap for a single metric. Without a bound
      // this in-memory store would retain all TICKS points forever (unbounded
      // Home Hub memory growth); the ring buffer must evict the oldest.
      const TICKS = FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC + 2500;
      // Record value = i + 1 so a PRESENT oldest point (value 1) is distinguishable
      // from an EVICTED one (empty bucket → 0).
      for (let i = 0; i < TICKS; i++) {
        provider.recordDataPoint("g", i + 1, new Date(baseTime + i * 60_000).toISOString());
      }

      // BOUNDED: retained point count never exceeds the cap (pre-fix: all TICKS).
      expect(provider.timeSeriesPointCount("g")).toBe(FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC);

      // NEWEST survive: the last recorded value is still queryable.
      const tail = provider.queryTimeSeries({
        metricName: "g",
        startTime: new Date(baseTime + (TICKS - 1) * 60_000).toISOString(),
        endTime: new Date(baseTime + TICKS * 60_000).toISOString(),
        bucketSize: "1m",
      });
      expect(tail.points[0].value).toBe(TICKS); // value of the last tick (i+1)

      // OLDEST evicted: the very first minute's point was dropped by the ring
      // buffer. Pre-fix (unbounded) it was PRESENT with value 1; post-fix the
      // bucket is empty → 0.
      const head = provider.queryTimeSeries({
        metricName: "g",
        startTime: new Date(baseTime).toISOString(),
        endTime: new Date(baseTime + 60_000).toISOString(),
        bucketSize: "1m",
      });
      expect(head.points[0].value).toBe(0); // evicted → empty bucket → 0
    });

    it("fills empty buckets with zero", () => {
      const { provider } = createFullProvider();
      const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

      provider.recordDataPoint("cpu.usage", 50, new Date(baseTime).toISOString());
      // Skip second minute
      provider.recordDataPoint("cpu.usage", 70, new Date(baseTime + 120_000).toISOString());

      const result = provider.queryTimeSeries({
        metricName: "cpu.usage",
        startTime: new Date(baseTime).toISOString(),
        endTime: new Date(baseTime + 180_000).toISOString(),
        bucketSize: "1m",
      });

      expect(result.points).toHaveLength(3);
      expect(result.points[1].value).toBe(0); // empty bucket
    });

    it("returns empty points for unknown metric", () => {
      const { provider } = createFullProvider();
      const result = provider.queryTimeSeries({
        metricName: "unknown",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T01:00:00.000Z",
        bucketSize: "1h",
      });

      expect(result.points).toHaveLength(1);
      expect(result.points[0].value).toBe(0);
    });

    it("supports 5-minute bucket size", () => {
      const { provider } = createFullProvider();
      const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

      for (let i = 0; i < 10; i++) {
        provider.recordDataPoint("m", i * 10, new Date(baseTime + i * 60_000).toISOString());
      }

      const result = provider.queryTimeSeries({
        metricName: "m",
        startTime: new Date(baseTime).toISOString(),
        endTime: new Date(baseTime + 600_000).toISOString(),
        bucketSize: "5m",
      });

      expect(result.points).toHaveLength(2);
    });
  });

  // ─── Trace Summary ───

  describe("getTraceSummary", () => {
    it("returns zeroes when no traces", () => {
      const { provider } = createFullProvider();
      const summary = provider.getTraceSummary();
      expect(summary.totalTraces).toBe(0);
      expect(summary.avgDurationMs).toBe(0);
    });

    it("aggregates completed trace stats", () => {
      const { provider, traces } = createFullProvider();

      // Create and complete 2 ok traces and 1 error trace
      for (let i = 0; i < 2; i++) {
        const { rootSpanContext } = traces.startTrace({
          name: `ok-${i}`,
          module: "api",
          operationName: "op",
        });
        traces.endSpan(rootSpanContext, "ok");
      }

      const { rootSpanContext } = traces.startTrace({
        name: "error",
        module: "api",
        operationName: "op",
      });
      traces.setSpanStatus(rootSpanContext, "error");
      traces.endSpan(rootSpanContext);

      // Start an active trace (not completed)
      traces.startTrace({ name: "active", module: "api", operationName: "op" });

      const summary = provider.getTraceSummary();
      expect(summary.totalTraces).toBe(3);
      expect(summary.okTraces).toBe(2);
      expect(summary.errorTraces).toBe(1);
      expect(summary.activeTraces).toBe(1);
    });

    it("returns zeroes when traces is null", () => {
      const provider = new FridayDashboardDataProvider({});
      const summary = provider.getTraceSummary();
      expect(summary.totalTraces).toBe(0);
    });
  });

  // ─── Audit Summary ───

  describe("getAuditSummary", () => {
    it("returns zeroes when no entries", () => {
      const { provider } = createFullProvider();
      const summary = provider.getAuditSummary();
      expect(summary.totalEntries).toBe(0);
    });

    it("aggregates audit entry stats", async () => {
      const { provider, audit } = createFullProvider();

      await audit.append({
        actor: { type: "user", id: "u1", displayName: "Alice" },
        actionCategory: "create",
        action: "rules.create",
        resource: { type: "rule", id: "r1" },
        outcome: "success",
        description: "Created rule",
        module: "rules",
      });
      await audit.append({
        actor: { type: "system", id: "sys", displayName: "System" },
        actionCategory: "delete",
        action: "rules.delete",
        resource: { type: "rule", id: "r2" },
        outcome: "failure",
        description: "Deleted rule",
        module: "api",
      });

      const summary = provider.getAuditSummary();
      expect(summary.totalEntries).toBe(2);
      expect(summary.byCategory.create).toBe(1);
      expect(summary.byCategory.delete).toBe(1);
      expect(summary.byOutcome.success).toBe(1);
      expect(summary.byOutcome.failure).toBe(1);
      expect(summary.byModule.rules).toBe(1);
      expect(summary.byModule.api).toBe(1);
    });
  });

  // ─── Alert Summary ───

  describe("getAlertSummary", () => {
    it("returns zeroes when no alerts", () => {
      const { provider } = createFullProvider();
      const summary = provider.getAlertSummary();
      expect(summary.activeAlerts).toBe(0);
      expect(summary.highestSeverity).toBeNull();
    });

    it("aggregates alert stats", () => {
      const { provider, alerts } = createFullProvider();

      alerts.setMetricProvider({
        getMetricValue: (name: string) => name === "m1" ? 10 : name === "m2" ? 10 : null,
        getMetricLastReportedAt: () => null,
      });
      alerts.addRule({
        id: "r1", name: "R1", description: "", severity: "critical", enabled: true,
        condition: { type: "threshold", metricName: "m1", threshold: 5, operator: "gt" },
        evaluationIntervalSec: 60, channelIds: [], escalationTiers: [],
        groupingWindowMin: 5, tags: [], etag: "", createdAt: "", updatedAt: "",
      });
      alerts.addRule({
        id: "r2", name: "R2", description: "", severity: "warning", enabled: true,
        condition: { type: "threshold", metricName: "m2", threshold: 5, operator: "gt" },
        evaluationIntervalSec: 60, channelIds: [], escalationTiers: [],
        groupingWindowMin: 5, tags: [], etag: "", createdAt: "", updatedAt: "",
      });
      alerts.evaluateAll();

      const summary = provider.getAlertSummary();
      expect(summary.activeAlerts).toBe(2);
      expect(summary.bySeverity.critical).toBe(1);
      expect(summary.bySeverity.warning).toBe(1);
      expect(summary.highestSeverity).toBe("critical");
      expect(summary.totalRules).toBe(2);
    });
  });

  // ─── Dashboard Overview ───

  describe("getOverview", () => {
    it("returns a complete overview", async () => {
      const { provider, health } = createFullProvider();

      health.registerCheck("api", "api", async (): Promise<ComponentHealth> => ({
        name: "api",
        module: "api",
        status: "healthy",
        dependencies: [],
        lastCheckedAt: new Date().toISOString(),
        checkDurationMs: 1,
      }));

      const overview = await provider.getOverview();
      expect(overview.traces).toBeDefined();
      expect(overview.audit).toBeDefined();
      expect(overview.alerts).toBeDefined();
      expect(overview.health).not.toBeNull();
      expect(overview.health!.status).toBe("healthy");
      expect(overview.generatedAt).toBeDefined();
    });

    it("returns null health when no health manager", async () => {
      const provider = new FridayDashboardDataProvider({});
      const overview = await provider.getOverview();
      expect(overview.health).toBeNull();
    });
  });

  // ─── Metric Snapshot ───

  describe("getMetricSnapshot", () => {
    it("returns snapshot from metrics collector", () => {
      const { provider, metrics } = createFullProvider();
      metrics.registerCounter("api.requests", "api");
      metrics.incrementCounter("api.requests", {}, 42);

      const snap = provider.getMetricSnapshot("api.requests");
      expect(snap).toMatchObject({ type: "counter", value: 42 });
    });

    it("returns null without metrics collector", () => {
      const provider = new FridayDashboardDataProvider({});
      expect(provider.getMetricSnapshot("any")).toBeNull();
    });
  });

  // ─── Time Series Maintenance ───

  describe("clearTimeSeriesData", () => {
    it("clears all time series data", () => {
      const { provider } = createFullProvider();
      provider.recordDataPoint("m", 1);
      provider.clearTimeSeriesData();

      const result = provider.queryTimeSeries({
        metricName: "m",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2027-01-01T00:00:00.000Z",
        bucketSize: "1d",
      });

      // All zero since data was cleared
      for (const p of result.points) {
        expect(p.value).toBe(0);
      }
    });
  });

  describe("purgeTimeSeriesBefore", () => {
    it("purges old data points", () => {
      const { provider } = createFullProvider();
      const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();

      provider.recordDataPoint("m", 10, new Date(baseTime).toISOString());
      provider.recordDataPoint("m", 20, new Date(baseTime + 86_400_000).toISOString());

      const purged = provider.purgeTimeSeriesBefore(new Date(baseTime + 1).toISOString());
      expect(purged).toBe(1);
    });
  });
});
