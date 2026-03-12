import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFridayPluginRoutes } from "#api";
import type { FridayRouteDefinition, FridayHttpContext } from "#api";
import type { FridayPluginService, FridayPluginEntity, FridayPluginManifest, FridayPluginManifestLoader } from "#plugins";
import { FridayDomainError } from "#errors";

const NOW = "2026-02-17T10:00:00.000Z";

function makeManifest(id: string): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    version: "1.0.0",
    name: `Plugin ${id}`,
    description: `Description for ${id}`,
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };
}

function makeEntity(id: string, overrides?: Partial<FridayPluginEntity>): FridayPluginEntity {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Description for ${id}`,
    version: "1.0.0",
    source: "local",
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: `/plugins/${id}`,
    kinds: ["skill"],
    manifest: makeManifest(id),
    config: {},
    signatureAlgorithm: null,
    signatureKeyId: null,
    signatureValue: null,
    signatureVerified: false,
    trustedFingerprintSha256: null,
    lastVerifiedAt: null,
    installedAt: NOW,
    updatedAt: NOW,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

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
      scopes: ["plugin.read" as const, "plugin.write" as const, "plugin.install" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    },
    ...overrides,
  };
}

describe("FridayPluginRoutes", () => {
  let pluginService: FridayPluginService;
  let manifestLoader: FridayPluginManifestLoader;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  beforeEach(() => {
    pluginService = {
      listPlugins: vi.fn(() => [makeEntity("friday.test.alpha")]),
      getPlugin: vi.fn((id: string) => (id === "friday.test.alpha" ? makeEntity("friday.test.alpha") : null)),
      listPluginVersions: vi.fn((id: string) => [
        { version: "1.0.0", installedAt: NOW, status: "installed" },
      ]),
      installPlugin: vi.fn((input) => makeEntity(input.manifest.id)),
      enablePlugin: vi.fn(async (id: string) => makeEntity(id, { status: "enabled", enabled: true })),
      disablePlugin: vi.fn(async (id: string) => makeEntity(id, { status: "disabled" })),
      uninstallPlugin: vi.fn(async () => undefined),
      searchMarketplace: vi.fn(async () => ({ items: [], total: 0 })),
      getMarketplacePlugin: vi.fn(async () => ({
        id: "friday.test.mp",
        name: "MP Plugin",
        description: "test",
        version: "1.0.0",
        author: "Test",
        downloads: 42,
        manifest: makeManifest("friday.test.mp"),
        checksum: "abc",
        packageUrl: "url",
        updatedAt: NOW,
      })),
      listMarketplacePluginVersions: vi.fn(async () => [
        { version: "1.0.0", releasedAt: NOW, checksum: "abc123" },
      ]),
      installFromMarketplace: vi.fn(async () => makeEntity("friday.test.mp", { source: "marketplace" })),
    };

    manifestLoader = {
      loadFromDirectory: vi.fn((dirPath: string) => {
        // Return a manifest whose ID is derived from the path
        return makeManifest("friday.test.new");
      }),
      validate: vi.fn((raw: unknown) => raw as FridayPluginManifest),
    };

    routes = createFridayPluginRoutes({ pluginService, manifestLoader });
  });

  // ─── Route registration ───

  it("registers 11 plugin routes", () => {
    expect(routes).toHaveLength(11);
  });

  it("has correct operation IDs", () => {
    const ids = routes.map((r) => r.operationId);
    expect(ids).toContain("plugins.list");
    expect(ids).toContain("plugins.get");
    expect(ids).toContain("plugins.versions.list");
    expect(ids).toContain("plugins.install");
    expect(ids).toContain("plugins.enable");
    expect(ids).toContain("plugins.disable");
    expect(ids).toContain("plugins.uninstall");
    expect(ids).toContain("marketplace.plugins.list");
    expect(ids).toContain("marketplace.plugins.get");
    expect(ids).toContain("marketplace.plugins.versions.list");
    expect(ids).toContain("marketplace.plugins.install");
  });

  // ─── plugins.list ───

  it("lists plugins", async () => {
    const route = findRoute("plugins.list");
    const result = await route.handler(makeCtx());
    expect(result).toMatchObject({ items: [{ id: "friday.test.alpha" }] });
  });

  // ─── plugins.get ───

  it("gets a plugin by ID", async () => {
    const route = findRoute("plugins.get");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.alpha" } }));
    expect(result).toMatchObject({ plugin: { id: "friday.test.alpha" } });
  });

  it("throws 404 for unknown plugin", async () => {
    const route = findRoute("plugins.get");
    await expect(
      route.handler(makeCtx({ params: { id: "nonexistent" } })),
    ).rejects.toThrow(FridayDomainError);
  });

  // ─── plugins.versions.list ───

  it("lists plugin versions", async () => {
    const route = findRoute("plugins.versions.list");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.alpha" } }));
    expect(result).toMatchObject({
      versions: [{ version: "1.0.0", status: "installed" }],
    });
  });

  // ─── plugins.install ───

  it("installs a plugin using real manifest from installPath", async () => {
    const route = findRoute("plugins.install");
    const result = await route.handler(
      makeCtx({
        params: { id: "friday.test.new" },
        body: { installPath: "/plugins/new" },
      }),
    );
    expect(result).toMatchObject({ plugin: { id: "friday.test.new" } });
    expect(manifestLoader.loadFromDirectory).toHaveBeenCalledWith("/plugins/new");
  });

  it("rejects install when manifest ID does not match route param", async () => {
    (manifestLoader.loadFromDirectory as ReturnType<typeof vi.fn>).mockReturnValue(
      makeManifest("friday.test.mismatch"),
    );

    const route = findRoute("plugins.install");
    await expect(
      route.handler(
        makeCtx({
          params: { id: "friday.test.new" },
          body: { installPath: "/plugins/new" },
        }),
      ),
    ).rejects.toThrow(FridayDomainError);
  });

  it("validates install body requires installPath", async () => {
    const route = findRoute("plugins.install");
    await expect(
      route.handler(makeCtx({ params: { id: "friday.test.new" }, body: {} })),
    ).rejects.toThrow(FridayDomainError);
  });

  it("validates install body rejects null body", async () => {
    const route = findRoute("plugins.install");
    await expect(
      route.handler(makeCtx({ params: { id: "friday.test.new" }, body: null })),
    ).rejects.toThrow(FridayDomainError);
  });

  // ─── plugins.enable ───

  it("enables a plugin", async () => {
    const route = findRoute("plugins.enable");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.alpha" } }));
    expect(result).toMatchObject({ plugin: { status: "enabled" } });
  });

  // ─── plugins.disable ───

  it("disables a plugin", async () => {
    const route = findRoute("plugins.disable");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.alpha" } }));
    expect(result).toMatchObject({ plugin: { status: "disabled" } });
  });

  // ─── plugins.uninstall ───

  it("uninstalls a plugin", async () => {
    const route = findRoute("plugins.uninstall");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.alpha" } }));
    expect(result).toMatchObject({ uninstalled: true });
    expect(pluginService.uninstallPlugin).toHaveBeenCalledWith("friday.test.alpha", false);
  });

  it("passes force parameter for uninstall", async () => {
    const route = findRoute("plugins.uninstall");
    await route.handler(makeCtx({ params: { id: "friday.test.alpha" }, query: { force: "true" } }));
    expect(pluginService.uninstallPlugin).toHaveBeenCalledWith("friday.test.alpha", true);
  });

  // ─── marketplace.plugins.list ───

  it("searches marketplace", async () => {
    const route = findRoute("marketplace.plugins.list");
    const result = await route.handler(makeCtx({ query: { q: "test" } }));
    expect(result).toMatchObject({ items: [], total: 0 });
  });

  // ─── marketplace.plugins.get ───

  it("gets marketplace plugin detail", async () => {
    const route = findRoute("marketplace.plugins.get");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.mp" } }));
    expect(result).toMatchObject({ plugin: { id: "friday.test.mp" } });
  });

  // ─── marketplace.plugins.versions.list ───

  it("lists marketplace plugin versions", async () => {
    const route = findRoute("marketplace.plugins.versions.list");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.mp" } }));
    expect(result).toMatchObject({
      versions: [{ version: "1.0.0", checksum: "abc123" }],
    });
  });

  // ─── marketplace.plugins.install ───

  it("installs from marketplace", async () => {
    const route = findRoute("marketplace.plugins.install");
    const result = await route.handler(makeCtx({ params: { id: "friday.test.mp" } }));
    expect(result).toMatchObject({ plugin: { source: "marketplace" } });
  });

  // ─── Auth configuration ───

  it("all routes require authentication", () => {
    for (const route of routes) {
      expect(route.auth).toMatchObject({ public: false });
    }
  });

  it("read routes require plugin.read scope", () => {
    const readRoutes = [
      "plugins.list", "plugins.get", "plugins.versions.list",
      "marketplace.plugins.list", "marketplace.plugins.get", "marketplace.plugins.versions.list",
    ];
    for (const opId of readRoutes) {
      const route = findRoute(opId);
      if (!route.auth.public) {
        expect(route.auth.anyOfScopes).toContain("plugin.read");
      }
    }
  });

  it("write routes require plugin.write scope", () => {
    const writeRoutes = ["plugins.enable", "plugins.disable", "plugins.uninstall"];
    for (const opId of writeRoutes) {
      const route = findRoute(opId);
      if (!route.auth.public) {
        expect(route.auth.anyOfScopes).toContain("plugin.write");
      }
    }
  });

  it("install routes require plugin.install scope", () => {
    const installRoutes = ["plugins.install", "marketplace.plugins.install"];
    for (const opId of installRoutes) {
      const route = findRoute(opId);
      if (!route.auth.public) {
        expect(route.auth.anyOfScopes).toContain("plugin.install");
      }
    }
  });

  // ─── Query validation (Issue 8) ───

  it("rejects invalid source enum in query", async () => {
    const route = findRoute("plugins.list");
    await expect(
      route.handler(makeCtx({ query: { source: "invalid_source" } })),
    ).rejects.toThrow(FridayDomainError);
  });

  it("rejects invalid status enum in query", async () => {
    const route = findRoute("plugins.list");
    await expect(
      route.handler(makeCtx({ query: { status: "bogus" } })),
    ).rejects.toThrow(FridayDomainError);
  });

  it("rejects invalid kind enum in query", async () => {
    const route = findRoute("plugins.list");
    await expect(
      route.handler(makeCtx({ query: { kind: "not_a_kind" } })),
    ).rejects.toThrow(FridayDomainError);
  });

  it("handles NaN limit in marketplace search gracefully", async () => {
    const route = findRoute("marketplace.plugins.list");
    await route.handler(makeCtx({ query: { limit: "not_a_number" } }));
    // Should not throw; falls back to default
    expect(pluginService.searchMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("handles NaN offset in marketplace search gracefully", async () => {
    const route = findRoute("marketplace.plugins.list");
    await route.handler(makeCtx({ query: { offset: "abc" } }));
    // Should not throw; falls back to 0
    expect(pluginService.searchMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0 }),
    );
  });

  it("clamps limit to max", async () => {
    const route = findRoute("marketplace.plugins.list");
    await route.handler(makeCtx({ query: { limit: "9999" } }));
    expect(pluginService.searchMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });
});
