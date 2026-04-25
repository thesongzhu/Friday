import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayPluginRepository,
  createFridayPluginRegistryService,
  createFridayPluginLoader,
  createFridayPluginSignatureVerifier,
} from "#plugins";
import type {
  FridayPluginRegistryService,
  FridayPluginLoader,
  FridayPluginEntrypointModule,
  FridayUpsertPluginInput,
  FridayPluginManifest,
} from "#plugins";
import { FridayDomainError } from "#errors";

function makeManifest(id: string, overrides?: Partial<FridayPluginManifest>): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    version: "1.0.0",
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    kinds: ["skill"],
    entrypoints: { skill: "./dist/skill.js" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
    ...overrides,
  };
}

function makeInput(id: string, overrides?: Partial<FridayUpsertPluginInput>): FridayUpsertPluginInput {
  return {
    id,
    name: `Plugin ${id}`,
    description: `Plugin ${id} description`,
    version: "1.0.0",
    source: "local",
    status: "configured",
    enabled: false,
    trustMode: "trust_on_install",
    trustedFingerprintSha256: "fingerprint-123",
    installPath: `/plugins/${id}`,
    kinds: ["skill"],
    manifest: makeManifest(id, overrides?.manifest ? overrides.manifest : undefined),
    nowIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FridayPluginLoader", () => {
  let db: FridaySqliteLayer;
  let registry: FridayPluginRegistryService;
  let loader: FridayPluginLoader;
  let activateCalls: string[];
  let deactivateCalls: string[];

  function makeModule(pluginId: string): FridayPluginEntrypointModule {
    return {
      activate: async (ctx) => {
        activateCalls.push(`${pluginId}:${ctx.pluginId}`);
      },
      deactivate: async () => {
        deactivateCalls.push(pluginId);
      },
    };
  }

  beforeEach(() => {
    db = createTestDb();
    activateCalls = [];
    deactivateCalls = [];

    const repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });

    loader = createFridayPluginLoader({
      registry,
      signatureVerifier: createFridayPluginSignatureVerifier({ computeSha256: () => "fingerprint-123" }),
      readPackageBytes: () => Buffer.from("package-bytes"),
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async (modulePath: string) => {
        // Extract plugin ID from path
        const parts = modulePath.split("/");
        const pluginId = parts[parts.indexOf("plugins") + 1] ?? "unknown";
        return makeModule(pluginId);
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Loading ───

  it("loads a single plugin", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    const loaded = await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("friday.test.alpha");
    expect(loaded[0].modules.size).toBe(1);
    expect(loaded[0].modules.has("skill")).toBe(true);
  });

  it("calls activate on load", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    expect(activateCalls).toContain("friday.test.alpha:friday.test.alpha");
  });

  it("loads plugins in plan order", async () => {
    registry.upsert(makeInput("friday.test.alpha"));
    registry.upsert(makeInput("friday.test.beta"));

    await loader.load({ order: ["friday.test.beta", "friday.test.alpha"], warnings: [] });
    expect(activateCalls[0]).toContain("friday.test.beta");
    expect(activateCalls[1]).toContain("friday.test.alpha");
  });

  it("transitions plugin to running after load", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    const entity = registry.get("friday.test.alpha");
    expect(entity!.status).toBe("running");
  });

  it("getLoaded returns loaded plugins", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    const loadedMap = loader.getLoaded();
    expect(loadedMap.size).toBe(1);
    expect(loadedMap.has("friday.test.alpha")).toBe(true);
  });

  // ─── Unloading ───

  it("unloads a plugin and calls deactivate", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    await loader.unload(["friday.test.alpha"]);

    expect(deactivateCalls).toContain("friday.test.alpha");
    expect(loader.getLoaded().size).toBe(0);
  });

  it("transitions plugin to disabled on unload", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    await loader.unload(["friday.test.alpha"]);

    const entity = registry.get("friday.test.alpha");
    expect(entity!.status).toBe("disabled");
  });

  it("unload is a no-op for unloaded plugins", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    // Don't load, just try to unload
    await loader.unload(["friday.test.alpha"]);
    expect(deactivateCalls).toHaveLength(0);
  });

  // ─── Error handling ───

  it("throws PLUGIN_NOT_FOUND for missing plugin in plan", async () => {
    try {
      await loader.load({ order: ["friday.test.missing"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_NOT_FOUND");
    }
  });

  it("sets error status when load fails", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    const failLoader = createFridayPluginLoader({
      registry,
      signatureVerifier: createFridayPluginSignatureVerifier({ computeSha256: () => "fingerprint-123" }),
      readPackageBytes: () => Buffer.from("package-bytes"),
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async () => {
        throw new Error("Module not found");
      },
    });

    try {
      await failLoader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch {
      const entity = registry.get("friday.test.alpha");
      expect(entity!.status).toBe("error");
    }
  });

  it("throws PLUGIN_LIFECYCLE_ERROR when activate fails", async () => {
    registry.upsert(makeInput("friday.test.alpha"));

    const failLoader = createFridayPluginLoader({
      registry,
      signatureVerifier: createFridayPluginSignatureVerifier({ computeSha256: () => "fingerprint-123" }),
      readPackageBytes: () => Buffer.from("package-bytes"),
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async () => ({
        activate: () => { throw new Error("activate failed"); },
      }),
    });

    try {
      await failLoader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_LIFECYCLE_ERROR");
    }
  });

  it("rejects entrypoints that escape the plugin install directory", async () => {
    registry.upsert(makeInput("friday.test.escape", {
      manifest: makeManifest("friday.test.escape", {
        entrypoints: { skill: "../escape.js" },
      }),
    }));

    await expect(loader.load({ order: ["friday.test.escape"], warnings: [] }))
      .rejects.toMatchObject({ code: "PLUGIN_ENTRYPOINT_INVALID" });
  });

  it("fails closed when trust-on-install fingerprint verification is unavailable", async () => {
    registry.upsert(makeInput("friday.test.no-verifier"));
    const unsafeLoader = createFridayPluginLoader({
      registry,
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async () => makeModule("friday.test.no-verifier"),
    });

    await expect(unsafeLoader.load({ order: ["friday.test.no-verifier"], warnings: [] }))
      .rejects.toMatchObject({ code: "PLUGIN_SIGNATURE_REQUIRED" });
  });

  it("rejects trust-on-install plugins when the current fingerprint differs", async () => {
    registry.upsert(makeInput("friday.test.changed"));
    const changedLoader = createFridayPluginLoader({
      registry,
      signatureVerifier: createFridayPluginSignatureVerifier({ computeSha256: () => "changed-fingerprint" }),
      readPackageBytes: () => Buffer.from("changed-package-bytes"),
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async () => makeModule("friday.test.changed"),
    });

    await expect(changedLoader.load({ order: ["friday.test.changed"], warnings: [] }))
      .rejects.toMatchObject({ code: "PLUGIN_TRUST_FINGERPRINT_MISMATCH" });
  });

  it("allows unloading core plugin (disable is permitted per design)", async () => {
    registry.upsert(makeInput("friday.channel.discord", {
      source: "bundled",
      status: "configured",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", {
        kinds: ["channel"],
        entrypoints: { channel: "./dist/channel.js" },
      }),
    }));

    // Load first, then unload
    await loader.load({ order: ["friday.channel.discord"], warnings: [] });
    expect(loader.getLoaded().has("friday.channel.discord")).toBe(true);

    await loader.unload(["friday.channel.discord"]);
    expect(loader.getLoaded().has("friday.channel.discord")).toBe(false);
  });

  // ─── Multi-kind plugins ───

  it("loads plugin with multiple kinds", async () => {
    registry.upsert(makeInput("friday.test.multi", {
      kinds: ["skill", "provider"],
      manifest: makeManifest("friday.test.multi", {
        kinds: ["skill", "provider"],
        entrypoints: { skill: "./dist/skill.js", provider: "./dist/provider.js" },
      }),
    }));

    const loaded = await loader.load({ order: ["friday.test.multi"], warnings: [] });
    expect(loaded[0].modules.size).toBe(2);
    expect(loaded[0].modules.has("skill")).toBe(true);
    expect(loaded[0].modules.has("provider")).toBe(true);
    // activate should be called twice (once per kind)
    expect(activateCalls).toHaveLength(2);
  });
});
