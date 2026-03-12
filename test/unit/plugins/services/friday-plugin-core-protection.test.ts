import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayPluginRepository,
  createFridayPluginRegistryService,
  createFridayPluginLoader,
} from "#plugins";
import type {
  FridayPluginRepository,
  FridayPluginRegistryService,
  FridayPluginLoader,
  FridayPluginManifest,
  FridayUpsertPluginInput,
  FridayPluginEntrypointModule,
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
    status: "installed",
    enabled: false,
    trustMode: "trust_on_install",
    installPath: `/plugins/${id}`,
    kinds: ["skill"],
    manifest: makeManifest(id),
    nowIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Core Plugin Protection Tests ───

describe("Core plugin protection", () => {
  let db: FridaySqliteLayer;
  let repo: FridayPluginRepository;
  let registry: FridayPluginRegistryService;

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Core plugin override attempts ───

  it("rejects upsert of core plugin from local source", () => {
    expect(() =>
      registry.upsert(makeInput("friday.channel.discord", {
        source: "local",
        kinds: ["channel"],
        manifest: makeManifest("friday.channel.discord", {
          kinds: ["channel"],
          entrypoints: { channel: "./dist/channel.js" },
        }),
      })),
    ).toThrow(FridayDomainError);

    try {
      registry.upsert(makeInput("friday.channel.discord", { source: "local" }));
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_CORE_PLUGIN_PROTECTED");
      expect((err as FridayDomainError).httpStatus).toBe(403);
    }
  });

  it("rejects upsert of core plugin from marketplace source", () => {
    expect(() =>
      registry.upsert(makeInput("friday.channel.discord", { source: "marketplace" })),
    ).toThrow(FridayDomainError);

    try {
      registry.upsert(makeInput("friday.channel.discord", { source: "marketplace" }));
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_CORE_PLUGIN_PROTECTED");
    }
  });

  it("rejects upsert of telegram core plugin from non-bundled source", () => {
    expect(() =>
      registry.upsert(makeInput("friday.channel.telegram", { source: "local" })),
    ).toThrow(FridayDomainError);
  });

  it("allows upsert of core plugin from bundled source", () => {
    const entity = registry.upsert(makeInput("friday.channel.discord", {
      source: "bundled",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", {
        kinds: ["channel"],
        entrypoints: { channel: "./dist/channel.js" },
      }),
    }));
    expect(entity.id).toBe("friday.channel.discord");
    expect(entity.source).toBe("bundled");
  });

  // ─── Core plugin removal ───

  it("rejects removal of core plugin", () => {
    // First register it as bundled
    registry.upsert(makeInput("friday.channel.discord", {
      source: "bundled",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", {
        kinds: ["channel"],
        entrypoints: { channel: "./dist/channel.js" },
      }),
    }));

    expect(() => registry.remove("friday.channel.discord")).toThrow(FridayDomainError);

    try {
      registry.remove("friday.channel.discord");
    } catch (err) {
      expect((err as FridayDomainError).code).toBe("PLUGIN_CORE_PLUGIN_PROTECTED");
      expect((err as FridayDomainError).httpStatus).toBe(403);
    }
  });

  it("rejects removal of telegram core plugin", () => {
    registry.upsert(makeInput("friday.channel.telegram", {
      source: "bundled",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.telegram", {
        kinds: ["channel"],
        entrypoints: { channel: "./dist/channel.js" },
      }),
    }));

    expect(() => registry.remove("friday.channel.telegram")).toThrow(FridayDomainError);
  });

  it("allows removal of non-core plugin", () => {
    registry.upsert(makeInput("friday.test.alpha"));
    registry.remove("friday.test.alpha");
    expect(registry.get("friday.test.alpha")).toBeNull();
  });
});

// ─── Loader Status Validation Tests ───

describe("Loader rejects load from invalid statuses", () => {
  let db: FridaySqliteLayer;
  let registry: FridayPluginRegistryService;
  let loader: FridayPluginLoader;

  function makeModule(): FridayPluginEntrypointModule {
    return {
      activate: async () => {},
      deactivate: async () => {},
    };
  }

  beforeEach(() => {
    db = createTestDb();
    const repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });

    loader = createFridayPluginLoader({
      registry,
      nowIso: () => "2026-01-15T00:00:00.000Z",
      importModule: async () => makeModule(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("rejects load from disabled status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "disabled" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("rejects load from error status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "error" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("rejects load from uninstalled status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "uninstalled" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("rejects load from not_installed status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "not_installed" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("rejects load from running status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "running" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("rejects load from installed status (must be configured first)", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "installed" }));

    try {
      await loader.load({ order: ["friday.test.alpha"], warnings: [] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });

  it("allows load from configured status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "configured" }));

    const loaded = await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    expect(loaded).toHaveLength(1);
    const entity = registry.get("friday.test.alpha");
    expect(entity!.status).toBe("running");
  });

  it("allows load from enabled status", async () => {
    registry.upsert(makeInput("friday.test.alpha", { status: "enabled" }));

    const loaded = await loader.load({ order: ["friday.test.alpha"], warnings: [] });
    expect(loaded).toHaveLength(1);
    const entity = registry.get("friday.test.alpha");
    expect(entity!.status).toBe("running");
  });

  // ─── Unload status validation ───

  it("unload rejects plugin not in running status", async () => {
    // Load a plugin to get it in the loaded map
    registry.upsert(makeInput("friday.test.alpha", { status: "configured" }));
    await loader.load({ order: ["friday.test.alpha"], warnings: [] });

    // Manually change its status in the registry to simulate state drift
    registry.setStatus("friday.test.alpha", "disabled", "2026-01-16T00:00:00.000Z");

    try {
      await loader.unload(["friday.test.alpha"]);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe("PLUGIN_INVALID_STATUS_TRANSITION");
    }
  });
});

// ─── Multi-source Same-ID Handling ───

describe("Multi-source same-ID handling", () => {
  let db: FridaySqliteLayer;
  let repo: FridayPluginRepository;
  let registry: FridayPluginRegistryService;

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPluginRepository();
    registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: repo });
  });

  afterEach(() => {
    db.close();
  });

  it("upsert with same ID from same source overwrites", () => {
    registry.upsert(makeInput("friday.test.alpha", { source: "local", version: "1.0.0" }));
    registry.upsert(makeInput("friday.test.alpha", { source: "local", version: "2.0.0" }));

    const entity = registry.get("friday.test.alpha");
    expect(entity!.version).toBe("2.0.0");
    expect(registry.list()).toHaveLength(1);
  });

  it("resolveRuntimePlugins returns one entry per ID", () => {
    registry.upsert(makeInput("friday.test.alpha", { source: "local" }));
    registry.upsert(makeInput("friday.test.beta", { source: "marketplace" }));

    const runtime = registry.resolveRuntimePlugins();
    expect(runtime).toHaveLength(2);
    const ids = runtime.map((p) => p.id);
    expect(ids).toContain("friday.test.alpha");
    expect(ids).toContain("friday.test.beta");
  });

  it("core plugin from bundled source is returned in runtime plugins", () => {
    registry.upsert(makeInput("friday.channel.discord", {
      source: "bundled",
      kinds: ["channel"],
      manifest: makeManifest("friday.channel.discord", {
        kinds: ["channel"],
        entrypoints: { channel: "./dist/channel.js" },
      }),
    }));

    const runtime = registry.resolveRuntimePlugins();
    const discord = runtime.find((p) => p.id === "friday.channel.discord");
    expect(discord).toBeDefined();
    expect(discord!.source).toBe("bundled");
  });

  it("non-bundled core plugin registration is blocked at upsert level", () => {
    // This verifies that even if somehow multi-source rows existed,
    // the upsert guard prevents non-bundled core plugin writes
    expect(() =>
      registry.upsert(makeInput("friday.channel.discord", { source: "local" })),
    ).toThrow(FridayDomainError);

    // No plugin should exist
    expect(registry.get("friday.channel.discord")).toBeNull();
  });
});
