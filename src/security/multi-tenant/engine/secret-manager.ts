/**
 * Secret Manager — CRUD with scope-discriminated union, version management, rotation.
 *
 * Enforces tenant isolation on every operation. Secret values are stored
 * as opaque encrypted strings (actual encryption is Phase 2); API responses
 * NEVER include the encrypted value — it is always redacted.
 *
 * Supports the three-level scope hierarchy:
 * - Tenant scope: visible to all workspace members in the tenant
 * - Workspace scope: visible to members of that workspace only
 * - Resource scope: visible to a specific resource (e.g., a skill)
 *
 * @module security/multi-tenant/engine/secret-manager
 */

import type {
  FridaySecretAccessAction,
  FridaySecretAccessLog,
  FridaySecretEntry,
  FridaySecretRotation,
  FridaySecretRotationState,
  FridaySecretScope,
  UUID,
} from "../model/friday-multi-tenant-security.types.js";

import {
  FRIDAY_SECRET_ROTATION_TRANSITIONS,
} from "../model/friday-multi-tenant-security.types.js";

import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../api/friday-multi-tenant-security-api.types.js";

import type { FridayCreateSecretScopeInput } from "../api/friday-multi-tenant-security-api.types.js";

import { cloneAndFreeze, generateEtag, generateId, now, SecurityEngineError } from "./utils.js";
import type { AuditLogger } from "./audit-logger.js";
import { decryptSecret, encryptSecret, getMasterKey } from "../../../providers/security/friday-secret-crypto.js";
import type { FridayEncryptedEnvelope } from "../../../providers/security/friday-secret-crypto.js";

// ─── Input Types ───

export interface CreateSecretInput {
  readonly name: string;
  readonly description?: string;
  readonly value: string;
  readonly scope: FridayCreateSecretScopeInput;
  readonly expiresAt?: string;
}

export interface UpdateSecretInput {
  readonly description?: string;
  readonly value?: string;
  readonly expiresAt?: string;
  readonly etag: string;
}

export interface RotateSecretInput {
  readonly newValue: string;
  readonly gracePeriodSeconds?: number;
  readonly etag: string;
  readonly initiatedBy: string;
}

/** Caller scope context for secret read/list/access-log visibility decisions. */
export type SecretRequestScopeContext =
  | {
      readonly principalId: string;
      readonly scopeType: "tenant";
    }
  | {
      readonly principalId: string;
      readonly scopeType: "workspace";
      readonly workspaceId: UUID;
    };

const DEFAULT_SECRET_REQUEST_SCOPE_CONTEXT: SecretRequestScopeContext = Object.freeze({
  principalId: "system",
  scopeType: "tenant",
});

// ─── Secret DTO (redacted) ───

/** Secret metadata without the encrypted value. */
export interface RedactedSecret {
  readonly id: UUID;
  readonly scope: FridaySecretScope;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly rotationState: FridaySecretRotationState;
  readonly expiresAt?: string;
  readonly rotatedAt?: string;
  readonly etag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ─── Secret Manager ───

/**
 * Optional persistence hook for secret/rotation/access-log writes.  The
 * hub bootstrap supplies a SQLite-backed implementation; in-memory tests
 * leave this undefined.
 */
export interface SecretManagerPersistence {
  hydrateSecrets(): Map<UUID, FridaySecretEntry>;
  hydrateRotations(): Map<UUID, FridaySecretRotation>;
  hydrateAccessLogs(): FridaySecretAccessLog[];
  saveSecret(secret: FridaySecretEntry): void;
  saveRotation(rotation: FridaySecretRotation): void;
  appendAccessLog(log: FridaySecretAccessLog): void;
}

/**
 * Optional master-key resolver override for the SecretManager.  Defaults
 * to {@link getMasterKey} which is fail-open (auto-generates and persists).
 * Bootstrap can pass `getStrictMasterKey` to fail closed when the env var
 * is not configured.
 */
export type MasterKeyResolver = () => Buffer;

export class SecretManager {
  private readonly secrets: Map<UUID, FridaySecretEntry>;
  private readonly rotations: Map<UUID, FridaySecretRotation>;
  private readonly accessLogs: FridaySecretAccessLog[];
  private readonly persistence?: SecretManagerPersistence;
  private readonly masterKeyResolver: MasterKeyResolver;

  constructor(
    private readonly auditLogger: AuditLogger,
    options?: { persistence?: SecretManagerPersistence; masterKeyResolver?: MasterKeyResolver },
  ) {
    this.persistence = options?.persistence;
    this.masterKeyResolver = options?.masterKeyResolver ?? getMasterKey;
    this.secrets = this.persistence?.hydrateSecrets() ?? new Map();
    this.rotations = this.persistence?.hydrateRotations() ?? new Map();
    this.accessLogs = this.persistence?.hydrateAccessLogs() ?? [];
  }

  private persistSecret(secret: FridaySecretEntry): void {
    this.secrets.set(secret.id, secret);
    this.persistence?.saveSecret(secret);
  }

  private persistRotation(rotation: FridaySecretRotation): void {
    this.rotations.set(rotation.id, rotation);
    this.persistence?.saveRotation(rotation);
  }

  private persistAccessLog(log: FridaySecretAccessLog): void {
    this.accessLogs.push(log);
    this.persistence?.appendAccessLog(log);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECRET CRUD
  // ═══════════════════════════════════════════════════════════════

  /** Create a secret within a tenant. */
  createSecret(tenantId: UUID, input: CreateSecretInput): RedactedSecret {
    const scope = this.buildScope(tenantId, input.scope);

    // Name uniqueness within scope
    for (const s of this.secrets.values()) {
      if (this.isSameScope(s.scope, scope) && s.name === input.name && !s.deletedAt) {
        throw new SecurityEngineError(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_NAME_CONFLICT,
          `A secret named '${input.name}' already exists in the same scope.`,
        );
      }
    }

    // Check workspace limit for workspace/resource scoped secrets
    if (scope.scopeType === "workspace" || scope.scopeType === "resource") {
      const workspaceId = scope.workspaceId;
      const count = Array.from(this.secrets.values())
        .filter((s) =>
          s.scope.scopeType !== "tenant" &&
          s.scope.tenantId === tenantId &&
          s.scope.workspaceId === workspaceId &&
          !s.deletedAt,
        ).length;
      // Note: limit enforcement would check tenant config; simplified for in-memory
      // The actual limit check against tenant config belongs in the service layer
      // where TenantManager is accessible.
      void count;
    }

    const timestamp = now();
    // Phase 2: real AES-256-GCM encryption via master key
    const masterKey = this.masterKeyResolver();
    const envelope = encryptSecret(input.value, masterKey);
    const encryptedValue = JSON.stringify(envelope);

    const secret: FridaySecretEntry = {
      id: generateId(),
      scope,
      name: input.name,
      description: input.description,
      encryptedValue,
      encryptionKeyId: "master-v1",
      version: 1,
      rotationState: "active",
      expiresAt: input.expiresAt,
      etag: generateEtag(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.persistSecret(secret);

    this.auditLogger.log({
      tenantId,
      action: "secret.create",
      resourceType: "secret",
      resourceId: secret.id,
      decision: "allow",
      reason: `Secret '${secret.name}' created at ${scope.scopeType} scope.`,
    });

    return cloneAndFreeze(this.redact(secret));
  }

  /** Get a secret by id, enforcing tenant + caller-scope isolation. Returns redacted (no value). */
  getSecret(
    tenantId: UUID,
    secretId: UUID,
    requestScope: SecretRequestScopeContext = DEFAULT_SECRET_REQUEST_SCOPE_CONTEXT,
  ): RedactedSecret {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(secretId, "secretId");
    this.assertValidRequestScopeContext(requestScope);
    const secret = this.getSecretInternal(tenantId, secretId, "secret.get");
    this.assertSecretScopeVisibility(secret, requestScope, "secret.get");
    this.auditLogger.log({
      tenantId,
      principalId: requestScope.principalId,
      action: "secret.get",
      resourceType: "secret",
      resourceId: secretId,
      decision: "allow",
      reason: `Secret visible to ${requestScope.scopeType}-scoped caller.`,
      metadata: {
        callerScopeType: requestScope.scopeType,
        secretScopeType: secret.scope.scopeType,
        ...(requestScope.scopeType === "workspace" ? { callerWorkspaceId: requestScope.workspaceId } : {}),
      },
    });
    return cloneAndFreeze(this.redact(secret));
  }

  /** List secrets visible to caller scope within a tenant. Returns redacted entries. */
  listSecrets(
    tenantId: UUID,
    options?: {
      workspaceId?: UUID;
      scopeType?: string;
      rotationState?: FridaySecretRotationState;
    },
    requestScope: SecretRequestScopeContext = DEFAULT_SECRET_REQUEST_SCOPE_CONTEXT,
  ): readonly RedactedSecret[] {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertValidRequestScopeContext(requestScope);
    const secrets = Array.from(this.secrets.values())
      .filter((s) => {
        if (s.scope.tenantId !== tenantId || s.deletedAt) return false;
        if (!this.assertSecretScopeVisibility(s, requestScope, "secret.list", true)) return false;
        if (options?.scopeType && s.scope.scopeType !== options.scopeType) return false;
        if (options?.rotationState && s.rotationState !== options.rotationState) return false;
        if (options?.workspaceId) {
          if (s.scope.scopeType === "tenant") return false;
          if (s.scope.workspaceId !== options.workspaceId) return false;
        }
        return true;
      })
      .map((s) => this.redact(s));

    this.auditLogger.log({
      tenantId,
      principalId: requestScope.principalId,
      action: "secret.list",
      resourceType: "secret",
      decision: "allow",
      reason: `Listed ${secrets.length} visible secrets for ${requestScope.scopeType}-scoped caller.`,
      metadata: {
        callerScopeType: requestScope.scopeType,
        ...(requestScope.scopeType === "workspace" ? { callerWorkspaceId: requestScope.workspaceId } : {}),
        ...(options?.scopeType !== undefined ? { requestedScopeType: options.scopeType } : {}),
      },
    });

    return cloneAndFreeze(secrets);
  }

  /** Update a secret with optimistic concurrency and tenant isolation. */
  updateSecret(tenantId: UUID, secretId: UUID, input: UpdateSecretInput): RedactedSecret {
    const existing = this.getSecretInternal(tenantId, secretId, "secret.update");

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for secret ${secretId}.`,
      );
    }

    const encryptedValue = input.value
      ? JSON.stringify(encryptSecret(input.value, this.masterKeyResolver()))
      : existing.encryptedValue;

    const version = input.value ? existing.version + 1 : existing.version;

    const updated: FridaySecretEntry = {
      ...existing,
      description: input.description !== undefined ? input.description : existing.description,
      encryptedValue,
      version,
      expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
      etag: generateEtag(),
      updatedAt: now(),
    };

    this.persistSecret(updated);

    this.auditLogger.log({
      tenantId,
      action: "secret.update",
      resourceType: "secret",
      resourceId: secretId,
      decision: "allow",
      reason: `Secret '${updated.name}' updated to version ${updated.version}.`,
    });

    return cloneAndFreeze(this.redact(updated));
  }

  /** Soft-delete a secret with optimistic concurrency and tenant isolation. */
  deleteSecret(tenantId: UUID, secretId: UUID, etag: string): RedactedSecret {
    const existing = this.getSecretInternal(tenantId, secretId, "secret.delete");

    if (existing.etag !== etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for secret ${secretId}.`,
      );
    }

    const deleted: FridaySecretEntry = {
      ...existing,
      rotationState: "retired",
      etag: generateEtag(),
      updatedAt: now(),
      deletedAt: now(),
    };

    this.persistSecret(deleted);

    this.auditLogger.log({
      tenantId,
      action: "secret.delete",
      resourceType: "secret",
      resourceId: secretId,
      decision: "allow",
      reason: `Secret '${existing.name}' soft-deleted.`,
    });

    return cloneAndFreeze(this.redact(deleted));
  }

  // ═══════════════════════════════════════════════════════════════
  // SECRET ROTATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Rotate a secret — create a new version with the new value.
   *
   * Validates the rotation state machine: only `active` secrets can be rotated.
   * Creates a rotation record for audit tracking.
   */
  rotateSecret(
    tenantId: UUID,
    secretId: UUID,
    input: RotateSecretInput,
  ): { secret: RedactedSecret; rotation: FridaySecretRotation } {
    const existing = this.getSecretInternal(tenantId, secretId, "secret.rotate");

    if (existing.etag !== input.etag) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.ETAG_MISMATCH,
        `Etag mismatch for secret ${secretId}.`,
      );
    }

    const beforeRotation = existing;
    let current = existing;
    const startedAt = now();
    let rotation: FridaySecretRotation = {
      id: generateId(),
      secretId,
      tenantId,
      fromVersion: existing.version,
      toVersion: existing.version,
      initiatedBy: input.initiatedBy,
      state: existing.rotationState,
      gracePeriodSeconds: input.gracePeriodSeconds ?? 3600,
      startedAt,
    };

    try {
      if (current.rotationState !== "active") {
        if (
          current.rotationState === "pending" ||
          current.rotationState === "pending_rotation" ||
          current.rotationState === "rotated"
        ) {
          current = this.transitionSecretState(
            current,
            "active",
            input.initiatedBy,
            "rotation activation",
          );
        } else {
          const allowed = FRIDAY_SECRET_ROTATION_TRANSITIONS[current.rotationState];
          const reason = `Secret ${secretId} is in '${current.rotationState}' state. ` +
            `Valid transitions: [${allowed.join(", ")}]. Cannot start rotation.`;
          rotation = {
            ...rotation,
            state: current.rotationState,
            errorMessage: reason,
            completedAt: now(),
          };
          this.persistRotation(rotation);
          this.auditLogger.log({
            tenantId,
            principalId: input.initiatedBy,
            action: "secret.rotate",
            resourceType: "secret",
            resourceId: secretId,
            decision: "deny",
            reason,
          });
          throw new SecurityEngineError(
            FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_ROTATION_INVALID,
            reason,
          );
        }
      }

      current = this.transitionSecretState(
        current,
        "rotating",
        input.initiatedBy,
        "rotation started",
      );
      rotation = {
        ...rotation,
        state: "rotating",
      };
      this.persistRotation(rotation);

      const newVersion = current.version + 1;
      const encryptedValue = JSON.stringify(encryptSecret(input.newValue, this.masterKeyResolver()));
      const updatingSecret: FridaySecretEntry = {
        ...current,
        encryptedValue,
        version: newVersion,
        etag: generateEtag(),
        updatedAt: now(),
      };
      this.persistSecret(updatingSecret);
      current = updatingSecret;

      const rotatedSecret = this.transitionSecretState(
        current,
        "rotated",
        input.initiatedBy,
        "rotation completed",
      );
      rotation = {
        ...rotation,
        toVersion: newVersion,
        state: "rotated",
        completedAt: now(),
      };
      this.persistRotation(rotation);

      this.auditLogger.log({
        tenantId,
        principalId: input.initiatedBy,
        action: "secret.rotate",
        resourceType: "secret",
        resourceId: secretId,
        decision: "allow",
        reason: `Secret '${existing.name}' rotated from v${existing.version} to v${newVersion}.`,
      });

      return cloneAndFreeze({ secret: this.redact(rotatedSecret), rotation });
    } catch (error) {
      this.persistSecret(beforeRotation);

      if (!rotation.completedAt) {
        const message = error instanceof Error ? error.message : "Unknown rotation failure.";
        const failedRotation: FridaySecretRotation = {
          ...rotation,
          state: current.rotationState,
          errorMessage: message,
          completedAt: now(),
        };
        this.persistRotation(failedRotation);
      }

      throw error;
    }
  }

  /** Get rotation history for a secret. */
  getRotationHistory(tenantId: UUID, secretId: UUID): readonly FridaySecretRotation[] {
    // Validate secret exists in tenant
    this.getSecret(tenantId, secretId);

    const history = Array.from(this.rotations.values())
      .filter((r) => r.secretId === secretId && r.tenantId === tenantId)
      .sort((a, b) => {
        const startedAtOrder = b.startedAt.localeCompare(a.startedAt);
        if (startedAtOrder !== 0) {
          return startedAtOrder;
        }
        return b.toVersion - a.toVersion;
      });
    return cloneAndFreeze(history);
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCESS LOG
  // ═══════════════════════════════════════════════════════════════

  /** Record a secret access event. */
  logAccess(
    tenantId: UUID,
    secretId: UUID,
    principalId: string,
    action: FridaySecretAccessAction,
    granted: boolean,
    policyEvaluationId?: UUID,
  ): FridaySecretAccessLog {
    const entry: FridaySecretAccessLog = {
      id: generateId(),
      secretId,
      tenantId,
      principalId,
      action,
      granted,
      policyEvaluationId,
      accessedAt: now(),
    };
    this.persistAccessLog(entry);

    this.auditLogger.log({
      tenantId,
      principalId,
      action: `secret.access.${action}`,
      resourceType: "secret",
      resourceId: secretId,
      decision: granted ? "allow" : "deny",
      reason: granted
        ? `Secret access action '${action}' granted.`
        : `Secret access action '${action}' denied.`,
      metadata: {
        ...(policyEvaluationId !== undefined ? { policyEvaluationId } : {}),
      },
    });

    return cloneAndFreeze(entry);
  }

  /** Query access log for a secret. Enforces tenant + caller-scope isolation. */
  queryAccessLog(
    tenantId: UUID,
    secretId: UUID,
    options?: {
      principalId?: string;
      action?: FridaySecretAccessAction;
      granted?: boolean;
      limit?: number;
    },
    requestScope: SecretRequestScopeContext = DEFAULT_SECRET_REQUEST_SCOPE_CONTEXT,
  ): readonly FridaySecretAccessLog[] {
    this.assertRequiredString(tenantId, "tenantId");
    this.assertRequiredString(secretId, "secretId");
    this.assertValidRequestScopeContext(requestScope);
    const secret = this.getSecretInternal(tenantId, secretId, "secret.access_log.query");
    this.assertSecretScopeVisibility(secret, requestScope, "secret.access_log.query");

    const limit = options?.limit ?? 50;
    const results = this.accessLogs
      .filter((e) => {
        if (e.tenantId !== tenantId || e.secretId !== secretId) return false;
        if (options?.principalId && e.principalId !== options.principalId) return false;
        if (options?.action && e.action !== options.action) return false;
        if (options?.granted !== undefined && e.granted !== options.granted) return false;
        return true;
      })
      .sort((a, b) => b.accessedAt.localeCompare(a.accessedAt))
      .slice(0, limit);

    this.auditLogger.log({
      tenantId,
      principalId: requestScope.principalId,
      action: "secret.access_log.query",
      resourceType: "secret",
      resourceId: secretId,
      decision: "allow",
      reason: `Access log query returned ${results.length} entries.`,
      metadata: {
        callerScopeType: requestScope.scopeType,
        limit,
        ...(requestScope.scopeType === "workspace" ? { callerWorkspaceId: requestScope.workspaceId } : {}),
      },
    });

    return cloneAndFreeze(results);
  }

  // ─── Internal Helpers ───

  /** Validate required string fields at public boundaries. */
  private assertRequiredString(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        `Missing required parameter '${fieldName}'.`,
      );
    }
  }

  /** Validate request scope context shape. */
  private assertValidRequestScopeContext(
    requestScope: SecretRequestScopeContext,
  ): void {
    if (!requestScope || typeof requestScope !== "object") {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "Missing required request scope context.",
      );
    }
    this.assertRequiredString(requestScope.principalId, "requestScope.principalId");
    if (requestScope.scopeType === "workspace") {
      this.assertRequiredString(requestScope.workspaceId, "requestScope.workspaceId");
      return;
    }
    if (requestScope.scopeType !== "tenant") {
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.VALIDATION_FAILED,
        "requestScope.scopeType must be 'tenant' or 'workspace'.",
      );
    }
  }

  /**
   * Assert whether caller scope can see a secret.
   *
   * - Tenant caller: may only read tenant-scoped secrets.
   * - Workspace caller: may only read workspace/resource secrets in the same workspace.
   */
  private assertSecretScopeVisibility(
    secret: FridaySecretEntry,
    requestScope: SecretRequestScopeContext,
    action: string,
    softDeny = false,
  ): boolean {
    let visible = false;
    if (requestScope.scopeType === "tenant") {
      visible = secret.scope.scopeType === "tenant";
    } else {
      if (secret.scope.scopeType === "workspace") {
        visible = secret.scope.workspaceId === requestScope.workspaceId;
      } else if (secret.scope.scopeType === "resource") {
        visible = secret.scope.workspaceId === requestScope.workspaceId;
      } else {
        visible = false;
      }
    }

    if (visible) return true;

    this.auditLogger.log({
      tenantId: secret.scope.tenantId,
      principalId: requestScope.principalId,
      action,
      resourceType: "secret",
      resourceId: secret.id,
      decision: softDeny ? "warn" : "deny",
      reason: `Secret scope '${secret.scope.scopeType}' is not visible to ${requestScope.scopeType}-scoped caller.`,
      metadata: {
        callerScopeType: requestScope.scopeType,
        secretScopeType: secret.scope.scopeType,
        ...(requestScope.scopeType === "workspace" ? { callerWorkspaceId: requestScope.workspaceId } : {}),
      },
    });

    if (softDeny) return false;

    throw new SecurityEngineError(
      FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.PERMISSION_DENIED,
      `Secret ${secret.id} is outside caller scope visibility.`,
    );
  }

  /** Get the raw secret entry (with encrypted value) — internal only. */
  private getSecretInternal(tenantId: UUID, secretId: UUID, action: string): FridaySecretEntry {
    const secret = this.secrets.get(secretId);
    if (!secret || secret.scope.tenantId !== tenantId || secret.deletedAt) {
      this.auditLogger.log({
        tenantId,
        action,
        resourceType: "secret",
        resourceId: secretId,
        decision: "deny",
        reason: `Secret ${secretId} not found in tenant ${tenantId}.`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_NOT_FOUND,
        `Secret ${secretId} not found in tenant ${tenantId}.`,
      );
    }
    return secret;
  }

  /** Perform a guarded secret-rotation state transition and persist transition reason. */
  private transitionSecretState(
    secret: FridaySecretEntry,
    nextState: FridaySecretRotationState,
    principalId: string,
    reason: string,
  ): FridaySecretEntry {
    const allowedTransitions = FRIDAY_SECRET_ROTATION_TRANSITIONS[secret.rotationState];
    if (!allowedTransitions.includes(nextState)) {
      const errorMessage = `Invalid transition ${secret.rotationState} -> ${nextState} for secret ${secret.id}. ` +
        `Allowed: [${allowedTransitions.join(", ")}].`;
      this.auditLogger.log({
        tenantId: secret.scope.tenantId,
        principalId,
        action: "secret.rotation.transition",
        resourceType: "secret",
        resourceId: secret.id,
        decision: "deny",
        reason: `${reason}; ${errorMessage}`,
      });
      throw new SecurityEngineError(
        FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.SECRET_ROTATION_INVALID,
        errorMessage,
      );
    }

    const transitionedSecret: FridaySecretEntry = {
      ...secret,
      rotationState: nextState,
      rotatedAt: nextState === "rotated" ? now() : secret.rotatedAt,
      etag: generateEtag(),
      updatedAt: now(),
    };
    this.persistSecret(transitionedSecret);
    this.auditLogger.log({
      tenantId: secret.scope.tenantId,
      principalId,
      action: "secret.rotation.transition",
      resourceType: "secret",
      resourceId: secret.id,
      decision: "allow",
      reason: `${secret.rotationState} -> ${nextState}: ${reason}`,
    });
    return transitionedSecret;
  }

  /** Redact the encrypted value from a secret entry. */
  private redact(secret: FridaySecretEntry): RedactedSecret {
    return {
      id: secret.id,
      scope: secret.scope,
      name: secret.name,
      description: secret.description,
      version: secret.version,
      rotationState: secret.rotationState,
      expiresAt: secret.expiresAt,
      rotatedAt: secret.rotatedAt,
      etag: secret.etag,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
    };
  }

  /** Build a FridaySecretScope from tenant + scope input. */
  private buildScope(tenantId: UUID, input: FridayCreateSecretScopeInput): FridaySecretScope {
    switch (input.scopeType) {
      case "tenant":
        return { scopeType: "tenant", tenantId };
      case "workspace":
        return { scopeType: "workspace", tenantId, workspaceId: input.workspaceId };
      case "resource":
        return {
          scopeType: "resource",
          tenantId,
          workspaceId: input.workspaceId,
          resourceId: input.resourceId,
        };
    }
  }

  /** Check if two secret scopes are the same (same type and same IDs). */
  private isSameScope(a: FridaySecretScope, b: FridaySecretScope): boolean {
    if (a.scopeType !== b.scopeType) return false;
    if (a.tenantId !== b.tenantId) return false;
    if (a.scopeType === "workspace" && b.scopeType === "workspace") {
      return a.workspaceId === b.workspaceId;
    }
    if (a.scopeType === "resource" && b.scopeType === "resource") {
      return a.workspaceId === b.workspaceId && a.resourceId === b.resourceId;
    }
    return true;
  }
}
