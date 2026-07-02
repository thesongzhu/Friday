import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridayFleetDashboardService,
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import { createFridaySessionService } from "#sessions";
import { createFridayJobSchedulerRepository } from "#jobs";
import { createFridayTuiRoutes } from "../../../../../src/api/http/routes/friday-tui-routes.js";
import { createTestDb, createTestIdGenerator } from "../../../../helpers/friday-test-db.helper.js";

const NOW = "2026-04-19T12:00:00.000Z";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const port = addr.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
    server.on("error", reject);
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

function makeBearerStubMiddleware(): FridayAuthMiddlewareFactory {
  return {
    requireAuth: (ctx) => {
      const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
      if (!auth) {
        return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
      }
      return { passed: true as const };
    },
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

describe("createFridayTuiRoutes", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function insertSatellite(id: string, pairingStatus: string = "online") {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at)
         VALUES (?, ?, 'standard', ?, 'trusted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
      )
      .run(id, `Satellite ${id}`, pairingStatus, NOW, NOW, NOW);
  }

  function insertHeartbeat(satelliteId: string) {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs)
         VALUES (?, ?, ?, 'ok', 20, 30, 0.5, 3, 1)`,
      )
      .run(`hb-${satelliteId}`, satelliteId, NOW);
  }

  it("registers status and jobs routes with hub-admin auth", () => {
    const routes = createFridayTuiRoutes({
      db,
      version: "test-version",
      fleetService: createFridayFleetDashboardService({
        db,
        nowIso: () => NOW,
        idGenerator: createTestIdGenerator(),
      }),
    });

    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.operationId)).toEqual([
      "tui.status.get",
      "tui.jobs.list",
    ]);
    expect(routes[0]?.auth).toEqual({ public: false, anyOfScopes: ["hub.admin"] });
    expect(routes[1]?.auth).toEqual({ public: false, anyOfScopes: ["hub.admin"] });
  });

  it("cr02-04: anonymous HTTP callers cannot reach TUI status when registered with RBAC", async () => {
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayTuiRoutes({
      db,
      version: "2026.04.19",
      fleetService: createFridayFleetDashboardService({
        db,
        nowIso: () => NOW,
        idGenerator: createTestIdGenerator(),
      }),
    })) {
      routes.register(route);
    }
    const port = await findFreePort();
    const server: FridayHttpServer = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware(),
      port,
      host: "127.0.0.1",
    });

    try {
      await server.listen();
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`);
      expect(response.status).toBe(401);
      const body = await response.json() as { ok: false; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await server.close();
    }
  });

  it("GET /v1/status returns counts backed by live state", async () => {
    const sessionService = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      // TS-R4/G3: seed legacy TS session rows for the read-only TUI status
      // projection. Product/default writers remain fail-closed.
      allowTestOnlySessionExecution: true,
    });
    await sessionService.createSession({
      channel: "discord",
      accountId: "acct-1",
      chatId: "chat-1",
    });
    await sessionService.createSession({
      channel: "discord",
      accountId: "acct-1",
      chatId: "chat-2",
    });
    await db.withWriteTransaction((writer) => {
      writer.prepare("UPDATE sessions SET status = 'idle' WHERE chat_id = 'chat-2'").run();
    });

    insertSatellite("sat-1");
    insertHeartbeat("sat-1");

    const schedulerRepo = createFridayJobSchedulerRepository({ db });
    schedulerRepo.upsert({
      id: "heartbeat-runner",
      intervalMs: 60_000,
      timeoutMs: 120_000,
      catchUpRuns: 1,
      nowIso: NOW,
    });
    schedulerRepo.markRunning("heartbeat-runner", NOW);

    const routes = createFridayTuiRoutes({
      db,
      version: "2026.04.19",
      fleetService: createFridayFleetDashboardService({
        db,
        nowIso: () => NOW,
        idGenerator: createTestIdGenerator(),
      }),
    });
    const route = routes.find((entry) => entry.operationId === "tui.status.get");

    const result = await route!.handler({
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
    } as never) as {
      version: string;
      uptime: number;
      activeSessions: number;
      runningJobs: number;
      connectedSatellites: number;
    };

    expect(result.version).toBe("2026.04.19");
    expect(result.uptime).toBeGreaterThanOrEqual(0);
    expect(result.activeSessions).toBe(1);
    expect(result.runningJobs).toBe(1);
    expect(result.connectedSatellites).toBe(1);
  });

  it("GET /v1/jobs maps scheduler rows into TUI summaries", async () => {
    const schedulerRepo = createFridayJobSchedulerRepository({ db });
    schedulerRepo.upsert({
      id: "workflow-timeout-sweep",
      intervalMs: 30_000,
      timeoutMs: 60_000,
      catchUpRuns: 1,
      nowIso: NOW,
    });
    schedulerRepo.upsert({
      id: "heartbeat-runner",
      intervalMs: 60_000,
      timeoutMs: 60_000,
      catchUpRuns: 1,
      nowIso: NOW,
    });
    schedulerRepo.markRunning("heartbeat-runner", NOW);
    schedulerRepo.markFailed("workflow-timeout-sweep", "boom", 123, "2026-04-19T12:30:00.000Z", NOW);

    const routes = createFridayTuiRoutes({
      db,
      version: "2026.04.19",
      fleetService: createFridayFleetDashboardService({
        db,
        nowIso: () => NOW,
        idGenerator: createTestIdGenerator(),
      }),
    });
    const route = routes.find((entry) => entry.operationId === "tui.jobs.list");

    const result = await route!.handler({
      requestId: "req-2",
      receivedAt: NOW,
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
    } as never) as Array<{
      jobId: string;
      name: string;
      status: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
    }>;

    expect(result).toEqual([
      {
        jobId: "heartbeat-runner",
        name: "heartbeat-runner",
        status: "running",
        lastRunAt: null,
        nextRunAt: null,
      },
      {
        jobId: "workflow-timeout-sweep",
        name: "workflow-timeout-sweep",
        status: "failed",
        lastRunAt: NOW,
        nextRunAt: "2026-04-19T12:30:00.000Z",
      },
    ]);
  });
});
