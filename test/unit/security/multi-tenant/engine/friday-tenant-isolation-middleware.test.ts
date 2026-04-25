/**
 * B-001 Tenant Isolation Middleware Tests
 *
 * Validates principal context extraction, tenant boundary enforcement,
 * superadmin/system/shared scope bypasses, audit logging, and deny tracking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTenantIsolationMiddleware,
  type TenantPrincipalContext,
  type TenantIsolationMiddlewareDeps,
  type ScopeFixtures,
} from "../../../../../src/security/multi-tenant/engine/friday-tenant-isolation-middleware.js";

// ─── Helpers ───

function makeDeps(overrides: Partial<TenantIsolationMiddlewareDeps> = {}): TenantIsolationMiddlewareDeps {
  return {
    auditLogger: { log: vi.fn() },
    nowIso: () => "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makePrincipal(overrides: Partial<TenantPrincipalContext> = {}): TenantPrincipalContext {
  return {
    principalId: "user-1",
    tenantId: "tenant-a",
    roles: ["member"],
    isSuperadmin: false,
    ...overrides,
  };
}

// ─── Tests ───

describe("B-001 FridayTenantIsolationMiddleware", () => {
  describe("extractTenantContext", () => {
    it("extracts basic tenant context from claims", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const ctx = mw.extractTenantContext({
        principalId: "user-42",
        tenantId: "tenant-x",
        workspaceId: "ws-1",
        roles: ["editor"],
      });

      expect(ctx.principalId).toBe("user-42");
      expect(ctx.tenantId).toBe("tenant-x");
      expect(ctx.workspaceId).toBe("ws-1");
      expect(ctx.roles).toEqual(["editor"]);
      expect(ctx.isSuperadmin).toBe(false);
    });

    it("sets tenantId to null when not provided", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const ctx = mw.extractTenantContext({
        principalId: "system-agent",
      });

      expect(ctx.tenantId).toBeNull();
    });

    it("sets tenantId to null when explicitly null", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const ctx = mw.extractTenantContext({
        principalId: "system-agent",
        tenantId: null,
      });

      expect(ctx.tenantId).toBeNull();
    });

    it("defaults roles to empty array", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const ctx = mw.extractTenantContext({
        principalId: "user-1",
        tenantId: "tenant-a",
      });

      expect(ctx.roles).toEqual([]);
    });

    it("detects superadmin from role list", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const ctx = mw.extractTenantContext({
        principalId: "admin-1",
        tenantId: "tenant-a",
        roles: ["member", "superadmin"],
      });

      expect(ctx.isSuperadmin).toBe(true);
    });

    it("detects superadmin with normalized role names", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      // Colon-prefixed (role:superadmin → role_superadmin → includes "superadmin")
      expect(mw.extractTenantContext({
        principalId: "a", roles: ["role:superadmin"],
      }).isSuperadmin).toBe(true);

      // Uppercase
      expect(mw.extractTenantContext({
        principalId: "a", roles: ["SUPERADMIN"],
      }).isSuperadmin).toBe(true);

      // Hyphenated becomes super_admin — does NOT match (underscore splits the word)
      expect(mw.extractTenantContext({
        principalId: "a", roles: ["super-admin"],
      }).isSuperadmin).toBe(false);

      expect(mw.extractTenantContext({
        principalId: "a", roles: ["not-superadmin"],
      }).isSuperadmin).toBe(false);
    });
  });

  describe("validateTenantBoundary — allow", () => {
    it("allows when tenant matches", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-a",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("passed");
      expect(result.audited).toBe(true);
      expect(deps.auditLogger!.log).toHaveBeenCalledOnce();
    });

    it("allows superadmin cross-tenant access", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a", isSuperadmin: true }),
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Superadmin");
      expect(result.isSuperadmin).toBe(true);
    });

    it("allows system scope bypass", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
        scopes: ["hub.admin"],
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("System scope");
    });

    it("allows shared scope bypass", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
        scopes: ["fleet.read"],
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Shared scope");
    });
  });

  describe("validateTenantBoundary — deny", () => {
    it("denies cross-tenant access without bypass", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("tenant-a");
      expect(result.reason).toContain("tenant-b");
      expect(result.audited).toBe(true);
    });

    it("denies null-tenant principal accessing a tenant route", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: null }),
      });

      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("none");
    });

    it("records deny events", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });
      mw.validateTenantBoundary({
        routeTenantId: "tenant-c",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      const denies = mw.getDenyEvents();
      expect(denies).toHaveLength(2);
      expect(denies[0].routeTenantId).toBe("tenant-b");
      expect(denies[1].routeTenantId).toBe("tenant-c");
    });
  });

  describe("audit logging", () => {
    it("logs all allow decisions", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      mw.validateTenantBoundary({
        routeTenantId: "tenant-a",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(deps.auditLogger!.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-a",
          principalId: "user-1",
          action: "tenant.isolation.boundary",
          resourceType: "tenant",
          decision: "allow",
        }),
      );
    });

    it("logs deny decisions", () => {
      const deps = makeDeps();
      const mw = createTenantIsolationMiddleware(deps);

      mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(deps.auditLogger!.log).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deny",
          resourceId: "tenant-b",
        }),
      );
    });

    it("works without audit logger", () => {
      const mw = createTenantIsolationMiddleware({});

      // Should not throw
      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(result.decision).toBe("deny");
    });
  });

  describe("scope helpers", () => {
    it("identifies shared scopes", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      expect(mw.isSharedScope("fleet.read")).toBe(true);
      expect(mw.isSharedScope("workflow.read")).toBe(false);
    });

    it("identifies system scopes", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      expect(mw.isSystemScope("hub.admin")).toBe(true);
      expect(mw.isSystemScope("fleet.read")).toBe(false);
    });

    it("respects custom scope fixtures", () => {
      const fixtures: ScopeFixtures = {
        sharedScopes: ["custom.shared"],
        systemScopes: ["custom.system"],
      };
      const mw = createTenantIsolationMiddleware(makeDeps({ scopeFixtures: fixtures }));

      expect(mw.isSharedScope("custom.shared")).toBe(true);
      expect(mw.isSharedScope("fleet.read")).toBe(false);
      expect(mw.isSystemScope("custom.system")).toBe(true);
      expect(mw.isSystemScope("hub.admin")).toBe(false);
    });
  });

  describe("bypass priority", () => {
    it("superadmin takes priority over scope checks", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a", isSuperadmin: true }),
        scopes: ["hub.admin", "fleet.read"],
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("Superadmin");
      expect(result.isSuperadmin).toBe(true);
    });

    it("system scope takes priority over shared scope", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
        scopes: ["hub.admin", "fleet.read"],
      });

      expect(result.decision).toBe("allow");
      expect(result.reason).toContain("System scope");
    });
  });

  describe("reset", () => {
    it("clears deny events", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });
      expect(mw.getDenyEvents()).toHaveLength(1);

      mw.reset();
      expect(mw.getDenyEvents()).toHaveLength(0);
    });
  });

  describe("result structure", () => {
    it("includes all required fields in allow result", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-a",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(result).toEqual({
        decision: "allow",
        reason: expect.any(String),
        routeTenantId: "tenant-a",
        principalTenantId: "tenant-a",
        isSuperadmin: false,
        audited: true,
      });
    });

    it("includes all required fields in deny result", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      const result = mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      expect(result).toEqual({
        decision: "deny",
        reason: expect.any(String),
        routeTenantId: "tenant-b",
        principalTenantId: "tenant-a",
        isSuperadmin: false,
        audited: true,
      });
    });

    it("getDenyEvents returns a copy (not mutable reference)", () => {
      const mw = createTenantIsolationMiddleware(makeDeps());

      mw.validateTenantBoundary({
        routeTenantId: "tenant-b",
        principal: makePrincipal({ tenantId: "tenant-a" }),
      });

      const events = mw.getDenyEvents();
      events.length = 0; // mutate the returned array

      expect(mw.getDenyEvents()).toHaveLength(1); // original unchanged
    });
  });
});
