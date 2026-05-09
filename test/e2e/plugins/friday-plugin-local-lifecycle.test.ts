/**
 * E2E: Local plugin install → enable → disable → uninstall lifecycle
 * at the service layer (no HTTP). Exercises createFridayPluginService
 * with real SQLite + real registry/loader/resolver/signature verifier.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";

import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import type { FridaySqliteLayer } from "#state";
import type { FridayPluginManifest } from "#plugins";
import {
  createFridayPluginRepository,
  createFridayPluginRegistryService,
  createFridayPluginDependencyResolver,
  createFridayPluginLoader,
  createFridayPluginSignatureVerifier,
  createFridayPluginService,
} from "#plugins";
import type { FridayPluginService } from "#plugins";

// ─── In-memory DB helper ───

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  };
}

// ─── Valid minimal manifest ───

function makeTestManifest(overrides?: Partial<FridayPluginManifest>): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id: "test.plugin.hello",
    version: "1.0.0",
    name: "Hello Plugin",
    description: "A test plugin",
    kinds: ["skill"],
    entrypoints: { skill: "./index.js" },
    permissions: {
      grants: [
        {
          id: "perm-read",
          resource: "filesystem",
          action: "read",
          required: true,
          reason: "Read files",
        },
      ],
      promptOn: [],
    },
    compatibility: {
      minHubVersion: "0.1.0",
      apiVersion: "1",
    },
    ...overrides,
  };
}

// ─── Build service stack ───

function buildPluginServiceStack(
  sqlite: FridaySqliteLayer,
  opts?: {
    importModule?: (path: string) => Promise<{ activate?: () => Promise<void>; deactivate?: () => Promise<void> }>;
  },
): {
  pluginService: FridayPluginService;
  markLifecyclePromoted: (pluginId: string) => void;
} {
  const pluginRepo = createFridayPluginRepository();
  const registry = createFridayPluginRegistryService({ sqlite, pluginRepository: pluginRepo });
  const resolver = createFridayPluginDependencyResolver();
  const signatureVerifier = createFridayPluginSignatureVerifier();
  const stubbedFileBytes = Buffer.from("test-file-content");
  const packageBytes = Buffer.concat([stubbedFileBytes, stubbedFileBytes]);

  // Stub loader — load() and unload() resolve without side effects.
  // importModule is overridable to test load-failure paths.
  const loader = createFridayPluginLoader({
    registry,
    signatureVerifier,
    nowIso: () => NOW,
    readPackageBytes: () => packageBytes,
    importModule: opts?.importModule ?? (async () => ({
      activate: async () => {},
      deactivate: async () => {},
    })),
  });

  // readFileAsBuffer is intentionally stubbed to a constant buffer.
  // This is a service-layer test, not a filesystem integration test.
  // The stub isolates the plugin service logic from actual disk I/O,
  // while still producing valid SHA-256 fingerprints for trust-on-install.
  const pluginService = createFridayPluginService({
    sqlite,
    registry,
    resolver,
    loader,
    signatureVerifier,
    nowIso: () => NOW,
    idGenerator: () => crypto.randomUUID(),
    readFileAsBuffer: () => stubbedFileBytes,
  });

  return {
    pluginService,
    markLifecyclePromoted(pluginId: string) {
      sqlite.withWriteTransaction((db) => {
        pluginRepo.setUpgradeMetadata(db, pluginId, {
          compatibilityStatus: "compatible",
          promotionChannel: "active",
          shadowVersionId: `${pluginId}@shadow`,
        }, NOW);
      });
    },
  };
}

const NOW = "2025-06-15T10:00:00.000Z";

// ─── Tests ───

describe("Plugin local lifecycle (service layer)", () => {
  let sqlite: FridaySqliteLayer;
  let pluginService: FridayPluginService;
  let markLifecyclePromoted: (pluginId: string) => void;

  beforeEach(() => {
    sqlite = createTestDb();
    ({ pluginService, markLifecyclePromoted } = buildPluginServiceStack(sqlite));
  });

  afterEach(() => {
    sqlite.close();
  });

  it("install_local_plugin_from_manifest", () => {
    const manifest = makeTestManifest();

    const entity = pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });

    expect(entity.id).toBe("test.plugin.hello");
    expect(entity.version).toBe("1.0.0");
    expect(entity.status).toBe("installed");
    expect(entity.source).toBe("local");
    expect(entity.enabled).toBe(false);
    expect(entity.trustMode).toBe("trust_on_install");

    // Confirm it's in the list
    const list = pluginService.listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("test.plugin.hello");
  });

  it("enable_sets_running_status", async () => {
    const manifest = makeTestManifest();
    pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });
    markLifecyclePromoted("test.plugin.hello");

    const enabled = await pluginService.enablePlugin("test.plugin.hello");

    // The loader mock transitions: enabled → running via load()
    expect(enabled.status).toBe("running");
    expect(enabled.enabled).toBe(true);
  });

  it("disable_sets_disabled_status", async () => {
    const manifest = makeTestManifest();
    pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });
    markLifecyclePromoted("test.plugin.hello");

    await pluginService.enablePlugin("test.plugin.hello");
    const disabled = await pluginService.disablePlugin("test.plugin.hello");

    expect(disabled.status).toBe("disabled");
    expect(disabled.enabled).toBe(false);
  });

  it("uninstall_removes_plugin", async () => {
    const manifest = makeTestManifest();
    pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });

    await pluginService.uninstallPlugin("test.plugin.hello");

    const list = pluginService.listPlugins();
    expect(list).toHaveLength(0);

    const found = pluginService.getPlugin("test.plugin.hello");
    expect(found).toBeNull();
  });

  it("core_plugin_uninstall_forbidden", async () => {
    // Core plugins are "friday.channel.discord" / "friday.channel.telegram".
    // They can only be registered from "bundled" source, so we can't install
    // one as "local". The service calls assertNotCorePlugin BEFORE requirePlugin,
    // so it throws CORE_PLUGIN_PROTECTED even if the plugin doesn't exist in DB.
    await expect(
      pluginService.uninstallPlugin("friday.channel.discord"),
    ).rejects.toThrow("Cannot modify core plugin");
  });

  it("install_records_trust_fingerprint", () => {
    const manifest = makeTestManifest();

    const entity = pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });

    // For local plugins, trust-on-install computes a SHA-256 fingerprint
    expect(entity.trustedFingerprintSha256).toBeTruthy();
    expect(typeof entity.trustedFingerprintSha256).toBe("string");
    // SHA-256 hex strings are 64 chars
    expect(entity.trustedFingerprintSha256).toHaveLength(64);
    expect(entity.signatureVerified).toBe(true);
    expect(entity.trustMode).toBe("trust_on_install");
  });

  it("import_module_failure_prevents_enable", async () => {
    // Build a stack where importModule always throws (simulates corrupt plugin JS)
    const failingSqlite = createTestDb();
    try {
      const {
        pluginService: failingService,
        markLifecyclePromoted: markBrokenLifecyclePromoted,
      } = buildPluginServiceStack(failingSqlite, {
        importModule: async () => {
          throw new Error("SyntaxError: Unexpected token");
        },
      });

      const manifest = makeTestManifest({ id: "test.plugin.broken" });
      failingService.installPlugin({
        manifest,
        installPath: "/tmp/broken-plugin",
        source: "local",
        userApproved: true,
      });
      markBrokenLifecyclePromoted("test.plugin.broken");

      // Enabling should fail because importModule throws during load
      await expect(
        failingService.enablePlugin("test.plugin.broken"),
      ).rejects.toThrow(/SyntaxError|load|failed/i);
    } finally {
      failingSqlite.close();
    }
  });

  it("install_duplicate_plugin_rejected", () => {
    // Installing the same plugin twice should fail with ALREADY_INSTALLED
    const manifest = makeTestManifest();
    pluginService.installPlugin({
      manifest,
      installPath: "/tmp/test-plugin",
      source: "local",
      userApproved: true,
    });

    expect(() =>
      pluginService.installPlugin({
        manifest,
        installPath: "/tmp/test-plugin-dup",
        source: "local",
        userApproved: true,
      }),
    ).toThrow(/already installed/i);
  });
});
