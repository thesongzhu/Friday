import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayPluginRepository,
  createFridayPluginRegistryService,
  createFridayPluginDependencyResolver,
  createFridayPluginLoader,
  createFridayPluginSignatureVerifier,
  createFridayPluginService,
} from "#plugins";
import type {
  FridayPluginManifest,
  FridayPluginRegistryService,
  FridayPluginDependencyResolver,
  FridayPluginLoader,
  FridayPluginSignatureVerifier,
  FridayPluginService,
  FridayPluginMarketplaceClient,
} from "#plugins";
import { FridayDomainError } from "#errors";

const NOW = "2026-01-01T00:00:00.000Z";

function makeManifest(id: string, overrides?: Partial<FridayPluginManifest>): FridayPluginManifest {
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
    ...overrides,
  };
}

describe("FridayPluginService", () => {
  let db: FridaySqliteLayer;
  let registry: FridayPluginRegistryService;
  let resolver: FridayPluginDependencyResolver;
  let loader: FridayPluginLoader;
  let signatureVerifier: FridayPluginSignatureVerifier;
  let service: FridayPluginService;

  beforeEach(() => {
    db = createTestDb();
    const repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });
    resolver = createFridayPluginDependencyResolver();
    loader = createFridayPluginLoader({
      registry,
      nowIso: () => NOW,
      importModule: vi.fn(async () => ({})),
    });
    signatureVerifier = createFridayPluginSignatureVerifier({
      computeSha256: () => "checksum-123",
      verifyEd25519: () => true,
    });
    service = createFridayPluginService({
      sqlite: db,
      registry,
      resolver,
      loader,
      signatureVerifier,
      nowIso: () => NOW,
      idGenerator: () => "test-id",
      readFileAsBuffer: () => Buffer.from("mock-file-content"),
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── installPlugin ───

  it("installs a local plugin with userApproved", () => {
    const manifest = makeManifest("friday.test.alpha");
    const entity = service.installPlugin({
      manifest,
      installPath: "/plugins/friday.test.alpha",
      source: "local",
      userApproved: true,
    });

    expect(entity.id).toBe("friday.test.alpha");
    expect(entity.status).toBe("installed");
    expect(entity.source).toBe("local");
    expect(entity.trustMode).toBe("trust_on_install");
  });

  it("surfaces preview capability and policy summaries for first-party preview plugins", () => {
    const manifest = makeManifest("friday.test.preview", {
      previewSdk: {
        sdkVersion: "2026-03-preview",
        capabilities: ["registerTool", "registerHooks"],
      },
    });

    const entity = service.installPlugin({
      manifest,
      installPath: "/plugins/friday.test.preview",
      source: "local",
      userApproved: true,
    });

    expect(entity.capabilitySummary).toMatchObject({
      previewEnabled: true,
      sdkVersion: "2026-03-preview",
      requestedCapabilities: ["registerTool", "registerHooks"],
      supportedCapabilities: ["registerTool", "registerHooks"],
      unsupportedCapabilities: [],
    });
    expect(entity.policySummary).toMatchObject({
      publisherProgram: "first_party",
      installAllowed: true,
      enableAllowed: true,
    });
  });

  it("blocks preview SDK installs for untrusted publishers", () => {
    const manifest = makeManifest("partner.test.preview", {
      previewSdk: {
        sdkVersion: "2026-03-preview",
        capabilities: ["registerTool"],
        publisherId: "partner.test",
      },
    });

    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/partner.test.preview",
        source: "local",
        userApproved: true,
      }),
    ).toThrow(FridayDomainError);
  });

  it("allows preview SDK installs for allowlisted partners", () => {
    const allowlistedService = createFridayPluginService({
      sqlite: db,
      registry,
      resolver,
      loader,
      signatureVerifier,
      previewPolicy: {
        allowlistedPluginIds: ["partner.test.preview"],
        allowlistedPublisherIds: ["partner.test"],
      },
      nowIso: () => NOW,
      idGenerator: () => "test-id",
      readFileAsBuffer: () => Buffer.from("mock-file-content"),
    });

    const entity = allowlistedService.installPlugin({
      manifest: makeManifest("partner.test.preview", {
        previewSdk: {
          sdkVersion: "2026-03-preview",
          capabilities: ["registerRoutes", "registerHooks"],
          publisherId: "partner.test",
        },
      }),
      installPath: "/plugins/partner.test.preview",
      source: "local",
      userApproved: true,
    });

    expect(entity.policySummary).toMatchObject({
      publisherProgram: "allowlisted_partner",
      installAllowed: true,
      enableAllowed: true,
    });
  });

  it("computes and stores fingerprint for local install without packageBytes", () => {
    const manifest = makeManifest("friday.test.alpha");
    const entity = service.installPlugin({
      manifest,
      installPath: "/plugins/friday.test.alpha",
      source: "local",
      userApproved: true,
    });

    expect(entity.trustedFingerprintSha256).toBe("checksum-123");
    expect(entity.signatureVerified).toBe(true);
  });

  it("installs a local plugin with packageBytes", () => {
    const manifest = makeManifest("friday.test.alpha");
    const entity = service.installPlugin({
      manifest,
      installPath: "/plugins/friday.test.alpha",
      source: "local",
      packageBytes: Buffer.from("package-data"),
      userApproved: true,
    });

    expect(entity.id).toBe("friday.test.alpha");
    expect(entity.signatureVerified).toBe(true);
    expect(entity.trustedFingerprintSha256).toBe("checksum-123");
  });

  it("rejects local install without userApproved and without packageBytes", () => {
    const manifest = makeManifest("friday.test.alpha");
    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.alpha",
        source: "local",
      }),
    ).toThrow(FridayDomainError);
  });

  it("throws on duplicate install", () => {
    const manifest = makeManifest("friday.test.alpha");
    service.installPlugin({
      manifest,
      installPath: "/plugins/friday.test.alpha",
      source: "local",
      userApproved: true,
    });

    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.alpha",
        source: "local",
        userApproved: true,
      }),
    ).toThrow(FridayDomainError);
  });

  it("requires signature for marketplace source", () => {
    const manifest = makeManifest("friday.test.alpha");

    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/mp",
        source: "marketplace",
      }),
    ).toThrow(FridayDomainError);
  });

  it("installs marketplace plugin with signature and packageBytes", () => {
    const manifest = makeManifest("friday.test.alpha", {
      signature: { algorithm: "ed25519", keyId: "key-1", value: "c2lnbmF0dXJl" },
    });

    const entity = service.installPlugin({
      manifest,
      installPath: "/plugins/mp/friday.test.alpha",
      source: "marketplace",
      packageBytes: Buffer.from("marketplace-package"),
    });

    expect(entity.trustMode).toBe("signed");
    expect(entity.signatureVerified).toBe(true);
  });

  it("rejects marketplace install without packageBytes", () => {
    const manifest = makeManifest("friday.test.alpha", {
      signature: { algorithm: "ed25519", keyId: "key-1", value: "c2lnbmF0dXJl" },
    });

    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/mp/friday.test.alpha",
        source: "marketplace",
      }),
    ).toThrow(FridayDomainError);
  });

  // ─── listPlugins / getPlugin ───

  it("lists installed plugins", () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });
    service.installPlugin({
      manifest: makeManifest("friday.test.beta"),
      installPath: "/plugins/beta",
      source: "local",
      userApproved: true,
    });

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
  });

  it("gets a plugin by ID", () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    const plugin = service.getPlugin("friday.test.alpha");
    expect(plugin).toBeDefined();
    expect(plugin!.id).toBe("friday.test.alpha");
  });

  it("returns null for missing plugin", () => {
    expect(service.getPlugin("nonexistent")).toBeNull();
  });

  // ─── listPluginVersions ───

  it("lists versions for installed plugin", () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    const versions = service.listPluginVersions("friday.test.alpha");
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[0].status).toBe("installed");
  });

  it("throws when listing versions for nonexistent plugin", () => {
    expect(() => service.listPluginVersions("nonexistent")).toThrow(FridayDomainError);
  });

  // ─── enablePlugin ───

  it("enables an installed plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    const enabled = await service.enablePlugin("friday.test.alpha");
    expect(enabled.status).toBe("running");
    expect(enabled.enabled).toBe(true);
  });

  it("throws when enabling already enabled plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });
    await service.enablePlugin("friday.test.alpha");

    await expect(service.enablePlugin("friday.test.alpha")).rejects.toThrow(FridayDomainError);
  });

  it("throws when enabling nonexistent plugin", async () => {
    await expect(service.enablePlugin("nonexistent")).rejects.toThrow(FridayDomainError);
  });

  // ─── disablePlugin ───

  it("disables an enabled plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });
    await service.enablePlugin("friday.test.alpha");

    const disabled = await service.disablePlugin("friday.test.alpha");
    expect(disabled.status).toBe("disabled");
    expect(disabled.enabled).toBe(false);
  });

  it("throws when disabling already disabled plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });
    await service.enablePlugin("friday.test.alpha");
    await service.disablePlugin("friday.test.alpha");

    await expect(service.disablePlugin("friday.test.alpha")).rejects.toThrow(FridayDomainError);
  });

  it("allows disabling core plugin (design: non-uninstallable but can be disabled)", async () => {
    // Insert a core plugin in enabled status
    registry.upsert({
      id: "friday.channel.discord",
      name: "Discord",
      description: "Discord channel",
      version: "1.0.0",
      source: "bundled",
      status: "enabled",
      enabled: true,
      trustMode: "trust_on_install",
      installPath: "/plugins/discord",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", { kinds: ["channel"], entrypoints: { channel: "./dist/channel.js" } }),
      nowIso: NOW,
    });

    const disabled = await service.disablePlugin("friday.channel.discord");
    expect(disabled.status).toBe("disabled");
    expect(disabled.enabled).toBe(false);
  });

  // ─── uninstallPlugin ───

  it("uninstalls an installed plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    await service.uninstallPlugin("friday.test.alpha");
    expect(service.getPlugin("friday.test.alpha")).toBeNull();
  });

  it("throws when uninstalling core plugin", async () => {
    registry.upsert({
      id: "friday.channel.discord",
      name: "Discord",
      description: "Discord channel",
      version: "1.0.0",
      source: "bundled",
      status: "installed",
      enabled: false,
      trustMode: "trust_on_install",
      installPath: "/plugins/discord",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", { kinds: ["channel"], entrypoints: { channel: "./dist/channel.js" } }),
      nowIso: NOW,
    });

    await expect(service.uninstallPlugin("friday.channel.discord")).rejects.toThrow(FridayDomainError);
  });

  it("blocks uninstall when reverse dependencies exist", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.base"),
      installPath: "/plugins/base",
      source: "local",
      userApproved: true,
    });
    service.installPlugin({
      manifest: makeManifest("friday.test.dependent", {
        dependencies: { "friday.test.base": "^1.0.0" },
      }),
      installPath: "/plugins/dependent",
      source: "local",
      userApproved: true,
    });

    await expect(service.uninstallPlugin("friday.test.base")).rejects.toThrow(FridayDomainError);
  });

  it("force uninstall ignores reverse dependencies", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.base"),
      installPath: "/plugins/base",
      source: "local",
      userApproved: true,
    });
    service.installPlugin({
      manifest: makeManifest("friday.test.dependent", {
        dependencies: { "friday.test.base": "^1.0.0" },
      }),
      installPath: "/plugins/dependent",
      source: "local",
      userApproved: true,
    });

    await service.uninstallPlugin("friday.test.base", true);
    expect(service.getPlugin("friday.test.base")).toBeNull();
  });

  // ─── Marketplace ───

  it("returns empty search results when marketplace is not configured", async () => {
    await expect(service.searchMarketplace({})).resolves.toEqual({ items: [], total: 0 });
  });

  it("throws when marketplace is not configured for detail", async () => {
    await expect(service.getMarketplacePlugin("some-id")).rejects.toThrow(FridayDomainError);
  });

  it("throws when marketplace is not configured for install", async () => {
    await expect(service.installFromMarketplace("some-id")).rejects.toThrow(FridayDomainError);
  });

  it("throws when marketplace is not configured for versions", async () => {
    await expect(service.listMarketplacePluginVersions("some-id")).rejects.toThrow(FridayDomainError);
  });

  it("searches marketplace when configured", async () => {
    const mockMarketplace: FridayPluginMarketplaceClient = {
      search: vi.fn(async () => ({
        items: [
          {
            id: "partner.preview.plugin",
            name: "Preview Plugin",
            description: "Test preview plugin",
            version: "1.0.0",
            author: "Partner",
            downloads: 0,
            updatedAt: NOW,
            previewSdk: {
              sdkVersion: "2026-03-preview",
              capabilities: ["registerTool"],
              publisherId: "partner.preview",
            },
          },
        ],
        total: 1,
      })),
      getPluginDetail: vi.fn(async () => ({
        id: "test",
        name: "Test",
        description: "Test",
        version: "1.0.0",
        author: "Test",
        downloads: 0,
        manifest: makeManifest("test"),
        checksum: "abc",
        packageUrl: "url",
        updatedAt: NOW,
      })),
      listVersions: vi.fn(async () => [
        { version: "1.0.0", releasedAt: NOW, checksum: "abc" },
      ]),
      downloadPackage: vi.fn(async () => ({
        packageBytes: Buffer.from("data"),
        checksum: "checksum-123",
        manifest: makeManifest("test"),
      })),
    };

    const serviceWithMp = createFridayPluginService({
      sqlite: db,
      registry,
      resolver,
      loader,
      marketplace: mockMarketplace,
      signatureVerifier,
      previewPolicy: {
        allowlistedPublisherIds: ["partner.preview"],
      },
      nowIso: () => NOW,
      idGenerator: () => "test-id",
    });

    const result = await serviceWithMp.searchMarketplace({ query: "test" });
    expect(result.items[0]?.capabilitySummary).toMatchObject({
      previewEnabled: true,
      requestedCapabilities: ["registerTool"],
    });
    expect(result.items[0]?.policySummary).toMatchObject({
      publisherProgram: "allowlisted_partner",
      installAllowed: true,
    });
    expect(mockMarketplace.search).toHaveBeenCalled();
  });

  it("enriches marketplace detail with preview policy summaries", async () => {
    const mockMarketplace: FridayPluginMarketplaceClient = {
      search: vi.fn(async () => ({ items: [], total: 0 })),
      getPluginDetail: vi.fn(async () => ({
        id: "partner.detail.preview",
        name: "Detail Preview",
        description: "Test",
        version: "1.0.0",
        author: "Partner",
        downloads: 1,
        manifest: makeManifest("partner.detail.preview", {
          previewSdk: {
            sdkVersion: "2026-03-preview",
            capabilities: ["registerProvider"],
            publisherId: "partner.detail",
          },
        }),
        checksum: "abc",
        packageUrl: "url",
        updatedAt: NOW,
      })),
      listVersions: vi.fn(async () => []),
      downloadPackage: vi.fn(async () => ({
        packageBytes: Buffer.from("data"),
        checksum: "checksum-123",
        manifest: makeManifest("partner.detail.preview"),
      })),
    };

    const serviceWithMp = createFridayPluginService({
      sqlite: db,
      registry,
      resolver,
      loader,
      marketplace: mockMarketplace,
      signatureVerifier,
      previewPolicy: {
        allowlistedPublisherIds: ["partner.detail"],
      },
      nowIso: () => NOW,
      idGenerator: () => "test-id",
    });

    const detail = await serviceWithMp.getMarketplacePlugin("partner.detail.preview");

    expect(detail.capabilitySummary).toMatchObject({
      previewEnabled: true,
      requestedCapabilities: ["registerProvider"],
    });
    expect(detail.policySummary).toMatchObject({
      publisherProgram: "allowlisted_partner",
      installAllowed: true,
    });
  });

  it("lists marketplace plugin versions when configured", async () => {
    const mockMarketplace: FridayPluginMarketplaceClient = {
      search: vi.fn(async () => ({ items: [], total: 0 })),
      getPluginDetail: vi.fn(async () => ({
        id: "friday.test.alpha",
        name: "Alpha",
        description: "test",
        version: "1.0.0",
        author: "Test",
        downloads: 0,
        manifest: makeManifest("friday.test.alpha"),
        checksum: "abc",
        packageUrl: "url",
        updatedAt: NOW,
      })),
      listVersions: vi.fn(async () => [
        { version: "1.0.0", releasedAt: NOW, checksum: "abc123" },
        { version: "1.1.0", releasedAt: NOW, checksum: "def456" },
      ]),
      downloadPackage: vi.fn(async () => ({
        packageBytes: Buffer.from("data"),
        checksum: "checksum-123",
        manifest: makeManifest("friday.test.alpha"),
      })),
    };

    const serviceWithMp = createFridayPluginService({
      sqlite: db,
      registry,
      resolver,
      loader,
      marketplace: mockMarketplace,
      signatureVerifier,
      nowIso: () => NOW,
      idGenerator: () => "test-id",
    });

    const versions = await serviceWithMp.listMarketplacePluginVersions("friday.test.alpha");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe("1.0.0");
    expect(versions[1].version).toBe("1.1.0");
    expect(mockMarketplace.listVersions).toHaveBeenCalledWith("friday.test.alpha");
  });
});
