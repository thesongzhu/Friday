import { describe, it, expect, beforeEach } from "vitest";
import {
  FridayMetricsCollector,
  DEFAULT_HISTOGRAM_BUCKETS,
} from "../../../../src/observability/engine/metrics-collector.js";

describe("FridayMetricsCollector", () => {
  let collector: FridayMetricsCollector;

  beforeEach(() => {
    collector = new FridayMetricsCollector();
  });

  // ─── Counter Registration ───

  describe("counter registration", () => {
    it("registers a counter", () => {
      collector.registerCounter("api.requests_total", "api");
      const metrics = collector.getRegisteredMetrics();
      expect(metrics).toContainEqual({ name: "api.requests_total", type: "counter", module: "api" });
    });

    it("throws when registering duplicate counter", () => {
      collector.registerCounter("api.requests_total", "api");
      expect(() => collector.registerCounter("api.requests_total", "api"))
        .toThrow('Counter "api.requests_total" is already registered');
    });
  });

  // ─── Counter Operations ───

  describe("counter operations", () => {
    beforeEach(() => {
      collector.registerCounter("api.requests_total", "api");
    });

    it("increments counter by 1 (default)", () => {
      collector.incrementCounter("api.requests_total");
      const snap = collector.getSnapshot("api.requests_total");
      expect(snap).toMatchObject({ type: "counter", value: 1 });
    });

    it("increments counter by custom delta", () => {
      collector.incrementCounter("api.requests_total", {}, 5);
      collector.incrementCounter("api.requests_total", {}, 3);
      const snap = collector.getSnapshot("api.requests_total");
      expect(snap).toMatchObject({ type: "counter", value: 8 });
    });

    it("throws on negative delta", () => {
      expect(() => collector.incrementCounter("api.requests_total", {}, -1))
        .toThrow("Counter delta must be non-negative");
    });

    it("throws on unregistered counter", () => {
      expect(() => collector.incrementCounter("unknown"))
        .toThrow('Counter "unknown" is not registered');
    });

    it("tracks separate label combinations", () => {
      collector.incrementCounter("api.requests_total", { method: "GET" }, 10);
      collector.incrementCounter("api.requests_total", { method: "POST" }, 3);

      const getSnap = collector.getSnapshot("api.requests_total", { method: "GET" });
      const postSnap = collector.getSnapshot("api.requests_total", { method: "POST" });
      expect(getSnap).toMatchObject({ value: 10 });
      expect(postSnap).toMatchObject({ value: 3 });
    });

    it("returns 0 for unrecorded label combination", () => {
      const snap = collector.getSnapshot("api.requests_total", { method: "DELETE" });
      expect(snap).toMatchObject({ type: "counter", value: 0 });
    });
  });

  // ─── Gauge Operations ───

  describe("gauge operations", () => {
    beforeEach(() => {
      collector.registerGauge("api.active_connections", "api");
    });

    it("sets gauge value", () => {
      collector.setGauge("api.active_connections", 42);
      const snap = collector.getSnapshot("api.active_connections");
      expect(snap).toMatchObject({ type: "gauge", value: 42 });
    });

    it("overwrites gauge value", () => {
      collector.setGauge("api.active_connections", 42);
      collector.setGauge("api.active_connections", 10);
      const snap = collector.getSnapshot("api.active_connections");
      expect(snap).toMatchObject({ value: 10 });
    });

    it("increments gauge", () => {
      collector.setGauge("api.active_connections", 5);
      collector.incrementGauge("api.active_connections", 3);
      const snap = collector.getSnapshot("api.active_connections");
      expect(snap).toMatchObject({ value: 8 });
    });

    it("decrements gauge with negative delta", () => {
      collector.setGauge("api.active_connections", 10);
      collector.incrementGauge("api.active_connections", -3);
      const snap = collector.getSnapshot("api.active_connections");
      expect(snap).toMatchObject({ value: 7 });
    });

    it("throws on unregistered gauge", () => {
      expect(() => collector.setGauge("unknown", 1)).toThrow('Gauge "unknown" is not registered');
    });

    it("throws when registering duplicate gauge", () => {
      expect(() => collector.registerGauge("api.active_connections", "api"))
        .toThrow('Gauge "api.active_connections" is already registered');
    });
  });

  // ─── Histogram Operations ───

  describe("histogram operations", () => {
    beforeEach(() => {
      collector.registerHistogram("api.latency_ms", "api", [10, 50, 100, 500, 1000]);
    });

    it("records values into correct buckets", () => {
      collector.recordHistogram("api.latency_ms", 5);   // <= 10
      collector.recordHistogram("api.latency_ms", 25);  // <= 50
      collector.recordHistogram("api.latency_ms", 75);  // <= 100
      collector.recordHistogram("api.latency_ms", 200); // <= 500
      collector.recordHistogram("api.latency_ms", 999); // <= 1000

      const snap = collector.getSnapshot("api.latency_ms");
      expect(snap?.type).toBe("histogram");
      if (snap?.type === "histogram") {
        expect(snap.count).toBe(5);
        expect(snap.sum).toBe(5 + 25 + 75 + 200 + 999);
        expect(snap.min).toBe(5);
        expect(snap.max).toBe(999);
        // Cumulative counts
        expect(snap.buckets).toEqual([
          { upperBound: 10, count: 1 },
          { upperBound: 50, count: 2 },
          { upperBound: 100, count: 3 },
          { upperBound: 500, count: 4 },
          { upperBound: 1000, count: 5 },
        ]);
      }
    });

    it("returns empty histogram for unrecorded labels", () => {
      const snap = collector.getSnapshot("api.latency_ms", { endpoint: "/foo" });
      expect(snap?.type).toBe("histogram");
      if (snap?.type === "histogram") {
        expect(snap.count).toBe(0);
        expect(snap.sum).toBe(0);
      }
    });

    it("uses default buckets when none specified", () => {
      collector.registerHistogram("default.hist", "api");
      collector.recordHistogram("default.hist", 50);
      const snap = collector.getSnapshot("default.hist");
      if (snap?.type === "histogram") {
        expect(snap.buckets.length).toBe(DEFAULT_HISTOGRAM_BUCKETS.length);
      }
    });

    it("throws on unregistered histogram", () => {
      expect(() => collector.recordHistogram("unknown", 5))
        .toThrow('Histogram "unknown" is not registered');
    });

    it("throws when registering duplicate histogram", () => {
      expect(() => collector.registerHistogram("api.latency_ms", "api"))
        .toThrow('Histogram "api.latency_ms" is already registered');
    });
  });

  // ─── Snapshot Queries ───

  describe("getSnapshot", () => {
    it("returns null for completely unknown metric", () => {
      expect(collector.getSnapshot("nonexistent")).toBeNull();
    });
  });

  describe("getAllSnapshots", () => {
    it("returns all label combinations for a counter", () => {
      collector.registerCounter("http.requests", "api");
      collector.incrementCounter("http.requests", { method: "GET" }, 5);
      collector.incrementCounter("http.requests", { method: "POST" }, 3);

      const snaps = collector.getAllSnapshots("http.requests");
      expect(snaps).toHaveLength(2);
      const values = snaps.map((s) => (s as { value: number }).value).sort();
      expect(values).toEqual([3, 5]);
    });

    it("returns empty array for unknown metric", () => {
      expect(collector.getAllSnapshots("unknown")).toEqual([]);
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("resetMetric clears a specific metric", () => {
      collector.registerCounter("api.count", "api");
      collector.incrementCounter("api.count", {}, 10);
      collector.resetMetric("api.count");

      const snap = collector.getSnapshot("api.count");
      expect(snap).toMatchObject({ value: 0 });
    });

    it("resetAll clears all metrics", () => {
      collector.registerCounter("c1", "api");
      collector.registerGauge("g1", "api");
      collector.incrementCounter("c1", {}, 5);
      collector.setGauge("g1", 42);
      collector.resetAll();

      expect(collector.getSnapshot("c1")).toMatchObject({ value: 0 });
      expect(collector.getSnapshot("g1")).toMatchObject({ value: 0 });
    });
  });

  // ─── getRegisteredMetrics ───

  describe("getRegisteredMetrics", () => {
    it("lists all registered metrics with types", () => {
      collector.registerCounter("c1", "api");
      collector.registerGauge("g1", "rules");
      collector.registerHistogram("h1", "observability");

      const metrics = collector.getRegisteredMetrics();
      expect(metrics).toHaveLength(3);
      expect(metrics).toContainEqual({ name: "c1", type: "counter", module: "api" });
      expect(metrics).toContainEqual({ name: "g1", type: "gauge", module: "rules" });
      expect(metrics).toContainEqual({ name: "h1", type: "histogram", module: "observability" });
    });
  });
});
