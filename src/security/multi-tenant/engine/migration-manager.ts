/**
 * Migration Manager — in-memory migration orchestration for multi-tenant security.
 *
 * Handles idempotent migration (`up`), rollback (`down`), and read-only planning (`dryRun`)
 * for RBAC assignments, secret scopes, and idempotency key scoping.
 *
 * @module security/multi-tenant/engine/migration-manager
 */

import type {
  FridayRole,
  FridayRoleAssignment,
  FridaySecretEntry,
  FridaySecretRotationState,
  FridayTenant,
  FridayWorkspace,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_SECRET_ROTATION_STATES } from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, now, SecurityEngineError } from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";
import type { TenantManager} from "./tenant-manager.js";
import { MIGRATION_ACTOR } from "./tenant-manager.js";
import type { RbacEngine } from "./rbac-engine.js";
import type { SecretManager } from "./secret-manager.js";
import type { IdempotencyManager } from "./idempotency-manager.js";

interface IdempotencyRecordShape {
  readonly compositeKey: string;
  readonly payloadHash: string;
  readonly response: unknown;
  readonly createdAt: number;
}

interface MigrationCheckpoint {
  readonly tenants: Map<UUID, FridayTenant>;
  readonly workspaces: Map<UUID, FridayWorkspace>;
  readonly assignments: Map<UUID, FridayRoleAssignment>;
  readonly secrets: Map<UUID, FridaySecretEntry>;
  readonly idempotencyRecords: Map<string, IdempotencyRecordShape>;
  readonly createdDefaultTenant: boolean;
  readonly createdDefaultWorkspace: boolean;
  readonly defaultTenantId: UUID;
  readonly defaultWorkspaceId: UUID;
  readonly upMetrics: {
    readonly remappedAssignments: number;
    readonly rescopedSecrets: number;
    readonly rekeyedIdempotencyRecords: number;
    readonly normalizedRotationStates: number;
  };
  readonly createdAt: string;
}

/** Read-only dry-run migration report. */
export interface MigrationDryRunReport {
  readonly action: "dry_run";
  readonly defaultTenantId?: UUID;
  readonly defaultWorkspaceId?: UUID;
  readonly willCreateDefaultTenant: boolean;
  readonly willCreateDefaultWorkspace: boolean;
  readonly rbacAssignmentsToRescope: number;
  readonly secretsToRescope: number;
  readonly idempotencyRecordsToRekey: number;
  readonly rotationStatesToNormalize: number;
  readonly alreadyMigrated: boolean;
}

/** Applied migration report for `up()`. */
export interface MigrationUpReport {
  readonly action: "up";
  readonly applied: boolean;
  readonly alreadyApplied: boolean;
  readonly defaultTenantId: UUID;
  readonly defaultWorkspaceId: UUID;
  readonly createdDefaultTenant: boolean;
  readonly createdDefaultWorkspace: boolean;
  readonly remappedAssignments: number;
  readonly rescopedSecrets: number;
  readonly rekeyedIdempotencyRecords: number;
  readonly normalizedRotationStates: number;
  readonly checkpointStored: boolean;
}

/** Rollback report for `down()`. */
export interface MigrationDownReport {
  readonly action: "down";
  readonly restored: boolean;
  readonly removedDefaultTenant: boolean;
  readonly removedDefaultWorkspace: boolean;
  readonly restoredAssignments: number;
  readonly restoredSecrets: number;
  readonly restoredIdempotencyRecords: number;
}

const VALID_ROTATION_STATES = new Set<string>(FRIDAY_SECRET_ROTATION_STATES);

/**
 * Coordinates phase migration between legacy single-tenant and scoped multi-tenant state.
 */
export class MigrationManager {
  private checkpoint: MigrationCheckpoint | null = null;
  private migrationApplied = false;

  constructor(
    private readonly tenantManager: TenantManager,
    private readonly rbacEngine: RbacEngine,
    private readonly secretManager: SecretManager,
    private readonly idempotencyManager: IdempotencyManager,
    private readonly auditLogger: AuditLogger,
  ) {
    this.assertManagers();
  }

  /**
   * Apply migration idempotently.
   *
   * - Creates/reuses default tenant + workspace.
   * - Rescopes legacy RBAC, secrets, idempotency records.
   * - Persists rollback checkpoint.
   */
  up(): MigrationUpReport {
    const plan = this.computePlan();
    if (this.migrationApplied || plan.alreadyMigrated) {
      const hierarchy = this.ensureDefaultHierarchy();
      const noopReport: MigrationUpReport = {
        action: "up",
        applied: false,
        alreadyApplied: true,
        defaultTenantId: hierarchy.defaultTenantId,
        defaultWorkspaceId: hierarchy.defaultWorkspaceId,
        createdDefaultTenant: false,
        createdDefaultWorkspace: false,
        remappedAssignments: 0,
        rescopedSecrets: 0,
        rekeyedIdempotencyRecords: 0,
        normalizedRotationStates: 0,
        checkpointStored: this.checkpoint !== null,
      };
      return cloneAndFreeze(noopReport);
    }

    const tenantStore = this.getStore<FridayTenant>(this.tenantManager, "tenants");
    const workspaceStore = this.getStore<FridayWorkspace>(this.tenantManager, "workspaces");
    const assignmentStore = this.getStore<FridayRoleAssignment>(this.rbacEngine, "assignments");
    const roleStore = this.getStore<FridayRole>(this.rbacEngine, "roles");
    const secretStore = this.getStore<FridaySecretEntry>(this.secretManager, "secrets");
    const idempotencyStore = this.getStore<IdempotencyRecordShape>(this.idempotencyManager, "records");

    const snapshotTenants = this.cloneMap(tenantStore);
    const snapshotWorkspaces = this.cloneMap(workspaceStore);
    const snapshotAssignments = this.cloneMap(assignmentStore);
    const snapshotSecrets = this.cloneMap(secretStore);
    const snapshotIdempotency = this.cloneMap(idempotencyStore);

    const hierarchy = this.ensureDefaultHierarchy();

    const remappedAssignments = this.rescopeAssignments(
      assignmentStore,
      roleStore,
      hierarchy.defaultTenantId,
      hierarchy.defaultWorkspaceId,
    );
    const { rescopedSecrets, normalizedRotationStates } = this.rescopeSecrets(
      secretStore,
      hierarchy.defaultTenantId,
    );
    const rekeyedIdempotencyRecords = this.rekeyIdempotencyRecords(
      idempotencyStore,
      hierarchy.defaultTenantId,
    );

    this.checkpoint = {
      tenants: snapshotTenants,
      workspaces: snapshotWorkspaces,
      assignments: snapshotAssignments,
      secrets: snapshotSecrets,
      idempotencyRecords: snapshotIdempotency,
      createdDefaultTenant: hierarchy.createdDefaultTenant,
      createdDefaultWorkspace: hierarchy.createdDefaultWorkspace,
      defaultTenantId: hierarchy.defaultTenantId,
      defaultWorkspaceId: hierarchy.defaultWorkspaceId,
      upMetrics: {
        remappedAssignments,
        rescopedSecrets,
        rekeyedIdempotencyRecords,
        normalizedRotationStates,
      },
      createdAt: now(),
    };
    this.migrationApplied = true;

    this.auditLogger.log({
      tenantId: hierarchy.defaultTenantId,
      principalId: MIGRATION_ACTOR.principalId,
      action: "migration.up",
      resourceType: "tenant",
      resourceId: hierarchy.defaultTenantId,
      decision: "allow",
      reason: "Migration completed.",
      metadata: {
        createdDefaultTenant: hierarchy.createdDefaultTenant,
        createdDefaultWorkspace: hierarchy.createdDefaultWorkspace,
        remappedAssignments,
        rescopedSecrets,
        rekeyedIdempotencyRecords,
        normalizedRotationStates,
      },
    });

    const report: MigrationUpReport = {
      action: "up",
      applied: true,
      alreadyApplied: false,
      defaultTenantId: hierarchy.defaultTenantId,
      defaultWorkspaceId: hierarchy.defaultWorkspaceId,
      createdDefaultTenant: hierarchy.createdDefaultTenant,
      createdDefaultWorkspace: hierarchy.createdDefaultWorkspace,
      remappedAssignments,
      rescopedSecrets,
      rekeyedIdempotencyRecords,
      normalizedRotationStates,
      checkpointStored: true,
    };
    return cloneAndFreeze(report);
  }

  /**
   * Roll back the latest migration.
   *
   * Restores stores from checkpoint and removes default hierarchy only when
   * it was created by `up()`.
   */
  down(): MigrationDownReport {
    if (!this.checkpoint) {
      const noCheckpointReport: MigrationDownReport = {
        action: "down",
        restored: false,
        removedDefaultTenant: false,
        removedDefaultWorkspace: false,
        restoredAssignments: 0,
        restoredSecrets: 0,
        restoredIdempotencyRecords: 0,
      };
      return cloneAndFreeze(noCheckpointReport);
    }

    const tenantStore = this.getStore<FridayTenant>(this.tenantManager, "tenants");
    const workspaceStore = this.getStore<FridayWorkspace>(this.tenantManager, "workspaces");
    const assignmentStore = this.getStore<FridayRoleAssignment>(this.rbacEngine, "assignments");
    const secretStore = this.getStore<FridaySecretEntry>(this.secretManager, "secrets");
    const idempotencyStore = this.getStore<IdempotencyRecordShape>(this.idempotencyManager, "records");

    this.restoreMap(tenantStore, this.checkpoint.tenants);
    this.restoreMap(workspaceStore, this.checkpoint.workspaces);
    this.restoreMap(assignmentStore, this.checkpoint.assignments);
    this.restoreMap(secretStore, this.checkpoint.secrets);
    this.restoreMap(idempotencyStore, this.checkpoint.idempotencyRecords);

    this.auditLogger.log({
      tenantId: this.checkpoint.defaultTenantId,
      principalId: MIGRATION_ACTOR.principalId,
      action: "migration.down",
      resourceType: "tenant",
      resourceId: this.checkpoint.defaultTenantId,
      decision: "allow",
      reason: "Migration rollback completed.",
      metadata: {
        removedDefaultTenant: this.checkpoint.createdDefaultTenant,
        removedDefaultWorkspace: this.checkpoint.createdDefaultWorkspace,
      },
    });

    const report: MigrationDownReport = {
      action: "down",
      restored: true,
      removedDefaultTenant: this.checkpoint.createdDefaultTenant,
      removedDefaultWorkspace: this.checkpoint.createdDefaultWorkspace,
      restoredAssignments: this.checkpoint.assignments.size,
      restoredSecrets: this.checkpoint.secrets.size,
      restoredIdempotencyRecords: this.checkpoint.idempotencyRecords.size,
    };

    this.checkpoint = null;
    this.migrationApplied = false;
    return cloneAndFreeze(report);
  }

  /** Compute migration impact without writing state. */
  dryRun(): MigrationDryRunReport {
    return cloneAndFreeze({
      action: "dry_run",
      ...this.computePlan(),
    });
  }

  private computePlan(): Omit<MigrationDryRunReport, "action"> {
    const tenantStore = this.getStore<FridayTenant>(this.tenantManager, "tenants");
    const workspaceStore = this.getStore<FridayWorkspace>(this.tenantManager, "workspaces");
    const assignmentStore = this.getStore<FridayRoleAssignment>(this.rbacEngine, "assignments");
    const roleStore = this.getStore<FridayRole>(this.rbacEngine, "roles");
    const secretStore = this.getStore<FridaySecretEntry>(this.secretManager, "secrets");
    const idempotencyStore = this.getStore<IdempotencyRecordShape>(this.idempotencyManager, "records");

    const defaultTenant = this.findDefaultTenant(tenantStore);
    const defaultWorkspace = defaultTenant
      ? this.findDefaultWorkspace(workspaceStore, defaultTenant.id)
      : undefined;

    let rbacAssignmentsToRescope = 0;
    for (const assignment of assignmentStore.values()) {
      if (this.shouldRescopeAssignment(assignment, roleStore)) {
        rbacAssignmentsToRescope += 1;
      }
    }

    let secretsToRescope = 0;
    let rotationStatesToNormalize = 0;
    for (const secret of secretStore.values()) {
      if (this.shouldRescopeSecret(secret)) {
        secretsToRescope += 1;
      }
      if (this.normalizeRotationState(secret.rotationState) !== secret.rotationState) {
        rotationStatesToNormalize += 1;
      }
    }

    let idempotencyRecordsToRekey = 0;
    const tenantIds = new Set<string>(tenantStore.keys());
    for (const compositeKey of idempotencyStore.keys()) {
      if (this.isLegacyIdempotencyKey(compositeKey, tenantIds)) {
        idempotencyRecordsToRekey += 1;
      }
    }

    const alreadyMigrated = !!defaultTenant &&
      !!defaultWorkspace &&
      rbacAssignmentsToRescope === 0 &&
      secretsToRescope === 0 &&
      idempotencyRecordsToRekey === 0 &&
      rotationStatesToNormalize === 0;

    return {
      defaultTenantId: defaultTenant?.id,
      defaultWorkspaceId: defaultWorkspace?.id,
      willCreateDefaultTenant: !defaultTenant,
      willCreateDefaultWorkspace: !defaultWorkspace,
      rbacAssignmentsToRescope,
      secretsToRescope,
      idempotencyRecordsToRekey,
      rotationStatesToNormalize,
      alreadyMigrated,
    };
  }

  private ensureDefaultHierarchy(): {
    readonly defaultTenantId: UUID;
    readonly defaultWorkspaceId: UUID;
    readonly createdDefaultTenant: boolean;
    readonly createdDefaultWorkspace: boolean;
  } {
    const tenantStore = this.getStore<FridayTenant>(this.tenantManager, "tenants");
    const workspaceStore = this.getStore<FridayWorkspace>(this.tenantManager, "workspaces");

    let defaultTenant = this.findDefaultTenant(tenantStore);
    let createdDefaultTenant = false;
    if (!defaultTenant) {
      defaultTenant = this.tenantManager.createTenant(
        { name: "Default Tenant", slug: "default" },
        MIGRATION_ACTOR,
      );
      createdDefaultTenant = true;
    }

    let defaultWorkspace = this.findDefaultWorkspace(workspaceStore, defaultTenant.id);
    let createdDefaultWorkspace = false;
    if (!defaultWorkspace) {
      defaultWorkspace = this.tenantManager.createWorkspace(
        defaultTenant.id,
        { name: "Default Workspace", slug: "default" },
        MIGRATION_ACTOR,
      );
      createdDefaultWorkspace = true;
    }

    return {
      defaultTenantId: defaultTenant.id,
      defaultWorkspaceId: defaultWorkspace.id,
      createdDefaultTenant,
      createdDefaultWorkspace,
    };
  }

  private rescopeAssignments(
    assignmentStore: Map<UUID, FridayRoleAssignment>,
    roleStore: Map<UUID, FridayRole>,
    defaultTenantId: UUID,
    defaultWorkspaceId: UUID,
  ): number {
    let changed = 0;
    for (const [assignmentId, assignment] of assignmentStore.entries()) {
      if (!this.shouldRescopeAssignment(assignment, roleStore)) continue;

      const role = roleStore.get(assignment.roleId);
      if (role?.scopeType === "workspace") {
        assignmentStore.set(assignmentId, {
          ...assignment,
          tenantId: defaultTenantId,
          scope: {
            scopeType: "workspace",
            tenantId: defaultTenantId,
            workspaceId: defaultWorkspaceId,
          },
        });
      } else {
        assignmentStore.set(assignmentId, {
          ...assignment,
          tenantId: defaultTenantId,
          scope: {
            scopeType: "tenant",
            tenantId: defaultTenantId,
          },
        });
      }
      changed += 1;
    }
    return changed;
  }

  private shouldRescopeAssignment(
    assignment: FridayRoleAssignment,
    roleStore: Map<UUID, FridayRole>,
  ): boolean {
    const scopeType = this.getScopeType(assignment.scope);
    if (scopeType === "tenant" || scopeType === "workspace") return false;

    const role = roleStore.get(assignment.roleId);
    if (scopeType === "system" && role && this.isSuperadminRole(role.name)) return false;
    return true;
  }

  private rescopeSecrets(
    secretStore: Map<UUID, FridaySecretEntry>,
    defaultTenantId: UUID,
  ): {
    readonly rescopedSecrets: number;
    readonly normalizedRotationStates: number;
  } {
    let rescopedSecrets = 0;
    let normalizedRotationStates = 0;

    for (const [secretId, secret] of secretStore.entries()) {
      const normalizedState = this.normalizeRotationState(secret.rotationState);
      const needsScopeRescope = this.shouldRescopeSecret(secret);
      const needsStateNormalize = normalizedState !== secret.rotationState;
      if (!needsScopeRescope && !needsStateNormalize) continue;

      let nextScope = secret.scope;
      if (needsScopeRescope) {
        nextScope = { scopeType: "tenant", tenantId: defaultTenantId };
        rescopedSecrets += 1;
      }
      if (needsStateNormalize) {
        normalizedRotationStates += 1;
      }

      secretStore.set(secretId, {
        ...secret,
        scope: nextScope,
        rotationState: normalizedState,
      });
    }

    return { rescopedSecrets, normalizedRotationStates };
  }

  private shouldRescopeSecret(secret: FridaySecretEntry): boolean {
    const scopeType = this.getScopeType(secret.scope);
    if (scopeType === "global") return true;
    if (scopeType === "tenant") {
      const rawScope = secret.scope as Partial<{ tenantId: string }>;
      return !rawScope.tenantId || rawScope.tenantId === "global";
    }
    return false;
  }

  private normalizeRotationState(state: unknown): FridaySecretRotationState {
    if (state === "pending_rotation") return "pending_rotation";
    if (typeof state === "string" && VALID_ROTATION_STATES.has(state)) {
      return state as FridaySecretRotationState;
    }
    return "active";
  }

  private rekeyIdempotencyRecords(
    idempotencyStore: Map<string, IdempotencyRecordShape>,
    defaultTenantId: UUID,
  ): number {
    const tenantStore = this.getStore<FridayTenant>(this.tenantManager, "tenants");
    const tenantIds = new Set<string>(tenantStore.keys());
    const updates: Array<{ readonly oldKey: string; readonly newKey: string; readonly record: IdempotencyRecordShape }> = [];

    for (const [compositeKey, record] of idempotencyStore.entries()) {
      if (!this.isLegacyIdempotencyKey(compositeKey, tenantIds)) continue;
      const parsed = this.parseLegacyIdempotencyKey(compositeKey);
      const newKey = `${parsed.principalId}:${defaultTenantId}:${parsed.operationId}:${parsed.key}`;
      updates.push({
        oldKey: compositeKey,
        newKey,
        record: {
          ...record,
          compositeKey: newKey,
        },
      });
    }

    for (const update of updates) {
      idempotencyStore.delete(update.oldKey);
      idempotencyStore.set(update.newKey, update.record);
    }
    return updates.length;
  }

  private isLegacyIdempotencyKey(compositeKey: string, tenantIds: Set<string>): boolean {
    const segments = compositeKey.split(":");
    if (segments.length < 4) return true;
    return !tenantIds.has(segments[1]);
  }

  private parseLegacyIdempotencyKey(compositeKey: string): {
    readonly principalId: string;
    readonly operationId: string;
    readonly key: string;
  } {
    const segments = compositeKey.split(":");
    if (segments.length < 3) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Invalid legacy idempotency key format '${compositeKey}'.`,
      );
    }
    return {
      principalId: segments[0],
      operationId: segments[1],
      key: segments.slice(2).join(":"),
    };
  }

  private findDefaultTenant(tenantStore: Map<UUID, FridayTenant>): FridayTenant | undefined {
    for (const tenant of tenantStore.values()) {
      if (tenant.slug === "default" && !tenant.deletedAt) return tenant;
    }
    return undefined;
  }

  private findDefaultWorkspace(
    workspaceStore: Map<UUID, FridayWorkspace>,
    tenantId: UUID,
  ): FridayWorkspace | undefined {
    for (const workspace of workspaceStore.values()) {
      if (
        workspace.tenantId === tenantId &&
        workspace.slug === "default" &&
        !workspace.deletedAt
      ) {
        return workspace;
      }
    }
    return undefined;
  }

  private getScopeType(scope: unknown): string {
    if (!scope || typeof scope !== "object") return "unknown";
    if (!Object.hasOwn(scope, "scopeType")) return "unknown";
    const scopeType = (scope as { readonly scopeType?: unknown }).scopeType;
    return typeof scopeType === "string" ? scopeType : "unknown";
  }

  private assertManagers(): void {
    if (!this.tenantManager || !this.rbacEngine || !this.secretManager || !this.idempotencyManager || !this.auditLogger) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "MigrationManager requires all manager dependencies.",
      );
    }
  }

  private getStore<TRecord>(owner: object, fieldName: string): Map<string, TRecord> {
    const store = Reflect.get(owner, fieldName);
    if (!(store instanceof Map)) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Expected map store '${fieldName}' on migration dependency.`,
      );
    }
    return store as Map<string, TRecord>;
  }

  private cloneMap<TKey, TValue>(input: Map<TKey, TValue>): Map<TKey, TValue> {
    const entries = Array.from(input.entries())
      .map(([key, value]) => [structuredClone(key), structuredClone(value)] as const);
    return new Map(entries);
  }

  private restoreMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
    target.clear();
    for (const [key, value] of source.entries()) {
      target.set(structuredClone(key), structuredClone(value));
    }
  }

  private isSuperadminRole(roleName: string): boolean {
    return roleName.trim().toLowerCase().replaceAll(/[:\s-]+/g, "_").includes("superadmin");
  }
}
