/**
 * B-001 Tenant Isolation Middleware — bridges the existing multi-tenant
 * security engine (RoutingGuard, RbacEngine) into the HTTP auth middleware
 * chain.
 *
 * Extends the auth principal with tenantId/workspaceId context, validates
 * tenant boundary on routed requests, audits deny events, and supports
 * shared/system scope fixtures.
 *
 * @module security/multi-tenant/engine
 */

import type { UUID } from "../model/friday-multi-tenant-security.types.js";
import { assertTenantRouteBoundary, type RoutingAuthContext } from "./routing-guard.js";
import type { AuditLogger, CreateAuditEntryInput } from "./audit-logger.js";

// ─── Extended Principal Context ───

export interface TenantPrincipalContext {
  /** Authenticated principal ID. */
  principalId: string;
  /** Tenant the principal belongs to. Null for system-level principals. */
  tenantId: UUID | null;
  /** Workspace within the tenant (optional). */
  workspaceId?: UUID;
  /** Roles assigned to this principal (hierarchical). */
  roles: readonly string[];
  /** Whether this principal has superadmin access. */
  isSuperadmin: boolean;
}

// ─── Isolation Decision ───

export type IsolationDecision = "allow" | "deny";

export interface TenantIsolationResult {
  decision: IsolationDecision;
  reason: string;
  routeTenantId: string | null;
  principalTenantId: string | null;
  isSuperadmin: boolean;
  audited: boolean;
}

// ─── Shared / System Scope Fixtures ───

/**
 * Scope fixtures define which scopes are considered "shared" (cross-tenant)
 * or "system" (global). Shared scopes bypass tenant boundary checks.
 */
export interface ScopeFixtures {
  /** Scopes that allow cross-tenant access (e.g., fleet monitoring). */
  sharedScopes: readonly string[];
  /** Scopes that grant system-wide access (e.g., hub.admin). */
  systemScopes: readonly string[];
}

const DEFAULT_SCOPE_FIXTURES: ScopeFixtures = {
  sharedScopes: ["fleet.read"],
  systemScopes: ["hub.admin"],
};

// ─── Dependencies ───

export interface TenantIsolationMiddlewareDeps {
  /** Audit logger for recording isolation decisions. */
  auditLogger?: {
    log: (input: CreateAuditEntryInput) => void;
  };
  /** Scope fixtures for shared/system access. */
  scopeFixtures?: ScopeFixtures;
  /** Clock function. */
  nowIso?: () => string;
}

// ─── Interface ───

export interface FridayTenantIsolationMiddleware {
  /**
   * Extract tenant context from an auth principal's claims.
   * Returns a TenantPrincipalContext enriched with tenant/workspace info.
   */
  extractTenantContext(params: {
    principalId: string;
    tenantId?: string | null;
    workspaceId?: string;
    roles?: readonly string[];
    scopes?: readonly string[];
  }): TenantPrincipalContext;

  /**
   * Validate that a request's route tenant matches the principal's tenant.
   * Superadmins and shared-scope holders bypass the check.
   */
  validateTenantBoundary(params: {
    routeTenantId: string;
    principal: TenantPrincipalContext;
    scopes?: readonly string[];
  }): TenantIsolationResult;

  /**
   * Check if a scope is shared (allows cross-tenant access).
   */
  isSharedScope(scope: string): boolean;

  /**
   * Check if a scope is system-level (grants global access).
   */
  isSystemScope(scope: string): boolean;

  /**
   * Get all deny events recorded since creation.
   */
  getDenyEvents(): TenantIsolationResult[];

  /**
   * Reset internal state.
   */
  reset(): void;
}

// ─── Factory ───

export function createTenantIsolationMiddleware(
  deps: TenantIsolationMiddlewareDeps = {},
): FridayTenantIsolationMiddleware {
  const fixtures = deps.scopeFixtures ?? DEFAULT_SCOPE_FIXTURES;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const sharedScopeSet = new Set(fixtures.sharedScopes);
  const systemScopeSet = new Set(fixtures.systemScopes);

  const denyEvents: TenantIsolationResult[] = [];

  function isSuperadmin(roles: readonly string[]): boolean {
    for (const role of roles) {
      const normalized = role.trim().toLowerCase().replaceAll(/[:\s-]+/g, "_");
      if (normalized.includes("superadmin")) return true;
    }
    return false;
  }

  function hasSharedScope(scopes: readonly string[]): boolean {
    for (const scope of scopes) {
      if (sharedScopeSet.has(scope)) return true;
    }
    return false;
  }

  function hasSystemScope(scopes: readonly string[]): boolean {
    for (const scope of scopes) {
      if (systemScopeSet.has(scope)) return true;
    }
    return false;
  }

  return {
    extractTenantContext(params) {
      const roles = params.roles ?? [];
      return {
        principalId: params.principalId,
        tenantId: params.tenantId ?? null,
        workspaceId: params.workspaceId,
        roles,
        isSuperadmin: isSuperadmin(roles),
      };
    },

    validateTenantBoundary(params) {
      const { routeTenantId, principal, scopes = [] } = params;

      // Superadmin bypass
      if (principal.isSuperadmin) {
        const result: TenantIsolationResult = {
          decision: "allow",
          reason: "Superadmin bypass: tenant boundary check skipped.",
          routeTenantId,
          principalTenantId: principal.tenantId,
          isSuperadmin: true,
          audited: true,
        };
        deps.auditLogger?.log({
          tenantId: routeTenantId,
          principalId: principal.principalId,
          action: "tenant.isolation.boundary",
          resourceType: "tenant",
          resourceId: routeTenantId,
          decision: "allow",
          reason: result.reason,
        });
        return result;
      }

      // System scope bypass
      if (hasSystemScope(scopes)) {
        const result: TenantIsolationResult = {
          decision: "allow",
          reason: "System scope bypass: global access granted.",
          routeTenantId,
          principalTenantId: principal.tenantId,
          isSuperadmin: false,
          audited: true,
        };
        deps.auditLogger?.log({
          tenantId: routeTenantId,
          principalId: principal.principalId,
          action: "tenant.isolation.boundary",
          resourceType: "tenant",
          resourceId: routeTenantId,
          decision: "allow",
          reason: result.reason,
        });
        return result;
      }

      // Shared scope bypass
      if (hasSharedScope(scopes)) {
        const result: TenantIsolationResult = {
          decision: "allow",
          reason: "Shared scope bypass: cross-tenant read permitted.",
          routeTenantId,
          principalTenantId: principal.tenantId,
          isSuperadmin: false,
          audited: true,
        };
        deps.auditLogger?.log({
          tenantId: routeTenantId,
          principalId: principal.principalId,
          action: "tenant.isolation.boundary",
          resourceType: "tenant",
          resourceId: routeTenantId,
          decision: "allow",
          reason: result.reason,
        });
        return result;
      }

      // Tenant boundary check
      if (principal.tenantId !== routeTenantId) {
        const result: TenantIsolationResult = {
          decision: "deny",
          reason: `Tenant boundary violated: principal tenant '${principal.tenantId ?? "none"}' does not match route tenant '${routeTenantId}'.`,
          routeTenantId,
          principalTenantId: principal.tenantId,
          isSuperadmin: false,
          audited: true,
        };
        deps.auditLogger?.log({
          tenantId: routeTenantId,
          principalId: principal.principalId,
          action: "tenant.isolation.boundary",
          resourceType: "tenant",
          resourceId: routeTenantId,
          decision: "deny",
          reason: result.reason,
        });
        denyEvents.push(result);
        return result;
      }

      // Allowed — tenant matches
      const result: TenantIsolationResult = {
        decision: "allow",
        reason: "Tenant boundary check passed.",
        routeTenantId,
        principalTenantId: principal.tenantId,
        isSuperadmin: false,
        audited: true,
      };
      deps.auditLogger?.log({
        tenantId: routeTenantId,
        principalId: principal.principalId,
        action: "tenant.isolation.boundary",
        resourceType: "tenant",
        resourceId: routeTenantId,
        decision: "allow",
        reason: result.reason,
      });
      return result;
    },

    isSharedScope(scope) {
      return sharedScopeSet.has(scope);
    },

    isSystemScope(scope) {
      return systemScopeSet.has(scope);
    },

    getDenyEvents() {
      return [...denyEvents];
    },

    reset() {
      denyEvents.length = 0;
    },
  };
}
