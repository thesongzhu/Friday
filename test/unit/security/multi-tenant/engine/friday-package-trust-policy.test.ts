/**
 * B-009 Package Trust Policy — Unit Tests
 *
 * Validates trust evaluation for packages and plugins, key trust store
 * management, policy modes, audit logging, and statistics.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createPackageTrustPolicy,
  type FridayPackageTrustPolicy,
  type TrustStoreKey,
  type PackageTrustInput,
  type PluginTrustInput,
  type TrustPolicyMode,
} from "../../../../../src/security/multi-tenant/engine/friday-package-trust-policy.js";
import type { ISODateTime } from "../../../../../src/security/multi-tenant/model/friday-multi-tenant-security.types.js";

// ─── Helpers ───

const T0 = "2026-01-15T00:00:00.000Z" as ISODateTime;
const T1 = "2026-02-01T00:00:00.000Z" as ISODateTime;
const PAST = "2025-01-01T00:00:00.000Z" as ISODateTime;
const FUTURE = "2027-01-01T00:00:00.000Z" as ISODateTime;

let idSeq = 0;

function makeDeps(overrides: {
  policyMode?: TrustPolicyMode;
  nowIso?: () => ISODateTime;
} = {}) {
  idSeq = 0;
  return {
    nowIso: overrides.nowIso ?? (() => T1),
    generateId: () => `tpe-${++idSeq}`,
    policyMode: overrides.policyMode,
  };
}

function makeKey(overrides: Partial<TrustStoreKey> = {}): TrustStoreKey {
  return {
    keyId: "key-1",
    publicKey: "base64publickey==",
    algorithm: "Ed25519" as const,
    owner: "admin",
    trustedAt: T0,
    ...overrides,
  };
}

function makePkgInput(overrides: Partial<PackageTrustInput> = {}): PackageTrustInput {
  return {
    packageName: "@friday/test-pkg",
    version: "1.0.0",
    hasSignature: true,
    keyId: "key-1",
    signatureDigest: "sha256:abc123",
    computedDigest: "sha256:abc123",
    tenantId: "tenant-1",
    ...overrides,
  };
}

function makePluginInput(overrides: Partial<PluginTrustInput> = {}): PluginTrustInput {
  return {
    pluginId: "plugin-weather",
    version: "2.0.0",
    source: "marketplace" as const,
    hasSignature: true,
    keyId: "key-1",
    signatureVerified: true,
    tenantId: "tenant-1",
    ...overrides,
  };
}

// ─── Tests ───

describe("B-009 FridayPackageTrustPolicy", () => {
  let policy: FridayPackageTrustPolicy;

  beforeEach(() => {
    policy = createPackageTrustPolicy(makeDeps());
  });

  // ═══════════════════════════════════════════════════════════════
  // KEY TRUST STORE
  // ═══════════════════════════════════════════════════════════════

  describe("key trust store", () => {
    it("adds a key to the trust store", () => {
      const key = makeKey();
      expect(policy.addTrustedKey(key)).toBe(true);
      expect(policy.getKey("key-1")).toEqual(key);
    });

    it("rejects duplicate key IDs", () => {
      policy.addTrustedKey(makeKey());
      expect(policy.addTrustedKey(makeKey())).toBe(false);
    });

    it("lists all keys", () => {
      policy.addTrustedKey(makeKey({ keyId: "k-1" }));
      policy.addTrustedKey(makeKey({ keyId: "k-2", tenantId: "tenant-1" }));
      policy.addTrustedKey(makeKey({ keyId: "k-3", tenantId: "tenant-2" }));
      expect(policy.listKeys().length).toBe(3);
    });

    it("filters keys by tenant (includes global keys)", () => {
      policy.addTrustedKey(makeKey({ keyId: "k-global" })); // no tenantId = global
      policy.addTrustedKey(makeKey({ keyId: "k-t1", tenantId: "tenant-1" }));
      policy.addTrustedKey(makeKey({ keyId: "k-t2", tenantId: "tenant-2" }));

      const t1Keys = policy.listKeys("tenant-1");
      expect(t1Keys.length).toBe(2); // global + tenant-1
      expect(t1Keys.map(k => k.keyId).sort()).toEqual(["k-global", "k-t1"]);
    });

    it("revokes a key with reason", () => {
      policy.addTrustedKey(makeKey());
      expect(policy.revokeKey("key-1", "compromised")).toBe(true);

      const revoked = policy.getKey("key-1")!;
      expect(revoked.revokedAt).toBe(T1);
      expect(revoked.revocationReason).toBe("compromised");
    });

    it("returns false when revoking unknown key", () => {
      expect(policy.revokeKey("nonexistent", "reason")).toBe(false);
    });

    it("returns false when revoking already-revoked key", () => {
      policy.addTrustedKey(makeKey());
      policy.revokeKey("key-1", "first revoke");
      expect(policy.revokeKey("key-1", "second revoke")).toBe(false);
    });

    it("getKey returns null for unknown key", () => {
      expect(policy.getKey("nonexistent")).toBeNull();
    });

    it("isKeyValid checks existence, revocation, and expiry", () => {
      // Non-existent
      expect(policy.isKeyValid("nonexistent")).toBe(false);

      // Valid key
      policy.addTrustedKey(makeKey({ keyId: "valid", expiresAt: FUTURE }));
      expect(policy.isKeyValid("valid")).toBe(true);

      // Expired key
      policy.addTrustedKey(makeKey({ keyId: "expired", expiresAt: PAST }));
      expect(policy.isKeyValid("expired")).toBe(false);

      // Revoked key
      policy.addTrustedKey(makeKey({ keyId: "revoked" }));
      policy.revokeKey("revoked", "test");
      expect(policy.isKeyValid("revoked")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // POLICY MODE
  // ═══════════════════════════════════════════════════════════════

  describe("policy mode", () => {
    it("defaults to strict", () => {
      expect(policy.getPolicyMode()).toBe("strict");
    });

    it("respects initial policy mode from deps", () => {
      const p = createPackageTrustPolicy(makeDeps({ policyMode: "permissive" }));
      expect(p.getPolicyMode()).toBe("permissive");
    });

    it("can change policy mode at runtime", () => {
      policy.setPolicyMode("disabled");
      expect(policy.getPolicyMode()).toBe("disabled");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PACKAGE TRUST EVALUATION
  // ═══════════════════════════════════════════════════════════════

  describe("evaluatePackageTrust", () => {
    it("trusts a signed package with valid key and matching digest", () => {
      policy.addTrustedKey(makeKey());
      const result = policy.evaluatePackageTrust(makePkgInput());

      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("trusted");
      expect(result.keyId).toBe("key-1");
      expect(result.policyMode).toBe("strict");
      expect(result.subjectType).toBe("package");
      expect(result.subjectId).toBe("@friday/test-pkg");
      expect(result.subjectVersion).toBe("1.0.0");
    });

    it("rejects package with no signature in strict mode", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ hasSignature: false }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("no_signature");
    });

    it("rejects package with unknown key in strict mode", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ keyId: "unknown-key" }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("untrusted_key");
    });

    it("rejects package with revoked key", () => {
      policy.addTrustedKey(makeKey());
      policy.revokeKey("key-1", "compromised");

      const result = policy.evaluatePackageTrust(makePkgInput());
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("revoked_key");
      expect(result.reason).toContain("compromised");
    });

    it("rejects package with expired key in strict mode", () => {
      policy.addTrustedKey(makeKey({ expiresAt: PAST }));
      const result = policy.evaluatePackageTrust(makePkgInput());
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("expired_key");
    });

    it("rejects package with digest mismatch", () => {
      policy.addTrustedKey(makeKey());
      const result = policy.evaluatePackageTrust(makePkgInput({
        signatureDigest: "sha256:abc123",
        computedDigest: "sha256:def456",
      }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("digest_mismatch");
    });

    it("rejects package with no keyId in signature (strict)", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ keyId: undefined }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("untrusted_key");
    });

    it("trusts package when digests are not both present (no comparison)", () => {
      policy.addTrustedKey(makeKey());
      // Only signatureDigest, no computedDigest — no comparison triggered
      const result = policy.evaluatePackageTrust(makePkgInput({ computedDigest: undefined }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("trusted");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PLUGIN TRUST EVALUATION
  // ═══════════════════════════════════════════════════════════════

  describe("evaluatePluginTrust", () => {
    it("trusts bundled plugins implicitly", () => {
      const result = policy.evaluatePluginTrust(makePluginInput({ source: "bundled" }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("trusted");
      expect(result.reason).toContain("Bundled");
      expect(result.subjectType).toBe("plugin");
    });

    it("trusts marketplace plugin with valid key and verified signature", () => {
      policy.addTrustedKey(makeKey());
      const result = policy.evaluatePluginTrust(makePluginInput());
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("trusted");
    });

    it("rejects marketplace plugin with unverified signature", () => {
      policy.addTrustedKey(makeKey());
      const result = policy.evaluatePluginTrust(makePluginInput({ signatureVerified: false }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("signature_invalid");
    });

    it("trusts local plugin with valid key", () => {
      policy.addTrustedKey(makeKey());
      const result = policy.evaluatePluginTrust(makePluginInput({
        source: "local",
        signatureVerified: false, // local doesn't require marketplace verification
      }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("trusted");
    });

    it("rejects plugin with no signature in strict mode", () => {
      const result = policy.evaluatePluginTrust(makePluginInput({ hasSignature: false }));
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("no_signature");
    });

    it("rejects plugin with revoked key", () => {
      policy.addTrustedKey(makeKey());
      policy.revokeKey("key-1", "leaked");
      const result = policy.evaluatePluginTrust(makePluginInput());
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("revoked_key");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PERMISSIVE MODE
  // ═══════════════════════════════════════════════════════════════

  describe("permissive mode", () => {
    beforeEach(() => {
      policy = createPackageTrustPolicy(makeDeps({ policyMode: "permissive" }));
    });

    it("allows package with no signature (warns)", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ hasSignature: false }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("permissive_allow");
    });

    it("allows package with unknown key (warns)", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ keyId: "unknown" }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("permissive_allow");
    });

    it("allows package with expired key (warns)", () => {
      policy.addTrustedKey(makeKey({ expiresAt: PAST }));
      const result = policy.evaluatePackageTrust(makePkgInput());
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("permissive_allow");
    });

    it("still denies revoked key even in permissive mode", () => {
      policy.addTrustedKey(makeKey());
      policy.revokeKey("key-1", "compromised");
      const result = policy.evaluatePackageTrust(makePkgInput());
      expect(result.allowed).toBe(false);
      expect(result.outcome).toBe("revoked_key");
    });

    it("allows no keyId in permissive mode", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ keyId: undefined }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("permissive_allow");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DISABLED MODE
  // ═══════════════════════════════════════════════════════════════

  describe("disabled mode", () => {
    beforeEach(() => {
      policy = createPackageTrustPolicy(makeDeps({ policyMode: "disabled" }));
    });

    it("allows everything when disabled (package)", () => {
      const result = policy.evaluatePackageTrust(makePkgInput({ hasSignature: false }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("policy_disabled");
    });

    it("allows everything when disabled (plugin)", () => {
      const result = policy.evaluatePluginTrust(makePluginInput({ hasSignature: false }));
      expect(result.allowed).toBe(true);
      expect(result.outcome).toBe("policy_disabled");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AUDIT LOG
  // ═══════════════════════════════════════════════════════════════

  describe("audit log", () => {
    it("records every trust decision", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput());
      policy.evaluatePluginTrust(makePluginInput({ source: "bundled" }));

      const log = policy.getAuditLog();
      expect(log.length).toBe(2);
      expect(log[0]!.subjectId).toBe("@friday/test-pkg");
      expect(log[1]!.subjectId).toBe("plugin-weather");
    });

    it("filters audit entries by subject", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput());
      policy.evaluatePluginTrust(makePluginInput({ source: "bundled" }));

      const pkgEntries = policy.getAuditForSubject("@friday/test-pkg");
      expect(pkgEntries.length).toBe(1);
      expect(pkgEntries[0]!.subjectType).toBe("package");
    });

    it("audit entries have unique IDs", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput());
      policy.evaluatePackageTrust(makePkgInput({ version: "2.0.0" }));

      const log = policy.getAuditLog();
      expect(log[0]!.id).not.toBe(log[1]!.id);
    });

    it("audit log is a snapshot (not a reference)", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput());
      const log1 = policy.getAuditLog();
      policy.evaluatePackageTrust(makePkgInput({ version: "2.0.0" }));
      const log2 = policy.getAuditLog();
      expect(log1.length).toBe(1);
      expect(log2.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════════

  describe("statistics", () => {
    it("tracks key counts", () => {
      policy.addTrustedKey(makeKey({ keyId: "k-1" }));
      policy.addTrustedKey(makeKey({ keyId: "k-2", expiresAt: PAST }));
      policy.addTrustedKey(makeKey({ keyId: "k-3" }));
      policy.revokeKey("k-3", "test");

      const stats = policy.getStats();
      expect(stats.totalKeys).toBe(3);
      expect(stats.activeKeys).toBe(1); // k-1 only
      expect(stats.revokedKeys).toBe(1); // k-3
    });

    it("tracks decision counts", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput()); // allowed
      policy.evaluatePackageTrust(makePkgInput({ hasSignature: false })); // denied (strict)
      policy.evaluatePluginTrust(makePluginInput({ source: "bundled" })); // allowed

      const stats = policy.getStats();
      expect(stats.totalDecisions).toBe(3);
      expect(stats.allowedDecisions).toBe(2);
      expect(stats.deniedDecisions).toBe(1);
      expect(stats.policyMode).toBe("strict");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // RESET
  // ═══════════════════════════════════════════════════════════════

  describe("reset", () => {
    it("clears all state", () => {
      policy.addTrustedKey(makeKey());
      policy.evaluatePackageTrust(makePkgInput());
      policy.setPolicyMode("permissive");

      policy.reset();

      expect(policy.listKeys().length).toBe(0);
      expect(policy.getAuditLog().length).toBe(0);
      expect(policy.getStats().totalDecisions).toBe(0);
      expect(policy.getPolicyMode()).toBe("strict"); // back to default
    });

    it("reset restores initial policy mode", () => {
      const p = createPackageTrustPolicy(makeDeps({ policyMode: "permissive" }));
      p.setPolicyMode("disabled");
      p.reset();
      expect(p.getPolicyMode()).toBe("permissive");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DECISION SHAPE
  // ═══════════════════════════════════════════════════════════════

  describe("decision shape", () => {
    it("includes all required fields", () => {
      policy.addTrustedKey(makeKey());
      const decision = policy.evaluatePackageTrust(makePkgInput());

      expect(decision).toHaveProperty("allowed");
      expect(decision).toHaveProperty("outcome");
      expect(decision).toHaveProperty("reason");
      expect(decision).toHaveProperty("policyMode");
      expect(decision).toHaveProperty("evaluatedAt");
      expect(decision).toHaveProperty("subjectId");
      expect(decision).toHaveProperty("subjectVersion");
      expect(decision).toHaveProperty("subjectType");
      expect(decision.evaluatedAt).toBe(T1);
    });
  });
});
