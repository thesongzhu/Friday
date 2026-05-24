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
  let repo: ReturnType<typeof createFridayPluginRepository>;
  let registry: FridayPluginRegistryService;
  let resolver: FridayPluginDependencyResolver;
  let loader: FridayPluginLoader;
  let signatureVerifier: FridayPluginSignatureVerifier;
  let service: FridayPluginService;

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });
    resolver = createFridayPluginDependencyResolver();
    signatureVerifier = createFridayPluginSignatureVerifier({
      computeSha256: () => "checksum-123",
      verifyEd25519: () => true,
    });
    loader = createFridayPluginLoader({
      registry,
      signatureVerifier,
      readPackageBytes: () => Buffer.from("mock-file-content"),
      nowIso: () => NOW,
      importModule: vi.fn(async () => ({})),
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

  function markLifecyclePromoted(pluginId: string): void {
    db.withWriteTransaction((conn) => {
      repo.setUpgradeMetadata(conn, pluginId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: `${pluginId}@shadow`,
      }, NOW);
    });
  }

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

  it("rejects local fingerprint reads for entrypoints outside the install directory", () => {
    const manifest = makeManifest("friday.test.escape", {
      entrypoints: { skill: "../escape.js" },
    });

    expect(() =>
      service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.escape",
        source: "local",
        userApproved: true,
      }),
    ).toThrow(FridayDomainError);
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
    markLifecyclePromoted("friday.test.alpha");

    const enabled = await service.enablePlugin("friday.test.alpha");
    expect(enabled.status).toBe("running");
    expect(enabled.enabled).toBe(true);
  });

  it("rejects public enable before local plugin lifecycle promotion", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    await expect(service.enablePlugin("friday.test.alpha")).rejects.toMatchObject({
      code: "PLUGIN_LIFECYCLE_PROMOTION_REQUIRED",
    });
  });

  it("allows lifecycle canary bypass without marking the plugin public-promoted", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });

    const enabled = await service.enablePlugin("friday.test.alpha", { lifecycleBypass: "canary" });
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
    markLifecyclePromoted("friday.test.alpha");
    await service.enablePlugin("friday.test.alpha");

    await expect(service.enablePlugin("friday.test.alpha")).rejects.toThrow(FridayDomainError);
  });

  it("throws when enabling nonexistent plugin", async () => {
    await expect(service.enablePlugin("nonexistent")).rejects.toThrow(FridayDomainError);
  });

  it("auto-disables a plugin after repeated enable/load failures", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.flaky"),
      installPath: "/plugins/flaky",
      source: "local",
      userApproved: true,
    });
    markLifecyclePromoted("friday.test.flaky");
    vi.spyOn(loader, "load").mockRejectedValue(
      new FridayDomainError("PLUGIN_LOAD_FAILED", "boom", { httpStatus: 500 }),
    );

    await expect(service.enablePlugin("friday.test.flaky")).rejects.toThrow(FridayDomainError);
    await expect(service.enablePlugin("friday.test.flaky")).rejects.toThrow(FridayDomainError);
    await expect(service.enablePlugin("friday.test.flaky")).rejects.toThrow(FridayDomainError);

    const plugin = service.getPlugin("friday.test.flaky");
    expect(plugin).toMatchObject({
      status: "disabled",
      enabled: false,
      lastErrorCode: "PLUGIN_AUTO_DISABLED",
    });
    expect(plugin?.lastErrorMessage).toContain("auto-disabled");
  });

  // ─── disablePlugin ───

  it("disables an enabled plugin", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.alpha"),
      installPath: "/plugins/alpha",
      source: "local",
      userApproved: true,
    });
    markLifecyclePromoted("friday.test.alpha");
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
    markLifecyclePromoted("friday.test.alpha");
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

  it("auto-disables a plugin after repeated unload/deactivate failures", async () => {
    service.installPlugin({
      manifest: makeManifest("friday.test.unload-flaky"),
      installPath: "/plugins/unload-flaky",
      source: "local",
      userApproved: true,
    });
    markLifecyclePromoted("friday.test.unload-flaky");
    await service.enablePlugin("friday.test.unload-flaky");

    vi.spyOn(loader, "unload").mockRejectedValue(
      new FridayDomainError("PLUGIN_LIFECYCLE_ERROR", "deactivate boom", { httpStatus: 500 }),
    );

    await expect(service.disablePlugin("friday.test.unload-flaky")).rejects.toThrow(FridayDomainError);
    await expect(service.disablePlugin("friday.test.unload-flaky")).rejects.toThrow(FridayDomainError);
    await expect(service.disablePlugin("friday.test.unload-flaky")).rejects.toThrow(FridayDomainError);

    const plugin = service.getPlugin("friday.test.unload-flaky");
    expect(plugin).toMatchObject({
      status: "disabled",
      enabled: false,
      lastErrorCode: "PLUGIN_AUTO_DISABLED",
    });
    expect(plugin?.lastErrorMessage).toContain("auto-disabled");
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

  // ─── B1 truth-labeling: plugin signature is advisory-only / proof_pending ───
  //
  // FridayPluginManifest accepts an ed25519 signature shape, but the install
  // path in friday-plugin-service.ts:280-313 does NOT verify it
  // cryptographically — it always falls into `evaluateLocalTrustOnInstall`
  // (user-approval / fingerprint trust-on-install). The slice adds:
  //   1. A docstring on FridayPluginSignature labeling it advisory-only.
  //   2. A one-time `console.info` advisory at install time when a manifest
  //      declares `signature` (so the operator knows the field is not a
  //      cryptographic guarantee).
  //   3. Inline comments on the related declarations.
  //
  // These tests lock in the advisory + the unchanged trust-on-install path.

  describe("B1 plugin signature truth-labeling", () => {
    let infoSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      infoSpy.mockRestore();
    });

    it("emits a one-time INFO advisory at installPlugin when manifest declares a signature", () => {
      const manifest = makeManifest("friday.test.signed", {
        signature: {
          algorithm: "ed25519",
          keyId: "test-publisher-key-1",
          value: "deadbeefcafef00d",
        },
      });

      service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.signed",
        source: "local",
        userApproved: true,
      });

      const signatureAdvisories = infoSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && msg.includes("signature verification is proof_pending"),
      );
      expect(signatureAdvisories).toHaveLength(1);
      const [message] = signatureAdvisories[0]!;
      expect(message).toContain("friday.test.signed");
      expect(message).toContain("test-publisher-key-1");
      expect(message).toContain("trust-on-install");
    });

    it("does NOT emit the signature advisory when manifest has no signature field", () => {
      const manifest = makeManifest("friday.test.unsigned"); // no signature

      service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.unsigned",
        source: "local",
        userApproved: true,
      });

      const signatureAdvisories = infoSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && msg.includes("signature verification is proof_pending"),
      );
      expect(signatureAdvisories).toHaveLength(0);
    });

    it("installs the plugin under trust_on_install mode regardless of whether a signature is present (signature is not verified)", () => {
      const manifest = makeManifest("friday.test.advisory", {
        signature: {
          algorithm: "ed25519",
          keyId: "any-key-id",
          value: "any-value",
        },
      });

      const entity = service.installPlugin({
        manifest,
        installPath: "/plugins/friday.test.advisory",
        source: "local",
        userApproved: true,
      });

      // Truth-labeling property: regardless of whether `signature` is present
      // and well-formed, the install path always uses `trust_on_install` —
      // the signature field is NOT a path to a "signed" trustMode in this
      // build. If a future slice wires real verification, that path must
      // also flip trustMode to "signed".
      expect(entity.trustMode).toBe("trust_on_install");
    });
  });

});
