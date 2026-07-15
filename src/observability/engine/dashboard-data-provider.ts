/**
 * Dashboard Data Provider — Aggregates data for observability dashboards.
 *
 * Collects and transforms data from the metrics collector, trace manager,
 * audit trail, alert engine, and health check manager into dashboard-friendly
 * formats. Supports time-series aggregation with configurable bucket sizes.
 *
 * @module observability/engine
 */

import type {
  FridayAlertEvent,
  FridayAlertSeverity,
  FridayObservabilityModule,
  FridaySpanStatus,
  ISODateTime,
} from "../model/friday-observability.types.js";

import type { FridayMetricsCollector, MetricSnapshot } from "./metrics-collector.js";
import type { FridayTraceManager } from "./trace-manager.js";
import type { FridayAuditTrail } from "./audit-trail.js";
import type { FridayAlertEngine } from "./alert-engine.js";
import type { FridayHealthCheckManager, SystemHealth } from "./health-check-manager.js";

// ─── Time-Series Types ───

/** Supported bucket sizes for time-series aggregation. */
export type BucketSize = "1m" | "5m" | "1h" | "1d";

/** Bucket size to milliseconds mapping. */
const BUCKET_MS: Record<BucketSize, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/**
 * Hard per-metric cap on retained time-series points. `recordDataPoint` keeps
 * only the newest `FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC` points per metric
 * (a bounded ring buffer that evicts the oldest), so a long-running Home Hub
 * cannot grow this in-memory store without bound.
 *
 * Every periodic gauge/counter/histogram — including the report-only
 * `realtime_events` growth gauges reported every 5 minutes — flows through
 * `recordDataPoint`, so without this cap a 10,000-report run would retain 10,000
 * points PER metric forever. At 2,000 points and a 5-minute cadence this still
 * preserves ~7 days of the RECENT trend the readback needs while staying O(1)
 * in memory. The whole store remains RESTART-VOLATILE (cleared on Hub restart).
 */
export const FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC = 2000;

/** A single time-series data point. */
export interface TimeSeriesPoint {
  /** Bucket start timestamp. */
  readonly timestamp: ISODateTime;
  /** Aggregated value for this bucket. */
  readonly value: number;
}

/** A time-series query specification. */
export interface TimeSeriesQuery {
  /** The metric name to query. */
  readonly metricName: string;
  /** Start of the time range (inclusive). */
  readonly startTime: ISODateTime;
  /** End of the time range (exclusive). */
  readonly endTime: ISODateTime;
  /** Aggregation bucket size. */
  readonly bucketSize: BucketSize;
}

/** A time-series result. */
export interface TimeSeriesResult {
  /** The queried metric name. */
  readonly metricName: string;
  /** The data points. */
  readonly points: readonly TimeSeriesPoint[];
  /** Bucket size used. */
  readonly bucketSize: BucketSize;
  /** Start of the time range. */
  readonly startTime: ISODateTime;
  /** End of the time range. */
  readonly endTime: ISODateTime;
}

// ─── Dashboard Summary Types ───

/** Summary of trace activity for the dashboard. */
export interface TraceSummaryStats {
  /** Total number of completed traces. */
  readonly totalTraces: number;
  /** Number of traces with error status. */
  readonly errorTraces: number;
  /** Number of traces with ok status. */
  readonly okTraces: number;
  /** Average trace duration in milliseconds. */
  readonly avgDurationMs: number;
  /** Number of currently active (in-progress) traces. */
  readonly activeTraces: number;
}

/** Summary of audit activity for the dashboard. */
export interface AuditSummaryStats {
  /** Total number of audit entries. */
  readonly totalEntries: number;
  /** Entries grouped by action category. */
  readonly byCategory: Record<string, number>;
  /** Entries grouped by outcome. */
  readonly byOutcome: Record<string, number>;
  /** Entries grouped by module. */
  readonly byModule: Record<string, number>;
}

/** Summary of alert activity for the dashboard. */
export interface AlertSummaryStats {
  /** Total number of active (non-resolved) alerts. */
  readonly activeAlerts: number;
  /** Active alerts grouped by severity. */
  readonly bySeverity: Record<string, number>;
  /** Active alerts grouped by status. */
  readonly byStatus: Record<string, number>;
  /** The highest severity among active alerts. */
  readonly highestSeverity: FridayAlertSeverity | null;
  /** Total number of configured alert rules. */
  readonly totalRules: number;
}

/** Full dashboard overview. */
export interface DashboardOverview {
  /** Trace activity summary. */
  readonly traces: TraceSummaryStats;
  /** Audit activity summary. */
  readonly audit: AuditSummaryStats;
  /** Alerts summary. */
  readonly alerts: AlertSummaryStats;
  /** System health. */
  readonly health: SystemHealth | null;
  /** When this overview was generated. */
  readonly generatedAt: ISODateTime;
}

// ─── Dashboard Data Provider ───

/**
 * Aggregates observability data for dashboard consumption.
 *
 * Usage:
 * ```ts
 * const provider = new FridayDashboardDataProvider({
 *   metrics: metricsCollector,
 *   traces: traceManager,
 *   audit: auditTrail,
 *   alerts: alertEngine,
 *   health: healthCheckManager,
 * });
 * const overview = await provider.getOverview();
 * ```
 */
export class FridayDashboardDataProvider {
  private readonly metrics: FridayMetricsCollector | null;
  private readonly traces: FridayTraceManager | null;
  private readonly audit: FridayAuditTrail | null;
  private readonly alerts: FridayAlertEngine | null;
  private readonly health: FridayHealthCheckManager | null;

  /** Time-series data store: metricName → array of (timestamp, value). */
  private readonly timeSeriesData = new Map<string, Array<{ timestamp: number; value: number }>>();

  constructor(deps: {
    metrics?: FridayMetricsCollector | null;
    traces?: FridayTraceManager | null;
    audit?: FridayAuditTrail | null;
    alerts?: FridayAlertEngine | null;
    health?: FridayHealthCheckManager | null;
  }) {
    this.metrics = deps.metrics ?? null;
    this.traces = deps.traces ?? null;
    this.audit = deps.audit ?? null;
    this.alerts = deps.alerts ?? null;
    this.health = deps.health ?? null;
  }

  // ─── Time-Series ───

  /**
   * Record a time-series data point.
   *
   * BOUNDED: retains only the newest `FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC`
   * points per metric (ring buffer, oldest evicted). Prevents unbounded
   * in-memory growth from periodic gauges/counters on a long-running Hub while
   * preserving the recent trend the readback needs (the newest points survive).
   */
  recordDataPoint(metricName: string, value: number, timestamp?: ISODateTime): void {
    const ts = timestamp ? new Date(timestamp).getTime() : Date.now();
    let series = this.timeSeriesData.get(metricName);
    if (!series) {
      series = [];
      this.timeSeriesData.set(metricName, series);
    }
    series.push({ timestamp: ts, value });
    // Evict the oldest points beyond the cap. One push adds one point, so at
    // steady state this removes exactly one — O(1) amortized, never unbounded.
    const overflow = series.length - FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC;
    if (overflow > 0) {
      series.splice(0, overflow);
    }
  }

  /**
   * Number of time-series points currently retained for a metric (diagnostics /
   * retention observability). Always ≤ `FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC`.
   */
  timeSeriesPointCount(metricName: string): number {
    return this.timeSeriesData.get(metricName)?.length ?? 0;
  }

  /** Query time-series data with aggregation. */
  queryTimeSeries(query: TimeSeriesQuery): TimeSeriesResult {
    const series = this.timeSeriesData.get(query.metricName) ?? [];
    const startMs = new Date(query.startTime).getTime();
    const endMs = new Date(query.endTime).getTime();
    const bucketMs = BUCKET_MS[query.bucketSize];

    // Filter to time range
    const filtered = series.filter((p) => p.timestamp >= startMs && p.timestamp < endMs);

    // Group into buckets and compute averages
    const buckets = new Map<number, number[]>();
    for (const point of filtered) {
      const bucketStart = Math.floor((point.timestamp - startMs) / bucketMs) * bucketMs + startMs;
      let bucket = buckets.get(bucketStart);
      if (!bucket) {
        bucket = [];
        buckets.set(bucketStart, bucket);
      }
      bucket.push(point.value);
    }

    // Generate all bucket timestamps in the range
    const points: TimeSeriesPoint[] = [];
    for (let ts = startMs; ts < endMs; ts += bucketMs) {
      const bucketValues = buckets.get(ts);
      if (bucketValues && bucketValues.length > 0) {
        const avg = bucketValues.reduce((a, b) => a + b, 0) / bucketValues.length;
        points.push({
          timestamp: new Date(ts).toISOString(),
          value: Math.round(avg * 1000) / 1000,
        });
      } else {
        points.push({
          timestamp: new Date(ts).toISOString(),
          value: 0,
        });
      }
    }

    return {
      metricName: query.metricName,
      points,
      bucketSize: query.bucketSize,
      startTime: query.startTime,
      endTime: query.endTime,
    };
  }

  // ─── Summaries ───

  /** Get trace activity summary. */
  getTraceSummary(): TraceSummaryStats {
    if (!this.traces) {
      return { totalTraces: 0, errorTraces: 0, okTraces: 0, avgDurationMs: 0, activeTraces: 0 };
    }

    const completed = this.traces.getCompletedTraces();
    let errorCount = 0;
    let okCount = 0;
    let totalDuration = 0;

    for (const trace of completed) {
      if (trace.status === "error") errorCount++;
      else if (trace.status === "ok") okCount++;
      totalDuration += trace.durationMs;
    }

    return {
      totalTraces: completed.length,
      errorTraces: errorCount,
      okTraces: okCount,
      avgDurationMs: completed.length > 0 ? Math.round(totalDuration / completed.length) : 0,
      activeTraces: this.traces.getActiveTraceCount(),
    };
  }

  /** Get audit activity summary. */
  getAuditSummary(): AuditSummaryStats {
    if (!this.audit) {
      return { totalEntries: 0, byCategory: {}, byOutcome: {}, byModule: {} };
    }

    const entries = this.audit.getEntries();
    const byCategory: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    const byModule: Record<string, number> = {};

    for (const entry of entries) {
      byCategory[entry.actionCategory] = (byCategory[entry.actionCategory] ?? 0) + 1;
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1;
      byModule[entry.module] = (byModule[entry.module] ?? 0) + 1;
    }

    return {
      totalEntries: entries.length,
      byCategory,
      byOutcome,
      byModule,
    };
  }

  /** Get alert activity summary. */
  getAlertSummary(): AlertSummaryStats {
    if (!this.alerts) {
      return {
        activeAlerts: 0,
        bySeverity: {},
        byStatus: {},
        highestSeverity: null,
        totalRules: 0,
      };
    }

    const activeEvents = this.alerts.getActiveEvents();
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const event of activeEvents) {
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
      byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
    }

    return {
      activeAlerts: activeEvents.length,
      bySeverity,
      byStatus,
      highestSeverity: this.alerts.getHighestActiveSeverity(),
      totalRules: this.alerts.getRules().length,
    };
  }

  /** Get full dashboard overview. */
  async getOverview(): Promise<DashboardOverview> {
    const systemHealth = this.health ? await this.health.checkAll() : null;

    return {
      traces: this.getTraceSummary(),
      audit: this.getAuditSummary(),
      alerts: this.getAlertSummary(),
      health: systemHealth,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Get a snapshot of a specific metric from the metrics collector. */
  getMetricSnapshot(metricName: string): MetricSnapshot | null {
    if (!this.metrics) return null;
    return this.metrics.getSnapshot(metricName);
  }

  /** Clear all time-series data. */
  clearTimeSeriesData(): void {
    this.timeSeriesData.clear();
  }

  /** Purge time-series data older than the given cutoff. */
  purgeTimeSeriesBefore(cutoff: ISODateTime): number {
    const cutoffMs = new Date(cutoff).getTime();
    let purged = 0;
    for (const [name, series] of this.timeSeriesData) {
      const before = series.length;
      const filtered = series.filter((p) => p.timestamp >= cutoffMs);
      purged += before - filtered.length;
      if (filtered.length === 0) {
        this.timeSeriesData.delete(name);
      } else {
        this.timeSeriesData.set(name, filtered);
      }
    }
    return purged;
  }
}
