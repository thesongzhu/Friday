import { describe, it, expect, beforeEach } from "vitest";
import { RbacEngine } from "../../../../../src/security/multi-tenant/engine/rbac-engine.js";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";
import type { FridayPermission } from "../../../../../src/security/multi-tenant/model/friday-multi-tenant-security.types.js";

describe("RbacEngine", () => {
  let auditLogger: AuditLogger;
  let rbac: RbacEngine;
  const tenantId = "tenant-1";

  const secretRead: FridayPermission = {
    id: "perm-secret-read",
    resource: "secret",
    action: "read",
    description: "Read secrets",
  };

  const secretWrite: FridayPermission = {
    id: "perm-secret-write",
    resource: "secret",
    action: "write",
    description: "Write secrets",
  };

  const workspaceRead: FridayPermission = {
    id: "perm-workspace-read",
    resource: "workspace",
    action: "read",
    description: "Read workspaces",
  };

  const tenantAdmin: FridayPermission = {
    id: "perm-tenant-admin",
    resource: "tenant",
    action: "admin",
    description: "Tenant administration",
  };

  beforeEach(() => {
    auditLogger = new AuditLogger();
    rbac = new RbacEngine(auditLogger);
  });

  // ═══════════════════════════════════════════════════════════════
  // ROLE CRUD
  // ═══════════════════════════════════════════════════════════════

  describe("createRole()", () => {
    it("creates a tenant-scoped role", () => {
      const role = rbac.createRole(tenantId, {
        name: "workspace:viewer",
        scopeType: "workspace",
        permissions: [secretRead, workspaceRead],
      });

      expect(role.id).toBeTypeOf("string");
      expect(role.tenantId).toBe(tenantId);
      expect(role.name).toBe("workspace:viewer");
      expect(role.scopeType).toBe("workspace");
      expect(role.isSystem).toBe(false);
      expect(role.permissions).toHaveLength(2);
    });

    it("creates a system role with null tenantId", () => {
      const role = rbac.createRole(null, {
        name: "system:admin",
        scopeType: "system",
        permissions: [tenantAdmin],
      });

      expect(role.tenantId).toBeNull();
      expect(role.isSystem).toBe(true);
      expect(role.scopeType).toBe("system");

      const systemAudit = auditLogger.queryAuditLog({ tenantId: null, action: "role.create" });
      expect(systemAudit).toHaveLength(1);
      expect(systemAudit[0].tenantId).toBeNull();
    });

    it("rejects system role with non-null tenantId", () => {
      expect(() =>
        rbac.createRole(tenantId, {
          name: "system:admin",
          scopeType: "system",
          permissions: [],
        }),
      ).toThrow(SecurityEngineError);
    });

    it("rejects tenant/workspace role with null tenantId", () => {
      expect(() =>
        rbac.createRole(null, {
          name: "tenant:admin",
          scopeType: "tenant",
          permissions: [],
        }),
      ).toThrow(SecurityEngineError);
    });

    it("rejects duplicate role names within tenant", () => {
      rbac.createRole(tenantId, { name: "viewer", scopeType: "workspace", permissions: [] });

      expect(() =>
        rbac.createRole(tenantId, { name: "viewer", scopeType: "workspace", permissions: [] }),
      ).toThrow(SecurityEngineError);

      try {
        rbac.createRole(tenantId, { name: "viewer", scopeType: "workspace", permissions: [] });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NAME_CONFLICT,
        );
      }
    });

    it("allows same role name in different tenants", () => {
      const r1 = rbac.createRole("tenant-a", { name: "viewer", scopeType: "workspace", permissions: [] });
      const r2 = rbac.createRole("tenant-b", { name: "viewer", scopeType: "workspace", permissions: [] });
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("updateRole()", () => {
    it("updates a mutable role", () => {
      const role = rbac.createRole(tenantId, {
        name: "editor",
        scopeType: "workspace",
        permissions: [secretRead],
      });

      const updated = rbac.updateRole(tenantId, role.id, {
        name: "power-editor",
        permissions: [secretRead, secretWrite],
        etag: role.etag,
      });

      expect(updated.name).toBe("power-editor");
      expect(updated.permissions).toHaveLength(2);
      expect(updated.etag).not.toBe(role.etag);
    });

    it("rejects modification of system roles", () => {
      const systemRole = rbac.createRole(null, {
        name: "system:owner",
        scopeType: "system",
        permissions: [],
      });

      expect(() =>
        rbac.updateRole(null, systemRole.id, { name: "hacked", etag: systemRole.etag }),
      ).toThrow(SecurityEngineError);

      try {
        rbac.updateRole(null, systemRole.id, { name: "hacked", etag: systemRole.etag });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_SYSTEM_IMMUTABLE,
        );
      }
    });

    it("rejects update with stale etag", () => {
      const role = rbac.createRole(tenantId, { name: "ed", scopeType: "workspace", permissions: [] });

      expect(() =>
        rbac.updateRole(tenantId, role.id, { name: "new", etag: "stale" }),
      ).toThrow(SecurityEngineError);
    });
  });

  describe("deleteRole()", () => {
    it("soft-deletes a mutable role", () => {
      const role = rbac.createRole(tenantId, { name: "del", scopeType: "workspace", permissions: [] });
      const deleted = rbac.deleteRole(tenantId, role.id, role.etag);

      expect(deleted.deletedAt).toBeTypeOf("string");
    });

    it("rejects deletion of system roles", () => {
      const systemRole = rbac.createRole(null, { name: "system:admin", scopeType: "system", permissions: [] });
      expect(() => rbac.deleteRole(null, systemRole.id, systemRole.etag)).toThrow(SecurityEngineError);
    });
  });

  describe("getRole() — tenant isolation", () => {
    it("returns system roles regardless of tenantId", () => {
      const sysRole = rbac.createRole(null, { name: "system:ro", scopeType: "system", permissions: [] });
      const fetched = rbac.getRole(tenantId, sysRole.id);
      expect(fetched.name).toBe("system:ro");
    });

    it("rejects cross-tenant role access", () => {
      const role = rbac.createRole("tenant-a", { name: "viewer", scopeType: "workspace", permissions: [] });
      expect(() => rbac.getRole("tenant-b", role.id)).toThrow(SecurityEngineError);
      const denies = auditLogger.queryAuditLog({
        tenantId: "tenant-b",
        action: "role.get",
        decision: "deny",
      });
      expect(denies).toHaveLength(1);
    });

    it("returns immutable role snapshots", () => {
      const role = rbac.createRole(tenantId, {
        name: "immutable-role",
        scopeType: "tenant",
        permissions: [secretRead],
      });
      const fetched = rbac.getRole(tenantId, role.id);

      expect(Object.isFrozen(fetched)).toBe(true);
      expect(() => {
        (fetched as { name: string }).name = "mutated";
      }).toThrow(TypeError);
    });
  });

  describe("listRoles()", () => {
    it("includes system roles and tenant roles", () => {
      rbac.createRole(null, { name: "system:admin", scopeType: "system", permissions: [] });
      rbac.createRole(tenantId, { name: "tenant:viewer", scopeType: "tenant", permissions: [] });
      rbac.createRole("other-tenant", { name: "other:viewer", scopeType: "tenant", permissions: [] });

      const roles = rbac.listRoles(tenantId);
      expect(roles).toHaveLength(2); // system + tenant role
      expect(roles.map((r) => r.name).sort()).toEqual(["system:admin", "tenant:viewer"]);
    });

    it("excludes system roles when includeSystem is false", () => {
      rbac.createRole(null, { name: "system:admin", scopeType: "system", permissions: [] });
      rbac.createRole(tenantId, { name: "viewer", scopeType: "workspace", permissions: [] });

      const roles = rbac.listRoles(tenantId, { includeSystem: false });
      expect(roles).toHaveLength(1);
      expect(roles[0].name).toBe("viewer");
    });

    it("filters by scopeType", () => {
      rbac.createRole(tenantId, { name: "tv", scopeType: "tenant", permissions: [] });
      rbac.createRole(tenantId, { name: "wv", scopeType: "workspace", permissions: [] });

      const tenantRoles = rbac.listRoles(tenantId, { scopeType: "tenant", includeSystem: false });
      expect(tenantRoles).toHaveLength(1);
      expect(tenantRoles[0].name).toBe("tv");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ROLE ASSIGNMENTS + SCOPE COMPATIBILITY
  // ═══════════════════════════════════════════════════════════════

  describe("grantRole() — role-scope compatibility (SEC-FIX-R5-03)", () => {
    it("allows workspace role at workspace scope", () => {
      const role = rbac.createRole(tenantId, { name: "ws:viewer", scopeType: "workspace", permissions: [secretRead] });

      const assignment = rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      expect(assignment.id).toBeTypeOf("string");
      expect(assignment.scope.scopeType).toBe("workspace");
    });

    it("allows tenant role at tenant scope", () => {
      const role = rbac.createRole(tenantId, { name: "t:member", scopeType: "tenant", permissions: [workspaceRead] });

      const assignment = rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      expect(assignment.scope.scopeType).toBe("tenant");
      expect(assignment.tenantId).toBe(tenantId);
    });

    it("allows system role at system scope", () => {
      const role = rbac.createRole(null, { name: "system:superadmin", scopeType: "system", permissions: [tenantAdmin] });

      const assignment = rbac.grantRole({
        principalId: "sysadmin",
        roleId: role.id,
        scope: { scopeType: "system" },
        grantedBy: "root",
      });

      expect(assignment.scope.scopeType).toBe("system");
      expect(assignment.tenantId).toBeNull();
    });

    it("REJECTS workspace role at tenant scope", () => {
      const role = rbac.createRole(tenantId, { name: "ws:admin", scopeType: "workspace", permissions: [] });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "tenant", tenantId },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);

      try {
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "tenant", tenantId },
          grantedBy: "admin",
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_SCOPE_INCOMPATIBLE,
        );
      }
    });

    it("REJECTS tenant role at workspace scope", () => {
      const role = rbac.createRole(tenantId, { name: "t:admin", scopeType: "tenant", permissions: [] });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("REJECTS system role at tenant scope", () => {
      const role = rbac.createRole(null, { name: "system:admin", scopeType: "system", permissions: [] });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "tenant", tenantId },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("REJECTS tenant role at system scope", () => {
      const role = rbac.createRole(tenantId, { name: "t:member", scopeType: "tenant", permissions: [] });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "system" },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("rejects cross-tenant role assignment", () => {
      const role = rbac.createRole("tenant-a", { name: "viewer", scopeType: "tenant", permissions: [] });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "tenant", tenantId: "tenant-b" },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);

      try {
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "tenant", tenantId: "tenant-b" },
          grantedBy: "admin",
        });
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.CROSS_TENANT_DENIED,
        );
      }
    });

    it("rejects duplicate active assignment", () => {
      const role = rbac.createRole(tenantId, { name: "viewer", scopeType: "workspace", permissions: [] });

      rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      expect(() =>
        rbac.grantRole({
          principalId: "user-1",
          roleId: role.id,
          scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });
  });

  describe("revokeAssignment()", () => {
    it("revokes an active assignment", () => {
      const role = rbac.createRole(tenantId, { name: "viewer", scopeType: "tenant", permissions: [] });
      const assignment = rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      const revoked = rbac.revokeAssignment(tenantId, assignment.id);
      expect(revoked.revokedAt).toBeTypeOf("string");
    });

    it("rejects cross-tenant revocation", () => {
      const role = rbac.createRole(tenantId, { name: "viewer", scopeType: "tenant", permissions: [] });
      const assignment = rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      expect(() => rbac.revokeAssignment("other-tenant", assignment.id)).toThrow(SecurityEngineError);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PERMISSION EVALUATION — HIERARCHICAL INHERITANCE
  // ═══════════════════════════════════════════════════════════════

  describe("getEffectivePermissions()", () => {
    it("returns workspace-scope permissions", () => {
      const role = rbac.createRole(tenantId, {
        name: "ws:viewer",
        scopeType: "workspace",
        permissions: [secretRead],
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      const perms = rbac.getEffectivePermissions("user-1", tenantId, "ws-1");
      expect(perms).toHaveLength(1);
      expect(perms[0].resource).toBe("secret");
      expect(perms[0].action).toBe("read");
    });

    it("inherits tenant-scope permissions down to workspace", () => {
      const tenantRole = rbac.createRole(tenantId, {
        name: "t:member",
        scopeType: "tenant",
        permissions: [workspaceRead],
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: tenantRole.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      const perms = rbac.getEffectivePermissions("user-1", tenantId, "ws-1");
      expect(perms).toHaveLength(1);
      expect(perms[0].resource).toBe("workspace");
    });

    it("inherits system-scope permissions down to tenant/workspace", () => {
      const systemRole = rbac.createRole(null, {
        name: "system:super",
        scopeType: "system",
        permissions: [tenantAdmin],
      });

      rbac.grantRole({
        principalId: "sysadmin",
        roleId: systemRole.id,
        scope: { scopeType: "system" },
        grantedBy: "root",
      });

      const perms = rbac.getEffectivePermissions("sysadmin", tenantId, "ws-1");
      expect(perms).toHaveLength(1);
      expect(perms[0].resource).toBe("tenant");
      expect(perms[0].action).toBe("admin");
    });

    it("unions permissions from multiple role assignments", () => {
      const viewerRole = rbac.createRole(tenantId, {
        name: "ws:viewer",
        scopeType: "workspace",
        permissions: [secretRead],
      });

      const tenantRole = rbac.createRole(tenantId, {
        name: "t:member",
        scopeType: "tenant",
        permissions: [workspaceRead],
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: viewerRole.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: tenantRole.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      const perms = rbac.getEffectivePermissions("user-1", tenantId, "ws-1");
      expect(perms).toHaveLength(2);
    });

    it("excludes revoked assignments", () => {
      const role = rbac.createRole(tenantId, {
        name: "ws:viewer",
        scopeType: "workspace",
        permissions: [secretRead],
      });

      const assignment = rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      rbac.revokeAssignment(tenantId, assignment.id);

      const perms = rbac.getEffectivePermissions("user-1", tenantId, "ws-1");
      expect(perms).toHaveLength(0);
    });

    it("workspace-scope permissions do not leak to other workspaces", () => {
      const role = rbac.createRole(tenantId, {
        name: "ws:viewer",
        scopeType: "workspace",
        permissions: [secretRead],
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "workspace", tenantId, workspaceId: "ws-1" },
        grantedBy: "admin",
      });

      const permsWs1 = rbac.getEffectivePermissions("user-1", tenantId, "ws-1");
      const permsWs2 = rbac.getEffectivePermissions("user-1", tenantId, "ws-2");

      expect(permsWs1).toHaveLength(1);
      expect(permsWs2).toHaveLength(0);
    });
  });

  describe("hasPermission()", () => {
    it("returns true when principal has the permission", () => {
      const role = rbac.createRole(tenantId, {
        name: "viewer",
        scopeType: "tenant",
        permissions: [secretRead],
      });

      rbac.grantRole({
        principalId: "user-1",
        roleId: role.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      expect(rbac.hasPermission({
        principalId: "user-1",
        tenantId,
        resource: "secret",
        action: "read",
      })).toBe(true);
    });

    it("returns false when principal lacks the permission", () => {
      expect(rbac.hasPermission({
        principalId: "user-1",
        tenantId,
        resource: "secret",
        action: "write",
      })).toBe(false);
    });
  });

  describe("hasRoleAtLeast() — hierarchy dominance", () => {
    it("superadmin satisfies all hierarchy thresholds", () => {
      const superadminRole = rbac.createRole(null, {
        name: "superadmin",
        scopeType: "system",
        permissions: [],
      });
      rbac.grantRole({
        principalId: "root",
        roleId: superadminRole.id,
        scope: { scopeType: "system" },
        grantedBy: "bootstrap",
      });

      expect(rbac.hasRoleAtLeast({
        principalId: "root",
        tenantId,
        requiredRole: "viewer",
      })).toBe(true);
      expect(rbac.hasRoleAtLeast({
        principalId: "root",
        tenantId,
        requiredRole: "member",
      })).toBe(true);
      expect(rbac.hasRoleAtLeast({
        principalId: "root",
        tenantId,
        requiredRole: "workspace_admin",
        workspaceId: "ws-1",
      })).toBe(true);
      expect(rbac.hasRoleAtLeast({
        principalId: "root",
        tenantId,
        requiredRole: "tenant_admin",
      })).toBe(true);
    });

    it("member does not satisfy workspace_admin threshold", () => {
      const memberRole = rbac.createRole(tenantId, {
        name: "member",
        scopeType: "tenant",
        permissions: [],
      });
      rbac.grantRole({
        principalId: "member-user",
        roleId: memberRole.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      expect(rbac.hasRoleAtLeast({
        principalId: "member-user",
        tenantId,
        workspaceId: "ws-1",
        requiredRole: "workspace_admin",
      })).toBe(false);
    });
  });

  describe("permission check auditing", () => {
    it("emits audit entries for both allow and deny checks", () => {
      const role = rbac.createRole(tenantId, {
        name: "viewer",
        scopeType: "tenant",
        permissions: [secretRead],
      });
      rbac.grantRole({
        principalId: "audited-user",
        roleId: role.id,
        scope: { scopeType: "tenant", tenantId },
        grantedBy: "admin",
      });

      expect(rbac.hasPermission({
        principalId: "audited-user",
        tenantId,
        resource: "secret",
        action: "read",
      })).toBe(true);

      expect(rbac.hasPermission({
        principalId: "audited-user",
        tenantId,
        resource: "secret",
        action: "write",
      })).toBe(false);

      const allowAudit = auditLogger.queryAuditLog({
        tenantId,
        action: "rbac.permission.check:secret:read",
        decision: "allow",
      });
      const denyAudit = auditLogger.queryAuditLog({
        tenantId,
        action: "rbac.permission.check:secret:write",
        decision: "deny",
      });

      expect(allowAudit).toHaveLength(1);
      expect(denyAudit).toHaveLength(1);
    });
  });
});
