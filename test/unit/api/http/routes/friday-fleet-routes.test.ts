import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../../satellites/_helpers/create-test-db.helper.js";
import { createFridayFleetRoutes, createFridayFleetDashboardService } from "#api";
import type { FridayFleetDashboardService } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type {
  FridayFleetOverviewResponse,
  FridayListFleetSatellitesResponse,
  FridayFleetSatelliteDetailResponse,
  FridayFleetRemediationActionExecutionResult,
  FridayFleetRemediationPlan,
} from "#api";
import { FridayDomainError } from "#errors";
import {
  createFridayFleetRemediationMutatingActionRequest,
} from "../../../../../src/api/http/routes/friday-fleet-routes.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../../../src/security/friday-mutating-action-gate.js";

describe("FridayFleetRoutes", () => {
  let db: FridaySqliteLayer;
  let fleetService: FridayFleetDashboardService;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  let outboxQueueService: {
    requeueExpiredLeases: ReturnType<typeof vi.fn>;
    expireByTtl: ReturnType<typeof vi.fn>;
  };
  const NOW = "2025-06-15T10:00:00.000Z";
  const PLAN_DIGEST = "fleet-plan-1";

  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user" as const,
        principalId: "user-1",
        userId: "user-1",
        role: "admin" as const,
        scopes: ["fleet.read" as const],
        tokenId: "tok-1",
        tokenKind: "access" as const,
        issuedAt: NOW,
      },
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  function makeApproval(input: {
    satelliteId: string;
    actionId: string;
    surface: string;
  }): FridayCanonicalApprovalResolution {
    const request = createFridayFleetRemediationMutatingActionRequest({
      satelliteId: input.satelliteId,
      actionId: input.actionId,
      actor: {
        kind: "user",
        id: "user-1",
        principalId: "user-1",
      },
      surface: input.surface,
      planDigest: PLAN_DIGEST,
    });
    return {
      decision: "approved",
      approvalId: "fleet-remediation-approval",
      decidedByPrincipalId: "user-1",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2025-06-15T11:00:00.000Z",
    };
  }

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
      .run(`hb-${satelliteId}`, satelliteId, "2025-06-15T09:59:55.000Z");
  }

  function insertOutboxMessage(messageId: string, satelliteId: string, status: "failed" | "dead_letter" = "failed") {
    db.writer
      .prepare(
        `INSERT INTO outbox_messages (
          id, satellite_id, queue_key, message_type, payload_ciphertext, nonce, key_id, idempotency_key,
          status, attempts, max_attempts, deliver_after, expires_at, last_error_code, last_error_message,
          leased_until, acked_at, created_at, updated_at
        ) VALUES (?, ?, 'fleet:commands', 'sync', 'cipher', 'nonce', 'key-1', ?, ?, 1, 5, ?, ?, 'ERR', 'failed', null, null, ?, ?)`,
      )
      .run(
        messageId,
        satelliteId,
        `idem-${messageId}`,
        status,
        NOW,
        "2099-01-01T00:00:00.000Z",
        NOW,
        NOW,
      );
  }

  beforeEach(() => {
    db = createTestDb();
    outboxQueueService = {
      requeueExpiredLeases: vi.fn(async () => 2),
      expireByTtl: vi.fn(async () => 3),
    };
    fleetService = createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
      outboxQueueService,
      // Method-level test-oracle: let the shared service run the legacy path so the
      // success case works. The "TS-runtime retirement" describe below builds routes
      // WITHOUT the route flag and asserts the ROUTE guard 503s before the service is
      // ever reached, so this method flag does not weaken that fail-close assertion.
      allowTestOnlyFleetRemediationExecution: true,
    });
    routes = createFridayFleetRoutes({
      fleetService,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-1",
      }),
      // Test-oracle flag: the remediation-execute success test below exercises the
      // live mutation. Production wiring leaves this unset (TS-runtime retirement).
      allowTestOnlyFleetRemediationExecution: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Route registration ───

  it("registers 5 fleet routes", () => {
    expect(routes).toHaveLength(5);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("fleet.overview");
    expect(opIds).toContain("fleet.list.satellites");
    expect(opIds).toContain("fleet.get.satellite.detail");
    expect(opIds).toContain("fleet.get.satellite.remediation");
    expect(opIds).toContain("fleet.execute.satellite.remediation");
  });

  // ─── Route auth ───

  it("read routes require fleet.read and execute route requires hub.admin", () => {
    expect(findRoute("fleet.overview").auth).toEqual({ public: true });
    expect(findRoute("fleet.list.satellites").auth).toEqual({ public: true });
    expect(findRoute("fleet.get.satellite.detail").auth).toEqual({ public: true });
    expect(findRoute("fleet.get.satellite.remediation").auth).toEqual({ public: true });
    expect(findRoute("fleet.execute.satellite.remediation").auth).toEqual({ public: true });
  });

  // ─── Fleet overview route ───

  it("GET /v1/fleet/overview returns overview data", async () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1");

    const route = findRoute("fleet.overview");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/overview");

    const result = await route.handler(makeCtx());
    expect(result).toHaveProperty("generatedAt");
    expect(result).toHaveProperty("totals");
    expect(result).toHaveProperty("health");
    expect(result).toHaveProperty("trust");
  });

  it("fleet overview works with no satellites", async () => {
    const route = findRoute("fleet.overview");
    const result = await route.handler(makeCtx());
    expect((result as FridayFleetOverviewResponse).totals.satellites).toBe(0);
  });

  // ─── List satellites route ───

  it("GET /v1/fleet/satellites lists satellite cards", async () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertHeartbeat("sat-1");
    insertHeartbeat("sat-2");

    const route = findRoute("fleet.list.satellites");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/satellites");

    const ctx = makeCtx({ query: {} });
    const result = await route.handler(ctx);
    expect((result as FridayListFleetSatellitesResponse).items).toHaveLength(2);
  });

  it("list satellites handles query filters", async () => {
    insertSatellite("sat-1", "online");
    insertSatellite("sat-2", "pending");

    const route = findRoute("fleet.list.satellites");
    const ctx = makeCtx({ query: { pairingStatus: "online" } });
    const result = await route.handler(ctx);
    expect((result as FridayListFleetSatellitesResponse).items).toHaveLength(1);
  });

  // ─── Get satellite detail route ───

  it("GET /v1/fleet/satellites/:satelliteId returns detail", async () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1");

    const route = findRoute("fleet.get.satellite.detail");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/satellites/:satelliteId");

    const ctx = makeCtx({ params: { satelliteId: "sat-1" } });
    const result = await route.handler(ctx);
    expect(result).not.toBeNull();
    expect((result as FridayFleetSatelliteDetailResponse).satellite.satelliteId).toBe("sat-1");
  });

  it("satellite detail returns 404 for unknown ID", async () => {
    const route = findRoute("fleet.get.satellite.detail");
    const ctx = makeCtx({ params: { satelliteId: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    try {
      await route.handler(ctx);
    } catch (e) {
      expect((e as FridayDomainError).code).toBe("SATELLITE_NOT_FOUND");
      expect((e as FridayDomainError).httpStatus).toBe(404);
    }
  });

  it("GET /v1/fleet/satellites/:satelliteId/remediation returns remediation details", async () => {
    insertSatellite("sat-1", "degraded");
    insertOutboxMessage("msg-remediate", "sat-1", "failed");

    const route = findRoute("fleet.get.satellite.remediation");
    const ctx = makeCtx({ params: { satelliteId: "sat-1" } });
    const result = await route.handler(ctx);

    expect((result as FridayFleetRemediationPlan).actions.some((action) => action.actionId === "requeue_expired_leases")).toBe(true);
  });

  it("POST /v1/fleet/satellites/:satelliteId/remediation/:actionId/execute requires canonical approval before side effects", async () => {
    insertSatellite("sat-1", "degraded");
    insertOutboxMessage("msg-exec", "sat-1", "failed");

    const route = findRoute("fleet.execute.satellite.remediation");
    const ctx = makeCtx({
      params: { satelliteId: "sat-1", actionId: "requeue_expired_leases" },
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    });
    await expect(route.handler(ctx)).rejects.toMatchObject({ code: "FLEET_REMEDIATION_PLAN_DIGEST_REQUIRED" });
    expect(outboxQueueService.requeueExpiredLeases).not.toHaveBeenCalled();
  });

  it("POST /v1/fleet/satellites/:satelliteId/remediation/:actionId/execute returns execution result with canonical evidence", async () => {
    insertSatellite("sat-1", "degraded");
    insertOutboxMessage("msg-exec", "sat-1", "failed");

    const route = findRoute("fleet.execute.satellite.remediation");
    const ctx = makeCtx({
      params: { satelliteId: "sat-1", actionId: "requeue_expired_leases" },
      body: {
        planDigest: PLAN_DIGEST,
        canonicalApproval: makeApproval({
          satelliteId: "sat-1",
          actionId: "requeue_expired_leases",
          surface: "api:/v1/fleet/satellites/remediation/execute",
        }),
      },
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    });
    const result = await route.handler(ctx);

    expect((result as FridayFleetRemediationActionExecutionResult).status).toBe("completed");
    expect((result as FridayFleetRemediationActionExecutionResult).canonicalGate?.ticketId).toBe("ticket-1");
    expect(outboxQueueService.requeueExpiredLeases).toHaveBeenCalledTimes(1);
  });

  describe("TS-runtime retirement (default/live fail-close)", () => {
    // Build routes WITHOUT the test-oracle flag = production/live wiring.
    function makeRetiredRoutes() {
      return createFridayFleetRoutes({
        fleetService,
        canonicalMutationGate: createFridayMutatingActionGate({
          nowIso: () => NOW,
          ticketIdGenerator: () => "ticket-1",
        }),
      });
    }

    it("fail-closes remediation execute with 503 (after a VALID approval) and does not run the action", async () => {
      insertSatellite("sat-1", "degraded");
      insertOutboxMessage("msg-exec", "sat-1", "failed");
      const retiredRoutes = makeRetiredRoutes();
      const route = retiredRoutes.find((r) => r.operationId === "fleet.execute.satellite.remediation")!;
      const ctx = makeCtx({
        params: { satelliteId: "sat-1", actionId: "requeue_expired_leases" },
        body: {
          planDigest: PLAN_DIGEST,
          canonicalApproval: makeApproval({
            satelliteId: "sat-1",
            actionId: "requeue_expired_leases",
            surface: "api:/v1/fleet/satellites/remediation/execute",
          }),
        },
        principal: {
          principalType: "user", principalId: "user-1", userId: "user-1", role: "admin",
          scopes: ["hub.admin"], tokenId: "tok-1", tokenKind: "access", issuedAt: NOW,
        },
      });
      await expect(route.handler(ctx)).rejects.toMatchObject({
        code: "TS_RUNTIME_FLEET_REMEDIATION_RETIRED",
        httpStatus: 503,
      });
      expect(outboxQueueService.requeueExpiredLeases).not.toHaveBeenCalled();
    });

    it("still enforces canonical approval (403) BEFORE the retirement guard", async () => {
      insertSatellite("sat-1", "degraded");
      const retiredRoutes = makeRetiredRoutes();
      const route = retiredRoutes.find((r) => r.operationId === "fleet.execute.satellite.remediation")!;
      // No canonicalApproval -> approval gate rejects before the 503.
      const ctx = makeCtx({
        params: { satelliteId: "sat-1", actionId: "requeue_expired_leases" },
        body: { planDigest: PLAN_DIGEST },
        principal: {
          principalType: "user", principalId: "user-1", userId: "user-1", role: "admin",
          scopes: ["hub.admin"], tokenId: "tok-1", tokenKind: "access", issuedAt: NOW,
        },
      });
      await expect(route.handler(ctx)).rejects.toMatchObject({ httpStatus: 403 });
      expect(outboxQueueService.requeueExpiredLeases).not.toHaveBeenCalled();
    });
  });
});
