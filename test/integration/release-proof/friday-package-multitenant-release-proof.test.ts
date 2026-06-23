import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import { createFridayPackagingRoutes } from "../../../src/api/http/routes/friday-packaging-routes.js";
import type { FridayPackagingRoutesDeps } from "../../../src/api/http/routes/friday-packaging-routes.js";
import { createFridayMultiTenantSecurityRoutes } from "../../../src/api/http/routes/friday-multi-tenant-security-routes.js";
import type { FridayMultiTenantSecurityRoutesDeps } from "../../../src/api/http/routes/friday-multi-tenant-security-routes.js";
import type {
  FridayHttpContext,
  FridayRouteDefinition,
} from "../../../src/api/model/friday-api-common.types.js";
import type { FridayAuthPrincipal } from "../../../src/api/model/friday-api-auth.types.js";
import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import { createFridayPackagingApiHandlers } from "../../../src/packaging/api/index.js";
import {
  computeFridayPackageArchiveDigest,
  computeFridayPackageManifestDigest,
  decodeFridayPackageArchiveEnvelope,
} from "../../../src/packaging/engine/package-archive-envelope.js";
import { verifySignatureLogical } from "../../../src/packaging/engine/package-validator.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
} from "../../../src/packaging/model/friday-packaging.types.js";
import {
  createSqlitePackageInstaller,
  createSqliteRegistryManager,
  createSqliteTrustedKeyStore,
} from "../../../src/packaging/persistence/friday-package-sqlite-store.js";
import {
  AuditLogger,
  FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
  TenantManager,
  TenantScopedResourceRegistry,
} from "../../../src/security/multi-tenant/engine/index.js";
import { MIGRATION_ACTOR } from "../../../src/security/multi-tenant/engine/tenant-manager.js";
import {
  createSqliteAuditPersistence,
  createSqliteTenantPersistence,
  createSqliteTenantScopedResourcePersistence,
} from "../../../src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js";

const NOW = "2026-05-27T00:00:00.000Z";
const PLATFORM_VERSION = "1.0.2";
const TEST_ADMIN_PRINCIPAL: FridayAuthPrincipal = {
  principalType: "user",
  principalId: "user:release-proof-admin",
  tenantId: "22222222-2222-4222-8222-222222222222",
  userId: "11111111-1111-4111-8111-111111111111",
  role: "admin",
  scopes: ["hub.admin", "security.write"],
  tokenId: "33333333-3333-4333-8333-333333333333",
  tokenKind: "access",
  issuedAt: NOW,
};

function makeCtx<TParams = unknown, TQuery = unknown, TBody = unknown>(
  overrides: Partial<FridayHttpContext<TParams, TQuery, TBody>> = {},
): FridayHttpContext<TParams, TQuery, TBody> {
  return {
    requestId: "req-release-proof",
    receivedAt: NOW,
    params: {} as TParams,
    query: {} as TQuery,
    body: null as TBody,
    headers: {},
    principal: TEST_ADMIN_PRINCIPAL,
    ...overrides,
  };
}

function findRoute(
  routes: readonly FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
): FridayRouteDefinition<unknown, unknown, unknown, unknown> {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (!route) throw new Error(`missing route ${operationId}`);
  return route;
}

async function callRoute(
  routes: readonly FridayRouteDefinition<unknown, unknown, unknown, unknown>[],
  operationId: string,
  ctx: Partial<FridayHttpContext<unknown, unknown, unknown>>,
): Promise<any> {
  return findRoute(routes, operationId).handler(makeCtx(ctx));
}

function buildLayer(dbPath: string): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
}

function manifest(version: string): FridayPackageManifest {
  return {
    name: "@friday/release-proof-package",
    version,
    description: "FRI-AUD-015 package roundtrip release proof",
    author: { name: "Friday Release Proof" },
    capabilities: ["skill:release-proof"],
    dependencies: {},
    fridayVersionRange: ">=0.0.0",
    assets: {},
  };
}

function signaturePayload(archiveDigest: string, manifestDigest: string): Buffer {
  return Buffer.from(JSON.stringify({ digest: archiveDigest, manifestDigest }), "utf8");
}

function makeKeyMaterial(): {
  publicKeyBase64: string;
  privateKey: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey,
  };
}

function buildArchive(input: {
  manifest: FridayPackageManifest;
  files: Record<string, string>;
  keyId: string;
  publicKeyBase64: string;
  privateKey: crypto.KeyObject;
  signatureOverride?: Partial<FridayPackageSignature>;
}): { archive: string; signature: FridayPackageSignature; manifestDigest: string; archiveDigest: string } {
  const manifestDigest = computeFridayPackageManifestDigest(input.manifest);
  const archiveDigest = computeFridayPackageArchiveDigest({
    manifest: input.manifest,
    files: input.files,
  });
  const signatureBytes = crypto.sign(
    null,
    signaturePayload(archiveDigest, manifestDigest),
    input.privateKey,
  );
  const signature: FridayPackageSignature = {
    algorithm: "Ed25519",
    publicKey: input.publicKeyBase64,
    signature: signatureBytes.toString("base64"),
    digest: archiveDigest,
    manifestDigest,
    timestamp: NOW,
    expiresAt: "2027-05-27T00:00:00.000Z",
    keyId: input.keyId,
    ...input.signatureOverride,
  };
  return {
    archive: Buffer.from(JSON.stringify({
      manifest: input.manifest,
      files: input.files,
      signature,
    }), "utf8").toString("base64"),
    signature,
    manifestDigest,
    archiveDigest,
  };
}

function buildPackagingRoutes(layer: FridaySqliteLayer): ReturnType<typeof createFridayPackagingRoutes> {
  let idCounter = 0;
  const nextId = () => {
    idCounter += 1;
    return `release-proof-id-${idCounter}`;
  };
  const registry = createSqliteRegistryManager({
    sqlite: layer,
    generateId: nextId,
    nowIso: () => NOW,
  });
  const trustedKeyStore = createSqliteTrustedKeyStore({
    sqlite: layer,
    generateId: nextId,
    nowIso: () => NOW,
  });
  const installer = createSqlitePackageInstaller({
    sqlite: layer,
    registry,
    generateId: nextId,
    nowIso: () => NOW,
    verifyPackage: (ctx) => verifySignatureLogical(
      ctx.entry.signature,
      ctx.entry.manifestDigest,
      ctx.entry.archiveDigest,
      trustedKeyStore.listAll(),
      ctx.verifiedAt,
    ),
  });
  const apiHandlers = createFridayPackagingApiHandlers({
    registry,
    installer,
    principalId: "release-proof",
    platformVersion: PLATFORM_VERSION,
  });

  const deps: FridayPackagingRoutesDeps = {
    allowTestOnlyPackagingMutationExecution: true,
    packages: {
      publish(req) {
        const envelope = decodeFridayPackageArchiveEnvelope(req.archive);
        const verification = verifySignatureLogical(
          envelope.signature,
          envelope.manifestDigest,
          envelope.archiveDigest,
          trustedKeyStore.listAll(),
          NOW,
        );
        if (!verification.valid) {
          throw new FridayDomainError(`PACKAGING_${verification.outcome.toUpperCase()}`, verification.message, { httpStatus: 400 });
        }
        return {
          package: registry.publish({
            manifest: envelope.manifest,
            signature: envelope.signature,
            archiveDigest: envelope.archiveDigest,
            manifestDigest: envelope.manifestDigest,
            sizeBytes: envelope.archiveSizeBytes,
            publishedBy: "release-proof",
            tenantId: req.tenantId,
          }) as any,
          verification,
        };
      },
      list(query) {
        const page = registry.search(
          { tenantId: query.tenantId, name: query.name, capability: query.capability, keyword: query.keyword, author: query.author, sortBy: query.sortBy, sortDir: query.sortDir },
          { cursor: query.cursor, limit: query.limit },
        );
        return { items: page.items as any, nextCursor: page.nextCursor };
      },
      get(packageId) {
        const entry = registry.getById(packageId);
        if (!entry) throw new FridayDomainError("NOT_FOUND", `Package "${packageId}" not found`);
        return { package: entry as any, signature: entry.signature as any, versionCount: registry.getVersionCount(entry.name, entry.tenantId) };
      },
      listVersions(packageName, query) {
        const versions = registry.getVersions(packageName, query.tenantId);
        return { items: versions.slice(0, query.limit ?? 20) as any, nextCursor: undefined };
      },
      verify(packageId) {
        const entry = registry.getById(packageId);
        if (!entry) throw new FridayDomainError("NOT_FOUND", `Package "${packageId}" not found`);
        return {
          package: entry as any,
          verification: verifySignatureLogical(
            entry.signature,
            entry.manifestDigest,
            entry.archiveDigest,
            trustedKeyStore.listAll(),
            NOW,
          ),
        };
      },
      checkDependencies: (packageName, req) => apiHandlers.checkDependencies(packageName, req),
    },
    installs: {
      install: (packageName, req) => apiHandlers.installPackage(packageName, req),
      upgrade: (packageName, req) => apiHandlers.upgradePackage(packageName, req),
      rollback: (packageName, req) => apiHandlers.rollbackPackage(packageName, req),
      uninstall: (packageName, req) => apiHandlers.uninstallPackage(packageName, req),
      list: (query) => apiHandlers.listInstalls(query),
      get: (installId) => apiHandlers.getInstall(installId),
    },
    lifecycle: {
      list: (query) => apiHandlers.listLifecycleEvents(query),
    },
    keys: {
      list(query) {
        const page = trustedKeyStore.list(query);
        return { items: page.items as any, nextCursor: page.nextCursor };
      },
      add(req) {
        return { key: trustedKeyStore.add(req) as any };
      },
      revoke(keyId, req) {
        const key = trustedKeyStore.revoke(keyId, req.reason);
        if (!key) throw new FridayDomainError("NOT_FOUND", `Key "${keyId}" not found`);
        return { key: key as any, affectedInstalls: 0 };
      },
      rotate(keyId, req) {
        const rotated = trustedKeyStore.rotate({
          oldKeyId: keyId,
          newKeyId: req.newKeyId,
          newPublicKey: req.newPublicKey,
          owner: req.owner,
          expiresAt: req.expiresAt,
        });
        return {
          newKey: rotated.newKey as any,
          oldKey: rotated.oldKey as any,
          gracePeriodEndsAt: rotated.gracePeriodEndsAt,
        };
      },
    },
  };

  return createFridayPackagingRoutes(deps);
}

function buildScopedResourceRoutes(layer: FridaySqliteLayer): {
  routes: ReturnType<typeof createFridayMultiTenantSecurityRoutes>;
  tenantManager: TenantManager;
} {
  const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
  const tenantManager = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
  const registry = new TenantScopedResourceRegistry(audit, {
    persistence: createSqliteTenantScopedResourcePersistence(layer),
  });
  const deps: FridayMultiTenantSecurityRoutesDeps = {
    tenants: {
      create: (req) => ({ tenant: tenantManager.createTenant(req as never, MIGRATION_ACTOR) }) as never,
      list: () => ({ items: tenantManager.listTenants(MIGRATION_ACTOR) }) as never,
      get: (tenantId) => ({ tenant: tenantManager.getTenant(tenantId, MIGRATION_ACTOR) }) as never,
      update: () => ({}) as never,
      delete: () => ({}) as never,
    },
    workspaces: { create: () => ({}) as never, list: () => ({ items: [] }) as never, get: () => ({}) as never, update: () => ({}) as never, delete: () => ({}) as never },
    members: { add: () => ({}) as never, list: () => ({ items: [] }) as never, revoke: () => ({}) as never },
    roles: { create: () => ({}) as never, list: () => ({ items: [] }) as never, get: () => ({}) as never, update: () => ({}) as never, delete: () => ({}) as never },
    assignments: { grant: () => ({}) as never, list: () => ({ items: [] }) as never, revoke: () => ({}) as never },
    secrets: { create: () => ({}) as never, list: () => ({ items: [] }) as never, get: () => ({}) as never, update: () => ({}) as never, delete: () => ({}) as never, rotate: () => ({}) as never, listAccessLog: () => ({ items: [] }) as never },
    policies: { create: () => ({}) as never, list: () => ({ items: [] }) as never, get: () => ({}) as never, update: () => ({}) as never, delete: () => ({}) as never, evaluate: () => ({}) as never },
    audit: { list: (tenantId, query) => ({ items: audit.queryAuditLog({ tenantId, ...(query as never) }) }) as never },
    violations: { list: () => ({ items: [] }) as never, resolve: () => ({}) as never },
    scopedResources: {
      register: (tenantId, req) => ({
        record: registry.register({
          tenantId,
          resourceKind: req.resourceKind,
          resourceId: req.resourceId,
          workspaceId: req.workspaceId,
          resourceLabel: req.resourceLabel,
        }),
      }),
      list: (tenantId, query) => ({ items: registry.listForTenant(tenantId, query?.resourceKind) }),
      get: (tenantId, resourceKind, resourceId) => {
        const record = registry.getForTenant(tenantId, resourceKind, resourceId);
        if (!record) throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
        return { record };
      },
      unregister: (tenantId, resourceKind, resourceId) => {
        const record = registry.unregister(tenantId, resourceKind, resourceId);
        if (!record) throw new FridayDomainError("NOT_FOUND", "scoped resource not found");
        return { record };
      },
      status: (tenantId) => ({
        tenantId,
        activeTotal: registry.listForTenant(tenantId).length,
        totals: Object.fromEntries(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.map((kind) => [kind, 0])) as never,
        supportedKinds: FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
      }),
    },
  };
  return { tenantManager, routes: createFridayMultiTenantSecurityRoutes(deps) };
}

let tmpdir: string;
let dbPath: string;
let layer: FridaySqliteLayer;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-fri-aud-release-proof-"));
  dbPath = path.join(tmpdir, "friday.sqlite");
  layer = buildLayer(dbPath);
});

afterEach(() => {
  try { layer.close(); } catch { /* ignore */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("FRI-AUD-015/016 package and multi-tenant release proof", () => {
  it("keeps packaging disabled by default and rejects publish attempts truthfully", async () => {
    const routes = createFridayPackagingRoutes();
    await expect(callRoute(routes, "packaging.packages.publish", {
      body: { archive: "e30=", idempotencyKey: "publish-disabled" },
    })).rejects.toMatchObject({
      code: "CAPABILITY_DISABLED",
      httpStatus: 501,
    });
  });

  it("publishes a signed package through the route, upgrades, rolls back, uninstalls, denies tamper, and survives restart", async () => {
    const keys = makeKeyMaterial();
    const routes = buildPackagingRoutes(layer);

    await callRoute(routes, "packaging.keys.add", {
      body: {
        keyId: "release-proof-key",
        publicKey: keys.publicKeyBase64,
        algorithm: "Ed25519",
        owner: "Release Proof",
        idempotencyKey: "key-add-1",
      },
    });

    const v1 = buildArchive({
      manifest: manifest("1.0.0"),
      files: { "skills/release-proof.json": JSON.stringify({ version: "1.0.0" }) },
      keyId: "release-proof-key",
      publicKeyBase64: keys.publicKeyBase64,
      privateKey: keys.privateKey,
    });
    const v1WithDifferentSignatureValue = buildArchive({
      manifest: manifest("1.0.0"),
      files: { "skills/release-proof.json": JSON.stringify({ version: "1.0.0" }) },
      keyId: "release-proof-key",
      publicKeyBase64: keys.publicKeyBase64,
      privateKey: keys.privateKey,
      signatureOverride: { timestamp: "2026-05-27T00:01:00.000Z" },
    });
    expect(decodeFridayPackageArchiveEnvelope(v1.archive).archiveDigest).toBe(
      decodeFridayPackageArchiveEnvelope(v1WithDifferentSignatureValue.archive).archiveDigest,
    );

    const publishedV1 = await callRoute(routes, "packaging.packages.publish", {
      body: { archive: v1.archive, tenantId: "tenant-a", idempotencyKey: "publish-v1" },
    });
    expect(publishedV1.verification.valid).toBe(true);
    expect(publishedV1.package.archiveDigest).toBe(v1.archiveDigest);

    const tampered = Buffer.from(JSON.stringify({
      manifest: manifest("1.0.0"),
      files: { "skills/release-proof.json": JSON.stringify({ version: "tampered" }) },
      signature: v1.signature,
    }), "utf8").toString("base64");
    await expect(callRoute(routes, "packaging.packages.publish", {
      body: { archive: tampered, tenantId: "tenant-a", idempotencyKey: "publish-tampered" },
    })).rejects.toMatchObject({ code: "PACKAGING_DIGEST_MISMATCH", httpStatus: 400 });

    const install = await callRoute(routes, "packaging.installs.install", {
      params: { packageName: "@friday/release-proof-package" },
      body: { tenantId: "tenant-a", version: "1.0.0", idempotencyKey: "install-v1" },
    });
    expect(install.install.state).toBe("active");
    expect(install.verification.valid).toBe(true);

    const v2 = buildArchive({
      manifest: manifest("2.0.0"),
      files: { "skills/release-proof.json": JSON.stringify({ version: "2.0.0" }) },
      keyId: "release-proof-key",
      publicKeyBase64: keys.publicKeyBase64,
      privateKey: keys.privateKey,
    });
    await callRoute(routes, "packaging.packages.publish", {
      body: { archive: v2.archive, tenantId: "tenant-a", idempotencyKey: "publish-v2" },
    });

    const upgraded = await callRoute(routes, "packaging.installs.upgrade", {
      params: { packageName: "@friday/release-proof-package" },
      body: {
        tenantId: "tenant-a",
        targetVersion: "2.0.0",
        etag: install.install.etag,
        idempotencyKey: "upgrade-v2",
      },
    });
    expect(upgraded.previousVersion).toBe("1.0.0");
    expect(upgraded.install.packageVersion).toBe("2.0.0");

    const rolledBack = await callRoute(routes, "packaging.installs.rollback", {
      params: { packageName: "@friday/release-proof-package" },
      body: {
        tenantId: "tenant-a",
        targetVersion: "1.0.0",
        etag: upgraded.install.etag,
        reason: "release proof rollback",
        idempotencyKey: "rollback-v1",
      },
    });
    expect(rolledBack.rollback.state).toBe("completed");

    const installsAfterRollback = await callRoute(routes, "packaging.installs.list", {
      query: { tenantId: "tenant-a", packageName: "@friday/release-proof-package" },
    });
    const activeInstall = installsAfterRollback.items.find((entry: any) => entry.state === "active");
    expect(activeInstall.packageVersion).toBe("1.0.0");

    const uninstalled = await callRoute(routes, "packaging.installs.uninstall", {
      params: { packageName: "@friday/release-proof-package" },
      body: {
        tenantId: "tenant-a",
        etag: activeInstall.etag,
        idempotencyKey: "uninstall-v1",
      },
    });
    expect(uninstalled.install.state).toBe("uninstalled");

    const lifecycle = await callRoute(routes, "packaging.lifecycle.list", {
      query: { tenantId: "tenant-a", packageName: "@friday/release-proof-package" },
    });
    expect(lifecycle.items.map((event: any) => event.operation)).toEqual(
      expect.arrayContaining(["publish", "install", "upgrade", "rollback", "uninstall"]),
    );

    layer.close();
    layer = buildLayer(dbPath);
    const restartedRoutes = buildPackagingRoutes(layer);
    const listedAfterRestart = await callRoute(restartedRoutes, "packaging.installs.list", {
      query: { tenantId: "tenant-a", packageName: "@friday/release-proof-package" },
    });
    expect(listedAfterRestart.items.some((entry: any) => entry.state === "uninstalled")).toBe(true);
    const versionsAfterRestart = await callRoute(restartedRoutes, "packaging.packages.versions.list", {
      params: { packageName: "@friday/release-proof-package" },
      query: { tenantId: "tenant-a", limit: 10 },
    });
    expect(versionsAfterRestart.items.map((entry: any) => entry.version)).toEqual(
      expect.arrayContaining(["1.0.0", "2.0.0"]),
    );
  });

  it("denies cross-tenant scoped-resource reads without leaking existence and records deny audit", async () => {
    const { routes, tenantManager } = buildScopedResourceRoutes(layer);
    const tenantA = tenantManager.createTenant({ name: "Tenant A", slug: "tenant-a" }, MIGRATION_ACTOR).id;
    const tenantB = tenantManager.createTenant({ name: "Tenant B", slug: "tenant-b" }, MIGRATION_ACTOR).id;

    await callRoute(routes, "security.scopedresources.register", {
      params: { tenantId: tenantA },
      body: {
        resourceKind: "workflow",
        resourceId: "workflow-secret-to-tenant-a",
        resourceLabel: "tenant A workflow",
        idempotencyKey: "register-a",
      },
    });

    await expect(callRoute(routes, "security.scopedresources.get", {
      params: {
        tenantId: tenantB,
        resourceKind: "workflow",
        resourceId: "workflow-secret-to-tenant-a",
      },
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const db = new Database(dbPath, { readonly: true });
    try {
      const deniedRows = db.prepare(
        "SELECT * FROM security_audit_log WHERE action = ? AND decision = ?",
      ).all("tenant_scoped_resource.cross_tenant_denied", "deny") as unknown[];
      expect(deniedRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
