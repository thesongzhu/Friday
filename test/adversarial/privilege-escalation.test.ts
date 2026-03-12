/**
 * Adversarial Privilege Escalation Tests (TEST-36 through TEST-39)
 *
 * Tests RBAC bypass with undefined/null roles, scope injection via
 * crafted tokens, tenant isolation boundary evasion, and superadmin
 * role detection bypass via confusable role names.
 *
 * - TEST-36: RBAC undefined/null role and scope bypass
 * - TEST-37: Scope escalation via crafted tokens against live API
 * - TEST-38: Tenant isolation — system scope and shared scope boundaries
 * - TEST-39: Superadmin role detection bypass via confusable names
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import { principalHasAnyRole, principalHasAnyScope } from "#api";
import type { FridayRole, FridayScope } from "#api";
import { createTenantIsolationMiddleware } from "../../src/security/multi-tenant/engine/friday-tenant-isolation-middleware.js";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  createTokenWithScopes,
  type FridayApiTestEnv,
} from "../e2e/api/_helpers/friday-api-test-server.helper.js";

// ─── TEST-36: RBAC Undefined/Null Role & Scope Bypass ───

describe("TEST-36: RBAC Undefined/Null Role & Scope Bypass", () => {
  it("principalHasAnyRole returns false for undefined role", () => {
    expect(principalHasAnyRole(undefined, ["admin", "operator", "viewer"])).toBe(false);
  });

  it("principalHasAnyRole returns false for null role cast to undefined", () => {
    expect(principalHasAnyRole(null as unknown as FridayRole | undefined, ["admin"])).toBe(false);
  });

  it("principalHasAnyRole returns false for empty string role", () => {
    expect(principalHasAnyRole("" as FridayRole, ["admin", "operator"])).toBe(false);
  });

  it("principalHasAnyRole returns false when requiredRoles is empty array", () => {
    expect(principalHasAnyRole("admin", [])).toBe(false);
  });

  it("principalHasAnyScope returns false for empty principal scopes", () => {
    expect(principalHasAnyScope([], ["hub.admin", "workflow.read"])).toBe(false);
  });

  it("principalHasAnyScope returns false for empty required scopes", () => {
    expect(principalHasAnyScope(["hub.admin"], [])).toBe(false);
  });

  it("principalHasAnyScope is case-sensitive — mixed case does not match", () => {
    expect(principalHasAnyScope(["Hub.Admin" as FridayScope], ["hub.admin"])).toBe(false);
    expect(principalHasAnyScope(["HUB.ADMIN" as FridayScope], ["hub.admin"])).toBe(false);
  });

  it("principalHasAnyRole is case-sensitive — 'Admin' !== 'admin'", () => {
    expect(principalHasAnyRole("Admin" as FridayRole, ["admin"])).toBe(false);
    expect(principalHasAnyRole("ADMIN" as FridayRole, ["admin"])).toBe(false);
  });

  it("principalHasAnyScope does not match prefix/suffix variants", () => {
    expect(principalHasAnyScope(["hub.admin.extra" as FridayScope], ["hub.admin"])).toBe(false);
    expect(principalHasAnyScope(["extra.hub.admin" as FridayScope], ["hub.admin"])).toBe(false);
  });
});

// ─── TEST-37: Scope Escalation via Crafted Tokens Against Live API ───

describe("TEST-37: Scope Escalation via Crafted Tokens Against Live API", () => {
  let env: FridayApiTestEnv;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
  });

  afterAll(async () => {
    await env?.close();
  });

  it("viewer-scoped token cannot access admin-only security center", async () => {
    const viewerToken = createTokenWithScopes(
      ["workflow.read", "session.read"],
      { role: "viewer" },
    );

    const res = await fetch(`${env.baseUrl}/v1/security/center`, {
      headers: authHeaders(viewerToken),
    });

    // security.read is required — viewer has it in ROLE_SCOPES but
    // the crafted token only has workflow.read + session.read
    expect(res.status).toBe(403);
  });

  it("operator-scoped token cannot write to security settings", async () => {
    const operatorToken = createTokenWithScopes(
      ["workflow.read", "workflow.write", "agent.read"],
      { role: "operator" },
    );

    const res = await fetch(`${env.baseUrl}/v1/security/tokens/revoke`, {
      method: "POST",
      headers: authHeaders(operatorToken),
      body: JSON.stringify({ tokenId: "some-token-id" }),
    });

    // security.write is required — operator does not have it
    expect(res.status).toBe(403);
  });

  it("token with no scopes cannot access scope-protected endpoints", async () => {
    const noScopeToken = createTokenWithScopes([], { role: "viewer" });

    // Use endpoints that require specific scopes
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      headers: authHeaders(noScopeToken),
    });

    // Endpoint requires session.read scope — token has none → 403
    expect(res.status).toBe(403);
  });

  it("token with wildcard-looking scope string does not grant access", async () => {
    const wildcardToken = createTokenWithScopes(
      ["*" as FridayScope, "*.read" as FridayScope, "hub.*" as FridayScope],
      { role: "viewer" },
    );

    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      headers: authHeaders(wildcardToken),
    });

    // Wildcard strings are not real scopes — must be rejected
    expect(res.status).toBe(403);
  });
});

// ─── TEST-38: Tenant Isolation — System Scope & Shared Scope Boundaries ───

describe("TEST-38: Tenant Isolation — System Scope & Shared Scope Boundaries", () => {
  const middleware = createTenantIsolationMiddleware();

  it("principal without system or shared scope cannot access other tenant", () => {
    const principal = middleware.extractTenantContext({
      principalId: "user-1",
      tenantId: "tenant-A",
      roles: ["operator"],
      scopes: ["workflow.read", "workflow.write"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-B",
      principal,
      scopes: ["workflow.read", "workflow.write"],
    });

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Tenant boundary violated");
  });

  it("principal with hub.admin (system scope) CAN access other tenant", () => {
    const principal = middleware.extractTenantContext({
      principalId: "admin-1",
      tenantId: "tenant-A",
      roles: ["admin"],
      scopes: ["hub.admin"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-B",
      principal,
      scopes: ["hub.admin"],
    });

    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("System scope bypass");
  });

  it("principal with fleet.read (shared scope) CAN access other tenant", () => {
    const principal = middleware.extractTenantContext({
      principalId: "monitor-1",
      tenantId: "tenant-A",
      roles: ["viewer"],
      scopes: ["fleet.read"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-B",
      principal,
      scopes: ["fleet.read"],
    });

    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Shared scope bypass");
  });

  it("non-standard scope 'hub.admin.extra' does NOT grant system bypass", () => {
    const principal = middleware.extractTenantContext({
      principalId: "attacker-1",
      tenantId: "tenant-A",
      roles: ["viewer"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-B",
      principal,
      scopes: ["hub.admin.extra"],
    });

    expect(result.decision).toBe("deny");
  });

  it("non-standard scope 'fleet.read.all' does NOT grant shared bypass", () => {
    const principal = middleware.extractTenantContext({
      principalId: "attacker-2",
      tenantId: "tenant-A",
      roles: ["viewer"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-B",
      principal,
      scopes: ["fleet.read.all"],
    });

    expect(result.decision).toBe("deny");
  });

  it("principal with null tenantId cannot access any tenant", () => {
    const principal = middleware.extractTenantContext({
      principalId: "orphan-user",
      tenantId: null,
      roles: ["viewer"],
    });

    const result = middleware.validateTenantBoundary({
      routeTenantId: "tenant-A",
      principal,
      scopes: [],
    });

    // null !== "tenant-A", so boundary check should deny
    expect(result.decision).toBe("deny");
  });

  it("deny events are recorded and accessible", () => {
    const freshMiddleware = createTenantIsolationMiddleware();

    const principal = freshMiddleware.extractTenantContext({
      principalId: "denied-user",
      tenantId: "tenant-X",
      roles: ["viewer"],
    });

    freshMiddleware.validateTenantBoundary({
      routeTenantId: "tenant-Y",
      principal,
      scopes: [],
    });

    const denyEvents = freshMiddleware.getDenyEvents();
    expect(denyEvents.length).toBe(1);
    expect(denyEvents[0]!.decision).toBe("deny");
    expect(denyEvents[0]!.principalTenantId).toBe("tenant-X");
    expect(denyEvents[0]!.routeTenantId).toBe("tenant-Y");
  });
});

// ─── TEST-39: Superadmin Role Detection Bypass via Confusable Names ───

describe("TEST-39: Superadmin Role Detection Bypass via Confusable Names", () => {
  const middleware = createTenantIsolationMiddleware();

  // The isSuperadmin check normalizes: trim → lowercase → replace /[:\s-]+/g with "_"
  // then checks `.includes("superadmin")`. So after normalization:
  // - "superadmin" → "superadmin" → matches
  // - "SUPERADMIN" → "superadmin" → matches
  // - "SuperAdmin" → "superadmin" → matches
  // - "super_admin" → "super_admin" → does NOT match (underscore preserved, not in regex)
  // - "super-admin" → "super_admin" → does NOT match (- replaced with _)
  // - "super admin" → "super_admin" → does NOT match (space replaced with _)
  // - "super:admin" → "super_admin" → does NOT match (: replaced with _)
  // - "globalSuperAdmin" → "globalsuperadmin" → matches (contains "superadmin")
  const legitimateSuperadminRoles = [
    "superadmin",
    "SUPERADMIN",
    "SuperAdmin",
    "globalSuperAdmin",
    "superadmin_global",
  ];

  it.each(legitimateSuperadminRoles)(
    "detects superadmin from role variant: %s",
    (role) => {
      const principal = middleware.extractTenantContext({
        principalId: "admin-user",
        tenantId: "tenant-A",
        roles: [role],
      });

      expect(principal.isSuperadmin).toBe(true);
    },
  );

  // These do NOT match because the regex replaces separators with "_",
  // and "super_admin" does not contain the substring "superadmin".
  // This is important: an attacker with role "super-admin" (hyphenated)
  // will NOT get superadmin privileges.
  const confusableButNonSuperadminRoles = [
    "super_admin",
    "super-admin",
    "super admin",
    "super:admin",
  ];

  it.each(confusableButNonSuperadminRoles)(
    "does NOT detect superadmin from confusable role: %s (separator normalizes to underscore)",
    (role) => {
      const principal = middleware.extractTenantContext({
        principalId: "confusable-user",
        tenantId: "tenant-A",
        roles: [role],
      });

      expect(principal.isSuperadmin).toBe(false);
    },
  );

  const nonSuperadminRoles = [
    "admin",
    "owner",
    "root",
    "sysadmin",
    "administrator",
    "super",
    "viewer",
    "operator",
  ];

  it.each(nonSuperadminRoles)(
    "does NOT detect superadmin from role: %s",
    (role) => {
      const principal = middleware.extractTenantContext({
        principalId: "regular-user",
        tenantId: "tenant-A",
        roles: [role],
      });

      expect(principal.isSuperadmin).toBe(false);
    },
  );

  it("superadmin detected even if mixed with non-admin roles", () => {
    const principal = middleware.extractTenantContext({
      principalId: "mixed-user",
      tenantId: "tenant-A",
      roles: ["viewer", "operator", "superadmin"],
    });

    expect(principal.isSuperadmin).toBe(true);
  });

  it("superadmin with null tenantId can access any tenant (cross-boundary)", () => {
    const principal = middleware.extractTenantContext({
      principalId: "global-admin",
      tenantId: null,
      roles: ["superadmin"],
    });

    expect(principal.isSuperadmin).toBe(true);

    const result = middleware.validateTenantBoundary({
      routeTenantId: "any-tenant-id",
      principal,
      scopes: [],
    });

    expect(result.decision).toBe("allow");
    expect(result.isSuperadmin).toBe(true);
  });

  it("empty roles array does not grant superadmin", () => {
    const principal = middleware.extractTenantContext({
      principalId: "no-role-user",
      tenantId: "tenant-A",
      roles: [],
    });

    expect(principal.isSuperadmin).toBe(false);
  });

  it("undefined roles array does not grant superadmin", () => {
    const principal = middleware.extractTenantContext({
      principalId: "undefined-role-user",
      tenantId: "tenant-A",
    });

    expect(principal.isSuperadmin).toBe(false);
  });
});
