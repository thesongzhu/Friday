import { describe, expect, it, vi } from "vitest";
import { createFridayDiscoveryRoutes } from "#api";

describe("createFridayDiscoveryRoutes", () => {
  function makeRoutes() {
    return createFridayDiscoveryRoutes({
      discovery: {
        discover: vi.fn(async () => ({
          id: "catalog-1",
          platform: "darwin",
          generatedAt: "2026-04-19T20:00:00.000Z",
          scanDurationMs: 12,
          scanErrors: [],
          programs: [],
        })),
        getCachedCatalog: vi.fn(() => null),
        recommend: vi.fn(async () => ({
          catalogId: "catalog-1",
          generatedAt: "2026-04-19T20:00:00.000Z",
          recommendations: [],
        })),
        getPolicy: vi.fn(() => ({
          enabled: true,
          scheduledRefreshEnabled: false,
          refreshIntervalMs: 0,
          excludedPaths: [],
          excludedProgramIds: [],
          redactSensitiveDetails: true,
        })),
        setPolicy: vi.fn(),
        isEnabled: vi.fn(() => true),
      },
    });
  }

  it("requires desktop.read for discovery inventory routes", () => {
    const routes = makeRoutes();
    const byId = new Map(routes.map((route) => [route.operationId, route]));

    for (const operationId of [
      "discovery.scan",
      "discovery.catalog.get",
      "discovery.programs.list",
      "discovery.recommend",
      "discovery.status",
    ]) {
      expect(byId.get(operationId)?.auth).toMatchObject({
        public: false,
        anyOfScopes: ["desktop.read"],
      });
    }
  });

  it("keeps discovery policy routes behind operator/admin gates", () => {
    const routes = makeRoutes();
    const byId = new Map(routes.map((route) => [route.operationId, route]));

    expect(byId.get("discovery.policy.get")?.auth).toMatchObject({
      public: false,
      anyOfScopes: ["desktop.read"],
      anyOfRoles: ["admin", "operator"],
    });
    expect(byId.get("discovery.policy.update")?.auth).toMatchObject({
      public: false,
      anyOfScopes: ["desktop.write"],
      anyOfRoles: ["admin"],
    });
  });
});
