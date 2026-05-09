import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime, type CreateFridayApiRuntimeDeps } from "#api";
import type { FridayProviderService } from "#providers";
import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations, type FridaySqliteLayer } from "#state";
import {
  createFridayPluginDependencyResolver,
  createFridayPluginLoader,
  createFridayPluginRepository,
  createFridayPluginRegistryService,
  createFridayPluginService,
  createFridayPluginSignatureVerifier,
  type FridayPluginManifest,
  type FridayPluginService,
} from "#plugins";

const NOW = "2026-05-07T23:00:00.000Z";

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

function createProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "provider-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: {
        id: "provider-1",
        kind: "openai" as const,
        name: "Provider",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: "openai-completions" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-4o"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function createManifest(pluginId: string): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id: pluginId,
    version: "1.0.0",
    name: "Review Enable Plugin",
    description: "Plugin fixture for runtime review-enable.",
    kinds: ["skill"],
    entrypoints: { skill: "./dist/index.mjs" },
    permissions: { grants: [], promptOn: [] },
    compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
  };
}

function createPluginService(db: FridaySqliteLayer): FridayPluginService {
  const pluginRepo = createFridayPluginRepository();
  const registry = createFridayPluginRegistryService({ sqlite: db, pluginRepository: pluginRepo });
  const signatureVerifier = createFridayPluginSignatureVerifier();
  const loader = createFridayPluginLoader({
    registry,
    signatureVerifier,
    nowIso: () => NOW,
    readPackageBytes: () => Buffer.from("plugin-review-enable-package"),
    importModule: async () => ({
      activate: async () => {},
      deactivate: async () => {},
    }),
  });
  return createFridayPluginService({
    sqlite: db,
    registry,
    resolver: createFridayPluginDependencyResolver(),
    loader,
    signatureVerifier,
    nowIso: () => NOW,
    idGenerator: () => "plugin-id-1",
    readFileAsBuffer: () => Buffer.from("plugin-review-enable-package"),
  });
}

function createRuntimeDeps(input: {
  db: FridaySqliteLayer;
  stateDir: string;
  pluginService: FridayPluginService;
}): CreateFridayApiRuntimeDeps {
  return {
    db: input.db,
    stateDir: input.stateDir,
    idGenerator: (() => {
      let counter = 0;
      return () => `runtime-id-${String(++counter)}`;
    })(),
    nowIso: () => NOW,
    providerService: createProviderService(),
    tokenSecret: "runtime-plugin-review-enable-secret", // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    pluginService: input.pluginService,
    serverVersion: "runtime-v1",
  };
}

describe("createFridayApiRuntime plugin review-enable lifecycle", () => {
  let db: FridaySqliteLayer | undefined;
  let stateDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("server-side signs canonical parent and child approvals before promoting a local plugin", async () => {
    db = createTestDb();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-review-enable-"));
    const pluginService = createPluginService(db);
    const pluginId = "friday.test.review-enable";
    pluginService.installPlugin({
      manifest: createManifest(pluginId),
      installPath: "/tmp/friday-test-review-enable-plugin",
      source: "local",
      userApproved: true,
      packageBytes: Buffer.from("plugin-review-enable-package"),
    });

    await expect(pluginService.enablePlugin(pluginId)).rejects.toMatchObject({
      code: "PLUGIN_LIFECYCLE_PROMOTION_REQUIRED",
    });

    const runtime = createFridayApiRuntime(createRuntimeDeps({ db, stateDir, pluginService }));
    const route = runtime.routes.getRoutes().find(
      (entry) => entry.operationId === "autonomy.plugins.review.enable",
    );
    expect(route).toBeDefined();

    const result = await route!.handler({
      requestId: "req-1",
      receivedAt: NOW,
      params: { pluginId },
      query: {},
      body: { providerModel: "model-v1" },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "admin-001",
        userId: "admin-001",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "token-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    });

    expect(result).toMatchObject({
      plugin: {
        id: pluginId,
        status: "running",
        enabled: true,
        promotionChannel: "active",
        compatibilityStatus: "compatible",
      },
      evidence: {
        stage: "active",
        canarySuccessCount: 1,
        canaryFailureCount: 0,
        rollbackPointerAvailable: true,
        parentLifecycleTicketId: expect.stringMatching(/^runtime-id-/),
      },
    });
    const evidenceFile = path.join(stateDir, "plugin-lifecycle", `${pluginId}.json`);
    const lifecycleEvidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8")) as {
      shadow?: { parentLifecycleTicketId?: string };
      canaryRuns?: Array<{ parentLifecycleTicketId?: string }>;
      promotion?: { parentLifecycleTicketId?: string };
    };
    const parentLifecycleTicketId = lifecycleEvidence.shadow?.parentLifecycleTicketId;
    expect(parentLifecycleTicketId).toMatch(/^runtime-id-/);
    expect(lifecycleEvidence.canaryRuns?.[0]?.parentLifecycleTicketId).toBe(parentLifecycleTicketId);
    expect(lifecycleEvidence.promotion?.parentLifecycleTicketId).toBe(parentLifecycleTicketId);
    expect(pluginService.getPlugin(pluginId)).toMatchObject({
      status: "running",
      enabled: true,
      promotionChannel: "active",
      compatibilityStatus: "compatible",
    });
  });
});
