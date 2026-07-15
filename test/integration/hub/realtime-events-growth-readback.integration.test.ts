import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import { initializeFridayState } from "#state";
import {
  REALTIME_EVENTS_ROWS_GAUGE,
  REALTIME_EVENTS_BYTES_GAUGE,
  REALTIME_EVENTS_STATUS_CODE_GAUGE,
} from "../../../src/observability/services/friday-observability-api-service.js";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";

/**
 * REAL production-path readback for the report-only realtime_events growth signal.
 *
 * NO PROOF-THEATER: this exercises the EXACT production wiring, not a test-only
 * duplicate adapter. It runs the real `createFridayHub`, then `hub.start()` — which
 * boots the real job scheduler and runs the EXACT registered `system-health-monitor`
 * job whose bootstrap `metricsSink` adapter publishes through
 * `observabilityService.recordRealtimeEventsGrowth`. The signal is then read back off
 * the authoritative, hub-registered `GET /v1/observability/metrics` and
 * `GET /v1/observability/time-series` route handlers (found on
 * `hub.apiRuntime.routes.getRoutes()`). No monitor/service/route is hand-constructed.
 *
 * HONESTY: the observability metrics collector and its time-series store are
 * IN-MEMORY, so the signal is RESTART-VOLATILE — a within-session snapshot + trend
 * are proven here; a durable cross-restart trend is PENDING. No claim of durability.
 */
describe("realtime_events growth — real bootstrap + scheduler + route readback", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];
  let envSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rte-growth-"));
    tmpDirs.push(dir);
    return dir;
  }

  /**
   * Seed the DERIVED realtime_events stream BEFORE the hub starts, through the same
   * on-disk friday.db the hub opens (append-only; nothing here deletes). Uses a
   * short-lived state runtime on the same stateDir (migrations are idempotent), so
   * the real scheduler's health tick reads exactly these rows.
   */
  function seedRealtimeEvents(stateDir: string, count: number, payload: string, at: string): void {
    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      state.sqlite.withWriteTransaction((db) => {
        const stmt = db.prepare(
          `INSERT INTO realtime_events
             (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
           VALUES (?, 'stream-1', ?, 'projection.update', ?, ?, NULL, NULL, ?)`,
        );
        for (let i = 0; i < count; i++) stmt.run(`evt-${i}`, i, payload, at, at);
      });
    } finally {
      state.close();
    }
  }

  /** Invoke a REAL hub-registered route handler by operationId (as the HTTP server would). */
  async function invokeRoute(
    hub: FridayHub,
    operationId: string,
    query: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const route = hub.apiRuntime.routes.getRoutes().find((entry) => entry.operationId === operationId);
    if (!route) throw new Error(`route ${operationId} is not registered on the hub`);
    return (await route.handler({
      requestId: `${operationId}:req`,
      receivedAt: new Date().toISOString(),
      params: {},
      query,
      body: {},
      headers: {},
      principal: null,
    } as never)) as Record<string, unknown>;
  }

  type GrowthSnapshot = {
    rowCount: number;
    estimatedBytes: number;
    status: string;
    statusCode: number;
    reclaim_status: string;
    sampleSize: number;
    durability: string;
  } | null;
  type MetricsResponse = { metrics: Record<string, number>; realtimeEventsGrowth: GrowthSnapshot };
  type TimeSeriesResponse = { series: { metricName: string; points: Array<{ value: number }> } };

  beforeEach(() => {
    envSnapshot = clearAutoDetectProviderEnv();
  });

  afterEach(async () => {
    for (const hub of hubs) {
      try {
        await hub.stop();
      } catch {
        // ignore cleanup errors
      }
    }
    hubs.length = 0;
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
    if (envSnapshot) {
      restoreAutoDetectProviderEnv(envSnapshot);
      envSnapshot = null;
    }
  });

  it("real createFridayHub → real registered system-health scheduler job → GET /v1/observability/metrics lands rows/bytes/status/reclaim_status", async () => {
    const stateDir = makeTmpDir();
    const N = 15;
    // Seed BEFORE start so the real scheduler's health tick reads these rows.
    seedRealtimeEvents(stateDir, N, JSON.stringify({ data: "x".repeat(40) }), "2026-03-07T12:00:00.000Z");

    const trendStart = new Date(Date.now() - 3_600_000).toISOString();
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);

    // REAL production start(): boots the real job scheduler, which runs the EXACT
    // registered "system-health-monitor" job (bootstrap metricsSink adapter →
    // observabilityService.recordRealtimeEventsGrowth). No duplicate wiring.
    await hub.start();

    // The plain-interval health job fires on the first scheduler pass; poll the
    // REAL metrics route until the (restart-volatile) growth snapshot is published.
    let snap: MetricsResponse | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = (await invokeRoute(hub, "observability.metrics.snapshot")) as MetricsResponse;
      if (response.realtimeEventsGrowth) {
        snap = response;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(snap).not.toBeNull();
    const growth = snap!.realtimeEventsGrowth!;
    // The seeded rows are reflected in the real readback (>= tolerates any
    // incidental projection emission during boot; a fresh hub emits none).
    expect(growth.rowCount).toBeGreaterThanOrEqual(N);
    expect(growth.status).toBe("healthy");
    expect(growth.reclaim_status).toBe("deferred_to_rust_epoch_resync");
    // Honestly labelled as restart-volatile (in-memory collector).
    expect(growth.durability).toBe("restart_volatile");
    // Numeric gauges are enumerated by the real route and internally consistent.
    expect(snap!.metrics[REALTIME_EVENTS_ROWS_GAUGE]).toBeGreaterThanOrEqual(N);
    expect(snap!.metrics[REALTIME_EVENTS_STATUS_CODE_GAUGE]).toBe(0); // healthy → 0
    expect(snap!.metrics[REALTIME_EVENTS_BYTES_GAUGE]).toBe(growth.estimatedBytes);

    // Trend is queryable off the REAL time-series route (single within-session point).
    const series = (await invokeRoute(hub, "observability.time.series", {
      metricName: REALTIME_EVENTS_ROWS_GAUGE,
      startTime: trendStart,
      endTime: new Date(Date.now() + 3_600_000).toISOString(),
      bucketSize: "1h",
    })) as TimeSeriesResponse;
    expect(series.series.metricName).toBe(REALTIME_EVENTS_ROWS_GAUGE);
    expect(series.series.points.some((point) => point.value >= N)).toBe(true);
  }, 30_000);
});
