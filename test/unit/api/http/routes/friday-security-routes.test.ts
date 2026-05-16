import { describe, it, expect, vi } from "vitest";
import { createFridaySecurityRoutes } from "#api";
import type { FridaySecurityRoutesDeps } from "#api";

describe("FridaySecurityRoutes", () => {
  const stubDeps: FridaySecurityRoutesDeps = {
    fleetService: {
      getOverview: () => ({
        generatedAt: "2025-01-01T00:00:00Z",
        totals: { satellites: 0, pending: 0, paired: 0, online: 0, degraded: 0, offline: 0, revoked: 0 },
        queue: { queued: 0, leased: 0, failed: 0, deadLetter: 0 },
        workflows: { activeRuns: 0, completed1h: 0, failed1h: 0 },
        health: { score: 1, state: "healthy", reasons: [] },
        trust: { averageScore: 1, lowTrustCount: 0, restrictedCount: 0, revokedCount: 0 },
      }),
      listSatellites: () => ({ items: [] }),
      getSatelliteDetail: () => null,
      getSecurityCenter: () => ({
        generatedAt: "2025-01-01T00:00:00Z",
        tokens: { active: 0, expired: 0, revoked24h: 0, highPrivilegeActive: 0 },
        satellites: { restricted: 0, trusted: 0, revoked: 0, pendingPairings: 0 },
        findings: [],
      }),
    },
    revokeToken: vi.fn((tokenId: string) => ({ revoked: true as const, tokenId })) as unknown as FridaySecurityRoutesDeps["revokeToken"],
    revokeSatellite: vi.fn((satelliteId: string) => ({ revoked: true as const, satelliteId })) as unknown as FridaySecurityRoutesDeps["revokeSatellite"],
  };

  const routes = createFridaySecurityRoutes(stubDeps);

  it("registers 3 security routes", () => {
    expect(routes).toHaveLength(3);
  });

  it("GET /v1/security/center requires security.read", () => {
    const route = routes.find((r) => r.operationId === "security.center");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/security/tokens/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revoke.token");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/security/satellites/:satelliteId/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revoke.satellite");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
  });

  // ── Phase 14.5A WP-001: parallel security-routes revocation surfaces ──────

  it("Phase 14.5A: POST /v1/security/tokens/revoke refuses the synthetic public principal", async () => {
    const route = routes.find((r) => r.operationId === "security.revoke.token")!;
    let thrown: unknown;
    try {
      await route.handler({
        body: { tokenId: "tok-1" },
        params: {},
        query: {},
        headers: {},
        principal: { principalId: "public:default" },
        requestId: "req-1",
        receivedAt: "2026-05-16T00:00:00.000Z",
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect(stubDeps.revokeToken).not.toHaveBeenCalled();
  });

  it("Phase 14.5A: POST /v1/security/tokens/revoke refuses a null principal", async () => {
    const route = routes.find((r) => r.operationId === "security.revoke.token")!;
    let thrown: unknown;
    try {
      await route.handler({
        body: { tokenId: "tok-1" },
        params: {},
        query: {},
        headers: {},
        principal: null,
        requestId: "req-1",
        receivedAt: "2026-05-16T00:00:00.000Z",
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect(stubDeps.revokeToken).not.toHaveBeenCalled();
  });

  it("Phase 14.5A: POST /v1/security/satellites/:satelliteId/revoke refuses the synthetic public principal", async () => {
    const route = routes.find((r) => r.operationId === "security.revoke.satellite")!;
    let thrown: unknown;
    try {
      await route.handler({
        body: { reason: "compromised" },
        params: { satelliteId: "sat-1" },
        query: {},
        headers: {},
        principal: { principalId: "public:default" },
        requestId: "req-1",
        receivedAt: "2026-05-16T00:00:00.000Z",
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe("OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED");
    expect(stubDeps.revokeSatellite).not.toHaveBeenCalled();
  });
});
