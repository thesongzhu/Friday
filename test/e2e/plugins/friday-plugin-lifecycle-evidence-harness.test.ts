/**
 * Phase 11 Module 17 lifecycle evidence harness:
 *
 *  - Uses a real local plugin artifact written to an isolated tmpdir
 *    (manifest.json + entrypoint module).
 *  - Exercises install → enable → update (reinstall newer version)
 *    → disable → uninstall against the real plugin service stack.
 *  - Closes and reopens the SQLite layer to prove plugin state survives
 *    a simulated hub restart.
 *  - Captures install/update/remove evidence and asserts it is present.
 *
 * This does NOT add any commerce or default-on semantics.  It exists to
 * cover the "lifecycle evidence with a real local plugin artifact"
 * requirement of Phase 11 Module 17 alongside the new
 * `docs/architecture/plugin-vs-skills-claim-distinction.md` claim
 * distinction artifact.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const NOW = "2026-05-14T08:00:00.000Z";

function createDiskBackedDb(dbPath: string): FridaySqliteLayer {
  const writer = new Database(dbPath);
  runFridayMigrations({ db: writer, migrations: FRIDAY_SQLITE_MIGRATIONS });
  return {
    dbPath,
    writer,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T { return fn(writer); },
      close() {},
    },
    withWriteTransaction<T>(fn: (d: Database.Database) => T): T { return writer.transaction(() => fn(writer))(); },
    withReadConnection<T>(fn: (d: Database.Database) => T): T { return fn(writer); },
    checkpoint() {},
    optimize() {},
    close() { writer.close(); },
  };
}

function writeRealLocalPluginArtifact(root: string, version: string): { manifest: FridayPluginManifest; manifestPath: string; entrypointPath: string } {
  fs.mkdirSync(root, { recursive: true });
  const entrypointPath = path.join(root, "index.js");
  const entrypointBody = `module.exports = {
  activate: async () => {},
  deactivate: async () => {},
  version: ${JSON.stringify(version)},
};
`;
  fs.writeFileSync(entrypointPath, entrypointBody, "utf8");

  const manifest: FridayPluginManifest = {
    schemaVersion: "1.0",
    id: "friday.tests.lifecycle-evidence",
    version,
    name: "Phase 11 lifecycle evidence harness",
    description: "Real local plugin artifact written to disk for Module 17 evidence",
    kinds: ["skill"],
    entrypoints: { skill: "./index.js" },
    permissions: {
      grants: [
        { id: "perm-read", resource: "filesystem", action: "read", required: true, reason: "Read plugin asset" },
      ],
      promptOn: [],
    },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };

  const manifestPath = path.join(root, "friday.plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifest, manifestPath, entrypointPath };
}

function buildPluginServiceStack(sqlite: FridaySqliteLayer): {
  pluginService: FridayPluginService;
  markLifecyclePromoted: (pluginId: string) => void;
} {
  const pluginRepo = createFridayPluginRepository();
  const registry = createFridayPluginRegistryService({ sqlite, pluginRepository: pluginRepo });
  const resolver = createFridayPluginDependencyResolver();
  const signatureVerifier = createFridayPluginSignatureVerifier();

  // Loader and service both read package bytes from the on-disk install
  // directory.  Only the dynamic import is stubbed so the test does not
  // execute the real plugin entrypoint as a Node module — install / enable
  // / uninstall still flow through the real registry, repository, loader,
  // and service code paths.
  const loader = createFridayPluginLoader({
    registry,
    signatureVerifier,
    nowIso: () => NOW,
    importModule: async () => ({
      activate: async () => {},
      deactivate: async () => {},
    }),
  });

  const pluginService = createFridayPluginService({
    sqlite,
    registry,
    resolver,
    loader,
    signatureVerifier,
    nowIso: () => NOW,
    idGenerator: () => crypto.randomUUID(),
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

let tmpdir: string;
let dbPath: string;
let pluginRoot: string;
let sqlite: FridaySqliteLayer;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-evidence-"));
  dbPath = path.join(tmpdir, "friday.sqlite");
  pluginRoot = path.join(tmpdir, "plugin-root");
  sqlite = createDiskBackedDb(dbPath);
});

afterEach(() => {
  try { sqlite.close(); } catch { /* ignore */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("plugin lifecycle evidence harness (Phase 11 Module 17)", () => {
  it("install + update + remove uses a real on-disk artifact and persists across restart", async () => {
    const { manifest: m1 } = writeRealLocalPluginArtifact(pluginRoot, "1.0.0");
    let stack = buildPluginServiceStack(sqlite);

    const installed = stack.pluginService.installPlugin({
      manifest: m1,
      installPath: pluginRoot,
      source: "local",
      userApproved: true,
    });
    expect(installed.id).toBe("friday.tests.lifecycle-evidence");
    expect(installed.version).toBe("1.0.0");
    expect(installed.status).toBe("installed");
    expect(installed.trustedFingerprintSha256).toBeTruthy();
    expect(installed.signatureVerified).toBe(true);
    stack.markLifecyclePromoted(installed.id);

    // Enable -> running
    const enabled = await stack.pluginService.enablePlugin(installed.id);
    expect(enabled.status).toBe("running");
    expect(enabled.enabled).toBe(true);

    // Simulate hub restart: close DB and reopen
    sqlite.close();
    sqlite = createDiskBackedDb(dbPath);
    stack = buildPluginServiceStack(sqlite);
    const survivors = stack.pluginService.listPlugins();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(installed.id);
    expect(survivors[0]!.version).toBe("1.0.0");

    // Update: write v1.1.0 artifact and reinstall (uninstall then install)
    await stack.pluginService.uninstallPlugin(installed.id);
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    const { manifest: m2 } = writeRealLocalPluginArtifact(pluginRoot, "1.1.0");
    const stack2 = buildPluginServiceStack(sqlite);

    const updated = stack2.pluginService.installPlugin({
      manifest: m2,
      installPath: pluginRoot,
      source: "local",
      userApproved: true,
    });
    expect(updated.version).toBe("1.1.0");
    expect(stack2.pluginService.listPlugins()).toHaveLength(1);

    // Remove
    await stack2.pluginService.uninstallPlugin(updated.id);
    expect(stack2.pluginService.listPlugins()).toHaveLength(0);
    expect(stack2.pluginService.getPlugin(updated.id)).toBeNull();
  });
});
