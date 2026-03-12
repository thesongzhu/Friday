/**
 * Tenant Manager — CRUD operations for tenants, workspaces, and memberships.
 *
 * Every operation enforces tenant isolation. Workspace operations validate
 * that the workspace belongs to the specified tenant via composite key lookups.
 * Membership operations enforce workspace-tenant binding.
 *
 * @module security/multi-tenant/engine/tenant-manager
 */

import type {
  FridayRoleHierarchyLevel,
  FridayTenant,
  FridayTenantConfig,
  FridayTenantStatus,
  FridayWorkspace,
  FridayWorkspaceMembership,
  FridayWorkspaceStatus,
  JsonObject,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import {
  FRIDAY_ROLE_HIERARCHY_RANK_MAP,
  FRIDAY_TENANT_CONFIG_DEFAULTS,
} from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, generateEtag, generateId, now, SecurityEngineError } from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";

// ─── Input Types ───

export interface CreateTenantInput {
  readonly name: string;
  readonly slug: string;
  readonly maxWorkspaces?: number;
  readonly maxMembers?: number;
  readonly maxSecretsPerWorkspace?: number;
  readonly auditRetentionDays?: number;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
}

export interface UpdateTenantInput {
  readonly name?: string;
  readonly status?: FridayTenantStatus;
  readonly maxWorkspaces?: number;
  readonly maxMembers?: number;
  readonly maxSecretsPerWorkspace?: number;
  readonly auditRetentionDays?: number;
  readonly featureFlags?: Readonly<Record<string, boolean>>;
  readonly etag: string;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
  readonly status?: FridayWorkspaceStatus;
  readonly etag: string;
}

export interface AddMemberInput {
  readonly principalId: string;
  readonly roleId: UUID;
  readonly grantedBy: string;
  readonly expiresAt?: string;
}

/** Actor context used to authorize tenant/workspace CRUD operations. */
export interface TenantCrudActorContext {
  readonly principalId: string;
  readonly roles: readonly string[];
}

/** Internal migration actor context for bootstrapping default hierarchy. */
export const MIGRATION_ACTOR: TenantCrudActorContext = Object.freeze({
  principalId: "migration-manager",
  roles: Object.freeze(["superadmin"]),
});

// ─── Tenant Manager ───

export class TenantManager {
  private readonly tenants = new Map<UUID, FridayTenant>();
  private readonly workspaces = new Map<UUID, FridayWorkspace>();
  private readonly memberships = new Map<UUID, FridayWorkspaceMembership>();

  constructor(private readonly auditLogger: AuditLogger) {}

  // ═══════════════════════════════════════════════════════════════
  // TENANT CRUD
  // ═══════════════════════════════════════════════════════════════

  /** Create a new tenant (superadmin only). */
  createTenant(
    input: CreateTenantInput,
    actor: TenantCrudActorContext,
  ): FridayTenant {
    this.assertCrudAuthorization("tenant.create", actor, "superadmin");
    this.assertRequiredString(input.name, "input.name");
    this.assertRequiredString(input.slug, "input.slug");

    // Slug uniqueness
    for (const t of this.tenants.values()) {
      if (t.slug === input.slug && !t.deletedAt) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_SLUG_CONFLICT,
          `A tenant with slug '${input.slug}' already exists.`,
        );
      }
    }

    const config: FridayTenantConfig = {
      maxWorkspaces: input.maxWorkspaces ?? FRIDAY_TENANT_CONFIG_DEFAULTS.maxWorkspaces,
      maxMembers: input.maxMembers ?? FRIDAY_TENANT_CONFIG_DEFAULTS.maxMembers,
      maxSecretsPerWorkspace: input.maxSecretsPerWorkspace ?? FRIDAY_TENANT_CONFIG_DEFAULTS.maxSecretsPerWorkspace,
      auditRetentionDays: input.auditRetentionDays ?? FRIDAY_TENANT_CONFIG_DEFAULTS.auditRetentionDays,
      featureFlags: structuredClone(input.featureFlags ?? {}),
    };

    const timestamp = now();
    const tenant: FridayTenant = {
      id: generateId(),
      name: input.name,
      slug: input.slug,
      status: "provisioning",
      config,
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.tenants.set(tenant.id, tenant);

    this.auditLogger.log({
      tenantId: tenant.id,
      principalId: actor.principalId,
      action: "tenant.create",
      resourceType: "tenant",
      resourceId: tenant.id,
      decision: "allow",
      reason: "Tenant created.",
    });

    return cloneAndFreeze(tenant);
  }

  /** Get a tenant by id (superadmin only). */
  getTenant(
    tenantId: UUID,
    actor: TenantCrudActorContext,
  ): FridayTenant {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertCrudAuthorization("tenant.get", actor, "superadmin", tenantId);
    const tenant = this.getTenantInternal(tenantId);
    return cloneAndFreeze(tenant);
  }

  /** List all active (non-deleted) tenants (superadmin only). */
  listTenants(
    actor: TenantCrudActorContext,
    status?: FridayTenantStatus,
  ): readonly FridayTenant[] {
    this.assertCrudAuthorization("tenant.list", actor, "superadmin");
    const tenants = Array.from(this.tenants.values())
      .filter((t) => !t.deletedAt && (!status || t.status === status));
    return cloneAndFreeze(tenants);
  }

  /** Update a tenant with optimistic concurrency (superadmin only). */
  updateTenant(
    tenantId: UUID,
    input: UpdateTenantInput,
    actor: TenantCrudActorContext,
  ): FridayTenant {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(input.etag, "input.etag");
    this.assertCrudAuthorization("tenant.update", actor, "superadmin", tenantId);
    const existing = this.getTenantInternal(tenantId);

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for tenant ${tenantId}. Expected '${existing.etag}', got '${input.etag}'.`,
      );
    }

    const config: FridayTenantConfig = {
      maxWorkspaces: input.maxWorkspaces ?? existing.config.maxWorkspaces,
      maxMembers: input.maxMembers ?? existing.config.maxMembers,
      maxSecretsPerWorkspace: input.maxSecretsPerWorkspace ?? existing.config.maxSecretsPerWorkspace,
      auditRetentionDays: input.auditRetentionDays ?? existing.config.auditRetentionDays,
      featureFlags: structuredClone(input.featureFlags ?? existing.config.featureFlags),
    };

    const updated: FridayTenant = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      config,
      etag: generateEtag(),
      updatedAt: now(),
    };

    this.tenants.set(tenantId, updated);

    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "tenant.update",
      resourceType: "tenant",
      resourceId: tenantId,
      decision: "allow",
      reason: "Tenant updated.",
    });

    return cloneAndFreeze(updated);
  }

  /** Soft-delete a tenant with optimistic concurrency (superadmin only). */
  deleteTenant(
    tenantId: UUID,
    etag: string,
    actor: TenantCrudActorContext,
  ): FridayTenant {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(etag, "etag");
    this.assertCrudAuthorization("tenant.delete", actor, "superadmin", tenantId);
    const existing = this.getTenantInternal(tenantId);

    if (existing.etag !== etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for tenant ${tenantId}.`,
      );
    }

    const deleted: FridayTenant = {
      ...existing,
      status: "deactivated",
      etag: generateEtag(),
      updatedAt: now(),
      deletedAt: now(),
    };

    this.tenants.set(tenantId, deleted);

    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "tenant.delete",
      resourceType: "tenant",
      resourceId: tenantId,
      decision: "allow",
      reason: "Tenant soft-deleted.",
    });

    return cloneAndFreeze(deleted);
  }

  /** Get raw tenant without authorization checks. */
  private getTenantInternal(tenantId: UUID): FridayTenant {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.deletedAt) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_NOT_FOUND,
        `Tenant ${tenantId} not found.`,
      );
    }
    return tenant;
  }

  // ═══════════════════════════════════════════════════════════════
  // WORKSPACE CRUD
  // ═══════════════════════════════════════════════════════════════

  /** Create a workspace within a tenant (tenant_admin+). */
  createWorkspace(
    tenantId: UUID,
    input: CreateWorkspaceInput,
    actor: TenantCrudActorContext,
  ): FridayWorkspace {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(input.name, "input.name");
    this.assertRequiredString(input.slug, "input.slug");
    this.assertCrudAuthorization("workspace.create", actor, "tenant_admin", tenantId);
    this.assertTenantWorkspaceAccessAllowed(tenantId, "workspace.create");
    const tenant = this.getTenantInternal(tenantId);

    // Check workspace limit
    const workspaceCount = this.countWorkspacesInternal(tenantId);
    if (workspaceCount >= tenant.config.maxWorkspaces) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.WORKSPACE_LIMIT_EXCEEDED,
        `Tenant ${tenantId} has reached the maximum number of workspaces (${tenant.config.maxWorkspaces}).`,
      );
    }

    // Slug uniqueness within tenant
    for (const ws of this.workspaces.values()) {
      if (ws.tenantId === tenantId && ws.slug === input.slug && !ws.deletedAt) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.WORKSPACE_SLUG_CONFLICT,
          `A workspace with slug '${input.slug}' already exists in tenant ${tenantId}.`,
        );
      }
    }

    const timestamp = now();
    const workspace: FridayWorkspace = {
      id: generateId(),
      tenantId,
      name: input.name,
      slug: input.slug,
      status: "active",
      config: {} as JsonObject,
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.workspaces.set(workspace.id, workspace);

    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "workspace.create",
      resourceType: "workspace",
      resourceId: workspace.id,
      decision: "allow",
      reason: "Workspace created.",
    });

    return cloneAndFreeze(workspace);
  }

  /** Get a workspace by id, enforcing tenant isolation (tenant_admin+). */
  getWorkspace(
    tenantId: UUID,
    workspaceId: UUID,
    actor: TenantCrudActorContext,
  ): FridayWorkspace {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(workspaceId, "workspaceId");
    this.assertCrudAuthorization("workspace.get", actor, "tenant_admin", tenantId, workspaceId);
    this.assertTenantWorkspaceAccessAllowed(tenantId, "workspace.get", workspaceId);
    const workspace = this.getWorkspaceInternal(tenantId, workspaceId, "workspace.get", actor.principalId);
    return cloneAndFreeze(workspace);
  }

  /** List workspaces within a tenant (tenant_admin+). */
  listWorkspaces(
    tenantId: UUID,
    actor: TenantCrudActorContext,
    status?: FridayWorkspaceStatus,
  ): readonly FridayWorkspace[] {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertCrudAuthorization("workspace.list", actor, "tenant_admin", tenantId);
    this.assertTenantWorkspaceAccessAllowed(tenantId, "workspace.list");
    const workspaces = Array.from(this.workspaces.values())
      .filter((ws) => ws.tenantId === tenantId && !ws.deletedAt && (!status || ws.status === status));
    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "workspace.list",
      resourceType: "workspace",
      decision: "allow",
      reason: `Listed ${workspaces.length} workspaces.`,
    });
    return cloneAndFreeze(workspaces);
  }

  /** Count active workspaces for a tenant (tenant_admin+). */
  countWorkspaces(
    tenantId: UUID,
    actor: TenantCrudActorContext,
  ): number {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertCrudAuthorization("workspace.count", actor, "tenant_admin", tenantId);
    this.assertTenantWorkspaceAccessAllowed(tenantId, "workspace.count");
    const count = this.countWorkspacesInternal(tenantId);
    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "workspace.count",
      resourceType: "workspace",
      decision: "allow",
      reason: `Workspace count resolved: ${count}.`,
    });
    return count;
  }

  /** Count active workspaces for a tenant without authorization checks. */
  private countWorkspacesInternal(tenantId: UUID): number {
    return Array.from(this.workspaces.values())
      .filter((ws) => ws.tenantId === tenantId && !ws.deletedAt).length;
  }

  /** Update a workspace with optimistic concurrency and tenant isolation (tenant_admin+). */
  updateWorkspace(
    tenantId: UUID,
    workspaceId: UUID,
    input: UpdateWorkspaceInput,
    actor: TenantCrudActorContext,
  ): FridayWorkspace {
    this.assertRequiredString(input.etag, "input.etag");
    const existing = this.getWorkspace(tenantId, workspaceId, actor);

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for workspace ${workspaceId}.`,
      );
    }

    const updated: FridayWorkspace = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      etag: generateEtag(),
      updatedAt: now(),
    };

    this.workspaces.set(workspaceId, updated);

    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "workspace.update",
      resourceType: "workspace",
      resourceId: workspaceId,
      decision: "allow",
      reason: "Workspace updated.",
    });

    return cloneAndFreeze(updated);
  }

  /** Soft-delete a workspace with optimistic concurrency and tenant isolation (tenant_admin+). */
  deleteWorkspace(
    tenantId: UUID,
    workspaceId: UUID,
    etag: string,
    actor: TenantCrudActorContext,
  ): FridayWorkspace {
    this.assertRequiredString(etag, "etag");
    const existing = this.getWorkspace(tenantId, workspaceId, actor);

    if (existing.etag !== etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for workspace ${workspaceId}.`,
      );
    }

    const deleted: FridayWorkspace = {
      ...existing,
      status: "archived",
      etag: generateEtag(),
      updatedAt: now(),
      deletedAt: now(),
    };

    this.workspaces.set(workspaceId, deleted);

    const revokedAt = now();
    let revokedMemberships = 0;
    for (const [membershipId, membership] of this.memberships.entries()) {
      if (
        membership.tenantId === tenantId &&
        membership.workspaceId === workspaceId &&
        !membership.revokedAt
      ) {
        this.memberships.set(membershipId, {
          ...membership,
          revokedAt,
        });
        revokedMemberships += 1;
      }
    }

    this.auditLogger.log({
      tenantId,
      principalId: actor.principalId,
      action: "workspace.delete",
      resourceType: "workspace",
      resourceId: workspaceId,
      decision: "allow",
      reason: `Workspace soft-deleted and ${revokedMemberships} memberships revoked.`,
    });

    return cloneAndFreeze(deleted);
  }

  // ═══════════════════════════════════════════════════════════════
  // MEMBERSHIP MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Add a member to a workspace. Enforces workspace-tenant binding. */
  addMember(tenantId: UUID, workspaceId: UUID, input: AddMemberInput): FridayWorkspaceMembership {
    this.assertTenantWorkspaceAccessAllowed(tenantId, "membership.add", workspaceId);
    // Validate workspace belongs to tenant
    this.getWorkspaceInternal(tenantId, workspaceId, "membership.add");

    // Validate tenant config limits
    const tenant = this.getTenantInternal(tenantId);
    const memberCount = this.countMembers(tenantId);
    if (memberCount >= tenant.config.maxMembers) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.MEMBERSHIP_LIMIT_EXCEEDED,
        `Tenant ${tenantId} has reached the maximum number of members (${tenant.config.maxMembers}).`,
      );
    }

    // Check for existing active membership with same principal+role in workspace
    for (const m of this.memberships.values()) {
      if (
        m.tenantId === tenantId &&
        m.workspaceId === workspaceId &&
        m.principalId === input.principalId &&
        m.roleId === input.roleId &&
        !m.revokedAt
      ) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.MEMBERSHIP_ALREADY_EXISTS,
          `Principal '${input.principalId}' already has role ${input.roleId} in workspace ${workspaceId}.`,
        );
      }
    }

    const membership: FridayWorkspaceMembership = {
      id: generateId(),
      workspaceId,
      tenantId,
      principalId: input.principalId,
      roleId: input.roleId,
      grantedBy: input.grantedBy,
      grantedAt: now(),
      expiresAt: input.expiresAt,
    };

    this.memberships.set(membership.id, membership);

    this.auditLogger.log({
      tenantId,
      action: "membership.add",
      resourceType: "membership",
      resourceId: membership.id,
      decision: "allow",
      principalId: input.grantedBy,
      reason: `Added ${input.principalId} with role ${input.roleId} to workspace ${workspaceId}.`,
    });

    return cloneAndFreeze(membership);
  }

  /** Revoke a membership. Enforces tenant isolation. */
  revokeMembership(tenantId: UUID, workspaceId: UUID, membershipId: UUID): FridayWorkspaceMembership {
    this.assertTenantWorkspaceAccessAllowed(tenantId, "membership.revoke", workspaceId);
    const membership = this.memberships.get(membershipId);
    if (
      !membership ||
      membership.tenantId !== tenantId ||
      membership.workspaceId !== workspaceId
    ) {
      this.auditLogger.log({
        tenantId,
        action: "membership.revoke",
        resourceType: "membership",
        resourceId: membershipId,
        decision: "deny",
        reason: `Membership ${membershipId} not found in workspace ${workspaceId} of tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.MEMBERSHIP_NOT_FOUND,
        `Membership ${membershipId} not found in workspace ${workspaceId} of tenant ${tenantId}.`,
      );
    }

    const revoked: FridayWorkspaceMembership = {
      ...membership,
      revokedAt: now(),
    };

    this.memberships.set(membershipId, revoked);

    this.auditLogger.log({
      tenantId,
      action: "membership.revoke",
      resourceType: "membership",
      resourceId: membershipId,
      decision: "allow",
      reason: `Revoked membership for ${membership.principalId} in workspace ${workspaceId}.`,
    });

    return cloneAndFreeze(revoked);
  }

  /** List members of a workspace. Enforces tenant isolation. */
  listMembers(
    tenantId: UUID,
    workspaceId: UUID,
    options?: { principalId?: string; roleId?: UUID; includeRevoked?: boolean },
  ): readonly FridayWorkspaceMembership[] {
    this.assertTenantWorkspaceAccessAllowed(tenantId, "membership.list", workspaceId);
    // Validate workspace belongs to tenant
    this.getWorkspaceInternal(tenantId, workspaceId, "membership.list");

    const memberships = Array.from(this.memberships.values())
      .filter((m) => {
        if (m.tenantId !== tenantId || m.workspaceId !== workspaceId) return false;
        if (!options?.includeRevoked && m.revokedAt) return false;
        if (options?.principalId && m.principalId !== options.principalId) return false;
        if (options?.roleId && m.roleId !== options.roleId) return false;
        return true;
      });
    return cloneAndFreeze(memberships);
  }

  /** Count total active members across all workspaces in a tenant. */
  countMembers(tenantId: UUID): number {
    this.assertTenantWorkspaceAccessAllowed(tenantId, "membership.count");
    const activeWorkspaceIds = new Set<UUID>(
      Array.from(this.workspaces.values())
        .filter((workspace) =>
          workspace.tenantId === tenantId &&
          !workspace.deletedAt &&
          workspace.status === "active"
        )
        .map((workspace) => workspace.id),
    );

    const uniquePrincipals = new Set<string>();
    for (const m of this.memberships.values()) {
      if (
        m.tenantId === tenantId &&
        !m.revokedAt &&
        activeWorkspaceIds.has(m.workspaceId)
      ) {
        uniquePrincipals.add(m.principalId);
      }
    }
    return uniquePrincipals.size;
  }

  /** Get a single membership by id. Enforces tenant isolation. */
  getMembership(tenantId: UUID, membershipId: UUID): FridayWorkspaceMembership {
    this.assertTenantWorkspaceAccessAllowed(tenantId, "membership.get", membershipId);
    const membership = this.memberships.get(membershipId);
    if (!membership || membership.tenantId !== tenantId) {
      this.auditLogger.log({
        tenantId,
        action: "membership.get",
        resourceType: "membership",
        resourceId: membershipId,
        decision: "deny",
        reason: `Membership ${membershipId} not found in tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.MEMBERSHIP_NOT_FOUND,
        `Membership ${membershipId} not found in tenant ${tenantId}.`,
      );
    }
    return cloneAndFreeze(membership);
  }

  /**
   * Assert actor authorization for tenant/workspace CRUD operations.
   *
   * Tenant CRUD requires `superadmin`.
   * Workspace CRUD requires `tenant_admin` or stronger.
   */
  private assertCrudAuthorization(
    action: string,
    actor: TenantCrudActorContext,
    requiredRole: FridayRoleHierarchyLevel,
    tenantId?: UUID,
    resourceId?: UUID,
  ): void {
    if (!actor || typeof actor !== "object") {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "Missing required actor context.",
      );
    }
    this.assertRequiredString(actor.principalId, "actor.principalId");
    if (!Array.isArray(actor.roles)) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "Missing required actor.roles array.",
      );
    }

    const highestRole = this.getHighestActorRole(actor.roles);
    const highestRank = highestRole === null ? -1 : FRIDAY_ROLE_HIERARCHY_RANK_MAP[highestRole];
    const requiredRank = FRIDAY_ROLE_HIERARCHY_RANK_MAP[requiredRole];
    const allowed = highestRank >= requiredRank;
    const resourceType = action.startsWith("tenant.") ? "tenant" : "workspace";

    this.auditLogger.log({
      tenantId: tenantId ?? null,
      principalId: actor.principalId,
      action: `authz.${action}`,
      resourceType,
      resourceId: resourceId ?? tenantId,
      decision: allowed ? "allow" : "deny",
      reason: allowed
        ? `Authorization granted. Highest role '${highestRole}' satisfies '${requiredRole}'.`
        : `Authorization denied. Highest role '${highestRole ?? "none"}' is below '${requiredRole}'.`,
      metadata: {
        requiredRole,
        highestRole,
      },
    });

    if (!allowed) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.PERMISSION_DENIED,
        `Operation '${action}' requires role '${requiredRole}'.`,
      );
    }
  }

  /** Resolve the highest canonical hierarchy role from actor role labels. */
  private getHighestActorRole(roles: readonly string[]): FridayRoleHierarchyLevel | null {
    let highestRole: FridayRoleHierarchyLevel | null = null;
    let highestRank = -1;

    for (const role of roles) {
      const normalized = role.trim().toLowerCase().replaceAll(/[:\s-]+/g, "_");
      let level: FridayRoleHierarchyLevel | null = null;

      if (normalized.includes("superadmin")) {
        level = "superadmin";
      } else if (normalized.includes("tenant_admin") || normalized.includes("tenantadmin")) {
        level = "tenant_admin";
      } else if (normalized.includes("workspace_admin") || normalized.includes("workspaceadmin")) {
        level = "workspace_admin";
      } else if (normalized.includes("member")) {
        level = "member";
      } else if (normalized.includes("viewer")) {
        level = "viewer";
      }

      if (!level) continue;

      const rank = FRIDAY_ROLE_HIERARCHY_RANK_MAP[level];
      if (rank > highestRank) {
        highestRole = level;
        highestRank = rank;
      }
    }

    return highestRole;
  }

  /** Get raw workspace without authorization checks. */
  private getWorkspaceInternal(
    tenantId: UUID,
    workspaceId: UUID,
    action: string,
    principalId?: string,
  ): FridayWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.tenantId !== tenantId || workspace.deletedAt) {
      this.auditLogger.log({
        tenantId,
        principalId,
        action,
        resourceType: "workspace",
        resourceId: workspaceId,
        decision: "deny",
        reason: `Workspace ${workspaceId} not found or not accessible in tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.WORKSPACE_NOT_FOUND,
        `Workspace ${workspaceId} not found in tenant ${tenantId}.`,
      );
    }
    return workspace;
  }

  /** Validate required string input fields. */
  private assertRequiredString(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Missing required parameter '${fieldName}'.`,
      );
    }
  }

  /** Ensure tenant allows workspace/member operations (not deleted or deactivated). */
  private assertTenantWorkspaceAccessAllowed(
    tenantId: UUID,
    action: string,
    resourceId?: UUID,
  ): void {
    const tenant = this.tenants.get(tenantId);
    if (!tenant || tenant.deletedAt) {
      this.auditLogger.log({
        tenantId,
        action,
        resourceType: "tenant",
        resourceId: tenantId,
        decision: "deny",
        reason: `Tenant ${tenantId} not found for ${action}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_NOT_FOUND,
        `Tenant ${tenantId} not found.`,
      );
    }

    if (tenant.status === "deactivated") {
      this.auditLogger.log({
        tenantId,
        action,
        resourceType: "tenant",
        resourceId: resourceId ?? tenantId,
        decision: "deny",
        reason: `Tenant ${tenantId} is deactivated. ${action} denied.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.TENANT_INVALID_STATE,
        `Tenant ${tenantId} is deactivated.`,
      );
    }
  }
}
