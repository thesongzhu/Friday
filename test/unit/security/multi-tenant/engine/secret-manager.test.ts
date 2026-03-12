import { describe, it, expect, beforeEach } from "vitest";
import { SecretManager } from "../../../../../src/security/multi-tenant/engine/secret-manager.js";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";
import type {
  FridaySecretEntry,
  FridaySecretRotation,
} from "../../../../../src/security/multi-tenant/model/friday-multi-tenant-security.types.js";

describe("SecretManager", () => {
  let auditLogger: AuditLogger;
  let manager: SecretManager;
  const tenantId = "tenant-1";

  beforeEach(() => {
    auditLogger = new AuditLogger();
    manager = new SecretManager(auditLogger);
  });

  // ═══════════════════════════════════════════════════════════════
  // SECRET CRUD
  // ═══════════════════════════════════════════════════════════════

  describe("createSecret()", () => {
    it("creates a tenant-scoped secret", () => {
      const secret = manager.createSecret(tenantId, {
        name: "API_KEY",
        description: "External API key",
        value: "sk-12345",
        scope: { scopeType: "tenant" },
      });

      expect(secret.id).toBeTypeOf("string");
      expect(secret.scope.scopeType).toBe("tenant");
      expect(secret.scope.tenantId).toBe(tenantId);
      expect(secret.name).toBe("API_KEY");
      expect(secret.version).toBe(1);
      expect(secret.rotationState).toBe("active");
      // Most importantly: no encryptedValue exposed
      expect((secret as Record<string, unknown>)["encryptedValue"]).toBeUndefined();
    });

    it("creates a workspace-scoped secret", () => {
      const secret = manager.createSecret(tenantId, {
        name: "DB_PASSWORD",
        value: "secret123",
        scope: { scopeType: "workspace", workspaceId: "ws-1" },
      });

      expect(secret.scope.scopeType).toBe("workspace");
      if (secret.scope.scopeType === "workspace") {
        expect(secret.scope.workspaceId).toBe("ws-1");
      }
    });

    it("creates a resource-scoped secret", () => {
      const secret = manager.createSecret(tenantId, {
        name: "SKILL_TOKEN",
        value: "tok-abc",
        scope: { scopeType: "resource", workspaceId: "ws-1", resourceId: "skill-42" },
      });

      expect(secret.scope.scopeType).toBe("resource");
      if (secret.scope.scopeType === "resource") {
        expect(secret.scope.workspaceId).toBe("ws-1");
        expect(secret.scope.resourceId).toBe("skill-42");
      }
    });

    it("rejects duplicate names in the same scope", () => {
      manager.createSecret(tenantId, {
        name: "DUPE",
        value: "v1",
        scope: { scopeType: "tenant" },
      });

      expect(() =>
        manager.createSecret(tenantId, {
          name: "DUPE",
          value: "v2",
          scope: { scopeType: "tenant" },
        }),
      ).toThrow(SecurityEngineError);

      try {
        manager.createSecret(tenantId, {
          name: "DUPE",
          value: "v2",
          scope: { scopeType: "tenant" },
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_NAME_CONFLICT,
        );
      }
    });

    it("allows same name in different scopes", () => {
      const s1 = manager.createSecret(tenantId, {
        name: "SHARED_KEY",
        value: "v1",
        scope: { scopeType: "tenant" },
      });
      const s2 = manager.createSecret(tenantId, {
        name: "SHARED_KEY",
        value: "v2",
        scope: { scopeType: "workspace", workspaceId: "ws-1" },
      });

      expect(s1.id).not.toBe(s2.id);
    });

    it("allows same name in different workspaces", () => {
      const s1 = manager.createSecret(tenantId, {
        name: "DB_PASS",
        value: "v1",
        scope: { scopeType: "workspace", workspaceId: "ws-1" },
      });
      const s2 = manager.createSecret(tenantId, {
        name: "DB_PASS",
        value: "v2",
        scope: { scopeType: "workspace", workspaceId: "ws-2" },
      });

      expect(s1.id).not.toBe(s2.id);
    });
  });

  describe("getSecret() — tenant isolation", () => {
    it("retrieves a secret within the correct tenant", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });
      const fetched = manager.getSecret(tenantId, created.id);
      expect(fetched.id).toBe(created.id);
    });

    it("rejects cross-tenant secret access", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      expect(() => manager.getSecret("other-tenant", created.id)).toThrow(SecurityEngineError);
      const denyEntries = auditLogger.queryAuditLog({
        tenantId: "other-tenant",
        action: "secret.get",
        decision: "deny",
      });
      expect(denyEntries).toHaveLength(1);
    });

    it("enforces secret scope visibility between tenant and workspace callers", () => {
      const tenantSecret = manager.createSecret(tenantId, {
        name: "TENANT_ONLY",
        value: "tenant-val",
        scope: { scopeType: "tenant" },
      });
      const workspaceSecret = manager.createSecret(tenantId, {
        name: "WORKSPACE_ONLY",
        value: "workspace-val",
        scope: { scopeType: "workspace", workspaceId: "ws-1" },
      });

      expect(() =>
        manager.getSecret(tenantId, workspaceSecret.id, {
          principalId: "tenant-caller",
          scopeType: "tenant",
        }),
      ).toThrow(SecurityEngineError);

      expect(() =>
        manager.getSecret(tenantId, tenantSecret.id, {
          principalId: "workspace-caller",
          scopeType: "workspace",
          workspaceId: "ws-1",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("never exposes encrypted value", () => {
      const secret = manager.createSecret(tenantId, {
        name: "SECRET",
        value: "super-secret-value",
        scope: { scopeType: "tenant" },
      });

      const fetched = manager.getSecret(tenantId, secret.id);
      const keys = Object.keys(fetched);
      expect(keys).not.toContain("encryptedValue");
      expect(keys).not.toContain("encryptionKeyId");
    });

    it("returns immutable snapshots", () => {
      const secret = manager.createSecret(tenantId, {
        name: "IMMUTABLE",
        value: "value",
        scope: { scopeType: "tenant" },
      });
      const fetched = manager.getSecret(tenantId, secret.id);

      expect(Object.isFrozen(fetched)).toBe(true);
      expect(() => {
        (fetched as { name: string }).name = "mutated";
      }).toThrow(TypeError);
    });
  });

  describe("updateSecret()", () => {
    it("updates description without changing value", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      const updated = manager.updateSecret(tenantId, created.id, {
        description: "Updated description",
        etag: created.etag,
      });

      expect(updated.description).toBe("Updated description");
      expect(updated.version).toBe(1); // No value change = no version bump
    });

    it("increments version when value changes", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      const updated = manager.updateSecret(tenantId, created.id, {
        value: "new-val",
        etag: created.etag,
      });

      expect(updated.version).toBe(2);
    });

    it("rejects update with stale etag", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      expect(() =>
        manager.updateSecret(tenantId, created.id, { value: "new", etag: "wrong" }),
      ).toThrow(SecurityEngineError);
    });
  });

  describe("deleteSecret()", () => {
    it("soft-deletes a secret", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      const deleted = manager.deleteSecret(tenantId, created.id, created.etag);
      expect(deleted.rotationState).toBe("retired");
    });

    it("deleted secrets are not retrievable", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });
      manager.deleteSecret(tenantId, created.id, created.etag);

      expect(() => manager.getSecret(tenantId, created.id)).toThrow(SecurityEngineError);
    });
  });

  describe("listSecrets()", () => {
    it("returns secrets scoped to the tenant", () => {
      manager.createSecret(tenantId, { name: "A", value: "a", scope: { scopeType: "tenant" } });
      manager.createSecret(tenantId, { name: "B", value: "b", scope: { scopeType: "workspace", workspaceId: "ws-1" } });
      manager.createSecret("other-tenant", { name: "C", value: "c", scope: { scopeType: "tenant" } });

      const secrets = manager.listSecrets(tenantId);
      expect(secrets).toHaveLength(1);
      expect(secrets.every((s) => s.scope.tenantId === tenantId)).toBe(true);
    });

    it("filters by workspace", () => {
      manager.createSecret(tenantId, { name: "T", value: "t", scope: { scopeType: "tenant" } });
      manager.createSecret(tenantId, { name: "W1", value: "w1", scope: { scopeType: "workspace", workspaceId: "ws-1" } });
      manager.createSecret(tenantId, { name: "W2", value: "w2", scope: { scopeType: "workspace", workspaceId: "ws-2" } });

      const ws1 = manager.listSecrets(
        tenantId,
        { workspaceId: "ws-1" },
        { principalId: "workspace-caller", scopeType: "workspace", workspaceId: "ws-1" },
      );
      expect(ws1).toHaveLength(1);
      expect(ws1[0].name).toBe("W1");
    });

    it("filters by scopeType", () => {
      manager.createSecret(tenantId, { name: "T", value: "t", scope: { scopeType: "tenant" } });
      manager.createSecret(tenantId, { name: "W", value: "w", scope: { scopeType: "workspace", workspaceId: "ws-1" } });

      const tenantScoped = manager.listSecrets(tenantId, { scopeType: "tenant" });
      expect(tenantScoped).toHaveLength(1);
      expect(tenantScoped[0].name).toBe("T");
    });

    it("excludes deleted secrets", () => {
      const s = manager.createSecret(tenantId, { name: "DEL", value: "d", scope: { scopeType: "tenant" } });
      manager.deleteSecret(tenantId, s.id, s.etag);

      const secrets = manager.listSecrets(tenantId);
      expect(secrets).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // SECRET ROTATION
  // ═══════════════════════════════════════════════════════════════

  describe("rotateSecret()", () => {
    it("rotates an active secret", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "old-val",
        scope: { scopeType: "tenant" },
      });

      const { secret, rotation } = manager.rotateSecret(tenantId, created.id, {
        newValue: "new-val",
        etag: created.etag,
        initiatedBy: "admin",
      });

      expect(secret.version).toBe(2);
      expect(secret.rotationState).toBe("rotated");
      expect(secret.rotatedAt).toBeTypeOf("string");

      expect(rotation.fromVersion).toBe(1);
      expect(rotation.toVersion).toBe(2);
      expect(rotation.initiatedBy).toBe("admin");
      expect(rotation.state).toBe("rotated");
    });

    it("rejects rotation of deleted secret", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      // Delete to put it in "retired" state
      manager.deleteSecret(tenantId, created.id, created.etag);

      expect(() =>
        manager.rotateSecret(tenantId, created.id, {
          newValue: "new",
          etag: created.etag,
          initiatedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("throws SECRET_ROTATION_INVALID on disallowed state transitions", () => {
      const created = manager.createSecret(tenantId, {
        name: "INVALID_ROTATION",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      const secretStore = Reflect.get(manager, "secrets") as Map<string, FridaySecretEntry>;
      const internal = secretStore.get(created.id);
      expect(internal).toBeDefined();
      if (!internal) {
        throw new Error("Expected secret to exist in internal store.");
      }
      secretStore.set(created.id, {
        ...internal,
        rotationState: "rotating",
      });

      expect(() =>
        manager.rotateSecret(tenantId, created.id, {
          newValue: "new",
          etag: created.etag,
          initiatedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);

      try {
        manager.rotateSecret(tenantId, created.id, {
          newValue: "new",
          etag: created.etag,
          initiatedBy: "admin",
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_ROTATION_INVALID,
        );
      }
    });

    it("rejects rotation with stale etag", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      expect(() =>
        manager.rotateSecret(tenantId, created.id, {
          newValue: "new",
          etag: "wrong",
          initiatedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });
  });

  describe("getRotationHistory()", () => {
    it("returns rotation records for a secret", () => {
      const created = manager.createSecret(tenantId, {
        name: "KEY",
        value: "v1",
        scope: { scopeType: "tenant" },
      });

      const { secret: rotated1 } = manager.rotateSecret(tenantId, created.id, {
        newValue: "v2",
        etag: created.etag,
        initiatedBy: "admin",
      });

      manager.rotateSecret(tenantId, created.id, {
        newValue: "v3",
        etag: rotated1.etag,
        initiatedBy: "admin",
      });

      const history = manager.getRotationHistory(tenantId, created.id);
      expect(history).toHaveLength(2);
      // Newest first
      expect(history[0].toVersion).toBe(3);
      expect(history[1].toVersion).toBe(2);
    });

    it("sorts deterministically by startedAt desc then toVersion desc", () => {
      const created = manager.createSecret(tenantId, {
        name: "SORT_KEY",
        value: "v1",
        scope: { scopeType: "tenant" },
      });

      const rotationStore = Reflect.get(manager, "rotations") as Map<string, FridaySecretRotation>;
      rotationStore.set("rotation-a", {
        id: "rotation-a",
        secretId: created.id,
        tenantId,
        fromVersion: 1,
        toVersion: 2,
        initiatedBy: "admin",
        state: "rotated",
        gracePeriodSeconds: 3600,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
      });
      rotationStore.set("rotation-b", {
        id: "rotation-b",
        secretId: created.id,
        tenantId,
        fromVersion: 2,
        toVersion: 3,
        initiatedBy: "admin",
        state: "rotated",
        gracePeriodSeconds: 3600,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
      });

      const history = manager.getRotationHistory(tenantId, created.id);
      expect(history[0].toVersion).toBe(3);
      expect(history[1].toVersion).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ACCESS LOG
  // ═══════════════════════════════════════════════════════════════

  describe("logAccess()", () => {
    it("records an access event", () => {
      const secret = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      const entry = manager.logAccess(tenantId, secret.id, "user-1", "read", true);
      expect(entry.secretId).toBe(secret.id);
      expect(entry.tenantId).toBe(tenantId);
      expect(entry.principalId).toBe("user-1");
      expect(entry.action).toBe("read");
      expect(entry.granted).toBe(true);
    });
  });

  describe("queryAccessLog()", () => {
    it("returns access logs for a secret scoped to tenant", () => {
      const secret = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      manager.logAccess(tenantId, secret.id, "u1", "read", true);
      manager.logAccess(tenantId, secret.id, "u2", "read", false);
      manager.logAccess("other-tenant", "other-secret", "u3", "read", true);

      const logs = manager.queryAccessLog(tenantId, secret.id);
      expect(logs).toHaveLength(2);
    });

    it("filters by granted status", () => {
      const secret = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      manager.logAccess(tenantId, secret.id, "u1", "read", true);
      manager.logAccess(tenantId, secret.id, "u2", "read", false);

      const granted = manager.queryAccessLog(tenantId, secret.id, { granted: true });
      expect(granted).toHaveLength(1);
      expect(granted[0].granted).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AUDIT INTEGRATION
  // ═══════════════════════════════════════════════════════════════

  describe("audit logging", () => {
    it("generates audit entries for all CRUD operations", () => {
      const secret = manager.createSecret(tenantId, {
        name: "KEY",
        value: "val",
        scope: { scopeType: "tenant" },
      });

      manager.updateSecret(tenantId, secret.id, {
        description: "Updated",
        etag: secret.etag,
      });

      const entries = auditLogger.queryAuditLog({ tenantId });
      const actions = entries.map((e) => e.action);
      expect(actions).toContain("secret.create");
      expect(actions).toContain("secret.update");
    });

    it("emits audit decision + scope metadata for secret read/list", () => {
      const tenantSecret = manager.createSecret(tenantId, {
        name: "AUDIT_TENANT",
        value: "v1",
        scope: { scopeType: "tenant" },
      });
      const workspaceSecret = manager.createSecret(tenantId, {
        name: "AUDIT_WORKSPACE",
        value: "v2",
        scope: { scopeType: "workspace", workspaceId: "ws-1" },
      });

      manager.getSecret(tenantId, tenantSecret.id, {
        principalId: "tenant-caller",
        scopeType: "tenant",
      });
      manager.listSecrets(
        tenantId,
        undefined,
        { principalId: "workspace-caller", scopeType: "workspace", workspaceId: "ws-1" },
      );
      expect(() =>
        manager.getSecret(tenantId, workspaceSecret.id, {
          principalId: "tenant-caller",
          scopeType: "tenant",
        }),
      ).toThrow(SecurityEngineError);

      const allowRead = auditLogger.queryAuditLog({
        tenantId,
        action: "secret.get",
        decision: "allow",
      });
      const denyRead = auditLogger.queryAuditLog({
        tenantId,
        action: "secret.get",
        decision: "deny",
      });
      const allowList = auditLogger.queryAuditLog({
        tenantId,
        action: "secret.list",
        decision: "allow",
      });

      expect(allowRead.length).toBeGreaterThanOrEqual(1);
      expect(denyRead.length).toBeGreaterThanOrEqual(1);
      expect(allowList.length).toBeGreaterThanOrEqual(1);
      expect(allowRead[0].metadata["callerScopeType"]).toBeTypeOf("string");
      expect(allowList[0].metadata["callerScopeType"]).toBeTypeOf("string");
    });
  });

  describe("KPI assertions", () => {
    it("keeps secret exposure incidents at 0 for read/list/rotation outputs", () => {
      const created = manager.createSecret(tenantId, {
        name: "KPI_SECRET",
        value: "top-secret-value",
        scope: { scopeType: "tenant" },
      });
      const fetched = manager.getSecret(tenantId, created.id);
      const listed = manager.listSecrets(tenantId);
      const rotated = manager.rotateSecret(tenantId, created.id, {
        newValue: "new-secret",
        etag: fetched.etag,
        initiatedBy: "admin",
      }).secret;

      const payloads = [fetched, listed[0], rotated];
      for (const payload of payloads) {
        const serialised = JSON.stringify(payload);
        expect(serialised).not.toContain("encryptedValue");
        expect(serialised).not.toContain("encryptionKeyId");
        expect(serialised).not.toContain("top-secret-value");
        expect(serialised).not.toContain("new-secret");
      }
    });
  });
});
