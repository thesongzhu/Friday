import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import {
  createFridayObservabilityApiService,
  type FridayObservabilityApiService,
} from "../../../../src/observability/services/friday-observability-api-service.js";
import { createFridayObservabilityRoutes } from "../../../../src/api/http/routes/friday-observability-routes.js";
import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

/**
 * SPLIT PROOF (collector-only): the report-only realtime_events growth signal is
 * computed by the health monitor but is NOT published to the observability
 * service seam and does NOT reach any `/v1/observability/*` route.
 *
 * Background: an earlier revision published the growth reading (rows/bytes/status/
 * reclaim_status + time-series) onto `/v1/observability/metrics` and
 * `/v1/observability/time-series`. That surface exposed owner/system data to any
 * caller (no owner-authorization model), producing two P0s. Per the operator
 * split, the growth COLLECTOR is retained (report-only; surfaced via the monitor's
 * transition-only warning logs) but the ROUTE exposure is dropped entirely.
 * Owner-authorized readback is DEFERRED to R3.
 *
 * These tests prove, at the observability-service seam, that a real monitor run
 * lands NONE of the growth fields on the real route handlers, and that the
 * collector still fails closed and never deletes a row.
 */
describe("realtime_events growth — collector-only, NOT published to the observability seam", () => {
  const dbs: FridaySqliteLayer[] = [];

  // Sentinels that would ONLY appear if the growth reading leaked onto a route.
  const GROWTH_SENTINELS = [
    "realtimeEventsGrowth",
    "friday.realtime_events",
    "deferred_to_rust_epoch_resync",
    "reclaim_status",
    "estimatedBytes",
  ] as const;

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
    } as FridaySqliteLayer;
  }

  /** Invoke a real observability route handler by path, exactly as the HTTP server would. */
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

  it("inversion: a real monitor run computes growth but NO growth field reaches /v1/observability/metrics or /time-series", async () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    const db = makeDb();
    const service = makeService(db, () => NOW);

    const N = 15;
    insertRealtimeEvents(db, N, JSON.stringify({ data: "x".repeat(40) }), NOW);

    // Run the REAL collector (no metricsSink — the observability publish path was
    // removed). It computes a real growth reading (report-only): proven here.
    const monitor = createFridaySystemHealthMonitor({ db, nowIso: () => NOW });
    const summary = monitor.runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;
    expect(growth.detail!.rowCount).toBe(N);
    expect(growth.detail!.status).toBe("healthy");
    expect(growth.detail!.sampleSize).toBe(N); // real sampled COUNT(*)
    expect(growth.detail!.reclaim_status).toBe("deferred_to_rust_epoch_resync");

    // The growth reading was NOT published to the service seam, so the real route
    // handlers carry none of it.
    const metricsSnap = (await getRoute(service, "/v1/observability/metrics")) as {
      metrics: Record<string, number>;
      realtimeEventsGrowth?: unknown;
    };
    // No structured growth snapshot, and no growth gauges enumerated.
    expect(metricsSnap.realtimeEventsGrowth).toBeUndefined();
    expect(Object.keys(metricsSnap.metrics).some((k) => k.startsWith("friday.realtime_events"))).toBe(false);

    // Belt-and-suspenders on the metrics body: NONE of the growth sentinels appear.
    const metricsJson = JSON.stringify(metricsSnap);
    for (const sentinel of GROWTH_SENTINELS) {
      expect(metricsJson).not.toContain(sentinel);
    }

    const series = (await getRoute(service, "/v1/observability/time-series", {
      metricName: "friday.realtime_events.rows_estimate",
      startTime: "2026-03-07T00:00:00.000Z",
      endTime: "2026-03-07T13:00:00.000Z",
      bucketSize: "1h",
    })) as { series: { points: Array<{ value: number }> } };
    // The time-series route ECHOES the caller-supplied metricName, so that string
    // is not a leak signal. The real leak signal is a non-zero growth VALUE: the
    // gauge was never recorded, so every point is 0 (no leaked trend).
    expect(series.series.points.length).toBeGreaterThan(0);
    expect(series.series.points.every((p) => p.value === 0)).toBe(true);
    // And no structured growth field rides in the series body either.
    const seriesJson = JSON.stringify(series);
    for (const field of ["realtimeEventsGrowth", "deferred_to_rust_epoch_resync", "reclaim_status", "estimatedBytes"]) {
      expect(seriesJson).not.toContain(field);
    }
  });

  it("collector fail-closed + zero-deletion: a FAILED READ reports degraded and leaves EVERY row byte-identical", () => {
    const NOW = "2026-03-07T12:00:00.000Z";
    // realDb keeps the table and its rows the WHOLE time — nothing is dropped.
    const realDb = makeDb();
    insertRealtimeEvents(realDb, 12, JSON.stringify({ data: "b".repeat(8) }), NOW);
    const before = snapshotRows(realDb);
    expect(before.count).toBe(12);

    // Inject a broken READ (connection error) while the rows REMAIN present.
    const brokenReadDb = makeBrokenReadDb(realDb);
    const summary = createFridaySystemHealthMonitor({ db: brokenReadDb, nowIso: () => NOW }).runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;

    // Fail-closed to degraded (never healthy), no deletion, marker retained.
    expect(growth.detail!.status).toBe("degraded");
    expect(growth.detail!.failClosed).toBe(true);
    expect(growth.detail!.reclaim_status).toBe("deferred_to_rust_epoch_resync");

    // ZERO deletion: the failed read left every existing row byte-identical
    // (same count, same ids, same content digest). The read failed — the data did not.
    const after = snapshotRows(realDb);
    expect(after.count).toBe(before.count);
    expect(after.ids).toEqual(before.ids);
    expect(after.digest).toBe(before.digest);
    expect(countRealtimeEvents(realDb)).toBe(12);
  });
});
