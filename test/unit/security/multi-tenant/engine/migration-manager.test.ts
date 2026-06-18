import { beforeEach, describe, expect, it } from "vitest";

import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { TenantManager } from "../../../../../src/security/multi-tenant/engine/tenant-manager.js";
import { RbacEngine } from "../../../../../src/security/multi-tenant/engine/rbac-engine.js";
import { SecretManager } from "../../../../../src/security/multi-tenant/engine/secret-manager.js";
import { IdempotencyManager } from "../../../../../src/security/multi-tenant/engine/idempotency-manager.js";
import { MigrationManager } from "../../../../../src/security/multi-tenant/engine/migration-manager.js";

describe("MigrationManager", () => {
  let auditLogger: AuditLogger;
  let tenantManager: TenantManager;
  let rbacEngine: RbacEngine;
  let secretManager: SecretManager;
  let idempotencyManager: IdempotencyManager;
  let migrationManager: MigrationManager;
  const testMasterKey = Buffer.from("55".repeat(32), "hex");
  const resolveTestMasterKey = () => Buffer.from(testMasterKey);

  beforeEach(() => {
    auditLogger = new AuditLogger();
    tenantManager = new TenantManager(auditLogger);
    rbacEngine = new RbacEngine(auditLogger);
    secretManager = new SecretManager(auditLogger, { masterKeyResolver: resolveTestMasterKey });
    idempotencyManager = new IdempotencyManager();
    migrationManager = new MigrationManager(
      tenantManager,
      rbacEngine,
      secretManager,
      idempotencyManager,
      auditLogger,
    );
  });

  it("up() creates default tenant/workspace and is idempotent", () => {
    const first = migrationManager.up();
    expect(first.applied).toBe(true);
    expect(first.createdDefaultTenant).toBe(true);
    expect(first.createdDefaultWorkspace).toBe(true);

    const second = migrationManager.up();
    expect(second.applied).toBe(false);
    expect(second.alreadyApplied).toBe(true);

    const tenantStore = Reflect.get(tenantManager, "tenants") as Map<string, { slug: string }>;
    const workspaceStore = Reflect.get(tenantManager, "workspaces") as Map<string, { slug: string; tenantId: string }>;
    const defaultTenant = Array.from(tenantStore.values()).find((tenant) => tenant.slug === "default");
    expect(defaultTenant).toBeDefined();
    const defaultWorkspace = Array.from(workspaceStore.values()).find((workspace) => workspace.slug === "default");
    expect(defaultWorkspace).toBeDefined();
  });

  it("up() re-scopes RBAC assignments, secrets, and idempotency records", () => {
    const legacyRole = rbacEngine.createRole(null, {
      name: "member",
      scopeType: "system",
      permissions: [],
    });
    const assignmentStore = Reflect.get(rbacEngine, "assignments") as Map<string, unknown>;
    assignmentStore.set("legacy-assignment", {
      id: "legacy-assignment",
      tenantId: null,
      principalId: "legacy-user",
      roleId: legacyRole.id,
      scope: { scopeType: "system" },
      grantedBy: "legacy-root",
      grantedAt: "2026-01-01T00:00:00.000Z",
    });

    const secret = secretManager.createSecret("legacy-tenant", {
      name: "LEGACY_SECRET",
      value: "legacy-value",
      scope: { scopeType: "tenant" },
    });
    const secretStore = Reflect.get(secretManager, "secrets") as Map<string, Record<string, unknown>>;
    const secretInternal = secretStore.get(secret.id);
    expect(secretInternal).toBeDefined();
    if (!secretInternal) {
      throw new Error("Expected legacy secret to exist.");
    }
    secretStore.set(secret.id, {
      ...secretInternal,
      scope: { scopeType: "global" },
      rotationState: "pending_rotation",
    });

    const idempotencyStore = Reflect.get(idempotencyManager, "records") as Map<string, Record<string, unknown>>;
    idempotencyStore.set("legacy-user:createSecret:idem-key", {
      compositeKey: "legacy-user:createSecret:idem-key",
      payloadHash: "hash",
      response: { ok: true },
      createdAt: Date.now(),
    });

    const report = migrationManager.up();

    expect(report.remappedAssignments).toBe(1);
    expect(report.rescopedSecrets).toBe(1);
    expect(report.rekeyedIdempotencyRecords).toBe(1);
    expect(report.normalizedRotationStates).toBe(0);

    const migratedAssignment = (Reflect.get(rbacEngine, "assignments") as Map<string, Record<string, unknown>>)
      .get("legacy-assignment");
    expect(migratedAssignment?.tenantId).toBe(report.defaultTenantId);
    expect((migratedAssignment?.scope as { scopeType: string }).scopeType).toBe("tenant");

    const migratedSecret = (Reflect.get(secretManager, "secrets") as Map<string, Record<string, unknown>>)
      .get(secret.id);
    expect((migratedSecret?.scope as { scopeType: string }).scopeType).toBe("tenant");
    expect((migratedSecret?.scope as { tenantId: string }).tenantId).toBe(report.defaultTenantId);
    expect(migratedSecret?.rotationState).toBe("pending_rotation");

    const rekeyed = Array.from((Reflect.get(idempotencyManager, "records") as Map<string, unknown>).keys())
      .find((key) => key.includes(`:${report.defaultTenantId}:`));
    expect(rekeyed).toBeDefined();
  });

  it("down() flattens hierarchy and restores secret rotation state from checkpoint", () => {
    const legacyRole = rbacEngine.createRole(null, {
      name: "member",
      scopeType: "system",
      permissions: [],
    });
    const assignmentStore = Reflect.get(rbacEngine, "assignments") as Map<string, Record<string, unknown>>;
    assignmentStore.set("legacy-assignment", {
      id: "legacy-assignment",
      tenantId: null,
      principalId: "legacy-user",
      roleId: legacyRole.id,
      scope: { scopeType: "system" },
      grantedBy: "legacy-root",
      grantedAt: "2026-01-01T00:00:00.000Z",
    });

    const secret = secretManager.createSecret("legacy-tenant", {
      name: "LEGACY_ROTATION",
      value: "legacy",
      scope: { scopeType: "tenant" },
    });
    const secretStore = Reflect.get(secretManager, "secrets") as Map<string, Record<string, unknown>>;
    const internal = secretStore.get(secret.id);
    expect(internal).toBeDefined();
    if (!internal) {
      throw new Error("Expected internal secret record.");
    }
    secretStore.set(secret.id, {
      ...internal,
      scope: { scopeType: "global" },
      rotationState: "pending_rotation",
    });

    migrationManager.up();
    const downReport = migrationManager.down();

    expect(downReport.restored).toBe(true);
    expect(downReport.removedDefaultTenant).toBe(true);
    expect(downReport.removedDefaultWorkspace).toBe(true);

    const restoredAssignment = (Reflect.get(rbacEngine, "assignments") as Map<string, Record<string, unknown>>)
      .get("legacy-assignment");
    expect(restoredAssignment?.tenantId).toBeNull();
    expect((restoredAssignment?.scope as { scopeType: string }).scopeType).toBe("system");

    const restoredSecret = (Reflect.get(secretManager, "secrets") as Map<string, Record<string, unknown>>)
      .get(secret.id);
    expect((restoredSecret?.scope as { scopeType: string }).scopeType).toBe("global");
    expect(restoredSecret?.rotationState).toBe("pending_rotation");

    const tenants = Array.from((Reflect.get(tenantManager, "tenants") as Map<string, { slug: string }>).values());
    expect(tenants.find((tenant) => tenant.slug === "default")).toBeUndefined();
  });

  it("dryRun() reports migration plan without mutating state", () => {
    const assignmentStore = Reflect.get(rbacEngine, "assignments") as Map<string, Record<string, unknown>>;
    assignmentStore.set("legacy-assignment", {
      id: "legacy-assignment",
      tenantId: null,
      principalId: "legacy-user",
      roleId: "missing-role",
      scope: { scopeType: "system" },
      grantedBy: "legacy-root",
      grantedAt: "2026-01-01T00:00:00.000Z",
    });

    const idempotencyStore = Reflect.get(idempotencyManager, "records") as Map<string, Record<string, unknown>>;
    idempotencyStore.set("legacy-user:createSecret:key", {
      compositeKey: "legacy-user:createSecret:key",
      payloadHash: "hash",
      response: { ok: true },
      createdAt: Date.now(),
    });

    const beforeTenantCount = (Reflect.get(tenantManager, "tenants") as Map<string, unknown>).size;
    const plan = migrationManager.dryRun();
    const afterTenantCount = (Reflect.get(tenantManager, "tenants") as Map<string, unknown>).size;

    expect(plan.action).toBe("dry_run");
    expect(plan.willCreateDefaultTenant).toBe(true);
    expect(plan.rbacAssignmentsToRescope).toBe(1);
    expect(plan.idempotencyRecordsToRekey).toBe(1);
    expect(beforeTenantCount).toBe(afterTenantCount);
  });
});
