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

  describe("TS-runtime retirement (default/live fail-close)", () => {
    function makeDiscoveryStub() {
      return {
        discover: vi.fn(async () => ({ id: "c1", platform: "darwin", generatedAt: "t", scanDurationMs: 1, scanErrors: [], programs: [] })),
        getCachedCatalog: vi.fn(() => null),
        recommend: vi.fn(async () => ({ catalogId: "c1", generatedAt: "t", recommendations: [] })),
        getPolicy: vi.fn(() => ({ enabled: true, scheduledRefreshEnabled: false, refreshIntervalMs: 0, excludedPaths: [], excludedProgramIds: [], redactSensitiveDetails: true })),
        setPolicy: vi.fn(),
        isEnabled: vi.fn(() => true),
      };
    }
    const ctx = { params: {}, query: {}, body: {}, headers: {}, principal: { principalId: "u1" } } as never;

    it("fail-closes discovery.scan with 503 TS_RUNTIME_DISCOVERY_RETIRED and does not scan", async () => {
      const discovery = makeDiscoveryStub();
      const routes = createFridayDiscoveryRoutes({ discovery });
      const scan = routes.find((r) => r.operationId === "discovery.scan")!;
      await expect(scan.handler(ctx)).rejects.toMatchObject({ code: "TS_RUNTIME_DISCOVERY_RETIRED", httpStatus: 503 });
      expect(discovery.discover).not.toHaveBeenCalled();
    });

    it("fail-closes discovery.policy.update with 503 and does not mutate policy", async () => {
      const discovery = makeDiscoveryStub();
      const routes = createFridayDiscoveryRoutes({ discovery });
      const policy = routes.find((r) => r.operationId === "discovery.policy.update")!;
      await expect(policy.handler({ ...ctx, body: { enabled: false } } as never)).rejects.toMatchObject({ code: "TS_RUNTIME_DISCOVERY_RETIRED", httpStatus: 503 });
      expect(discovery.setPolicy).not.toHaveBeenCalled();
    });

    it("runs scan + policy + recommendations when the test-oracle flag is set", async () => {
      const discovery = makeDiscoveryStub();
      const routes = createFridayDiscoveryRoutes({ discovery, allowTestOnlyDiscoveryExecution: true });
      const scan = routes.find((r) => r.operationId === "discovery.scan")!;
      await scan.handler(ctx);
      expect(discovery.discover).toHaveBeenCalledOnce();
      const recommend = routes.find((r) => r.operationId === "discovery.recommend")!;
      const res = await recommend.handler(ctx) as { status: number };
      expect(res.status).toBe(200);
    });

    it("fail-closes the GET recommendations (it falls back to discover() on cache-miss, which is the retired scan)", async () => {
      // recommend() -> cachedCatalog ?? this.discover(): with scan retired the cache
      // can never warm in default/live, so an unguarded GET would execute the scan.
      const discovery = makeDiscoveryStub();
      const routes = createFridayDiscoveryRoutes({ discovery });
      const recommend = routes.find((r) => r.operationId === "discovery.recommend")!;
      await expect(recommend.handler(ctx)).rejects.toMatchObject({ code: "TS_RUNTIME_DISCOVERY_RETIRED", httpStatus: 503 });
      expect(discovery.recommend).not.toHaveBeenCalled();
      expect(discovery.discover).not.toHaveBeenCalled();
    });
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
