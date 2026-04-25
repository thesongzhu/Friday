/**
 * RBAC Engine — Role definitions, role assignments, and permission evaluation.
 *
 * Enforces the RBAC hierarchy (system → tenant → workspace) with strict
 * role-scope compatibility validation (SEC-FIX-R5-03). Computes effective
 * permissions through hierarchical inheritance with explicit override.
 *
 * Key security invariants:
 * - hub.admin ≠ tenant:admin (hub.tenantAdmin for tenant-scoped admin)
 * - Role-scope compatibility validated on every assignment
 * - System-scope assignments require null tenantId
 * - Every mutation is audit-logged
 *
 * @module security/multi-tenant/engine/rbac-engine
 */

import type {
  FridayPermission,
  FridayRole,
  FridayRoleAssignment,
  FridayRoleAssignmentScopeUnion,
  FridayRoleHierarchyLevel,
  FridayRoleScopeType,
  FridaySecurityActionType,
  FridaySecurityResourceType,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import {
  FRIDAY_ROLE_HIERARCHY_RANK_MAP,
  validateRoleScopeCompatibility,
} from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, generateEtag, generateId, now, SecurityEngineError } from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";
import { resolveRoleHierarchyLevelFromLabel } from "./role-hierarchy.js";

// ─── Input Types ───

export interface CreateRoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopeType: FridayRoleScopeType;
  readonly permissions: readonly FridayPermission[];
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string;
  readonly permissions?: readonly FridayPermission[];
  readonly etag: string;
}

export interface GrantRoleInput {
  readonly principalId: string;
  readonly roleId: UUID;
  readonly scope: FridayRoleAssignmentScopeUnion;
  readonly grantedBy: string;
  readonly expiresAt?: string;
}

export interface PermissionCheckContext {
  readonly principalId: string;
  readonly tenantId: UUID;
  readonly workspaceId?: UUID;
  readonly resource: FridaySecurityResourceType;
  readonly action: FridaySecurityActionType;
}

/**
 * Role hierarchy threshold check context.
 *
 * Evaluates whether a principal's highest active role in scope is at least
 * the required hierarchy level.
 */
export interface RoleThresholdCheckContext {
  readonly principalId: string;
  readonly tenantId: UUID;
  readonly workspaceId?: UUID;
  readonly requiredRole: FridayRoleHierarchyLevel;
}

// ─── RBAC Engine ───

export class RbacEngine {
  private readonly roles = new Map<UUID, FridayRole>();
  private readonly assignments = new Map<UUID, FridayRoleAssignment>();
  private readonly permissions = new Map<UUID, FridayPermission>();

  constructor(private readonly auditLogger: AuditLogger) {}

  // ═══════════════════════════════════════════════════════════════
  // PERMISSION REGISTRY
  // ═══════════════════════════════════════════════════════════════

  /** Register a permission definition. */
  registerPermission(permission: FridayPermission): void {
    this.permissions.set(permission.id, cloneAndFreeze(permission));
  }

  /** Get a permission by id. */
  getPermission(permissionId: UUID): FridayPermission | undefined {
    const permission = this.permissions.get(permissionId);
    return permission ? cloneAndFreeze(permission) : undefined;
  }

  /** List all registered permissions. */
  listPermissions(): readonly FridayPermission[] {
    return cloneAndFreeze(Array.from(this.permissions.values()));
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLE CRUD
  // ═══════════════════════════════════════════════════════════════

  /** Create a role within a tenant (or system role with null tenantId). */
  createRole(tenantId: UUID | null, input: CreateRoleInput): FridayRole {
    // System roles must have null tenantId; tenant/workspace roles must have non-null
    if (input.scopeType === "system" && tenantId !== null) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "System-scoped roles must have null tenantId.",
      );
    }
    if (input.scopeType !== "system" && tenantId === null) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Roles with scope '${input.scopeType}' must belong to a tenant.`,
      );
    }

    // Name uniqueness within tenant scope
    for (const r of this.roles.values()) {
      if (r.tenantId === tenantId && r.name === input.name && !r.deletedAt) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NAME_CONFLICT,
          `A role named '${input.name}' already exists in ${tenantId ? `tenant ${tenantId}` : "system scope"}.`,
        );
      }
    }

    const timestamp = now();
    const role: FridayRole = {
      id: generateId(),
      tenantId,
      name: input.name,
      description: input.description,
      scopeType: input.scopeType,
      isSystem: input.scopeType === "system",
      permissions: structuredClone(input.permissions),
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.roles.set(role.id, role);

    this.auditLogger.log({
      tenantId,
      action: "role.create",
      resourceType: "role",
      resourceId: role.id,
      decision: "allow",
      reason: `Role '${role.name}' created with scope '${role.scopeType}'.`,
    });

    return cloneAndFreeze(role);
  }

  /** Get a role by id, enforcing tenant isolation. */
  getRole(tenantId: UUID | null, roleId: UUID): FridayRole {
    const role = this.roles.get(roleId);
    if (!role || role.deletedAt) {
      this.auditLogger.log({
        tenantId,
        action: "role.get",
        resourceType: "role",
        resourceId: roleId,
        decision: "deny",
        reason: `Role ${roleId} not found.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NOT_FOUND,
        `Role ${roleId} not found.`,
      );
    }
    // System roles are visible to all tenants
    if (role.tenantId !== null && role.tenantId !== tenantId) {
      this.auditLogger.log({
        tenantId,
        action: "role.get",
        resourceType: "role",
        resourceId: roleId,
        decision: "deny",
        reason: `Role ${roleId} is outside tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NOT_FOUND,
        `Role ${roleId} not found in tenant ${tenantId}.`,
      );
    }
    return cloneAndFreeze(role);
  }

  /** List roles visible to a tenant (tenant roles + system roles). */
  listRoles(
    tenantId: UUID,
    options?: { scopeType?: FridayRoleScopeType; includeSystem?: boolean },
  ): readonly FridayRole[] {
    const roles = Array.from(this.roles.values())
      .filter((r) => {
        if (r.deletedAt) return false;
        // Include system roles if requested (default: true)
        const includeSystem = options?.includeSystem ?? true;
        if (r.tenantId === null && !includeSystem) return false;
        if (r.tenantId !== null && r.tenantId !== tenantId) return false;
        if (options?.scopeType && r.scopeType !== options.scopeType) return false;
        return true;
      });
    return cloneAndFreeze(roles);
  }

  /** Update a role with optimistic concurrency. System roles are immutable. */
  updateRole(tenantId: UUID | null, roleId: UUID, input: UpdateRoleInput): FridayRole {
    const existing = this.getRole(tenantId, roleId);

    if (existing.isSystem) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_SYSTEM_IMMUTABLE,
        `Cannot modify system role '${existing.name}'.`,
      );
    }

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for role ${roleId}.`,
      );
    }

    // Check name uniqueness if changing
    if (input.name && input.name !== existing.name) {
      for (const r of this.roles.values()) {
        if (r.tenantId === tenantId && r.name === input.name && !r.deletedAt && r.id !== roleId) {
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NAME_CONFLICT,
            `A role named '${input.name}' already exists.`,
          );
        }
      }
    }

    const updated: FridayRole = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      permissions: structuredClone(input.permissions ?? existing.permissions),
      etag: generateEtag(),
      updatedAt: now(),
    };

    this.roles.set(roleId, updated);

    this.auditLogger.log({
      tenantId,
      action: "role.update",
      resourceType: "role",
      resourceId: roleId,
      decision: "allow",
      reason: `Role '${updated.name}' updated.`,
    });

    return cloneAndFreeze(updated);
  }

  /** Soft-delete a role. System roles are immutable. */
  deleteRole(tenantId: UUID | null, roleId: UUID, etag: string): FridayRole {
    const existing = this.getRole(tenantId, roleId);

    if (existing.isSystem) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_SYSTEM_IMMUTABLE,
        `Cannot delete system role '${existing.name}'.`,
      );
    }

    if (existing.etag !== etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for role ${roleId}.`,
      );
    }

    const deleted: FridayRole = {
      ...existing,
      etag: generateEtag(),
      updatedAt: now(),
      deletedAt: now(),
    };

    this.roles.set(roleId, deleted);

    this.auditLogger.log({
      tenantId,
      action: "role.delete",
      resourceType: "role",
      resourceId: roleId,
      decision: "allow",
      reason: `Role '${existing.name}' soft-deleted.`,
    });

    return cloneAndFreeze(deleted);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLE ASSIGNMENTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Grant a role assignment to a principal.
   *
   * Validates role-scope compatibility per SEC-FIX-R5-03:
   * - system role → only system scope
   * - tenant role → only tenant scope
   * - workspace role → only workspace scope
   */
  grantRole(input: GrantRoleInput): FridayRoleAssignment {
    const role = this.roles.get(input.roleId);
    if (!role || role.deletedAt) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ROLE_NOT_FOUND,
        `Role ${input.roleId} not found.`,
      );
    }

    // Enforce role-scope compatibility (SEC-FIX-R5-03)
    const compatibilityCheck = validateRoleScopeCompatibility(
      role.scopeType,
      input.scope.scopeType,
    );
    if (!compatibilityCheck.compatible) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_SCOPE_INCOMPATIBLE,
        compatibilityCheck.reason!,
      );
    }

    // Derive tenantId from scope
    const tenantId = input.scope.scopeType === "system"
      ? null
      : input.scope.tenantId;

    // Validate role belongs to the correct tenant
    if (role.tenantId !== null && role.tenantId !== tenantId) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.CROSS_TENANT_DENIED,
        `Role ${input.roleId} does not belong to tenant ${tenantId}.`,
      );
    }

    // Check for duplicate active assignment
    for (const a of this.assignments.values()) {
      if (
        a.principalId === input.principalId &&
        a.roleId === input.roleId &&
        a.scope.scopeType === input.scope.scopeType &&
        !a.revokedAt
      ) {
        // Check scope-specific fields
        if (input.scope.scopeType === "system") {
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_ALREADY_EXISTS,
            `Role ${input.roleId} already assigned to principal '${input.principalId}' at system scope.`,
          );
        }
        if (
          input.scope.scopeType === "tenant" &&
          a.scope.scopeType === "tenant" &&
          a.scope.tenantId === input.scope.tenantId
        ) {
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_ALREADY_EXISTS,
            `Role ${input.roleId} already assigned to principal '${input.principalId}' at tenant scope.`,
          );
        }
        if (
          input.scope.scopeType === "workspace" &&
          a.scope.scopeType === "workspace" &&
          a.scope.tenantId === input.scope.tenantId &&
          a.scope.workspaceId === input.scope.workspaceId
        ) {
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_ALREADY_EXISTS,
            `Role ${input.roleId} already assigned to principal '${input.principalId}' at workspace scope.`,
          );
        }
      }
    }

    const assignment: FridayRoleAssignment = {
      id: generateId(),
      tenantId,
      principalId: input.principalId,
      roleId: input.roleId,
      scope: input.scope,
      grantedBy: input.grantedBy,
      grantedAt: now(),
      expiresAt: input.expiresAt,
    };

    this.assignments.set(assignment.id, assignment);

    this.auditLogger.log({
      tenantId,
      action: "role.assign",
      resourceType: "role",
      resourceId: input.roleId,
      decision: "allow",
      principalId: input.grantedBy,
      reason: `Role '${role.name}' assigned to '${input.principalId}' at ${input.scope.scopeType} scope.`,
    });

    return cloneAndFreeze(assignment);
  }

  /** Revoke a role assignment. Enforces tenant isolation. */
  revokeAssignment(tenantId: UUID | null, assignmentId: UUID): FridayRoleAssignment {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.tenantId !== tenantId) {
      this.auditLogger.log({
        tenantId,
        action: "role.revoke",
        resourceType: "role",
        resourceId: assignmentId,
        decision: "deny",
        reason: `Assignment ${assignmentId} not found${tenantId ? ` in tenant ${tenantId}` : ""}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ASSIGNMENT_NOT_FOUND,
        `Assignment ${assignmentId} not found${tenantId ? ` in tenant ${tenantId}` : ""}.`,
      );
    }

    const revoked: FridayRoleAssignment = {
      ...assignment,
      revokedAt: now(),
    };

    this.assignments.set(assignmentId, revoked);

    this.auditLogger.log({
      tenantId,
      action: "role.revoke",
      resourceType: "role",
      resourceId: assignment.roleId,
      decision: "allow",
      reason: `Role assignment ${assignmentId} revoked for principal '${assignment.principalId}'.`,
    });

    return cloneAndFreeze(revoked);
  }

  /** List role assignments. Enforces tenant isolation. */
  listAssignments(
    tenantId: UUID,
    options?: {
      principalId?: string;
      roleId?: UUID;
      scopeType?: string;
      includeRevoked?: boolean;
    },
  ): readonly FridayRoleAssignment[] {
    const assignments = Array.from(this.assignments.values())
      .filter((a) => {
        if (a.tenantId !== tenantId) return false;
        if (!options?.includeRevoked && a.revokedAt) return false;
        if (options?.principalId && a.principalId !== options.principalId) return false;
        if (options?.roleId && a.roleId !== options.roleId) return false;
        if (options?.scopeType && a.scope.scopeType !== options.scopeType) return false;
        return true;
      });
    return cloneAndFreeze(assignments);
  }

  /** Count active assignments for a role (used for role detail). */
  countAssignments(roleId: UUID): number {
    return Array.from(this.assignments.values())
      .filter((a) => a.roleId === roleId && !a.revokedAt).length;
  }

  // ═══════════════════════════════════════════════════════════════
  // PERMISSION EVALUATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute the effective permissions for a principal within a scope.
   *
   * Follows the RBAC inheritance hierarchy:
   * 1. System-scope assignments (applies to all tenants)
   * 2. Tenant-scope assignments (applies to all workspaces in tenant)
   * 3. Workspace-scope assignments (applies to specific workspace)
   *
   * Permissions are unioned from all matching role assignments.
   */
  getEffectivePermissions(
    principalId: string,
    tenantId: UUID,
    workspaceId?: UUID,
  ): readonly FridayPermission[] {
    this.assertRequiredString(principalId, "principalId");
    this.assertRequiredString(tenantId, "tenantId");
    const currentTime = now();
    const permissionMap = new Map<string, FridayPermission>();

    for (const assignment of this.assignments.values()) {
      // Skip revoked or expired
      if (assignment.revokedAt) continue;
      if (assignment.expiresAt && assignment.expiresAt < currentTime) continue;

      // Skip if not for this principal
      if (assignment.principalId !== principalId) continue;

      if (!this.assignmentMatchesContext(assignment, tenantId, workspaceId)) continue;

      // Look up the role and collect permissions
      const role = this.roles.get(assignment.roleId);
      if (!role || role.deletedAt) continue;

      for (const perm of role.permissions) {
        const key = `${perm.resource}:${perm.action}`;
        if (!permissionMap.has(key)) {
          permissionMap.set(key, perm);
        }
      }
    }

    return cloneAndFreeze(Array.from(permissionMap.values()));
  }

  /**
   * Check whether a principal has a specific permission in context.
   *
   * Uses the hierarchical effective permissions computation.
   * Returns true if the principal holds the requested permission.
   */
  hasPermission(context: PermissionCheckContext): boolean {
    this.assertRequiredString(context.principalId, "context.principalId");
    this.assertRequiredString(context.tenantId, "context.tenantId");
    this.assertRequiredString(context.resource, "context.resource");
    this.assertRequiredString(context.action, "context.action");

    const effective = this.getEffectivePermissions(
      context.principalId,
      context.tenantId,
      context.workspaceId,
    );

    const allowed = effective.some(
      (p) => p.resource === context.resource && p.action === context.action,
    );

    this.auditLogger.log({
      tenantId: context.tenantId,
      principalId: context.principalId,
      action: `rbac.permission.check:${context.resource}:${context.action}`,
      resourceType: context.resource,
      resourceId: context.workspaceId,
      decision: allowed ? "allow" : "deny",
      reason: allowed
        ? "Permission granted by effective RBAC permissions."
        : "Permission denied. No matching effective RBAC permission.",
      metadata: {
        effectivePermissionCount: effective.length,
        ...(context.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
      },
    });

    return allowed;
  }

  /**
   * Returns the principal's highest hierarchical role level in scope.
   *
   * Role levels are derived from matching role assignment names and compared
   * using `FRIDAY_ROLE_HIERARCHY_RANK_MAP`.
   */
  getHighestRoleLevel(
    principalId: string,
    tenantId: UUID,
    workspaceId?: UUID,
  ): FridayRoleHierarchyLevel | null {
    this.assertRequiredString(principalId, "principalId");
    this.assertRequiredString(tenantId, "tenantId");

    const currentTime = now();
    let highestRole: FridayRoleHierarchyLevel | null = null;
    let highestRank = -1;

    for (const assignment of this.assignments.values()) {
      if (assignment.revokedAt) continue;
      if (assignment.expiresAt && assignment.expiresAt < currentTime) continue;
      if (assignment.principalId !== principalId) continue;
      if (!this.assignmentMatchesContext(assignment, tenantId, workspaceId)) continue;

      const role = this.roles.get(assignment.roleId);
      if (!role || role.deletedAt) continue;

      const level = this.resolveRoleHierarchyLevel(role.name);
      if (!level) continue;

      const rank = FRIDAY_ROLE_HIERARCHY_RANK_MAP[level];
      if (rank > highestRank) {
        highestRole = level;
        highestRank = rank;
      }
    }

    return highestRole;
  }

  /**
   * Check whether a principal's highest role in scope meets the required level.
   *
   * Emits an audit entry for both allow and deny decisions.
   */
  hasRoleAtLeast(context: RoleThresholdCheckContext): boolean {
    this.assertRequiredString(context.principalId, "context.principalId");
    this.assertRequiredString(context.tenantId, "context.tenantId");

    const highestRole = this.getHighestRoleLevel(
      context.principalId,
      context.tenantId,
      context.workspaceId,
    );

    const requiredRank = FRIDAY_ROLE_HIERARCHY_RANK_MAP[context.requiredRole];
    const highestRank = highestRole ? FRIDAY_ROLE_HIERARCHY_RANK_MAP[highestRole] : -1;
    const allowed = highestRank >= requiredRank;

    this.auditLogger.log({
      tenantId: context.tenantId,
      principalId: context.principalId,
      action: `rbac.role.threshold:${context.requiredRole}`,
      resourceType: "role",
      resourceId: context.workspaceId,
      decision: allowed ? "allow" : "deny",
      reason: allowed
        ? `Role threshold met. Highest role '${highestRole}' satisfies '${context.requiredRole}'.`
        : `Role threshold not met. Highest role '${highestRole ?? "none"}' is below '${context.requiredRole}'.`,
      metadata: {
        highestRole,
        requiredRole: context.requiredRole,
        ...(context.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
      },
    });

    return allowed;
  }

  /** Validate required string parameters for public API boundaries. */
  private assertRequiredString(value: unknown, fieldName: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Missing required parameter '${fieldName}'.`,
      );
    }
  }

  /** Check whether a role assignment applies to the provided tenant/workspace context. */
  private assignmentMatchesContext(
    assignment: FridayRoleAssignment,
    tenantId: UUID,
    workspaceId?: UUID,
  ): boolean {
    if (assignment.scope.scopeType === "system") return true;
    if (assignment.scope.scopeType === "tenant") {
      return assignment.scope.tenantId === tenantId;
    }
    if (workspaceId === undefined) return false;
    return assignment.scope.tenantId === tenantId && assignment.scope.workspaceId === workspaceId;
  }

  /** Map a role name to a hierarchical RBAC level. */
  private resolveRoleHierarchyLevel(roleName: string): FridayRoleHierarchyLevel | null {
    return resolveRoleHierarchyLevelFromLabel(roleName);
  }
}
