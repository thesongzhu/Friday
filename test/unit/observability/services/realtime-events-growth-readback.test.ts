import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import {
  createFridayObservabilityApiService,
  type FridayObservabilityApiService,
  REALTIME_EVENTS_ROWS_GAUGE,
  REALTIME_EVENTS_BYTES_GAUGE,
  REALTIME_EVENTS_STATUS_CODE_GAUGE,
} from "../../../../src/observability/services/friday-observability-api-service.js";
import { FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC } from "../../../../src/observability/engine/dashboard-data-provider.js";
import { createFridayObservabilityRoutes } from "../../../../src/api/http/routes/friday-observability-routes.js";
import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

/**
 * Service-seam readback for the report-only realtime_events growth signal.
 *
 * These tests exercise the REAL observability route handlers (the exact functions
 * `createFridayObservabilityRoutes` binds into the HTTP server) over the real
 * observability service seam (gauges + metricState + dashboard time-series). They
 * drive the real `createFridaySystemHealthMonitor` directly.
 *
 * The end-to-end proof that the REAL production bootstrap + job scheduler wire this
 * up (real `createFridayHub` → real registered `system-health-monitor` job → real
 * route) lives in
 * `test/integration/hub/realtime-events-growth-readback.integration.test.ts` — this
 * file does NOT claim to run the bootstrap or the scheduler.
 *
 * HONESTY: the metrics collector and its time-series store are IN-MEMORY. The signal
 * is RESTART-VOLATILE — a within-session snapshot + trend are proven here; a durable
 * cross-restart trend is PENDING. No test claims durability.
 */
describe("realtime_events growth service-seam readback", () => {
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

  /** Exact content fingerprint of every surviving row (rowid + id + payload). */
  function snapshotRows(db: FridaySqliteLayer): { count: number; ids: string[]; digest: string } {
    const rows = db.withReadConnection((r) =>
      r.prepare("SELECT rowid AS rid, event_id, payload_json FROM realtime_events ORDER BY rowid").all(),
    ) as Array<{ rid: number; event_id: string; payload_json: string }>;
    return {
      count: rows.length,
      ids: rows.map((row) => row.event_id),
      digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }

  /**
   * A FridaySqliteLayer whose READ path throws, while the underlying table and its
   * rows REMAIN fully present (the write path still delegates). Simulates a broken
   * connection / failed read WITHOUT dropping anything, so a failed read can be
   * proven to leave existing rows byte-identical.
   */
  function makeBrokenReadDb(real: FridaySqliteLayer): FridaySqliteLayer {
    const failRead = (): never => {
      throw new Error("injected read failure: realtime_events growth query connection is broken");
    };
    return {
      ...real,
      reads: { ...real.reads, withReadConnection: failRead },
      withReadConnection: failRead,
    };
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
      sampleSize: number;
      failClosed: boolean;
      durability: string;
    } | null;
  };

  it("readback: a health tick lands rows/bytes/status/reclaim_status on GET /v1/observability/metrics (service seam)", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);

    const N = 15;
    insertRealtimeEvents(db, N, JSON.stringify({ data: "x".repeat(40) }), NOW);

    // Drives the real monitor + the real service seam adapter (the same
    // recordRealtimeEventsGrowth the bootstrap installs). End-to-end bootstrap +
    // scheduler is proven in the integration test.
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
    expect(snap.realtimeEventsGrowth!.sampleSize).toBe(N); // real sampled COUNT(*)
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

  it("repeated identical ticks are idempotent — no unbounded metric snapshot accumulation", async () => {
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

  it("STRESS: 10,000+ growth ticks stay BOUNDED per gauge in the time-series (newest trend survives)", async () => {
    // Every 5-minute health tick appends 3 time-series points (rows/bytes/status).
    // Without a bound, a 10k-report run would retain 10k points PER gauge forever.
    // The bounded ring buffer caps retention while keeping the RECENT trend.
    let now = new Date("2026-03-07T12:00:00.000Z").getTime();
    const nowIso = () => new Date(now).toISOString();
    const db = makeDb();
    const service = makeService(db, nowIso);

    const TICKS = 10_500; // > FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC
    let lastRowCount = 0;
    for (let i = 0; i < TICKS; i++) {
      lastRowCount = i + 1;
      service.recordRealtimeEventsGrowth({
        status: "healthy",
        rowCount: lastRowCount,
        estimatedBytes: lastRowCount * 10,
        sampleSize: Math.min(1000, lastRowCount),
        reclaim_status: "deferred_to_rust_epoch_resync",
      });
      now += 5 * 60_000; // +5 minutes per tick
    }

    // BOUNDED: each growth gauge retains at most the cap, NOT all 10,500 points.
    for (const gauge of [REALTIME_EVENTS_ROWS_GAUGE, REALTIME_EVENTS_BYTES_GAUGE, REALTIME_EVENTS_STATUS_CODE_GAUGE]) {
      expect(service.dashboard.timeSeriesPointCount(gauge)).toBeLessThanOrEqual(
        FRIDAY_MAX_TIMESERIES_POINTS_PER_METRIC,
      );
    }

    // NEWEST trend SURVIVES: the last tick's value is still queryable off the real
    // time-series route (the newest points are the ones the ring buffer keeps).
    const series = (await getRoute(service, "/v1/observability/time-series", {
      metricName: REALTIME_EVENTS_ROWS_GAUGE,
      startTime: new Date(now - 10 * 60_000).toISOString(),
      endTime: new Date(now).toISOString(),
      bucketSize: "5m",
    })) as { series: { points: Array<{ value: number }> } };
    const values = series.series.points.map((p) => p.value).filter((v) => v > 0);
    expect(values).toContain(lastRowCount);

    // Current snapshot still reflects the latest tick.
    const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(snap.realtimeEventsGrowth!.rowCount).toBe(lastRowCount);
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

  it("degraded path: a FAILED READ (table + rows still present) reports degraded and leaves EVERY row byte-identical", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    // realDb keeps the table and its rows the WHOLE time — nothing is dropped.
    const realDb = makeDb();
    insertRealtimeEvents(realDb, 12, JSON.stringify({ data: "b".repeat(8) }), NOW);
    const before = snapshotRows(realDb);
    expect(before.count).toBe(12);

    const service = makeService(realDb, () => NOW);

    // Inject a broken READ (connection error) while the rows REMAIN present.
    const brokenReadDb = makeBrokenReadDb(realDb);
    createFridaySystemHealthMonitor({
      db: brokenReadDb,
      nowIso: () => NOW,
      metricsSink: { report: (detail) => service.recordRealtimeEventsGrowth(detail) },
    }).runAll();

    // Fail-closed to degraded off the real route (never healthy, no deletion).
    const snap = (await getRoute(service, "/v1/observability/metrics")) as MetricsSnapshot;
    expect(snap.realtimeEventsGrowth!.status).toBe("degraded");
    expect(snap.realtimeEventsGrowth!.failClosed).toBe(true);
    expect(snap.metrics[REALTIME_EVENTS_STATUS_CODE_GAUGE]).toBe(3); // degraded → 3
    expect(snap.realtimeEventsGrowth!.reclaim_status).toBe("deferred_to_rust_epoch_resync");

    // ZERO deletion: the failed read left every existing row byte-identical
    // (same count, same ids, same content digest). The read failed — the data did not.
    const after = snapshotRows(realDb);
    expect(after.count).toBe(before.count);
    expect(after.ids).toEqual(before.ids);
    expect(after.digest).toBe(before.digest);
    expect(countRealtimeEvents(realDb)).toBe(12);
  });
});
