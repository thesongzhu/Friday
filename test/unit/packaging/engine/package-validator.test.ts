import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  validatePackage,
  verifySignatureLogical,
  validatePlatformCompatibility,
} from "../../../../src/packaging/engine/package-validator.js";
import type { PackageContents } from "../../../../src/packaging/engine/package-validator.js";
import type {
  FridayPackageManifest,
  FridayPackageSignature,
  FridayPackageTrustedKey,
} from "../../../../src/packaging/model/friday-packaging.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
const FUTURE = "2027-02-24T12:00:00.000Z";
const PAST = "2025-01-01T00:00:00.000Z";
const TRUSTED_KEY_MATERIAL = "friday-packaging-test-key";
const TRUSTED_KEY_B64 = Buffer.from(TRUSTED_KEY_MATERIAL, "utf8").toString("base64");

function signArchiveDigest(archiveDigest: string, keyB64: string = TRUSTED_KEY_B64): string {
  return createHmac("sha256", Buffer.from(keyB64, "base64"))
    .update(archiveDigest, "utf8")
    .digest("base64");
}

function validManifest(): FridayPackageManifest {
  return {
    name: "@friday/test-pkg",
    version: "1.0.0",
    description: "Test package",
    author: { name: "Test Author" },
    capabilities: ["skill:test"],
    dependencies: {},
    fridayVersionRange: ">=0.1.0",
    assets: {},
  };
}

function validSignature(): FridayPackageSignature {
  const digest = "sha256:abc123def456";
  return {
    algorithm: "Ed25519",
    publicKey: TRUSTED_KEY_B64,
    signature: signArchiveDigest(digest),
    digest,
    manifestDigest: "sha256:manifest789",
    timestamp: NOW,
    expiresAt: FUTURE,
    keyId: "test-key-1",
  };
}

function validTrustedKey(): FridayPackageTrustedKey {
  return {
    id: "key-uuid-1",
    keyId: "test-key-1",
    publicKey: TRUSTED_KEY_B64,
    algorithm: "Ed25519",
    owner: "Test Owner",
    trustedAt: PAST,
    createdAt: PAST,
    updatedAt: PAST,
  };
}

function validContents(overrides?: Partial<PackageContents>): PackageContents {
  return {
    hasManifest: true,
    hasSignature: true,
    manifest: validManifest(),
    signature: validSignature(),
    filePaths: ["manifest.json", "signature.json"],
    totalSizeBytes: 1024,
    ...overrides,
  };
}

// ─── validatePackage ───

describe("validatePackage", () => {
  it("validates a well-formed package", () => {
    const result = validatePackage(validContents());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects package without manifest.json", () => {
    const result = validatePackage(validContents({ hasManifest: false, manifest: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "structure" && e.path === "manifest.json")).toBe(true);
  });

  it("rejects package without signature.json", () => {
    const result = validatePackage(validContents({ hasSignature: false, signature: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "structure" && e.path === "signature.json")).toBe(true);
  });

  it("rejects package exceeding size limit", () => {
    const result = validatePackage(
      validContents({ totalSizeBytes: 200_000_000 }),
      { maxPackageSizeBytes: 100_000_000 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "size")).toBe(true);
  });

  it("validates signature structure", () => {
    const badSig = { ...validSignature(), algorithm: "RSA" as "Ed25519" };
    const result = validatePackage(validContents({ signature: badSig }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "signature" && e.path === "algorithm")).toBe(true);
  });

  it("validates signature digest format", () => {
    const badSig = { ...validSignature(), digest: "invalid-digest" };
    const result = validatePackage(validContents({ signature: badSig }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "digest")).toBe(true);
  });

  it("validates manifest from JSON string", () => {
    const result = validatePackage(
      validContents({
        manifest: undefined,
        manifestJson: JSON.stringify({
          name: "@friday/test",
          version: "invalid",
          description: "Test",
          author: { name: "A" },
          capabilities: [],
          dependencies: {},
          fridayVersionRange: ">=0.1.0",
          assets: {},
        }),
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "manifest")).toBe(true);
  });

  it("handles invalid manifest JSON", () => {
    const result = validatePackage(
      validContents({
        manifest: undefined,
        manifestJson: "{broken json",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.category === "manifest")).toBe(true);
  });
});

// ─── verifySignatureLogical ───

describe("verifySignatureLogical", () => {
  it("returns valid for a correctly signed package", () => {
    const sig = validSignature();
    const result = verifySignatureLogical(
      sig,
      sig.manifestDigest,
      sig.digest,
      [validTrustedKey()],
      NOW,
    );
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("valid");
  });

  it("rejects untrusted key", () => {
    const sig = validSignature();
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("untrusted_key");
  });

  it("rejects revoked key", () => {
    const sig = validSignature();
    const revokedKey = { ...validTrustedKey(), revokedAt: NOW };
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [revokedKey], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("key_revoked");
  });

  it("rejects expired key", () => {
    const sig = validSignature();
    const expiredKey = { ...validTrustedKey(), expiresAt: PAST };
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [expiredKey], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("untrusted_key");
  });

  it("rejects expired signature", () => {
    const sig = { ...validSignature(), expiresAt: PAST };
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [validTrustedKey()], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("expired_signature");
  });

  it("rejects archive digest mismatch", () => {
    const sig = validSignature();
    const result = verifySignatureLogical(sig, sig.manifestDigest, "sha256:wrong", [validTrustedKey()], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("digest_mismatch");
  });

  it("rejects manifest digest mismatch", () => {
    const sig = validSignature();
    const result = verifySignatureLogical(sig, "sha256:wrong", sig.digest, [validTrustedKey()], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("manifest_tampered");
  });

  it("rejects public key mismatch", () => {
    const sig = validSignature();
    const wrongKey = { ...validTrustedKey(), publicKey: "d3Jvbmcta2V5" };
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [wrongKey], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("signature_invalid");
  });

  it("rejects cryptographically invalid signatures", () => {
    const sig = { ...validSignature(), signature: signArchiveDigest("sha256:different") };
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [validTrustedKey()], NOW);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("signature_invalid");
  });

  it("includes keyId and timing in result", () => {
    const sig = validSignature();
    const result = verifySignatureLogical(sig, sig.manifestDigest, sig.digest, [validTrustedKey()], NOW);
    expect(result.keyId).toBe("test-key-1");
    expect(result.verifiedAt).toBe(NOW);
    expect(typeof result.durationMs).toBe("number");
  });
});

// ─── validatePlatformCompatibility ───

describe("validatePlatformCompatibility", () => {
  it("returns empty for compatible platform", () => {
    const manifest = validManifest();
    const errors = validatePlatformCompatibility(manifest, "0.5.0");
    expect(errors).toHaveLength(0);
  });

  it("returns error for incompatible platform", () => {
    const manifest = { ...validManifest(), fridayVersionRange: ">=1.0.0" };
    const errors = validatePlatformCompatibility(manifest, "0.5.0");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path).toBe("fridayVersionRange");
  });

  it("returns error for invalid platform version", () => {
    const manifest = validManifest();
    const errors = validatePlatformCompatibility(manifest, "invalid");
    expect(errors.length).toBeGreaterThan(0);
  });
});
