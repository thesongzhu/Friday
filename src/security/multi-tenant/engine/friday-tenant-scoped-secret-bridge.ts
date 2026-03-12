/**
 * B-003 Tenant-Scoped Secret Bridge — connects the provider/channel layer's
 * flat secret references (scope + refKey) with the multi-tenant SecretManager's
 * tenant/workspace/resource scoping, access logging, and least-privilege checks.
 *
 * Providers and channels resolve credentials through this bridge, which:
 * - Maps flat provider refs to tenant-scoped secret lookups
 * - Enforces caller scope visibility (tenant vs workspace)
 * - Logs every access attempt with action + grant decision
 * - Supports secret resolution with fallback for migration
 *
 * @module security/multi-tenant/engine
 */

import type { UUID } from "../model/friday-multi-tenant-security.types.js";

// ─── Secret Reference ───

/**
 * A flat secret reference as used by providers/channels.
 * Maps to a multi-tenant scoped secret lookup.
 */
export interface TenantSecretRef {
  /** Tenant that owns the secret. */
  tenantId: UUID;
  /** Workspace scope (optional — narrows lookup). */
  workspaceId?: UUID;
  /** Resource scope (optional — e.g., provider ID, channel ID). */
  resourceId?: string;
  /** Flat reference key (e.g., `provider:openai-1:apiKey`). */
  refKey: string;
}

// ─── Resolved Secret ───

export interface ResolvedTenantSecret {
  /** The decrypted plaintext value. */
  value: string;
  /** Secret name in the tenant's secret store. */
  name: string;
  /** Current version (rotation tracking). */
  version: number;
  /** Scope at which the secret was found. */
  scopeType: "tenant" | "workspace" | "resource";
  /** Whether the secret is in a healthy rotation state. */
  rotationHealthy: boolean;
}

// ─── Access Result ───

export type SecretAccessDecision = "granted" | "denied" | "not_found";

export interface SecretAccessResult {
  decision: SecretAccessDecision;
  secret: ResolvedTenantSecret | null;
  reason: string;
  logged: boolean;
}

// ─── Dependencies ───

export interface TenantScopedSecretBridgeDeps {
  /** Resolve a secret by tenant + name (from the multi-tenant SecretManager). */
  resolveSecret: (params: {
    tenantId: UUID;
    name: string;
    workspaceId?: UUID;
    resourceId?: string;
  }) => {
    value: string;
    name: string;
    version: number;
    scopeType: "tenant" | "workspace" | "resource";
    rotationState: string;
  } | null;

  /** Log an access attempt. */
  logAccess: (params: {
    tenantId: UUID;
    secretName: string;
    principalId: string;
    action: "read" | "list" | "write" | "delete" | "rotate";
    granted: boolean;
    reason?: string;
  }) => void;

  /** Check if a caller has permission for the requested scope. */
  checkScopePermission: (params: {
    principalId: string;
    tenantId: UUID;
    workspaceId?: UUID;
    requiredAction: "read" | "write";
  }) => boolean;

  /** Clock. */
  nowIso?: () => string;
}

// ─── Interface ───

export interface FridayTenantScopedSecretBridge {
  /**
   * Resolve a secret through the tenant-scoped secret manager.
   * Enforces scope visibility and logs every access attempt.
   */
  resolve(params: {
    ref: TenantSecretRef;
    principalId: string;
    action?: "read" | "write";
  }): SecretAccessResult;

  /**
   * Resolve a provider credential by provider ID.
   * Shorthand for resolving `provider:<providerId>:apiKey` within a tenant.
   */
  resolveProviderCredential(params: {
    tenantId: UUID;
    providerId: string;
    principalId: string;
    workspaceId?: UUID;
  }): SecretAccessResult;

  /**
   * Resolve a channel credential by channel ID.
   * Shorthand for resolving `channel:<channelId>:secret` within a tenant.
   */
  resolveChannelCredential(params: {
    tenantId: UUID;
    channelId: string;
    principalId: string;
    workspaceId?: UUID;
  }): SecretAccessResult;

  /**
   * Get all access attempts recorded since creation.
   */
  getAccessLog(): readonly SecretAccessLogEntry[];

  /**
   * Reset internal state.
   */
  reset(): void;
}

// ─── Access Log Entry ───

export interface SecretAccessLogEntry {
  tenantId: UUID;
  secretName: string;
  principalId: string;
  action: string;
  decision: SecretAccessDecision;
  reason: string;
  timestamp: string;
}

// ─── Healthy rotation states ───

const HEALTHY_ROTATION_STATES = new Set(["active", "pending_rotation", "rotated"]);

// ─── Factory ───

export function createTenantScopedSecretBridge(
  deps: TenantScopedSecretBridgeDeps,
): FridayTenantScopedSecretBridge {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const accessLog: SecretAccessLogEntry[] = [];

  function recordAccess(
    tenantId: UUID,
    secretName: string,
    principalId: string,
    action: string,
    decision: SecretAccessDecision,
    reason: string,
  ): void {
    accessLog.push({
      tenantId,
      secretName,
      principalId,
      action,
      decision,
      reason,
      timestamp: nowIso(),
    });
  }

  function resolveInternal(
    ref: TenantSecretRef,
    principalId: string,
    action: "read" | "write",
  ): SecretAccessResult {
    const secretName = ref.refKey;

    // 1. Scope permission check
    const hasPermission = deps.checkScopePermission({
      principalId,
      tenantId: ref.tenantId,
      workspaceId: ref.workspaceId,
      requiredAction: action,
    });

    if (!hasPermission) {
      deps.logAccess({
        tenantId: ref.tenantId,
        secretName,
        principalId,
        action,
        granted: false,
        reason: "Insufficient scope permission",
      });
      recordAccess(ref.tenantId, secretName, principalId, action, "denied", "Insufficient scope permission");
      return {
        decision: "denied",
        secret: null,
        reason: "Insufficient scope permission",
        logged: true,
      };
    }

    // 2. Resolve secret from tenant-scoped store
    const resolved = deps.resolveSecret({
      tenantId: ref.tenantId,
      name: secretName,
      workspaceId: ref.workspaceId,
      resourceId: ref.resourceId,
    });

    if (!resolved) {
      deps.logAccess({
        tenantId: ref.tenantId,
        secretName,
        principalId,
        action,
        granted: false,
        reason: "Secret not found",
      });
      recordAccess(ref.tenantId, secretName, principalId, action, "not_found", "Secret not found");
      return {
        decision: "not_found",
        secret: null,
        reason: `Secret '${secretName}' not found in tenant '${ref.tenantId}'`,
        logged: true,
      };
    }

    // 3. Log successful access
    deps.logAccess({
      tenantId: ref.tenantId,
      secretName,
      principalId,
      action,
      granted: true,
    });
    recordAccess(ref.tenantId, secretName, principalId, action, "granted", "Access granted");

    return {
      decision: "granted",
      secret: {
        value: resolved.value,
        name: resolved.name,
        version: resolved.version,
        scopeType: resolved.scopeType,
        rotationHealthy: HEALTHY_ROTATION_STATES.has(resolved.rotationState),
      },
      reason: "Access granted",
      logged: true,
    };
  }

  return {
    resolve(params) {
      return resolveInternal(params.ref, params.principalId, params.action ?? "read");
    },

    resolveProviderCredential(params) {
      const ref: TenantSecretRef = {
        tenantId: params.tenantId,
        workspaceId: params.workspaceId,
        resourceId: params.providerId,
        refKey: `provider:${params.providerId}:apiKey`,
      };
      return resolveInternal(ref, params.principalId, "read");
    },

    resolveChannelCredential(params) {
      const ref: TenantSecretRef = {
        tenantId: params.tenantId,
        workspaceId: params.workspaceId,
        resourceId: params.channelId,
        refKey: `channel:${params.channelId}:secret`,
      };
      return resolveInternal(ref, params.principalId, "read");
    },

    getAccessLog() {
      return [...accessLog];
    },

    reset() {
      accessLog.length = 0;
    },
  };
}
