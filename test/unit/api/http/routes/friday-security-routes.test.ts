import { describe, it, expect } from "vitest";
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
    revokeToken: (tokenId: string) => ({ revoked: true as const, tokenId }),
    revokeSatellite: (satelliteId: string) => ({ revoked: true as const, satelliteId }),
  };

  const routes = createFridaySecurityRoutes(stubDeps);

  it("registers 3 security routes", () => {
    expect(routes).toHaveLength(3);
  });

  it("GET /v1/security/center requires security.read", () => {
    const route = routes.find((r) => r.operationId === "security.center");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.read"] });
  });

  it("POST /v1/security/tokens/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revoke.token");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.write"] });
  });

  it("POST /v1/security/satellites/:satelliteId/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revoke.satellite");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.write"] });
  });
});
