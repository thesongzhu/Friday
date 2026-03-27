import { FridayDomainError } from "#errors";

/**
 * Metrics Collector — Collects and aggregates runtime metrics.
 *
 * Supports three metric types:
 * - **Counter** — Monotonically increasing value (e.g., request count).
 * - **Gauge** — Point-in-time value that can go up or down (e.g., active connections).
 * - **Histogram** — Distribution of values with configurable buckets (e.g., latency).
 *
 * All metrics are namespaced by module and metric name (dot-separated).
 * Thread-safe within a single Node.js event loop (no shared-state concurrency).
 *
 * @module observability/engine
 */

import type {
  FridayObservabilityModule,
  ISODateTime,
} from "../model/friday-observability.types.js";

// ─── Metric Types ───

/** The kind of metric being collected. */
export type MetricType = "counter" | "gauge" | "histogram";

/** Label set for dimensional metrics. */
export interface MetricLabels {
  readonly [key: string]: string;
}

/** A single data point in a metric time series. */
export interface MetricDataPoint {
  readonly value: number;
  readonly timestamp: ISODateTime;
  readonly labels: MetricLabels;
}

/** Snapshot of a counter metric. */
export interface CounterSnapshot {
  readonly type: "counter";
  readonly name: string;
  readonly module: FridayObservabilityModule;
  readonly value: number;
  readonly labels: MetricLabels;
}

/** Snapshot of a gauge metric. */
export interface GaugeSnapshot {
  readonly type: "gauge";
  readonly name: string;
  readonly module: FridayObservabilityModule;
  readonly value: number;
  readonly labels: MetricLabels;
}

/** Histogram bucket boundary with cumulative count. */
export interface HistogramBucket {
  readonly upperBound: number;
  readonly count: number;
}

/** Snapshot of a histogram metric. */
export interface HistogramSnapshot {
  readonly type: "histogram";
  readonly name: string;
  readonly module: FridayObservabilityModule;
  readonly buckets: readonly HistogramBucket[];
  readonly sum: number;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly labels: MetricLabels;
}

/** Union of all metric snapshots. */
export type MetricSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

// ─── Default Histogram Buckets ───

/** Default latency buckets in milliseconds (inspired by Prometheus defaults). */
export const DEFAULT_HISTOGRAM_BUCKETS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

// ─── Internal State ───

/** Serializable key for a metric + label combination. */
function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

/** Internal counter state. */
interface CounterState {
  value: number;
}

/** Internal gauge state. */
interface GaugeState {
  value: number;
}

/** Internal histogram state. */
interface HistogramState {
  buckets: number[];
  boundaries: readonly number[];
  sum: number;
  count: number;
  min: number;
  max: number;
}

/** Internal metric entry keyed by label combination. */
interface MetricEntry<T> {
  module: FridayObservabilityModule;
  states: Map<string, T>;
}

// ─── Metrics Collector ───

/**
 * In-memory metrics collector supporting counters, gauges, and histograms.
 *
 * Usage:
 * ```ts
 * const collector = new FridayMetricsCollector();
 * collector.registerCounter("api.requests_total", "api");
 * collector.incrementCounter("api.requests_total", { method: "GET" });
 * const snapshot = collector.getSnapshot("api.requests_total", { method: "GET" });
 * ```
 */
export class FridayMetricsCollector {
  private readonly counters = new Map<string, MetricEntry<CounterState>>();
  private readonly gauges = new Map<string, MetricEntry<GaugeState>>();
  private readonly histograms = new Map<string, MetricEntry<HistogramState>>();
  private readonly histogramBoundaries = new Map<string, readonly number[]>();

  // ─── Registration ───

  /** Register a new counter metric. Throws if already registered. */
  registerCounter(name: string, module: FridayObservabilityModule): void {
    if (this.counters.has(name)) {
      throw new FridayDomainError("VALIDATION_ERROR", `Counter "${name}" is already registered`, { httpStatus: 400 });
    }
    this.counters.set(name, { module, states: new Map() });
  }

  /** Register a new gauge metric. Throws if already registered. */
  registerGauge(name: string, module: FridayObservabilityModule): void {
    if (this.gauges.has(name)) {
      throw new FridayDomainError("VALIDATION_ERROR", `Gauge "${name}" is already registered`, { httpStatus: 400 });
    }
    this.gauges.set(name, { module, states: new Map() });
  }

  /** Register a new histogram metric with optional custom bucket boundaries. */
  registerHistogram(
    name: string,
    module: FridayObservabilityModule,
    buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS,
  ): void {
    if (this.histograms.has(name)) {
      throw new FridayDomainError("VALIDATION_ERROR", `Histogram "${name}" is already registered`, { httpStatus: 400 });
    }
    const sorted = [...buckets].sort((a, b) => a - b);
    this.histogramBoundaries.set(name, sorted);
    this.histograms.set(name, { module, states: new Map() });
  }

  // ─── Counter Operations ───

  /** Increment a counter by a positive delta (default 1). */
  incrementCounter(name: string, labels: MetricLabels = {}, delta: number = 1): void {
    if (delta < 0) {
      throw new FridayDomainError("VALIDATION_ERROR", `Counter delta must be non-negative, got ${delta}`, { httpStatus: 400 });
    }
    const entry = this.counters.get(name);
    if (!entry) {
      throw new FridayDomainError("NOT_FOUND", `Counter "${name}" is not registered`, { httpStatus: 404 });
    }
    const key = labelKey(labels);
    const state = entry.states.get(key);
    if (state) {
      state.value += delta;
    } else {
      entry.states.set(key, { value: delta });
    }
  }

  // ─── Gauge Operations ───

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const entry = this.gauges.get(name);
    if (!entry) {
      throw new FridayDomainError("NOT_FOUND", `Gauge "${name}" is not registered`, { httpStatus: 404 });
    }
    const key = labelKey(labels);
    const state = entry.states.get(key);
    if (state) {
      state.value = value;
    } else {
      entry.states.set(key, { value });
    }
  }

  /** Increment a gauge by a delta (can be negative). */
  incrementGauge(name: string, delta: number = 1, labels: MetricLabels = {}): void {
    const entry = this.gauges.get(name);
    if (!entry) {
      throw new FridayDomainError("NOT_FOUND", `Gauge "${name}" is not registered`, { httpStatus: 404 });
    }
    const key = labelKey(labels);
    const state = entry.states.get(key);
    if (state) {
      state.value += delta;
    } else {
      entry.states.set(key, { value: delta });
    }
  }

  // ─── Histogram Operations ───

  /** Record a value in a histogram. */
  recordHistogram(name: string, value: number, labels: MetricLabels = {}): void {
    const entry = this.histograms.get(name);
    if (!entry) {
      throw new FridayDomainError("NOT_FOUND", `Histogram "${name}" is not registered`, { httpStatus: 404 });
    }
    const boundaries = this.histogramBoundaries.get(name)!;
    const key = labelKey(labels);
    let state = entry.states.get(key);
    if (!state) {
      state = {
        buckets: new Array(boundaries.length).fill(0),
        boundaries,
        sum: 0,
        count: 0,
        min: Infinity,
        max: -Infinity,
      };
      entry.states.set(key, state);
    }
    state.sum += value;
    state.count += 1;
    if (value < state.min) state.min = value;
    if (value > state.max) state.max = value;
    for (let i = 0; i < boundaries.length; i++) {
      if (value <= boundaries[i]) {
        state.buckets[i] += 1;
      }
    }
  }

  // ─── Snapshots ───

  /** Get a snapshot of a specific metric + label combination. Returns null if not found. */
  getSnapshot(name: string, labels: MetricLabels = {}): MetricSnapshot | null {
    const key = labelKey(labels);

    const counter = this.counters.get(name);
    if (counter) {
      const state = counter.states.get(key);
      return {
        type: "counter",
        name,
        module: counter.module,
        value: state?.value ?? 0,
        labels,
      };
    }

    const gauge = this.gauges.get(name);
    if (gauge) {
      const state = gauge.states.get(key);
      return {
        type: "gauge",
        name,
        module: gauge.module,
        value: state?.value ?? 0,
        labels,
      };
    }

    const histogram = this.histograms.get(name);
    if (histogram) {
      const state = histogram.states.get(key);
      const boundaries = this.histogramBoundaries.get(name)!;
      if (!state) {
        return {
          type: "histogram",
          name,
          module: histogram.module,
          buckets: boundaries.map((b) => ({ upperBound: b, count: 0 })),
          sum: 0,
          count: 0,
          min: 0,
          max: 0,
          labels,
        };
      }
      return {
        type: "histogram",
        name,
        module: histogram.module,
        buckets: boundaries.map((b, i) => ({ upperBound: b, count: state.buckets[i] })),
        sum: state.sum,
        count: state.count,
        min: state.min === Infinity ? 0 : state.min,
        max: state.max === -Infinity ? 0 : state.max,
        labels,
      };
    }

    return null;
  }

  /** Get all snapshots for a named metric (across all label combinations). */
  getAllSnapshots(name: string): MetricSnapshot[] {
    const results: MetricSnapshot[] = [];

    const counter = this.counters.get(name);
    if (counter) {
      for (const [key, state] of counter.states) {
        results.push({
          type: "counter",
          name,
          module: counter.module,
          value: state.value,
          labels: parseLabels(key),
        });
      }
      return results;
    }

    const gauge = this.gauges.get(name);
    if (gauge) {
      for (const [key, state] of gauge.states) {
        results.push({
          type: "gauge",
          name,
          module: gauge.module,
          value: state.value,
          labels: parseLabels(key),
        });
      }
      return results;
    }

    const histogram = this.histograms.get(name);
    if (histogram) {
      const boundaries = this.histogramBoundaries.get(name)!;
      for (const [key, state] of histogram.states) {
        results.push({
          type: "histogram",
          name,
          module: histogram.module,
          buckets: boundaries.map((b, i) => ({ upperBound: b, count: state.buckets[i] })),
          sum: state.sum,
          count: state.count,
          min: state.min === Infinity ? 0 : state.min,
          max: state.max === -Infinity ? 0 : state.max,
          labels: parseLabels(key),
        });
      }
      return results;
    }

    return results;
  }

  /** Get names of all registered metrics. */
  getRegisteredMetrics(): { name: string; type: MetricType; module: FridayObservabilityModule }[] {
    const result: { name: string; type: MetricType; module: FridayObservabilityModule }[] = [];
    for (const [name, entry] of this.counters) {
      result.push({ name, type: "counter", module: entry.module });
    }
    for (const [name, entry] of this.gauges) {
      result.push({ name, type: "gauge", module: entry.module });
    }
    for (const [name, entry] of this.histograms) {
      result.push({ name, type: "histogram", module: entry.module });
    }
    return result;
  }

  /** Reset all state for a named metric. */
  resetMetric(name: string): void {
    const counter = this.counters.get(name);
    if (counter) {
      counter.states.clear();
      return;
    }
    const gauge = this.gauges.get(name);
    if (gauge) {
      gauge.states.clear();
      return;
    }
    const histogram = this.histograms.get(name);
    if (histogram) {
      histogram.states.clear();
      return;
    }
  }

  /** Reset all metrics. */
  resetAll(): void {
    for (const entry of this.counters.values()) entry.states.clear();
    for (const entry of this.gauges.values()) entry.states.clear();
    for (const entry of this.histograms.values()) entry.states.clear();
  }
}

// ─── Helpers ───

/** Parse a label key string back into a MetricLabels object. */
function parseLabels(key: string): MetricLabels {
  if (key === "") return {};
  const labels: Record<string, string> = {};
  for (const pair of key.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx !== -1) {
      labels[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return labels;
}
