import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFridayHttpRouteRegistry,
  createFridayHttpServer,
  createFridayRetentionSettingsRoutes,
  type FridayAuthMiddlewareFactory,
  type FridayHttpServer,
  type FridayRealtimeWsGateway,
} from "#api";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayRetentionSettingsRepository,
  createFridayRetentionSettingsStore,
} from "#jobs";
import type { FridayRetentionSettingsStore } from "#jobs";
import {
  classifyDiskGrowth,
  createFridayDiskGrowthHolder,
  type FridayDiskGrowthHolder,
} from "../../../../src/learning/services/friday-disk-growth-evaluator.js";
import { createFridayObservabilityApiService } from "../../../../src/observability/services/friday-observability-api-service.js";
import { createFridayObservabilityRoutes } from "../../../../src/api/http/routes/friday-observability-routes.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

/**
 * RETENTION-R3b — owner-bound disk-usage readback + no-leak regression.
 *
 * The seam the Settings UI later consumes is the ONLY read surface for the
 * disk-growth warning, and it reuses R3a's CANONICAL-OWNER binding
 * (`assertCanonicalRetentionOwner`): owner/admin ROLE is a floor, but the
 * authenticated principal's `userId` MUST MATCH the single canonical owner the
 * reaper is bound to. This directly guards against repeating #1606's
 * SEC-NET-PRINCIPAL-001 P0 (owner/system data published on a public route with
 * no owner model). Test 14 asserts the reading appears on NO `/v1/observability/*`
 * route.
 */

const ROUTE = "/v1/uix/retention-policy/disk-usage";
const NOW = "2026-07-15T12:00:00.000Z";
const CANONICAL_OWNER_ID = "admin-001";
const GiB = 1024 ** 3;

type StubPrincipal = {
  principalId: string;
  userId: string;
  tenantId: string;
  role: string;
  scopes: string[];
  tokenId: string;
  principalType?: string;
};

const CANONICAL_OWNER: StubPrincipal = {
  principalId: "user:admin-001",
  userId: CANONICAL_OWNER_ID,
  tenantId: "admin-001",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "tok-admin-001",
};

const SECOND_ADMIN: StubPrincipal = {
  principalId: "user:admin-002",
  userId: "admin-002",
  tenantId: "admin-002",
  role: "admin",
  scopes: ["hub.admin", "session.read"],
  tokenId: "tok-admin-002",
};

const VIEWER: StubPrincipal = {
  principalId: "user:viewer-1",
  userId: "viewer-1",
  tenantId: "viewer-1",
  role: "viewer",
  scopes: ["session.read"],
  tokenId: "tok-viewer-1",
};

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const p = addr.port;
      srv.close((closeErr) => (closeErr ? reject(closeErr) : resolve(p)));
    });
    srv.on("error", reject);
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

function makeBearerStubMiddleware(
  validTokens: Record<string, StubPrincipal>,
): FridayAuthMiddlewareFactory {
  return {
    requireAuth: (ctx) => {
      if (ctx.principal) return { passed: true as const };
      const auth = ctx.headers["authorization"] ?? ctx.headers["Authorization"];
      if (!auth) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "missing token" };
      const parts = auth.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "malformed header" };
      }
      const principal = validTokens[parts[1]];
      if (!principal) return { passed: false as const, statusCode: 401, code: "UNAUTHORIZED", message: "invalid token" };
      (ctx as { principal: unknown }).principal = principal;
      return { passed: true as const };
    },
    requireAnyScope: () => ({ passed: true as const }),
    requireAnyRole: () => ({ passed: true as const }),
    enforceRateLimit: () => ({ passed: true as const }),
  };
}

describe("FridayHttpServer — /v1/uix/retention-policy/disk-usage canonical-owner binding (RETENTION-R3b)", () => {
  let server: FridayHttpServer | null = null;
  let db: FridaySqliteLayer | null = null;
  let store: FridayRetentionSettingsStore;
  let holder: FridayDiskGrowthHolder;
  let port = 0;
  let baseUrl = "";
  let idc = 0;

  beforeEach(async () => {
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    idc = 0;
    db = createTestDb();
    store = createFridayRetentionSettingsStore({
      db,
      repo: createFridayRetentionSettingsRepository(),
      idGenerator: () => `ret-${String(++idc).padStart(4, "0")}`,
      nowIso: () => NOW,
    });
    holder = createFridayDiskGrowthHolder();
    // Seed a real WARN reading (free below the U13 10 GiB floor) so a leak would
    // carry non-trivial owner/system data.
    holder.set(
      classifyDiskGrowth({
        freeBytes: 5 * GiB,
        totalCapacityBytes: 1000 * GiB,
        diagnostics: { totalDbBytes: 10_000_000, realtimeEventsEstimatedBytes: 1_000_000 },
      }),
    );
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (db) {
      db.close();
      db = null;
    }
  });

  function startServer(
    tokens: Record<string, StubPrincipal>,
    resolveCanonicalOwnerId: () => string | null | undefined = () => CANONICAL_OWNER_ID,
  ) {
    const routes = createFridayHttpRouteRegistry();
    for (const route of createFridayRetentionSettingsRoutes({
      store,
      resolveCanonicalOwnerId,
      readDiskUsage: () => holder.get(),
    })) {
      routes.register(route);
    }
    server = createFridayHttpServer({
      routes,
      wsGateway: makeStubWsGateway(),
      middleware: makeBearerStubMiddleware(tokens),
      port,
      host: "127.0.0.1",
    });
    return server.listen();
  }

  async function get(headers: Record<string, string>) {
    return fetch(`${baseUrl}${ROUTE}`, { headers });
  }

  it("synthetic-public (no token) → 401", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER });
    const res = await get({});
    expect(res.status).toBe(401);
  });

  it("bound non-owner (viewer) → 403", async () => {
    await startServer({ "tok-viewer-1": VIEWER });
    const res = await get({ Authorization: "Bearer tok-viewer-1" });
    expect(res.status).toBe(403);
  });

  it("second admin (admin-002, real hub.admin token) → 403 (canonical-owner ==, not role)", async () => {
    await startServer({ "tok-admin-002": SECOND_ADMIN });
    const res = await get({ Authorization: "Bearer tok-admin-002" });
    expect(res.status).toBe(403);
  });

  it("unresolvable canonical owner → 403 even for the canonical owner (fail-closed, never any-admin)", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER }, () => null);
    const res = await get({ Authorization: "Bearer tok-admin-001" });
    expect(res.status).toBe(403);
  });

  it("canonical owner (admin-001) → 200 with the report-only disk-usage summary", async () => {
    await startServer({ "tok-admin-001": CANONICAL_OWNER });
    const res = await get({ Authorization: "Bearer tok-admin-001" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        diskUsage:
          | { status: string; freeBytes: number; freeSpaceFloorBytes: number; reasons: string[]; authority: { decision: string } }
          | null;
      };
    };
    expect(body.data.diskUsage).not.toBeNull();
    expect(body.data.diskUsage!.status).toBe("warn");
    expect(typeof body.data.diskUsage!.freeBytes).toBe("number");
    expect(typeof body.data.diskUsage!.freeSpaceFloorBytes).toBe("number");
    expect(body.data.diskUsage!.authority.decision).toBe("U13-STORAGE-PRESSURE");
    expect(Array.isArray(body.data.diskUsage!.reasons)).toBe(true);
  });

  // ── NO-LEAK regression (#1606 SEC-NET-PRINCIPAL-001): the disk-usage reading
  //    must appear on NO /v1/observability/* route. ────────────────────────────
  it("no-leak: disk-usage sentinels appear on NO /v1/observability/* route", async () => {
    const service = createFridayObservabilityApiService({
      db: db!,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
    const obsRoutes = createFridayObservabilityRoutes(service.routes);

    const DISK_SENTINELS = [
      "disk_growth",
      "freeSpaceFloorBytes",
      "totalCapacityBytes",
      "projectedExhaustionDays",
      "U13-STORAGE-PRESSURE",
      "diskUsage",
    ] as const;

    async function callRoute(path: string, query: Record<string, unknown> = {}): Promise<string> {
      const route = obsRoutes.find((r) => r.path === path && r.method === "GET");
      if (!route) return "";
      const out = await route.handler({ query } as never);
      return JSON.stringify(out);
    }

    const metricsJson = await callRoute("/v1/observability/metrics");
    const seriesJson = await callRoute("/v1/observability/time-series", {
      metricName: "friday.disk.total_bytes",
      startTime: "2026-07-15T00:00:00.000Z",
      endTime: "2026-07-15T13:00:00.000Z",
      bucketSize: "1h",
    });

    for (const sentinel of DISK_SENTINELS) {
      expect(metricsJson).not.toContain(sentinel);
      // These are all disk-usage STRUCTURE sentinels (the time-series route only
      // echoes the caller-supplied metricName, which is "friday.disk.*" — not one
      // of these), so none may appear on either route.
      expect(seriesJson).not.toContain(sentinel);
    }
  });
});
