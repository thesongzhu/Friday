import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createFridayHub } from "#hub";
import type { FridayHub } from "#hub";
import {
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { initializeFridayState } from "#state";
import { createFridaySystemHealthMonitor } from "../../../src/learning/services/friday-system-health-monitor.js";
import {
  clearAutoDetectProviderEnv,
  restoreAutoDetectProviderEnv,
  type FridayAutoDetectProviderEnvSnapshot,
} from "../../_helpers/auto-detect-provider-env.js";

/**
 * SPLIT PROOF (production wiring): the report-only realtime_events growth signal
 * is computed by the real Hub's system-health-monitor but is NOT exposed on ANY
 * `/v1/observability/*` route.
 *
 * NO PROOF-THEATER: this runs the EXACT production path — real `createFridayHub`
 * → `hub.start()` boots the real job scheduler and its registered
 * `system-health-monitor` job (report-only; per the #1606 split it no longer
 * wires a metricsSink to the observability service). The real, hub-registered
 * observability routes are then served through a REAL `createFridayHttpServer`
 * (over `hub.apiRuntime.routes`) and fetched over HTTP exactly as a client would.
 *
 * The test asserts (a) the collector DOES compute a real growth reading from the
 * seeded rows (so the signal is not silently gone), and (b) NONE of the growth
 * fields reach `/v1/observability/metrics` or `/v1/observability/time-series`.
 * This is a regression guard: re-adding the bootstrap metricsSink publish would
 * make (b) fail. Owner-authorized readback is DEFERRED to R3.
 */
describe("realtime_events growth — real Hub computes it, but NO growth reaches any observability route", () => {
  const tmpDirs: string[] = [];
  const hubs: FridayHub[] = [];
  const servers: FridayHttpServer[] = [];
  let envSnapshot: FridayAutoDetectProviderEnvSnapshot | null = null;

  // Sentinels that would ONLY appear if the growth reading leaked onto a route.
  const GROWTH_SENTINELS = [
    "realtimeEventsGrowth",
    "friday.realtime_events",
    "deferred_to_rust_epoch_resync",
    "reclaim_status",
    "estimatedBytes",
  ] as const;

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rte-growth-"));
    tmpDirs.push(dir);
    return dir;
  }

  function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        if (!addr || typeof addr === "string") {
          probe.close();
          reject(new Error("failed to allocate free port"));
          return;
        }
        const port = addr.port;
        probe.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
      });
      probe.on("error", reject);
    });
  }

  function makeStubWsGateway(): FridayRealtimeWsGateway {
    return {
      handleClientFrame: () => ({ handled: false }),
      addConnection: () => {},
      removeConnection: () => {},
      broadcastEvent: () => {},
    } as unknown as FridayRealtimeWsGateway;
  }

  // Anonymous/public reads only: never sets a principal, so the server falls back
  // to its synthetic default-public principal (these routes are public).
  function makeStubMiddleware(): FridayAuthMiddlewareFactory {
    return {
      requireAuth: () => ({ passed: true as const }),
      requireAnyScope: () => ({ passed: true as const }),
      requireAnyRole: () => ({ passed: true as const }),
      enforceRateLimit: () => ({ passed: true as const }),
    };
  }

  /**
   * Seed the DERIVED realtime_events stream through the same on-disk friday.db
   * the hub opens (append-only; nothing here deletes). Migrations are idempotent.
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

  /** Directly run the collector over the seeded state to prove it computes a growth reading. */
  function computeGrowthDirectly(stateDir: string): { rowCount: number; status: string; sampleSize: number } {
    const state = initializeFridayState({ env: { ...process.env, FRIDAY_STATE_DIR: stateDir } });
    try {
      const summary = createFridaySystemHealthMonitor({
        db: state.sqlite,
        nowIso: () => new Date().toISOString(),
      }).runAll();
      const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;
      return {
        rowCount: growth.detail!.rowCount,
        status: growth.detail!.status,
        sampleSize: growth.detail!.sampleSize,
      };
    } finally {
      state.close();
    }
  }

  beforeEach(() => {
    envSnapshot = clearAutoDetectProviderEnv();
  });

  afterEach(async () => {
    for (const server of servers) {
      try {
        await server.close();
      } catch {
        // ignore
      }
    }
    servers.length = 0;
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

  it("real createFridayHub → real system-health scheduler → growth is computed but ABSENT from /v1/observability/metrics and /time-series", async () => {
    const stateDir = makeTmpDir();
    const N = 15;
    // Seed BEFORE start so the real scheduler's health tick reads these rows.
    seedRealtimeEvents(stateDir, N, JSON.stringify({ data: "x".repeat(40) }), "2026-03-07T12:00:00.000Z");

    // (a) The collector DOES compute a real growth reading from this data
    // (report-only). Proven deterministically over the seeded state.
    const growth = computeGrowthDirectly(stateDir);
    expect(growth.rowCount).toBeGreaterThanOrEqual(N);
    expect(growth.status).toBe("healthy");
    expect(growth.sampleSize).toBeGreaterThanOrEqual(N);

    // REAL production start(): boots the real job scheduler + the registered
    // "system-health-monitor" job (report-only; no metricsSink publish).
    const hub = await createFridayHub({ stateDir, skillDirs: [makeTmpDir(), makeTmpDir()] });
    hubs.push(hub);
    await hub.start();

    // Serve the REAL hub-registered routes through a REAL HTTP server and fetch
    // exactly as a network client would.
    const port = await findFreePort();
    const server = createFridayHttpServer({
      routes: hub.apiRuntime.routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeStubMiddleware(),
      port,
      host: "127.0.0.1",
    });
    servers.push(server);
    await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    // (b) NO growth field reaches either observability route.
    const metricsRes = await fetch(`${baseUrl}/v1/observability/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsRaw = await metricsRes.text();
    const metricsBody = JSON.parse(metricsRaw) as {
      ok: true;
      data: { metrics: Record<string, number>; realtimeEventsGrowth?: unknown };
    };
    expect(metricsBody.data.realtimeEventsGrowth).toBeUndefined();
    expect(Object.keys(metricsBody.data.metrics).some((k) => k.startsWith("friday.realtime_events"))).toBe(false);

    const seriesRes = await fetch(
      `${baseUrl}/v1/observability/time-series?metricName=friday.realtime_events.rows_estimate` +
        "&startTime=2026-03-07T00:00:00.000Z&endTime=2026-03-07T13:00:00.000Z&bucketSize=1h",
    );
    expect(seriesRes.status).toBe(200);
    const seriesRaw = await seriesRes.text();
    const seriesBody = JSON.parse(seriesRaw) as { ok: true; data: { series: { points: Array<{ value: number }> } } };
    // The time-series route ECHOES the caller-supplied metricName, so that string
    // is not a leak signal. The real leak signal is a non-zero growth VALUE: the
    // gauge was never published, so every point is 0 (no leaked trend).
    expect(seriesBody.data.series.points.length).toBeGreaterThan(0);
    expect(seriesBody.data.series.points.every((p) => p.value === 0)).toBe(true);

    // No growth sentinel appears in the metrics body; no structured growth field
    // rides in the series body (metricName echo excluded — see above).
    for (const sentinel of GROWTH_SENTINELS) {
      expect(metricsRaw).not.toContain(sentinel);
    }
    for (const field of ["realtimeEventsGrowth", "deferred_to_rust_epoch_resync", "reclaim_status", "estimatedBytes"]) {
      expect(seriesRaw).not.toContain(field);
    }
  }, 30_000);
});
