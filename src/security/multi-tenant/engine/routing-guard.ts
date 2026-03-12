/**
 * Routing Guard — early tenant route boundary enforcement.
 *
 * Prevents cross-tenant calls before engine invocation by verifying that the
 * authenticated tenant matches the route tenant, with superadmin exception.
 *
 * @module security/multi-tenant/engine/routing-guard
 */

import type { UUID } from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import type { AuditLogger } from "./audit-logger.js";
import { SecurityEngineError } from "./utils.js";

/** Auth context required for route-level tenant boundary checks. */
export interface RoutingAuthContext {
  readonly principalId: string;
  readonly tenantId: UUID | null;
  readonly roles: readonly string[];
}

/**
 * Enforce that authenticated tenant context matches tenant route parameter.
 *
 * Superadmin principals are exempt from tenant-route match checks.
 * HTTP route handlers must call this guard before invoking engine operations.
 */
export function assertTenantRouteBoundary(
  routeTenantId: UUID,
  authContext: RoutingAuthContext,
  auditLogger: AuditLogger,
): void {
  assertRequiredString(routeTenantId, "routeTenantId");
  assertRequiredString(authContext?.principalId, "authContext.principalId");
  if (!Array.isArray(authContext?.roles)) {
    throw new SecurityEngineError(
      FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
      "Missing required authContext.roles array.",
    );
  }

  const superadmin = isSuperadmin(authContext.roles);
  if (superadmin) {
    auditLogger.log({
      tenantId: routeTenantId,
      principalId: authContext.principalId,
      action: "routing.tenant.boundary",
      resourceType: "tenant",
      resourceId: routeTenantId,
      decision: "allow",
      reason: "Tenant route boundary bypassed for superadmin principal.",
      metadata: {
        routeTenantId,
        authenticatedTenantId: authContext.tenantId,
      },
    });
    return;
  }

  if (authContext.tenantId !== routeTenantId) {
    auditLogger.log({
      tenantId: routeTenantId,
      principalId: authContext.principalId,
      action: "routing.tenant.boundary",
      resourceType: "tenant",
      resourceId: routeTenantId,
      decision: "deny",
      reason: `Authenticated tenant '${authContext.tenantId ?? "none"}' does not match route tenant '${routeTenantId}'.`,
      metadata: {
        routeTenantId,
        authenticatedTenantId: authContext.tenantId,
      },
    });

    throw new SecurityEngineError(
      FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.CROSS_TENANT_DENIED,
      "Route tenant boundary violated.",
    );
  }

  auditLogger.log({
    tenantId: routeTenantId,
    principalId: authContext.principalId,
    action: "routing.tenant.boundary",
    resourceType: "tenant",
    resourceId: routeTenantId,
    decision: "allow",
    reason: "Route tenant boundary check passed.",
    metadata: {
      routeTenantId,
      authenticatedTenantId: authContext.tenantId,
    },
  });
}

/** Validate required string parameters. */
function assertRequiredString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SecurityEngineError(
      FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
      `Missing required parameter '${fieldName}'.`,
    );
  }
}

/** Detect whether auth roles include superadmin privileges. */
function isSuperadmin(roles: readonly string[]): boolean {
  for (const role of roles) {
    const normalized = role.trim().toLowerCase().replaceAll(/[:\s-]+/g, "_");
    if (normalized.includes("superadmin")) return true;
  }
  return false;
}
