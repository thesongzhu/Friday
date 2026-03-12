import { describe, expect, it, vi } from "vitest";
import { FridayDomainError } from "#errors";
import { createFridaySkillMarketplaceRoutes } from "../../../../src/api/http/routes/friday-skill-marketplace-routes.js";
import type { FridaySkillMarketplaceRoutesDeps } from "../../../../src/api/http/routes/friday-skill-marketplace-routes.js";

function createMockDeps(
  overrides: Partial<FridaySkillMarketplaceRoutesDeps> = {},
): FridaySkillMarketplaceRoutesDeps {
  return {
    sources: {
      addSource: vi.fn().mockReturnValue({
        id: "src-1",
        name: "Main",
        baseUrl: "https://marketplace.example.com",
        enabled: true,
        trustPolicy: "warn",
        pinnedKeyIds: [],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      getSource: vi.fn().mockReturnValue(null),
      listSources: vi.fn().mockReturnValue([]),
      updateSource: vi.fn().mockReturnValue({
        id: "src-1",
        name: "Main",
        baseUrl: "https://marketplace.example.com",
        enabled: true,
        trustPolicy: "warn",
        pinnedKeyIds: [],
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      enableSource: vi.fn(),
      disableSource: vi.fn(),
      removeSource: vi.fn(),
    },
    discovery: {
      search: vi.fn().mockReturnValue({
        items: [],
        nextCursor: undefined,
        total: 0,
      }),
    },
    installations: {
      install: vi.fn().mockResolvedValue({
        installationIds: ["inst-1"],
        resolvedVersion: "1.0.0",
        verification: {
          integrityValid: true,
          signatureValid: true,
          checks: ["integrity:pass"],
        },
        trust: {
          total: 90,
          signature: 30,
          integrity: 30,
          keyPinning: 10,
          sourcePolicy: 10,
          publisher: 5,
          freshness: 5,
          reasons: [],
        },
      }),
      uninstall: vi.fn(),
    },
    sync: {
      syncAllSources: vi.fn().mockResolvedValue([]),
      syncSource: vi.fn().mockResolvedValue({
        sourceId: "src-1",
        sourceName: "Main",
        skillsSynced: 1,
        versionsSynced: 1,
        errors: [],
      }),
    },
    cache: {
      getStaleSourceIds: vi.fn().mockReturnValue([]),
      pruneStaleEntries: vi.fn().mockReturnValue(0),
      clearSourceCache: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: {
      principalId: "tenant-1",
      principalType: "user",
      role: "viewer",
      scopes: ["marketplace.read", "marketplace.write", "marketplace.admin"],
      tokenId: "token-1",
      tokenKind: "access",
      issuedAt: "2026-03-01T00:00:00.000Z",
    },
    requestId: "req-1",
    receivedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

function findRoute(
  routes: ReturnType<typeof createFridaySkillMarketplaceRoutes>,
  operationId: string,
) {
  const route = routes.find((item) => item.operationId === operationId);
  if (!route) {
    throw new Error(`Route "${operationId}" not found`);
  }
  return route;
}

describe("createFridaySkillMarketplaceRoutes", () => {
  it("registers core source/catalog/install routes", () => {
    const routes = createFridaySkillMarketplaceRoutes(createMockDeps());
    expect(routes.some((route) => route.operationId === "marketplace.sources.list")).toBe(true);
    expect(routes.some((route) => route.operationId === "marketplace.sources.create")).toBe(true);
    expect(routes.some((route) => route.operationId === "marketplace.skills.catalog")).toBe(true);
    expect(routes.some((route) => route.operationId === "marketplace.skills.install")).toBe(true);
  });

  it("creates a source with validated trust policy", async () => {
    const deps = createMockDeps();
    const routes = createFridaySkillMarketplaceRoutes(deps);
    const route = findRoute(routes, "marketplace.sources.create");

    const result = await route.handler(createMockCtx({
      body: {
        name: "Main",
        baseUrl: "https://marketplace.example.com",
        trustPolicy: "warn",
        pinnedKeyIds: ["k1"],
      },
    }));

    expect(result).toHaveProperty("source.id", "src-1");
    expect(deps.sources.addSource).toHaveBeenCalledWith({
      name: "Main",
      baseUrl: "https://marketplace.example.com",
      trustPolicy: "warn",
      pinnedKeyIds: ["k1"],
    });
  });

  it("rejects invalid source trustPolicy", async () => {
    const routes = createFridaySkillMarketplaceRoutes(createMockDeps());
    const route = findRoute(routes, "marketplace.sources.create");

    await expect(route.handler(createMockCtx({
      body: {
        name: "Main",
        baseUrl: "https://marketplace.example.com",
        trustPolicy: "invalid-policy",
      },
    }))).rejects.toThrow(FridayDomainError);
  });

  it("returns 404 for missing source on get", async () => {
    const routes = createFridaySkillMarketplaceRoutes(createMockDeps());
    const route = findRoute(routes, "marketplace.sources.get");

    await expect(route.handler(createMockCtx({
      params: { id: "missing-source" },
    }))).rejects.toThrow(FridayDomainError);
  });

  it("forwards catalog query to discovery service", async () => {
    const deps = createMockDeps();
    const routes = createFridaySkillMarketplaceRoutes(deps);
    const route = findRoute(routes, "marketplace.skills.catalog");

    await route.handler(createMockCtx({
      query: {
        sourceId: "src-1",
        q: "search term",
        category: "utility",
        cursor: "10",
        limit: "25",
        includeStale: "true",
      },
    }));

    expect(deps.discovery.search).toHaveBeenCalledWith({
      sourceId: "src-1",
      q: "search term",
      category: "utility",
      cursor: "10",
      limit: 25,
      includeStale: true,
    });
  });

  it("installs a marketplace skill", async () => {
    const deps = createMockDeps();
    const routes = createFridaySkillMarketplaceRoutes(deps);
    const route = findRoute(routes, "marketplace.skills.install");

    const result = await route.handler(createMockCtx({
      body: {
        skillId: "friday.skill.test",
        version: "1.0.0",
        sourceId: "src-1",
        targetSatelliteIds: ["sat-1"],
        grantPermissions: ["fs:read"],
      },
    }));

    expect(result).toHaveProperty("installationIds");
    expect(deps.installations.install).toHaveBeenCalledWith({
      skillId: "friday.skill.test",
      version: "1.0.0",
      sourceId: "src-1",
      targetSatelliteIds: ["sat-1"],
      grantPermissions: ["fs:read"],
    });
  });

  it("runs sync for a specific source when sourceId is provided", async () => {
    const deps = createMockDeps();
    const routes = createFridaySkillMarketplaceRoutes(deps);
    const route = findRoute(routes, "marketplace.skills.sync");

    const result = await route.handler(createMockCtx({
      body: { sourceId: "src-1" },
    }));

    expect(deps.sync.syncSource).toHaveBeenCalledWith("src-1");
    expect(deps.sync.syncAllSources).not.toHaveBeenCalled();
    expect(result).toHaveProperty("totalSources", 1);
  });

  it("returns sync status with stale source metrics", async () => {
    const deps = createMockDeps({
      sources: {
        ...createMockDeps().sources,
        listSources: vi.fn()
          .mockReturnValueOnce([{ id: "src-1" }, { id: "src-2" }])
          .mockReturnValueOnce([{ id: "src-1" }]),
      } as unknown as FridaySkillMarketplaceRoutesDeps["sources"],
      cache: {
        ...createMockDeps().cache,
        getStaleSourceIds: vi.fn().mockReturnValue(["src-2"]),
      },
    });
    const routes = createFridaySkillMarketplaceRoutes(deps);
    const route = findRoute(routes, "marketplace.skills.status.sync");

    const result = await route.handler(createMockCtx());

    expect(result).toEqual({
      sourceCount: 2,
      enabledSourceCount: 1,
      staleSourceIds: ["src-2"],
      staleSourceCount: 1,
    });
  });
});
