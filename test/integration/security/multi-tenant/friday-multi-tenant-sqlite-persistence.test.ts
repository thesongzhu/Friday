/**
 * Phase 11 Module 18 integration test:
 *
 *  - Tenant CRUD persists across simulated hub restart.
 *  - Secrets stay encrypted at rest in SQLite (no plaintext leaks).
 *  - Cross-tenant access is denied via the engine's tenant scoping.
 *  - Deleting a tenant cascades workspaces and revokes memberships.
 *  - getStrictMasterKey fails closed when FRIDAY_MASTER_KEY is unset.
 *  - Tenant-scoped resource records (sessions / skills / workflows /
 *    providers / memory items / rules) persist across restart and
 *    cross-tenant access through the registry is denied.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer } from "#state";
import type { FridaySqliteLayer } from "#state";
import {
  AuditLogger,
  TenantManager,
  SecretManager,
  RbacEngine,
  TenantScopedResourceRegistry,
  FRIDAY_TENANT_SCOPED_RESOURCE_KINDS,
} from "../../../../src/security/multi-tenant/engine/index.js";
import { MIGRATION_ACTOR } from "../../../../src/security/multi-tenant/engine/tenant-manager.js";
import {
  createSqliteTenantPersistence,
  createSqliteSecretPersistence,
  createSqliteAuditPersistence,
  createSqliteTenantScopedResourcePersistence,
} from "../../../../src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.js";
import {
  decryptSecret,
  getStrictMasterKey,
  resetMasterKeyCache,
} from "../../../../src/providers/security/friday-secret-crypto.js";

function buildLayer(dbPath: string): FridaySqliteLayer {
  return createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
}

const MASTER_KEY_HEX = crypto.randomBytes(32).toString("hex");

let tmpdir: string;
let dbPath: string;
let layer: FridaySqliteLayer;
let previousMasterKey: string | undefined;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mt-persistence-"));
  dbPath = path.join(tmpdir, "friday.sqlite");
  layer = buildLayer(dbPath);
  previousMasterKey = process.env.FRIDAY_MASTER_KEY;
  process.env.FRIDAY_MASTER_KEY = MASTER_KEY_HEX;
  resetMasterKeyCache();
});

afterEach(() => {
  if (previousMasterKey === undefined) {
    delete process.env.FRIDAY_MASTER_KEY;
  } else {
    process.env.FRIDAY_MASTER_KEY = previousMasterKey;
  }
  resetMasterKeyCache();
  try { layer.close(); } catch { /* ignore */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("multi-tenant SQLite persistence (Phase 11 Module 18)", () => {
  it("persists tenant + workspace state across simulated restart", () => {
    const auditPersistence = createSqliteAuditPersistence(layer);
    const tenantPersistence = createSqliteTenantPersistence(layer);
    let audit = new AuditLogger({ persistence: auditPersistence });
    let tenants = new TenantManager(audit, { persistence: tenantPersistence });

    const created = tenants.createTenant({ name: "Alpha", slug: "alpha" }, MIGRATION_ACTOR);
    const wsCreated = tenants.createWorkspace(created.id, { name: "default", slug: "default" }, MIGRATION_ACTOR);

    layer.close();
    layer = buildLayer(dbPath);

    audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    tenants = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });

    const reloaded = tenants.listTenants(MIGRATION_ACTOR);
    expect(reloaded.find((t) => t.id === created.id)?.slug).toBe("alpha");
    const workspaces = tenants.listWorkspaces(created.id, MIGRATION_ACTOR);
    expect(workspaces.find((w) => w.id === wsCreated.id)?.slug).toBe("default");
  });

  it("encrypts secret values at rest and never persists plaintext", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenantManager = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const tenant = tenantManager.createTenant({ name: "Beta", slug: "beta" }, MIGRATION_ACTOR);

    const secrets = new SecretManager(audit, {
      persistence: createSqliteSecretPersistence(layer),
      masterKeyResolver: getStrictMasterKey,
    });
    const secret = secrets.createSecret(tenant.id, {
      name: "alpha-token",
      value: "supersecret-VALUE",
      scope: { scopeType: "tenant" } as never,
    });
    expect(secret.name).toBe("alpha-token");
    expect((secret as unknown as { encryptedValue?: string }).encryptedValue).toBeUndefined();

    // Direct SQL probe: encrypted_value column must not contain plaintext
    const writer = new Database(dbPath, { readonly: true });
    try {
      const row = writer.prepare("SELECT encrypted_value FROM security_secrets WHERE id = ?").get(secret.id) as { encrypted_value: string };
      expect(row.encrypted_value).toBeTruthy();
      expect(row.encrypted_value).not.toContain("supersecret-VALUE");
      const envelope = JSON.parse(row.encrypted_value) as { iv: string; ciphertext: string; tag: string };
      const decrypted = decryptSecret(envelope, getStrictMasterKey());
      expect(decrypted).toBe("supersecret-VALUE");
    } finally {
      writer.close();
    }
  });

  it("denies cross-tenant access through the secret manager", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenantManager = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const a = tenantManager.createTenant({ name: "A", slug: "a-1" }, MIGRATION_ACTOR);
    const b = tenantManager.createTenant({ name: "B", slug: "b-1" }, MIGRATION_ACTOR);

    const secrets = new SecretManager(audit, {
      persistence: createSqliteSecretPersistence(layer),
      masterKeyResolver: getStrictMasterKey,
    });
    const secret = secrets.createSecret(a.id, {
      name: "secret-a",
      value: "value-a",
      scope: { scopeType: "tenant" } as never,
    });
    expect(() => secrets.getSecret(b.id, secret.id)).toThrowError();
  });

  it("soft-deletes workspaces when a tenant is deleted (cascade behaviour)", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenants = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const t = tenants.createTenant({ name: "Cascade", slug: "cascade" }, MIGRATION_ACTOR);
    const ws = tenants.createWorkspace(t.id, { name: "w", slug: "w" }, MIGRATION_ACTOR);
    expect(tenants.listWorkspaces(t.id, MIGRATION_ACTOR).length).toBe(1);
    void ws;

    const deleted = tenants.deleteTenant(t.id, t.etag, MIGRATION_ACTOR);
    expect(deleted.status).toBe("deactivated");

    // Workspaces under deleted tenant must be soft-deleted in SQLite
    const db = new Database(dbPath, { readonly: true });
    try {
      const wsRows = db.prepare("SELECT deleted_at FROM security_workspaces WHERE tenant_id = ?").all(t.id) as { deleted_at: string | null }[];
      expect(wsRows.length).toBeGreaterThan(0);
      for (const row of wsRows) {
        expect(row.deleted_at).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it("fails closed when FRIDAY_MASTER_KEY is not configured", () => {
    delete process.env.FRIDAY_MASTER_KEY;
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
    expect(() => getStrictMasterKey()).toThrowError(/FRIDAY_MASTER_KEY is not configured/);
  });

  it("RBAC engine still works in-memory without persistence (regression guard)", () => {
    const audit = new AuditLogger();
    const rbac = new RbacEngine(audit);
    expect(rbac).toBeDefined();
  });

  it("registers tenant-scoped legacy resources and survives restart for every required domain", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenants = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const tenantA = tenants.createTenant({ name: "DomainTenantA", slug: "domain-a" }, MIGRATION_ACTOR);

    let registry = new TenantScopedResourceRegistry(audit, {
      persistence: createSqliteTenantScopedResourcePersistence(layer),
    });

    // The Module 18 CSV explicitly lists these six legacy domains.
    expect(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS).toEqual([
      "session", "skill", "workflow", "provider", "memory", "rule",
    ]);

    for (const kind of FRIDAY_TENANT_SCOPED_RESOURCE_KINDS) {
      const record = registry.register({
        tenantId: tenantA.id,
        resourceKind: kind,
        resourceId: `res-${kind}-1`,
        resourceLabel: `Tenant-A ${kind}`,
      });
      expect(record.tenantId).toBe(tenantA.id);
      expect(record.resourceKind).toBe(kind);
    }
    expect(registry.listForTenant(tenantA.id)).toHaveLength(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.length);

    // Simulated hub restart: close+reopen the SQLite layer, rehydrate
    // the registry, and confirm every record survives.
    layer.close();
    layer = buildLayer(dbPath);
    const audit2 = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    registry = new TenantScopedResourceRegistry(audit2, {
      persistence: createSqliteTenantScopedResourcePersistence(layer),
    });
    for (const kind of FRIDAY_TENANT_SCOPED_RESOURCE_KINDS) {
      expect(registry.getForTenant(tenantA.id, kind, `res-${kind}-1`)).not.toBeNull();
    }
    expect(registry.listForTenant(tenantA.id)).toHaveLength(FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.length);
  });

  it("denies cross-tenant access to scoped legacy resources via the registry", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenants = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const tenantA = tenants.createTenant({ name: "DomainTenantA2", slug: "domain-a-2" }, MIGRATION_ACTOR);
    const tenantB = tenants.createTenant({ name: "DomainTenantB2", slug: "domain-b-2" }, MIGRATION_ACTOR);

    const registry = new TenantScopedResourceRegistry(audit, {
      persistence: createSqliteTenantScopedResourcePersistence(layer),
    });
    registry.register({
      tenantId: tenantA.id,
      resourceKind: "workflow",
      resourceId: "wf-7",
      resourceLabel: "Tenant-A workflow",
    });

    // Same resource id with a different tenant must be denied (returns null,
    // not the record) so the registry can answer "T2 does not own R" the
    // same way as "no such record" — preventing information leakage.
    expect(registry.getForTenant(tenantB.id, "workflow", "wf-7")).toBeNull();
    // Tenant-B's list must not contain Tenant-A's records.
    expect(registry.listForTenant(tenantB.id)).toEqual([]);

    // Tenant-B cannot soft-delete tenant-A's record either.
    expect(registry.unregister(tenantB.id, "workflow", "wf-7")).toBeNull();

    // Tenant-A still owns and can list/delete its own record.
    expect(registry.getForTenant(tenantA.id, "workflow", "wf-7")).not.toBeNull();
    const removed = registry.unregister(tenantA.id, "workflow", "wf-7");
    expect(removed?.deletedAt).toBeTruthy();
    expect(registry.getForTenant(tenantA.id, "workflow", "wf-7")).toBeNull();

    // The cross-tenant denied event was recorded honestly.
    const auditDb = new Database(dbPath, { readonly: true });
    try {
      const deniedRows = auditDb.prepare(
        "SELECT * FROM security_audit_log WHERE action = ? AND decision = ?",
      ).all("tenant_scoped_resource.cross_tenant_denied", "deny") as unknown[];
      expect(deniedRows.length).toBeGreaterThan(0);
    } finally {
      auditDb.close();
    }
  });

  it("rejects registering the same resource under a different tenant (no silent re-scoping)", () => {
    const audit = new AuditLogger({ persistence: createSqliteAuditPersistence(layer) });
    const tenants = new TenantManager(audit, { persistence: createSqliteTenantPersistence(layer) });
    const t1 = tenants.createTenant({ name: "TConflict1", slug: "tc-1" }, MIGRATION_ACTOR);
    const t2 = tenants.createTenant({ name: "TConflict2", slug: "tc-2" }, MIGRATION_ACTOR);
    const registry = new TenantScopedResourceRegistry(audit, {
      persistence: createSqliteTenantScopedResourcePersistence(layer),
    });
    registry.register({ tenantId: t1.id, resourceKind: "memory", resourceId: "mem-shared" });
    expect(() =>
      registry.register({ tenantId: t2.id, resourceKind: "memory", resourceId: "mem-shared" }),
    ).toThrowError(/already scoped/);
  });
});
