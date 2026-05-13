import { describe, expect, it, vi } from "vitest";
import { createFridayDiscoveryDisabledRoutes, createFridayDiscoveryRoutes } from "#api";

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
      expect(byId.get(operationId)?.auth).toMatchObject({ public: true });
    }
  });

  it("keeps discovery policy routes behind operator/admin gates", () => {
    const routes = makeRoutes();
    const byId = new Map(routes.map((route) => [route.operationId, route]));

    expect(byId.get("discovery.policy.get")?.auth).toMatchObject({ public: true });
    expect(byId.get("discovery.policy.update")?.auth).toMatchObject({ public: true });
  });
});

describe("createFridayDiscoveryDisabledRoutes", () => {
  it("keeps discovery status stable when the capability is disabled", async () => {
    const routes = createFridayDiscoveryDisabledRoutes();
    const statusRoute = routes.find((route) => route.operationId === "discovery.status");

    expect(statusRoute?.auth).toMatchObject({ public: true });

    const result = await statusRoute?.handler({} as never) as any;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      enabled: false,
      hasCatalog: false,
      catalogId: null,
      lastScanAt: null,
      programCount: 0,
    });
    expect(result.body.unavailableReason).toContain("FRIDAY_DISCOVERY_ENABLED");
  });

  it("returns an explicit disabled error for actions that require discovery", async () => {
    const routes = createFridayDiscoveryDisabledRoutes();
    const scanRoute = routes.find((route) => route.operationId === "discovery.scan");

    await expect(scanRoute?.handler({} as never)).rejects.toMatchObject({
      code: "CAPABILITY_DISABLED",
      httpStatus: 501,
    });
  });
});
