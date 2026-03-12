/**
 * B-009 Package Trust Policy — Enforces signed-package trust policy through
 * the security engine.
 *
 * Provides:
 * - Unified trust evaluation for packages and plugins
 * - Key trust store management (add, revoke, check expiry)
 * - Package install trust gate (blocks untrusted packages)
 * - Trust audit logging for all decisions
 * - Policy modes: strict (signature required), permissive (warn only), disabled
 *
 * @module security/multi-tenant/engine
 */

import type { ISODateTime, UUID } from "../model/friday-multi-tenant-security.types.js";

// ─── Trust Policy Types ───

/** Trust policy enforcement mode. */
export type TrustPolicyMode = "strict" | "permissive" | "disabled";

/** Trust evaluation outcome. */
export type TrustOutcome =
  | "trusted"
  | "untrusted_key"
  | "expired_key"
  | "revoked_key"
  | "expired_signature"
  | "digest_mismatch"
  | "signature_invalid"
  | "no_signature"
  | "policy_disabled"
  | "permissive_allow";

/** A trust decision for a package or plugin. */
export interface TrustDecision {
  /** Whether the operation is allowed to proceed. */
  readonly allowed: boolean;
  /** The outcome of trust evaluation. */
  readonly outcome: TrustOutcome;
  /** Human-readable explanation. */
  readonly reason: string;
  /** The key ID used for verification (if applicable). */
  readonly keyId?: string;
  /** The policy mode in effect. */
  readonly policyMode: TrustPolicyMode;
  /** When the decision was made. */
  readonly evaluatedAt: ISODateTime;
  /** Package or plugin identifier. */
  readonly subjectId: string;
  /** Subject version. */
  readonly subjectVersion: string;
  /** Subject type. */
  readonly subjectType: "package" | "plugin";
}

/** A trusted key in the trust store. */
export interface TrustStoreKey {
  /** Unique key identifier. */
  readonly keyId: string;
  /** Base64-encoded public key. */
  readonly publicKey: string;
  /** Signature algorithm. */
  readonly algorithm: "Ed25519" | "HMAC-SHA256";
  /** Key owner display name. */
  readonly owner: string;
  /** Tenant scope (undefined for global). */
  readonly tenantId?: string;
  /** When the key was trusted. */
  readonly trustedAt: ISODateTime;
  /** When the key expires (undefined for no expiry). */
  readonly expiresAt?: ISODateTime;
  /** When the key was revoked (undefined if not revoked). */
  readonly revokedAt?: ISODateTime;
  /** Revocation reason. */
  readonly revocationReason?: string;
}

/** Input for evaluating trust of a package. */
export interface PackageTrustInput {
  /** Package name. */
  readonly packageName: string;
  /** Package version. */
  readonly version: string;
  /** The signing key ID from the package signature. */
  readonly keyId?: string;
  /** Whether the package has a valid signature structure. */
  readonly hasSignature: boolean;
  /** The archive digest from the signature. */
  readonly signatureDigest?: string;
  /** The computed archive digest. */
  readonly computedDigest?: string;
  /** Tenant context. */
  readonly tenantId: string;
}

/** Input for evaluating trust of a plugin. */
export interface PluginTrustInput {
  /** Plugin identifier. */
  readonly pluginId: string;
  /** Plugin version. */
  readonly version: string;
  /** Source of the plugin. */
  readonly source: "marketplace" | "local" | "bundled";
  /** The signing key ID from the plugin signature. */
  readonly keyId?: string;
  /** Whether the plugin has a valid signature. */
  readonly hasSignature: boolean;
  /** Whether the signature was cryptographically verified. */
  readonly signatureVerified: boolean;
  /** Tenant context. */
  readonly tenantId: string;
}

/** Trust audit log entry. */
export interface TrustAuditEntry {
  /** Unique entry identifier. */
  readonly id: string;
  /** Subject identifier. */
  readonly subjectId: string;
  /** Subject version. */
  readonly subjectVersion: string;
  /** Subject type. */
  readonly subjectType: "package" | "plugin";
  /** Trust decision. */
  readonly decision: TrustDecision;
  /** When the audit entry was created. */
  readonly createdAt: ISODateTime;
}

// ─── Dependencies ───

export interface PackageTrustPolicyDeps {
  /** Clock function. */
  nowIso?: () => ISODateTime;
  /** ID generator. */
  generateId?: () => string;
  /** Initial policy mode. */
  policyMode?: TrustPolicyMode;
}

// ─── Interface ───

export interface FridayPackageTrustPolicy {
  /** Evaluate trust for a package installation. */
  evaluatePackageTrust(input: PackageTrustInput): TrustDecision;
  /** Evaluate trust for a plugin installation. */
  evaluatePluginTrust(input: PluginTrustInput): TrustDecision;
  /** Add a key to the trust store. Returns false if key already exists. */
  addTrustedKey(key: TrustStoreKey): boolean;
  /** Revoke a key in the trust store. Returns false if key not found or already revoked. */
  revokeKey(keyId: string, reason: string): boolean;
  /** Get a trusted key by ID. */
  getKey(keyId: string): TrustStoreKey | null;
  /** List all trusted keys (optionally filtered by tenant). */
  listKeys(tenantId?: string): readonly TrustStoreKey[];
  /** Check if a key is valid (exists, not revoked, not expired). */
  isKeyValid(keyId: string): boolean;
  /** Get the current policy mode. */
  getPolicyMode(): TrustPolicyMode;
  /** Set the policy mode. */
  setPolicyMode(mode: TrustPolicyMode): void;
  /** Get the trust audit log. */
  getAuditLog(): readonly TrustAuditEntry[];
  /** Get audit entries for a specific subject. */
  getAuditForSubject(subjectId: string): readonly TrustAuditEntry[];
  /** Get trust statistics. */
  getStats(): TrustPolicyStats;
  /** Reset all state. */
  reset(): void;
}

/** Aggregate trust policy statistics. */
export interface TrustPolicyStats {
  /** Total keys in trust store. */
  readonly totalKeys: number;
  /** Active (non-revoked, non-expired) keys. */
  readonly activeKeys: number;
  /** Revoked keys. */
  readonly revokedKeys: number;
  /** Total trust decisions made. */
  readonly totalDecisions: number;
  /** Decisions that allowed the operation. */
  readonly allowedDecisions: number;
  /** Decisions that denied the operation. */
  readonly deniedDecisions: number;
  /** Current policy mode. */
  readonly policyMode: TrustPolicyMode;
}

// ─── Factory ───

let idCounter = 0;

export function createPackageTrustPolicy(
  deps: PackageTrustPolicyDeps = {},
): FridayPackageTrustPolicy {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const generateId = deps.generateId ?? (() => `tpe-${++idCounter}`);

  let policyMode: TrustPolicyMode = deps.policyMode ?? "strict";
  const keys = new Map<string, TrustStoreKey>();
  const auditLog: TrustAuditEntry[] = [];
  let totalDecisions = 0;
  let allowedDecisions = 0;
  let deniedDecisions = 0;

  function isKeyValidInternal(key: TrustStoreKey): boolean {
    if (key.revokedAt) return false;
    if (key.expiresAt) {
      const now = nowIso();
      if (key.expiresAt < now) return false;
    }
    return true;
  }

  function makeDecision(
    allowed: boolean,
    outcome: TrustOutcome,
    reason: string,
    subjectId: string,
    subjectVersion: string,
    subjectType: "package" | "plugin",
    keyId?: string,
  ): TrustDecision {
    const decision: TrustDecision = {
      allowed,
      outcome,
      reason,
      keyId,
      policyMode,
      evaluatedAt: nowIso(),
      subjectId,
      subjectVersion,
      subjectType,
    };

    totalDecisions++;
    if (allowed) allowedDecisions++;
    else deniedDecisions++;

    // Audit log
    auditLog.push({
      id: generateId(),
      subjectId,
      subjectVersion,
      subjectType,
      decision,
      createdAt: nowIso(),
    });

    return decision;
  }

  function evaluateKeyTrust(
    keyId: string | undefined,
    hasSignature: boolean,
    subjectId: string,
    subjectVersion: string,
    subjectType: "package" | "plugin",
  ): TrustDecision | null {
    // Disabled mode: always allow
    if (policyMode === "disabled") {
      return makeDecision(true, "policy_disabled", "Trust policy is disabled", subjectId, subjectVersion, subjectType, keyId);
    }

    // No signature
    if (!hasSignature) {
      if (policyMode === "permissive") {
        return makeDecision(true, "permissive_allow", "No signature present; allowed by permissive policy", subjectId, subjectVersion, subjectType);
      }
      return makeDecision(false, "no_signature", "Package has no signature and strict policy requires one", subjectId, subjectVersion, subjectType);
    }

    // No key ID in signature
    if (!keyId) {
      if (policyMode === "permissive") {
        return makeDecision(true, "permissive_allow", "No signing key ID; allowed by permissive policy", subjectId, subjectVersion, subjectType);
      }
      return makeDecision(false, "untrusted_key", "Signature has no key ID", subjectId, subjectVersion, subjectType);
    }

    // Look up key in trust store
    const key = keys.get(keyId);
    if (!key) {
      if (policyMode === "permissive") {
        return makeDecision(true, "permissive_allow", `Key "${keyId}" not in trust store; allowed by permissive policy`, subjectId, subjectVersion, subjectType, keyId);
      }
      return makeDecision(false, "untrusted_key", `Signing key "${keyId}" is not in the trust store`, subjectId, subjectVersion, subjectType, keyId);
    }

    // Check revocation
    if (key.revokedAt) {
      return makeDecision(false, "revoked_key", `Signing key "${keyId}" has been revoked: ${key.revocationReason ?? "no reason"}`, subjectId, subjectVersion, subjectType, keyId);
    }

    // Check expiry
    if (key.expiresAt && key.expiresAt < nowIso()) {
      if (policyMode === "permissive") {
        return makeDecision(true, "permissive_allow", `Key "${keyId}" has expired; allowed by permissive policy`, subjectId, subjectVersion, subjectType, keyId);
      }
      return makeDecision(false, "expired_key", `Signing key "${keyId}" has expired`, subjectId, subjectVersion, subjectType, keyId);
    }

    // Key is valid
    return null; // Signal to caller to continue with content verification
  }

  return {
    evaluatePackageTrust(input) {
      // Check key trust first
      const keyResult = evaluateKeyTrust(input.keyId, input.hasSignature, input.packageName, input.version, "package");
      if (keyResult) return keyResult;

      // Verify digest match
      if (input.signatureDigest && input.computedDigest) {
        if (input.signatureDigest !== input.computedDigest) {
          return makeDecision(false, "digest_mismatch", `Archive digest mismatch: signature claims ${input.signatureDigest}, computed ${input.computedDigest}`, input.packageName, input.version, "package", input.keyId);
        }
      }

      return makeDecision(true, "trusted", "Package signature verified against trust store", input.packageName, input.version, "package", input.keyId);
    },

    evaluatePluginTrust(input) {
      // Bundled plugins are always trusted
      if (input.source === "bundled") {
        return makeDecision(true, "trusted", "Bundled plugins are implicitly trusted", input.pluginId, input.version, "plugin");
      }

      // Check key trust first
      const keyResult = evaluateKeyTrust(input.keyId, input.hasSignature, input.pluginId, input.version, "plugin");
      if (keyResult) return keyResult;

      // Marketplace plugins must have verified signatures
      if (input.source === "marketplace" && !input.signatureVerified) {
        return makeDecision(false, "signature_invalid", "Marketplace plugin signature verification failed", input.pluginId, input.version, "plugin", input.keyId);
      }

      return makeDecision(true, "trusted", "Plugin signature verified against trust store", input.pluginId, input.version, "plugin", input.keyId);
    },

    addTrustedKey(key) {
      if (keys.has(key.keyId)) return false;
      keys.set(key.keyId, key);
      return true;
    },

    revokeKey(keyId, reason) {
      const key = keys.get(keyId);
      if (!key) return false;
      if (key.revokedAt) return false;

      keys.set(keyId, {
        ...key,
        revokedAt: nowIso(),
        revocationReason: reason,
      });
      return true;
    },

    getKey(keyId) {
      return keys.get(keyId) ?? null;
    },

    listKeys(tenantId?) {
      const all = Array.from(keys.values());
      if (!tenantId) return all;
      return all.filter(k => !k.tenantId || k.tenantId === tenantId);
    },

    isKeyValid(keyId) {
      const key = keys.get(keyId);
      if (!key) return false;
      return isKeyValidInternal(key);
    },

    getPolicyMode() {
      return policyMode;
    },

    setPolicyMode(mode) {
      policyMode = mode;
    },

    getAuditLog() {
      return [...auditLog];
    },

    getAuditForSubject(subjectId) {
      return auditLog.filter(e => e.subjectId === subjectId);
    },

    getStats(): TrustPolicyStats {
      const allKeys = Array.from(keys.values());
      return {
        totalKeys: allKeys.length,
        activeKeys: allKeys.filter(k => isKeyValidInternal(k)).length,
        revokedKeys: allKeys.filter(k => !!k.revokedAt).length,
        totalDecisions,
        allowedDecisions,
        deniedDecisions,
        policyMode,
      };
    },

    reset() {
      keys.clear();
      auditLog.length = 0;
      totalDecisions = 0;
      allowedDecisions = 0;
      deniedDecisions = 0;
      policyMode = deps.policyMode ?? "strict";
      idCounter = 0;
    },
  };
}
