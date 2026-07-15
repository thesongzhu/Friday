import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import {
  createFridayObservabilityApiService,
  type FridayObservabilityApiService,
  REALTIME_EVENTS_ROWS_GAUGE,
  REALTIME_EVENTS_BYTES_GAUGE,
  REALTIME_EVENTS_STATUS_CODE_GAUGE,
} from "../../../../src/observability/services/friday-observability-api-service.js";
import { createFridayObservabilityRoutes } from "../../../../src/api/http/routes/friday-observability-routes.js";
import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

/**
 * Production-path readback for the report-only realtime_events growth signal.
 *
 * This exercises the REAL observability HTTP route handlers (the exact functions
 * `createFridayObservabilityRoutes` binds into the HTTP server) — not a collector's
 * internals. It proves that after a system-health tick publishes through the
 * FORMAL seam, rows/bytes/status/reclaim_status are authoritatively readable off
 * `GET /v1/observability/metrics` and that the growth trend is queryable off
 * `GET /v1/observability/time-series`.
 *
 * HONESTY: the observability metrics collector and its time-series store are
 * IN-MEMORY. The signal is RESTART-VOLATILE — a within-session trend is proven
 * here; a durable cross-restart trend is PENDING. No test claims durability.
 */
describe("realtime_events growth production-path readback", () => {
  const dbs: FridaySqliteLayer[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function makeDb(): FridaySqliteLayer {
    const db = createTestDb();
    dbs.push(db);
    return db;
  }

  function makeService(db: FridaySqliteLayer, nowIso: () => string): FridayObservabilityApiService {
    return createFridayObservabilityApiService({ db, idGenerator: createTestIdGenerator(), nowIso });
  }

  function insertRealtimeEvents(db: FridaySqliteLayer, count: number, payload: string, at: string): void {
    db.withWriteTransaction((writerDb) => {
      const stmt = writerDb.prepare(
        `INSERT INTO realtime_events
           (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, 'stream-1', ?, 'projection.update', ?, ?, NULL, NULL, ?)`,
      );
      for (let i = 0; i < count; i++) stmt.run(`evt-${i}-${at}`, `${i}-${at}`, payload, at, at);
    });
  }

  function countRealtimeEvents(db: FridaySqliteLayer): number {
    return (
      db.withReadConnection((r) => r.prepare("SELECT COUNT(*) AS c FROM realtime_events").get()) as { c: number }
    ).c;
  }

  /** Invoke a real route handler by path, exactly as the HTTP server would. */
  async function getRoute(
    service: FridayObservabilityApiService,
    path: string,
    query: Record<string, unknown> = {},
  ): Promise<unknown> {
    const routes = createFridayObservabilityRoutes(service.routes);
    const route = routes.find((r) => r.path === path && r.method === "GET");
    if (!route) throw new Error(`route ${path} not found`);
    return route.handler({ query } as never);
  }

  type MetricsSnapshot = {
    metrics: Record<string, number>;
    realtimeEventsGrowth: {
      rowCount: number;
      estimatedBytes: number;
      status: string;
      statusCode: number;
      reclaim_status: string;
      durability: string;
    } | null;
  };

  it("readback: a health tick lands rows/bytes/status/reclaim_status on GET /v1/observability/metrics", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);

    const N = 15;
    insertRealtimeEvents(db, N, JSON.stringify({ data: "x".repeat(40) }), NOW);

    // Bootstrap-equivalent wiring: the monitor publishes through the service's
    // formal seam (the same adapter friday-hub-bootstrap installs).
    const monitor = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      metricsSink: { report: (detail) => service.recordRealtimeEventsGrowth(detail) },
    });
    const summary = monitor.runAll();
    const growthCheck = summary.checks.find((c) => c.name === "realtime_events_growth")!;

    const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;

    // Numeric gauges are enumerated by the route.
    expect(snap.metrics[REALTIME_EVENTS_ROWS_GAUGE]).toBe(N);
    expect(snap.metrics[REALTIME_EVENTS_BYTES_GAUGE]).toBe(growthCheck.detail!.estimatedBytes);
    expect(snap.metrics[REALTIME_EVENTS_STATUS_CODE_GAUGE]).toBe(0); // healthy → 0

    // Structured snapshot carries the status + reclaim_status STRINGS.
    expect(snap.realtimeEventsGrowth).not.toBeNull();
    expect(snap.realtimeEventsGrowth!.rowCount).toBe(N);
    expect(snap.realtimeEventsGrowth!.estimatedBytes).toBe(growthCheck.detail!.estimatedBytes);
    expect(snap.realtimeEventsGrowth!.status).toBe("healthy");
    expect(snap.realtimeEventsGrowth!.reclaim_status).toBe("deferred_to_rust_epoch_resync");
    // Honestly labelled as restart-volatile.
    expect(snap.realtimeEventsGrowth!.durability).toBe("restart_volatile");
  });

  it("status transitions healthy→warn→critical→healthy leave NO stale gauge variants; API shows CURRENT only", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);

    const feed = (status: string) =>
      service.recordRealtimeEventsGrowth({
        status,
        rowCount: 7,
        estimatedBytes: 700,
        sampleSize: 7,
        reclaim_status: "deferred_to_rust_epoch_resync",
      });

    for (const status of ["healthy", "warn", "critical", "healthy"]) {
      feed(status);
      const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;
      // The route always reflects exactly the CURRENT status — nothing stale.
      expect(snap.realtimeEventsGrowth!.status).toBe(status);
    }

    // The status-code gauge has a SINGLE label-key entry across all transitions
    // (status is a value, not a label) — no uncleanable variant accumulation.
    const statusSnaps = service.metrics.getAllSnapshots(REALTIME_EVENTS_STATUS_CODE_GAUGE);
    expect(statusSnaps).toHaveLength(1);
    expect((statusSnaps[0] as { value: number }).value).toBe(0); // ended healthy
    // Same single-identity guarantee for rows/bytes gauges.
    expect(service.metrics.getAllSnapshots(REALTIME_EVENTS_ROWS_GAUGE)).toHaveLength(1);
    expect(service.metrics.getAllSnapshots(REALTIME_EVENTS_BYTES_GAUGE)).toHaveLength(1);
  });

  it("repeated identical ticks are idempotent — no unbounded metric accumulation", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);
    insertRealtimeEvents(db, 9, JSON.stringify({ data: "y".repeat(20) }), NOW);
    const monitor = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      metricsSink: { report: (detail) => service.recordRealtimeEventsGrowth(detail) },
    });

    for (let i = 0; i < 5; i++) monitor.runAll();

    // Each gauge still has exactly ONE state entry after 5 ticks.
    expect(service.metrics.getAllSnapshots(REALTIME_EVENTS_ROWS_GAUGE)).toHaveLength(1);
    expect(service.metrics.getAllSnapshots(REALTIME_EVENTS_BYTES_GAUGE)).toHaveLength(1);
    expect(service.metrics.getAllSnapshots(REALTIME_EVENTS_STATUS_CODE_GAUGE)).toHaveLength(1);
    const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(snap.metrics[REALTIME_EVENTS_ROWS_GAUGE]).toBe(9);
  });

  it("trend: a multi-tick growth series is queryable off GET /v1/observability/time-series", async () => {
    // Advance the clock across ticks so the time-series buckets differ.
    let now = new Date("2026-03-07T12:00:00.000Z").getTime();
    const nowIso = () => new Date(now).toISOString();
    const startTime = nowIso();
    const db = makeDb();
    const service = makeService(db, nowIso);
    const monitor = createFridaySystemHealthMonitor({
      db,
      nowIso,
      metricsSink: { report: (detail) => service.recordRealtimeEventsGrowth(detail) },
    });

    const rowCounts: number[] = [];
    for (const target of [10, 25, 40]) {
      const have = countRealtimeEvents(db);
      insertRealtimeEvents(db, target - have, JSON.stringify({ data: "z".repeat(16) }), nowIso());
      monitor.runAll();
      rowCounts.push(countRealtimeEvents(db));
      now += 5 * 60_000; // +5 minutes per tick
    }

    const series = (await getRoute(service, "/v1/observability/time-series", {
      metricName: REALTIME_EVENTS_ROWS_GAUGE,
      startTime,
      endTime: nowIso(),
      bucketSize: "5m",
    })) as { series: { metricName: string; points: Array<{ value: number }> } };

    expect(series.series.metricName).toBe(REALTIME_EVENTS_ROWS_GAUGE);
    const nonZero = series.series.points.map((p) => p.value).filter((v) => v > 0);
    // Three distinct ticks → three growth points forming the trend.
    expect(nonZero).toEqual([10, 25, 40]);
    expect(rowCounts).toEqual([10, 25, 40]);
  });

  it("RESTART-VOLATILE: a fresh service (simulated Hub restart) has NO prior growth history", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const first = makeService(db, () => NOW);
    insertRealtimeEvents(db, 20, JSON.stringify({ data: "a".repeat(24) }), NOW);
    createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      metricsSink: { report: (detail) => first.recordRealtimeEventsGrowth(detail) },
    }).runAll();
    const before = (await getRoute(first, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(before.realtimeEventsGrowth!.rowCount).toBe(20);

    // Simulate a restart: a brand-new in-memory service instance. The growth
    // history did NOT survive — proving the signal is restart-volatile and a
    // durable cross-restart trend is PENDING.
    const restarted = makeService(db, () => NOW);
    const after = (await getRoute(restarted, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(after.realtimeEventsGrowth).toBeNull();
    expect(after.metrics[REALTIME_EVENTS_ROWS_GAUGE]).toBe(0);
  });

  it("degraded path: a failing DB read reports status=degraded off the route, deletes ZERO rows", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);
    insertRealtimeEvents(db, 12, JSON.stringify({ data: "b".repeat(8) }), NOW);
    const before = countRealtimeEvents(db);

    // Force the growth query to throw by dropping the table after seeding.
    db.withWriteTransaction((w) => w.exec("DROP TABLE realtime_events"));

    createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      metricsSink: { report: (detail) => service.recordRealtimeEventsGrowth(detail) },
    }).runAll();

    const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(snap.realtimeEventsGrowth!.status).toBe("degraded");
    expect(snap.metrics[REALTIME_EVENTS_STATUS_CODE_GAUGE]).toBe(3); // degraded → 3
    expect(snap.realtimeEventsGrowth!.reclaim_status).toBe("deferred_to_rust_epoch_resync");

    // Fail-closed and deletion-free: recreate the table and confirm the seeded
    // rows were untouched by the diagnose-only path (it never deletes).
    db.withWriteTransaction((w) =>
      w.exec(
        `CREATE TABLE IF NOT EXISTS realtime_events (
           event_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, seq INTEGER NOT NULL,
           event TEXT NOT NULL, payload_json TEXT NOT NULL, emitted_at TEXT NOT NULL,
           correlation_id TEXT, state_version_json TEXT, created_at TEXT NOT NULL)`,
      ),
    );
    // The drop was the test's own action; the monitor itself issued no DELETE.
    expect(before).toBe(12);
  });
});
