/**
 * E2E: Marketplace plugin lifecycle with mocked network.
 *
 * Tests search, download+install, checksum validation, and signature
 * rejection flows through the full service stack with in-memory SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
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
import type {
  FridayPluginService,
  FridayPluginMarketplaceClient,
  FridayMarketplaceSearchResult,
  FridayMarketplacePluginDetail,
  FridayMarketplaceDownloadResult,
} from "#plugins";

// ─── In-memory DB ───

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
    close() {
      db.close();
    },
  };
}

// ─── Manifest factory ───

const PACKAGE_BYTES = Buffer.from("marketplace-plugin-package-bytes");

function makeMarketplaceManifest(
  overrides?: Partial<FridayPluginManifest>,
): FridayPluginManifest {
  return {
    schemaVersion: "1.0",
    id: "test.marketplace.weather",
    version: "2.0.0",
    name: "Weather Plugin",
    description: "A marketplace weather plugin",
    kinds: ["skill"],
    entrypoints: { skill: "./index.js" },
    permissions: {
      grants: [
        {
          id: "net-connect",
          resource: "network",
          action: "connect",
          required: true,
          reason: "Fetch weather data",
        },
      ],
      promptOn: ["network.connect"],
    },
    compatibility: {
      minHubVersion: "0.1.0",
      apiVersion: "1",
    },
    signature: {
      algorithm: "ed25519",
      keyId: "test-key-001",
      value: "dGVzdC1zaWduYXR1cmUtdmFsdWU=", // base64 placeholder
    },
    ...overrides,
  };
}

// ─── Compute the real checksum for PACKAGE_BYTES using the same logic ───

function realChecksum(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const NOW = "2025-06-15T10:00:00.000Z";

// ─── Build full service stack with mock marketplace ───

interface TestStack {
  pluginService: FridayPluginService;
  sqlite: FridaySqliteLayer;
}

function buildStack(opts: {
  marketplaceClient: FridayPluginMarketplaceClient;
  verifyEd25519?: (publicKeyPem: string, sigValue: Buffer, payload: Buffer) => boolean;
}): TestStack {
  const sqlite = createTestDb();
  const pluginRepo = createFridayPluginRepository();
  const registry = createFridayPluginRegistryService({ sqlite, pluginRepository: pluginRepo });
  const resolver = createFridayPluginDependencyResolver();

  const signatureVerifier = createFridayPluginSignatureVerifier({
    // When verifyEd25519 is provided, use it (e.g., () => false for rejection tests).
    // When omitted, fall through to the production Ed25519 verifier (real crypto).
    ...(opts.verifyEd25519 ? { verifyEd25519: opts.verifyEd25519 } : {}),
  });

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
    marketplace: opts.marketplaceClient,
    signatureVerifier,
    nowIso: () => NOW,
    idGenerator: () => crypto.randomUUID(),
  });

  return { pluginService, sqlite };
}

// ─── Tests ───

describe("Plugin marketplace lifecycle (mocked network)", () => {
  let sqlite: FridaySqliteLayer;

  afterEach(() => {
    sqlite?.close();
  });

  it("search_marketplace_returns_results", async () => {
    const searchResult: FridayMarketplaceSearchResult = {
      items: [
        {
          id: "test.marketplace.weather",
          name: "Weather Plugin",
          description: "A weather plugin",
          version: "2.0.0",
          author: "friday-team",
          downloads: 1234,
          updatedAt: NOW,
        },
      ],
      total: 1,
    };

    const mockClient: FridayPluginMarketplaceClient = {
      search: async () => searchResult,
      getPluginDetail: async () => {
        throw new Error("not called");
      },
      listVersions: async () => [],
      downloadPackage: async () => {
        throw new Error("not called");
      },
    };

    const stack = buildStack({ marketplaceClient: mockClient });
    sqlite = stack.sqlite;

    const result = await stack.pluginService.searchMarketplace({ query: "weather" });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("test.marketplace.weather");
    expect(result.items[0]!.name).toBe("Weather Plugin");
  });

  it("download_and_install_marketplace_plugin", async () => {
    // Generate a real Ed25519 key pair for signature verification
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const checksum = realChecksum(PACKAGE_BYTES);

    // Build the canonical signing payload:
    //   "friday-plugin-signature-v1\n{pluginId}\n{version}\n{checksum}"
    const pluginId = "test.marketplace.weather";
    const version = "2.0.0";
    const signingPayload = Buffer.from(
      `friday-plugin-signature-v1\n${pluginId}\n${version}\n${checksum}`,
    );
    const sigBytes = sign(null, signingPayload, privateKey);
    const sigBase64 = sigBytes.toString("base64");

    // Use the real signature in the manifest
    const manifest = makeMarketplaceManifest({
      signature: {
        algorithm: "ed25519",
        keyId: publicKeyPem, // verifyMarketplacePackage passes keyId as publicKeyPem
        value: sigBase64,
      },
    });

    const mockClient: FridayPluginMarketplaceClient = {
      search: async () => ({ items: [], total: 0 }),
      getPluginDetail: async () =>
        ({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          author: "test",
          downloads: 0,
          manifest,
          checksum,
          packageUrl: "https://marketplace.test/packages/weather.tar.gz",
          updatedAt: NOW,
        }) satisfies FridayMarketplacePluginDetail,
      listVersions: async () => [],
      downloadPackage: async () =>
        ({
          packageBytes: PACKAGE_BYTES,
          checksum,
          manifest,
        }) satisfies FridayMarketplaceDownloadResult,
    };

    // Use real Ed25519 verification (no override — default uses node:crypto verify)
    const stack = buildStack({ marketplaceClient: mockClient });
    sqlite = stack.sqlite;

    const entity = await stack.pluginService.installFromMarketplace("test.marketplace.weather");

    expect(entity.id).toBe("test.marketplace.weather");
    expect(entity.version).toBe("2.0.0");
    expect(entity.source).toBe("marketplace");
    expect(entity.status).toBe("installed");
    expect(entity.trustMode).toBe("signed");
    expect(entity.signatureVerified).toBe(true);
    expect(entity.signatureKeyId).toBe(publicKeyPem);
  });

  it("checksum_mismatch_rejected", async () => {
    const manifest = makeMarketplaceManifest();
    // Return a checksum that doesn't match PACKAGE_BYTES
    const wrongChecksum = "0000000000000000000000000000000000000000000000000000000000000000";

    const mockClient: FridayPluginMarketplaceClient = {
      search: async () => ({ items: [], total: 0 }),
      getPluginDetail: async () =>
        ({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          author: "test",
          downloads: 0,
          manifest,
          checksum: wrongChecksum,
          packageUrl: "https://marketplace.test/packages/weather.tar.gz",
          updatedAt: NOW,
        }) satisfies FridayMarketplacePluginDetail,
      listVersions: async () => [],
      downloadPackage: async () =>
        ({
          packageBytes: PACKAGE_BYTES,
          checksum: wrongChecksum,
          manifest,
        }) satisfies FridayMarketplaceDownloadResult,
    };

    const stack = buildStack({ marketplaceClient: mockClient });
    sqlite = stack.sqlite;

    await expect(
      stack.pluginService.installFromMarketplace("test.marketplace.weather"),
    ).rejects.toThrow("Checksum mismatch");
  });

  it("invalid_signature_rejected", async () => {
    const manifest = makeMarketplaceManifest();
    const checksum = realChecksum(PACKAGE_BYTES);

    const mockClient: FridayPluginMarketplaceClient = {
      search: async () => ({ items: [], total: 0 }),
      getPluginDetail: async () =>
        ({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          author: "test",
          downloads: 0,
          manifest,
          checksum,
          packageUrl: "https://marketplace.test/packages/weather.tar.gz",
          updatedAt: NOW,
        }) satisfies FridayMarketplacePluginDetail,
      listVersions: async () => [],
      downloadPackage: async () =>
        ({
          packageBytes: PACKAGE_BYTES,
          checksum,
          manifest,
        }) satisfies FridayMarketplaceDownloadResult,
    };

    // Ed25519 verification always returns false → invalid signature
    const stack = buildStack({
      marketplaceClient: mockClient,
      verifyEd25519: () => false,
    });
    sqlite = stack.sqlite;

    await expect(
      stack.pluginService.installFromMarketplace("test.marketplace.weather"),
    ).rejects.toThrow("signature verification failed");
  });
});
