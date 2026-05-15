/**
 * Tenant-Scoped Resource Registry — Phase 11 Module 18.
 *
 * Records per-tenant ownership claims for the six legacy domains called
 * out by the Module 18 CSV (sessions, skills, workflows, providers,
 * memory items, rules) without refactoring the per-domain stores.  The
 * registry's job is to give the multi-tenant security engine a
 * deterministic answer to "does tenant T own resource R of kind K?"
 * and to make that ownership claim survive a hub restart.
 *
 * Cross-tenant denial: looking up a resource record using a tenant id
 * that does not own the resource returns null.  This is the engine-side
 * gate that backs the Module 18 cross-tenant denial requirement.
 */

import type {
  ISODateTime,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import {
  cloneAndFreeze,
  generateEtag,
  generateId,
  now,
  SecurityEngineError,
} from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";

/** Legacy domains covered by the tenant-scoped resource registry. */
export const FRIDAY_TENANT_SCOPED_RESOURCE_KINDS = [
  "session",
  "skill",
  "workflow",
  "provider",
  "memory",
  "rule",
] as const;

export type FridayTenantScopedResourceKind =
  (typeof FRIDAY_TENANT_SCOPED_RESOURCE_KINDS)[number];

export interface FridayTenantScopedResourceRecord {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly workspaceId?: UUID;
  readonly resourceKind: FridayTenantScopedResourceKind;
  readonly resourceId: string;
  readonly resourceLabel?: string;
  readonly etag: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly deletedAt?: ISODateTime;
}

export interface RegisterScopedResourceInput {
  readonly tenantId: UUID;
  readonly workspaceId?: UUID;
  readonly resourceKind: FridayTenantScopedResourceKind;
  readonly resourceId: string;
  readonly resourceLabel?: string;
}

export interface TenantScopedResourceRegistryPersistence {
  hydrate(): Map<UUID, FridayTenantScopedResourceRecord>;
  save(record: FridayTenantScopedResourceRecord): void;
}

export class TenantScopedResourceRegistry {
  private readonly records: Map<UUID, FridayTenantScopedResourceRecord>;
  private readonly persistence?: TenantScopedResourceRegistryPersistence;

  constructor(
    private readonly auditLogger: AuditLogger,
    options?: { persistence?: TenantScopedResourceRegistryPersistence },
  ) {
    this.persistence = options?.persistence;
    this.records = this.persistence?.hydrate() ?? new Map();
  }

  private persist(record: FridayTenantScopedResourceRecord): void {
    this.records.set(record.id, record);
    this.persistence?.save(record);
  }

  /** Claim ownership of a legacy resource for a tenant. */
  register(input: RegisterScopedResourceInput): FridayTenantScopedResourceRecord {
    if (!input.tenantId) {
      throw new SecurityEngineError("VALIDATION_ERROR", "tenantId is required");
    }
    if (!input.resourceId) {
      throw new SecurityEngineError("VALIDATION_ERROR", "resourceId is required");
    }
    if (!FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.includes(input.resourceKind)) {
      throw new SecurityEngineError(
        "VALIDATION_ERROR",
        `resourceKind must be one of ${FRIDAY_TENANT_SCOPED_RESOURCE_KINDS.join(", ")}`,
      );
    }

    for (const existing of this.records.values()) {
      if (
        existing.resourceKind === input.resourceKind &&
        existing.resourceId === input.resourceId &&
        !existing.deletedAt
      ) {
        if (existing.tenantId !== input.tenantId) {
          throw new SecurityEngineError(
            "CONFLICT",
            `${input.resourceKind} ${input.resourceId} is already scoped to a different tenant`,
          );
        }
        const updated: FridayTenantScopedResourceRecord = {
          ...existing,
          workspaceId: input.workspaceId ?? existing.workspaceId,
          resourceLabel: input.resourceLabel ?? existing.resourceLabel,
          etag: generateEtag(),
          updatedAt: now(),
        };
        this.persist(updated);
        return cloneAndFreeze(updated);
      }
    }

    const timestamp = now();
    const record: FridayTenantScopedResourceRecord = {
      id: generateId(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: input.resourceLabel,
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.persist(record);

    this.auditLogger.log({
      tenantId: input.tenantId,
      principalId: "tenant-scoped-resource-registry",
      action: "tenant_scoped_resource.register",
      resourceType: "tenant",
      resourceId: input.tenantId,
      decision: "allow",
      metadata: {
        resourceKind: input.resourceKind,
        scopedResourceId: input.resourceId,
      },
    });

    return cloneAndFreeze(record);
  }

  /**
   * Read a record only if the requesting tenant owns it.  Cross-tenant
   * lookups return null — the caller cannot distinguish "not found"
   * from "owned by a different tenant" by design.
   */
  getForTenant(
    tenantId: UUID,
    resourceKind: FridayTenantScopedResourceKind,
    resourceId: string,
  ): FridayTenantScopedResourceRecord | null {
    for (const record of this.records.values()) {
      if (
        record.resourceKind === resourceKind &&
        record.resourceId === resourceId &&
        !record.deletedAt
      ) {
        if (record.tenantId !== tenantId) {
          this.auditLogger.log({
            tenantId,
            principalId: "tenant-scoped-resource-registry",
            action: "tenant_scoped_resource.cross_tenant_denied",
            resourceType: "tenant",
            resourceId: tenantId,
            decision: "deny",
            reason: "cross-tenant access blocked",
            metadata: {
              resourceKind,
              scopedResourceId: resourceId,
            },
          });
          return null;
        }
        return cloneAndFreeze(record);
      }
    }
    return null;
  }

  /** List a tenant's records for a kind.  Other tenants are filtered out. */
  listForTenant(
    tenantId: UUID,
    resourceKind?: FridayTenantScopedResourceKind,
  ): FridayTenantScopedResourceRecord[] {
    const items: FridayTenantScopedResourceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenantId !== tenantId) continue;
      if (record.deletedAt) continue;
      if (resourceKind && record.resourceKind !== resourceKind) continue;
      items.push(cloneAndFreeze(record));
    }
    return items;
  }

  /** Soft-delete a record.  Requires the caller's tenantId to match. */
  unregister(
    tenantId: UUID,
    resourceKind: FridayTenantScopedResourceKind,
    resourceId: string,
  ): FridayTenantScopedResourceRecord | null {
    for (const record of this.records.values()) {
      if (
        record.resourceKind === resourceKind &&
        record.resourceId === resourceId &&
        !record.deletedAt
      ) {
        if (record.tenantId !== tenantId) {
          this.auditLogger.log({
            tenantId,
            principalId: "tenant-scoped-resource-registry",
            action: "tenant_scoped_resource.cross_tenant_denied",
            resourceType: "tenant",
            resourceId: tenantId,
            decision: "deny",
            reason: "cross-tenant unregister blocked",
            metadata: {
              resourceKind,
              scopedResourceId: resourceId,
            },
          });
          return null;
        }
        const removed: FridayTenantScopedResourceRecord = {
          ...record,
          etag: generateEtag(),
          updatedAt: now(),
          deletedAt: now(),
        };
        this.persist(removed);
        this.auditLogger.log({
          tenantId,
          principalId: "tenant-scoped-resource-registry",
          action: "tenant_scoped_resource.unregister",
          resourceType: "tenant",
          resourceId: tenantId,
          decision: "allow",
          metadata: {
            resourceKind,
            scopedResourceId: resourceId,
          },
        });
        return cloneAndFreeze(removed);
      }
    }
    return null;
  }
}
