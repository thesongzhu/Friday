import { describe, it, expect, beforeEach } from "vitest";
import { TenantManager } from "../../../../../src/security/multi-tenant/engine/tenant-manager.js";
import { AuditLogger } from "../../../../../src/security/multi-tenant/engine/audit-logger.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";

describe("TenantManager", () => {
  let auditLogger: AuditLogger;
  let manager: TenantManager;
  const superadminActor = { principalId: "root", roles: ["superadmin"] };
  const tenantAdminActor = { principalId: "tenant-admin", roles: ["tenant_admin"] };
  const workspaceAdminActor = { principalId: "workspace-admin", roles: ["workspace_admin"] };

  beforeEach(() => {
    auditLogger = new AuditLogger();
    manager = new TenantManager(auditLogger);
  });

  // ═══════════════════════════════════════════════════════════════
  // TENANT CRUD
  // ═══════════════════════════════════════════════════════════════

  describe("createTenant()", () => {
    it("creates a tenant with default config", () => {
      const tenant = manager.createTenant({ name: "Acme", slug: "acme" }, superadminActor);

      expect(tenant.id).toBeTypeOf("string");
      expect(tenant.name).toBe("Acme");
      expect(tenant.slug).toBe("acme");
      expect(tenant.status).toBe("provisioning");
      expect(tenant.config.maxWorkspaces).toBe(50);
      expect(tenant.config.maxMembers).toBe(500);
      expect(tenant.config.maxSecretsPerWorkspace).toBe(200);
      expect(tenant.config.auditRetentionDays).toBe(90);
      expect(tenant.etag).toBeTypeOf("string");
      expect(tenant.createdAt).toBeTypeOf("string");
    });

    it("applies custom config overrides", () => {
      const tenant = manager.createTenant({
        name: "Custom",
        slug: "custom",
        maxWorkspaces: 10,
        maxMembers: 100,
        auditRetentionDays: 30,
        featureFlags: { beta: true },
      }, superadminActor);

      expect(tenant.config.maxWorkspaces).toBe(10);
      expect(tenant.config.maxMembers).toBe(100);
      expect(tenant.config.auditRetentionDays).toBe(30);
      expect(tenant.config.featureFlags).toEqual({ beta: true });
    });

    it("rejects duplicate slugs", () => {
      manager.createTenant({ name: "A", slug: "acme" }, superadminActor);

      expect(() => manager.createTenant({ name: "B", slug: "acme" }, superadminActor)).toThrow(SecurityEngineError);
      try {
        manager.createTenant({ name: "B", slug: "acme" }, superadminActor);
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_SLUG_CONFLICT,
        );
      }
    });

    it("generates audit entry on create", () => {
      const tenant = manager.createTenant({ name: "Audited", slug: "audited" }, superadminActor);
      const entries = auditLogger.queryAuditLog({ tenantId: tenant.id });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("tenant.create");
    });
  });

  describe("getTenant()", () => {
    it("retrieves an existing tenant", () => {
      const created = manager.createTenant({ name: "Get", slug: "get" }, superadminActor);
      const fetched = manager.getTenant(created.id, superadminActor);
      expect(fetched.id).toBe(created.id);
    });

    it("throws TENANT_NOT_FOUND for missing tenant", () => {
      expect(() => manager.getTenant("nonexistent", superadminActor)).toThrow(SecurityEngineError);
    });

    it("throws TENANT_NOT_FOUND for deleted tenant", () => {
      const tenant = manager.createTenant({ name: "Del", slug: "del" }, superadminActor);
      manager.deleteTenant(tenant.id, tenant.etag, superadminActor);
      expect(() => manager.getTenant(tenant.id, superadminActor)).toThrow(SecurityEngineError);
    });

    it("returns immutable snapshots", () => {
      const created = manager.createTenant({ name: "Immutable", slug: "immutable" }, superadminActor);
      const fetched = manager.getTenant(created.id, superadminActor);

      expect(Object.isFrozen(fetched)).toBe(true);
      expect(() => {
        (fetched as { name: string }).name = "mutated";
      }).toThrow(TypeError);
    });
  });

  describe("updateTenant()", () => {
    it("updates tenant with correct etag", () => {
      const created = manager.createTenant({ name: "Old", slug: "upd" }, superadminActor);
      const updated = manager.updateTenant(created.id, {
        name: "New",
        status: "active",
        etag: created.etag,
      }, superadminActor);

      expect(updated.name).toBe("New");
      expect(updated.status).toBe("active");
      expect(updated.etag).not.toBe(created.etag);
    });

    it("rejects update with stale etag", () => {
      const created = manager.createTenant({ name: "Stale", slug: "stale" }, superadminActor);

      expect(() =>
        manager.updateTenant(created.id, { name: "New", etag: "wrong-etag" }, superadminActor),
      ).toThrow(SecurityEngineError);

      try {
        manager.updateTenant(created.id, { name: "New", etag: "wrong-etag" }, superadminActor);
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        );
      }
    });
  });

  describe("tenant CRUD authorization", () => {
    it("denies tenant CRUD for non-superadmin", () => {
      expect(() =>
        manager.createTenant({ name: "Denied", slug: "denied" }, tenantAdminActor),
      ).toThrow(SecurityEngineError);
    });

    it("does not authorize tenant CRUD from role-name substrings", () => {
      expect(() =>
        manager.createTenant(
          { name: "Substring", slug: "substring" },
          { principalId: "fake-root", roles: ["not-superadmin"] },
        ),
      ).toThrow(SecurityEngineError);
    });

    it("allows tenant CRUD for superadmin", () => {
      const created = manager.createTenant({ name: "Allowed", slug: "allowed" }, superadminActor);
      const fetched = manager.getTenant(created.id, superadminActor);
      const updated = manager.updateTenant(created.id, { name: "Allowed 2", etag: created.etag }, superadminActor);
      const deleted = manager.deleteTenant(created.id, updated.etag, superadminActor);

      expect(fetched.id).toBe(created.id);
      expect(updated.name).toBe("Allowed 2");
      expect(deleted.deletedAt).toBeTypeOf("string");
    });
  });

  describe("deleteTenant()", () => {
    it("soft-deletes a tenant", () => {
      const created = manager.createTenant({ name: "Delete", slug: "delete" }, superadminActor);
      const deleted = manager.deleteTenant(created.id, created.etag, superadminActor);

      expect(deleted.status).toBe("deactivated");
      expect(deleted.deletedAt).toBeTypeOf("string");
    });
  });

  describe("listTenants()", () => {
    it("returns non-deleted tenants", () => {
      const t1 = manager.createTenant({ name: "A", slug: "a" }, superadminActor);
      manager.createTenant({ name: "B", slug: "b" }, superadminActor);
      manager.deleteTenant(t1.id, t1.etag, superadminActor);

      const tenants = manager.listTenants(superadminActor);
      expect(tenants).toHaveLength(1);
      expect(tenants[0].slug).toBe("b");
    });

    it("filters by status", () => {
      const t = manager.createTenant({ name: "A", slug: "a" }, superadminActor);
      manager.updateTenant(t.id, { status: "active", etag: t.etag }, superadminActor);
      manager.createTenant({ name: "B", slug: "b" }, superadminActor); // provisioning

      const active = manager.listTenants(superadminActor, "active");
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe("active");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // WORKSPACE CRUD
  // ═══════════════════════════════════════════════════════════════

  describe("createWorkspace()", () => {
    it("creates a workspace within a tenant", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      expect(ws.id).toBeTypeOf("string");
      expect(ws.tenantId).toBe(tenant.id);
      expect(ws.name).toBe("Dev");
      expect(ws.slug).toBe("dev");
      expect(ws.status).toBe("active");
    });

    it("rejects duplicate workspace slugs within tenant", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      expect(() =>
        manager.createWorkspace(tenant.id, { name: "Dev 2", slug: "dev" }, superadminActor),
      ).toThrow(SecurityEngineError);
    });

    it("allows same slug in different tenants", () => {
      const t1 = manager.createTenant({ name: "T1", slug: "t1" }, superadminActor);
      const t2 = manager.createTenant({ name: "T2", slug: "t2" }, superadminActor);

      const ws1 = manager.createWorkspace(t1.id, { name: "Dev", slug: "dev" }, superadminActor);
      const ws2 = manager.createWorkspace(t2.id, { name: "Dev", slug: "dev" }, superadminActor);

      expect(ws1.tenantId).toBe(t1.id);
      expect(ws2.tenantId).toBe(t2.id);
    });

    it("enforces workspace limit", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t", maxWorkspaces: 2 }, superadminActor);
      manager.createWorkspace(tenant.id, { name: "A", slug: "a" }, superadminActor);
      manager.createWorkspace(tenant.id, { name: "B", slug: "b" }, superadminActor);

      expect(() =>
        manager.createWorkspace(tenant.id, { name: "C", slug: "c" }, superadminActor),
      ).toThrow(SecurityEngineError);

      try {
        manager.createWorkspace(tenant.id, { name: "C", slug: "c" }, superadminActor);
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.WORKSPACE_LIMIT_EXCEEDED,
        );
      }
    });
  });

  describe("workspace CRUD authorization", () => {
    it("denies workspace CRUD for workspace_admin", () => {
      const tenant = manager.createTenant({ name: "Auth", slug: "auth" }, superadminActor);
      expect(() =>
        manager.createWorkspace(tenant.id, { name: "Denied", slug: "denied" }, workspaceAdminActor),
      ).toThrow(SecurityEngineError);
    });

    it("allows workspace CRUD for tenant_admin", () => {
      const tenant = manager.createTenant({ name: "Auth2", slug: "auth2" }, superadminActor);
      const workspace = manager.createWorkspace(
        tenant.id,
        { name: "Allowed", slug: "allowed" },
        tenantAdminActor,
      );
      const fetched = manager.getWorkspace(tenant.id, workspace.id, tenantAdminActor);
      const updated = manager.updateWorkspace(
        tenant.id,
        workspace.id,
        { name: "Allowed Updated", etag: workspace.etag },
        tenantAdminActor,
      );
      const deleted = manager.deleteWorkspace(tenant.id, workspace.id, updated.etag, tenantAdminActor);

      expect(fetched.id).toBe(workspace.id);
      expect(updated.name).toBe("Allowed Updated");
      expect(deleted.deletedAt).toBeTypeOf("string");
    });
  });

  describe("getWorkspace() — tenant isolation", () => {
    it("retrieves a workspace within the correct tenant", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);
      const fetched = manager.getWorkspace(tenant.id, ws.id, superadminActor);
      expect(fetched.id).toBe(ws.id);
    });

    it("rejects cross-tenant workspace access", () => {
      const t1 = manager.createTenant({ name: "T1", slug: "t1" }, superadminActor);
      const t2 = manager.createTenant({ name: "T2", slug: "t2" }, superadminActor);
      const ws = manager.createWorkspace(t1.id, { name: "Dev", slug: "dev" }, superadminActor);

      expect(() => manager.getWorkspace(t2.id, ws.id, superadminActor)).toThrow(SecurityEngineError);
      const denies = auditLogger.queryAuditLog({
        tenantId: t2.id,
        action: "workspace.get",
        decision: "deny",
      });
      expect(denies).toHaveLength(1);
    });

    it("rejects workspace reads when tenant is deactivated", () => {
      const tenant = manager.createTenant({ name: "T", slug: "deactivate-read" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);
      const updatedTenant = manager.updateTenant(tenant.id, {
        status: "deactivated",
        etag: tenant.etag,
      }, superadminActor);

      expect(() => manager.getWorkspace(updatedTenant.id, ws.id, superadminActor)).toThrow(SecurityEngineError);
      try {
        manager.getWorkspace(updatedTenant.id, ws.id, superadminActor);
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_INVALID_STATE,
        );
      }
    });
  });

  describe("deleteWorkspace()", () => {
    it("soft-deletes a workspace", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Del", slug: "del" }, superadminActor);
      const deleted = manager.deleteWorkspace(tenant.id, ws.id, ws.etag, superadminActor);

      expect(deleted.status).toBe("archived");
      expect(deleted.deletedAt).toBeTypeOf("string");
    });

    it("revokes memberships when workspace is deleted", () => {
      const tenant = manager.createTenant({ name: "T", slug: "delete-members" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);
      const membership = manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      manager.deleteWorkspace(tenant.id, ws.id, ws.etag, superadminActor);

      const fetchedMembership = manager.getMembership(tenant.id, membership.id);
      expect(fetchedMembership.revokedAt).toBeTypeOf("string");
      expect(manager.countMembers(tenant.id)).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // MEMBERSHIP MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  describe("addMember()", () => {
    it("adds a member to a workspace", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      const membership = manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      expect(membership.id).toBeTypeOf("string");
      expect(membership.tenantId).toBe(tenant.id);
      expect(membership.workspaceId).toBe(ws.id);
      expect(membership.principalId).toBe("user-1");
      expect(membership.roleId).toBe("role-viewer");
      expect(membership.grantedBy).toBe("admin");
      expect(membership.revokedAt).toBeUndefined();
    });

    it("rejects duplicate active membership (same principal+role)", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      expect(() =>
        manager.addMember(tenant.id, ws.id, {
          principalId: "user-1",
          roleId: "role-viewer",
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("allows same principal with different roles", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      const m1 = manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });
      const m2 = manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-editor",
        grantedBy: "admin",
      });

      expect(m1.id).not.toBe(m2.id);
    });

    it("rejects membership for cross-tenant workspace", () => {
      const t1 = manager.createTenant({ name: "T1", slug: "t1" }, superadminActor);
      const t2 = manager.createTenant({ name: "T2", slug: "t2" }, superadminActor);
      const ws = manager.createWorkspace(t1.id, { name: "Dev", slug: "dev" }, superadminActor);

      expect(() =>
        manager.addMember(t2.id, ws.id, {
          principalId: "user-1",
          roleId: "role-viewer",
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });

    it("enforces member limit", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t", maxMembers: 1 }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      expect(() =>
        manager.addMember(tenant.id, ws.id, {
          principalId: "user-2",
          roleId: "role-viewer",
          grantedBy: "admin",
        }),
      ).toThrow(SecurityEngineError);
    });
  });

  describe("revokeMembership()", () => {
    it("revokes an active membership", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);
      const m = manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      const revoked = manager.revokeMembership(tenant.id, ws.id, m.id);
      expect(revoked.revokedAt).toBeTypeOf("string");
    });

    it("rejects cross-tenant revocation", () => {
      const t1 = manager.createTenant({ name: "T1", slug: "t1" }, superadminActor);
      const t2 = manager.createTenant({ name: "T2", slug: "t2" }, superadminActor);
      const ws = manager.createWorkspace(t1.id, { name: "Dev", slug: "dev" }, superadminActor);
      const m = manager.addMember(t1.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      expect(() => manager.revokeMembership(t2.id, ws.id, m.id)).toThrow(SecurityEngineError);
    });
  });

  describe("listMembers()", () => {
    it("lists active members of a workspace", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      const m1 = manager.addMember(tenant.id, ws.id, { principalId: "u1", roleId: "r1", grantedBy: "admin" });
      manager.addMember(tenant.id, ws.id, { principalId: "u2", roleId: "r1", grantedBy: "admin" });
      manager.revokeMembership(tenant.id, ws.id, m1.id);

      const members = manager.listMembers(tenant.id, ws.id);
      expect(members).toHaveLength(1);
      expect(members[0].principalId).toBe("u2");
    });

    it("includes revoked when requested", () => {
      const tenant = manager.createTenant({ name: "T", slug: "t" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);

      const m1 = manager.addMember(tenant.id, ws.id, { principalId: "u1", roleId: "r1", grantedBy: "admin" });
      manager.addMember(tenant.id, ws.id, { principalId: "u2", roleId: "r1", grantedBy: "admin" });
      manager.revokeMembership(tenant.id, ws.id, m1.id);

      const members = manager.listMembers(tenant.id, ws.id, { includeRevoked: true });
      expect(members).toHaveLength(2);
    });

    it("rejects member reads when tenant is deactivated", () => {
      const tenant = manager.createTenant({ name: "T", slug: "member-read" }, superadminActor);
      const ws = manager.createWorkspace(tenant.id, { name: "Dev", slug: "dev" }, superadminActor);
      manager.addMember(tenant.id, ws.id, {
        principalId: "user-1",
        roleId: "role-viewer",
        grantedBy: "admin",
      });

      const updatedTenant = manager.updateTenant(tenant.id, {
        status: "deactivated",
        etag: tenant.etag,
      }, superadminActor);

      expect(() => manager.listMembers(updatedTenant.id, ws.id)).toThrow(SecurityEngineError);
    });
  });

  describe("countMembers()", () => {
    it("counts only memberships in active workspaces", () => {
      const tenant = manager.createTenant({ name: "T", slug: "member-count" }, superadminActor);
      const wsActive = manager.createWorkspace(tenant.id, { name: "Active", slug: "active" }, superadminActor);
      const wsArchived = manager.createWorkspace(tenant.id, { name: "Archive", slug: "archive" }, superadminActor);

      manager.addMember(tenant.id, wsActive.id, {
        principalId: "user-active",
        roleId: "role-viewer",
        grantedBy: "admin",
      });
      manager.addMember(tenant.id, wsArchived.id, {
        principalId: "user-archived",
        roleId: "role-viewer",
        grantedBy: "admin",
      });
      manager.updateWorkspace(tenant.id, wsArchived.id, {
        status: "archived",
        etag: wsArchived.etag,
      }, superadminActor);

      expect(manager.countMembers(tenant.id)).toBe(1);
    });
  });
});
