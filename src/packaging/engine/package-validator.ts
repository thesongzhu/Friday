/**
 * Package Validator — Validate package structure, manifest, dependencies,
 * and signature integrity.
 *
 * Provides comprehensive pre-publish and pre-install validation including
 * manifest schema validation, dependency consistency checks, capability
 * format validation, size limits, and signature structure verification.
 *
 * @module packaging/engine/package-validator
 */

import { createPublicKey, verify } from "node:crypto";
import type {
  FridayPackageEngineConfig,
  FridayPackageManifest,
  FridayPackageSignature,
  FridayPackageTrustedKey,
  FridayPackageVerificationOutcome,
  FridayPackageVerificationResult,
  ISODateTime,
} from "../model/friday-packaging.types.js";
import { FRIDAY_PACKAGE_ENGINE_DEFAULTS } from "../model/friday-packaging.types.js";
import { isValidSemver, satisfiesRange } from "./semver.js";
import { validateManifestObject } from "./manifest-parser.js";
import type { ManifestValidationError } from "./manifest-parser.js";

// ─── Validation Result ───

/** Result of full package validation. */
export interface PackageValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PackageValidationError[];
}

/** A single validation error with category and detail. */
export interface PackageValidationError {
  readonly category: "manifest" | "structure" | "signature" | "dependency" | "size" | "platform";
  readonly path: string;
  readonly message: string;
}

// ─── Package Content Representation ───

/**
 * Abstract representation of a package's contents for validation.
 * Decouples validation from the actual archive format.
 */
export interface PackageContents {
  /** Whether the package contains a manifest.json. */
  readonly hasManifest: boolean;
  /** Whether the package contains a signature.json. */
  readonly hasSignature: boolean;
  /** Raw manifest JSON string. */
  readonly manifestJson?: string;
  /** Parsed manifest object (if already parsed). */
  readonly manifest?: FridayPackageManifest;
  /** Raw signature JSON string. */
  readonly signatureJson?: string;
  /** Parsed signature (if already parsed). */
  readonly signature?: FridayPackageSignature;
  /** List of all file paths in the package. */
  readonly filePaths: readonly string[];
  /** Total package size in bytes. */
  readonly totalSizeBytes: number;
}

// ─── Validator ───

/**
 * Validate a package's structure and contents.
 *
 * Performs the following checks:
 * 1. Required files exist (manifest.json, signature.json)
 * 2. Manifest is valid (delegates to manifest-parser)
 * 3. Package size is within limits
 * 4. Signature structure is well-formed
 * 5. Dependency versions are valid semver ranges
 * 6. Capabilities follow the type:name format
 */
export function validatePackage(
  contents: PackageContents,
  config?: Partial<FridayPackageEngineConfig>,
): PackageValidationResult {
  const maxSize = config?.maxPackageSizeBytes ?? FRIDAY_PACKAGE_ENGINE_DEFAULTS.maxPackageSizeBytes;
  const errors: PackageValidationError[] = [];

  // 1. Structure checks
  if (!contents.hasManifest) {
    errors.push({
      category: "structure",
      path: "manifest.json",
      message: "Package must contain a manifest.json file",
    });
  }
  if (!contents.hasSignature) {
    errors.push({
      category: "structure",
      path: "signature.json",
      message: "Package must contain a signature.json file",
    });
  }

  // 2. Size check
  if (contents.totalSizeBytes > maxSize) {
    errors.push({
      category: "size",
      path: "",
      message: `Package size ${contents.totalSizeBytes} bytes exceeds maximum ${maxSize} bytes`,
    });
  }

  // 3. Manifest validation
  if (contents.manifest) {
    const manifestResult = validateManifestObject(contents.manifest);
    if (!manifestResult.success) {
      for (const err of manifestResult.errors) {
        errors.push({ category: "manifest", path: err.path, message: err.message });
      }
    }
  } else if (contents.manifestJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.manifestJson);
    } catch (e) {
      errors.push({
        category: "manifest",
        path: "",
        message: `Invalid manifest JSON: ${(e as Error).message}`,
      });
      return { valid: false, errors };
    }
    const manifestResult = validateManifestObject(parsed);
    if (!manifestResult.success) {
      for (const err of manifestResult.errors) {
        errors.push({ category: "manifest", path: err.path, message: err.message });
      }
    }
  }

  // 4. Signature structure validation
  if (contents.signature) {
    validateSignatureStructure(contents.signature, errors);
  } else if (contents.signatureJson && contents.hasSignature) {
    let sigParsed: unknown;
    try {
      sigParsed = JSON.parse(contents.signatureJson);
    } catch (e) {
      errors.push({
        category: "signature",
        path: "",
        message: `Invalid signature JSON: ${(e as Error).message}`,
      });
    }
    if (sigParsed && typeof sigParsed === "object") {
      validateSignatureStructure(sigParsed as FridayPackageSignature, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Signature Structure Validation ───

function validateSignatureStructure(
  sig: FridayPackageSignature,
  errors: PackageValidationError[],
): void {
  if (sig.algorithm !== "Ed25519") {
    errors.push({
      category: "signature",
      path: "algorithm",
      message: `Unsupported signature algorithm: ${sig.algorithm}. Only Ed25519 is supported.`,
    });
  }
  if (!sig.publicKey || typeof sig.publicKey !== "string") {
    errors.push({ category: "signature", path: "publicKey", message: "Must be a non-empty base64 string" });
  }
  if (!sig.signature || typeof sig.signature !== "string") {
    errors.push({ category: "signature", path: "signature", message: "Must be a non-empty base64 string" });
  }
  if (!sig.digest || typeof sig.digest !== "string" || !sig.digest.startsWith("sha256:")) {
    errors.push({
      category: "signature",
      path: "digest",
      message: "Must be a string in format sha256:<hex>",
    });
  }
  if (!sig.manifestDigest || typeof sig.manifestDigest !== "string" || !sig.manifestDigest.startsWith("sha256:")) {
    errors.push({
      category: "signature",
      path: "manifestDigest",
      message: "Must be a string in format sha256:<hex>",
    });
  }
  if (!sig.keyId || typeof sig.keyId !== "string") {
    errors.push({ category: "signature", path: "keyId", message: "Must be a non-empty string" });
  }
  if (!sig.timestamp || typeof sig.timestamp !== "string") {
    errors.push({ category: "signature", path: "timestamp", message: "Must be an ISO 8601 date-time string" });
  }
  if (!sig.expiresAt || typeof sig.expiresAt !== "string") {
    errors.push({ category: "signature", path: "expiresAt", message: "Must be an ISO 8601 date-time string" });
  }
}

// ─── Signature Verification (Logical) ───

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Bytes(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed || !BASE64_RE.test(trimmed)) {
    return null;
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const normalizedInput = trimmed.replace(/=+$/u, "");
  const normalizedDecoded = decoded.toString("base64").replace(/=+$/u, "");
  return normalizedDecoded === normalizedInput ? decoded : null;
}

function buildSignaturePayload(archiveDigest: string, manifestDigest: string): Buffer {
  return Buffer.from(JSON.stringify({ digest: archiveDigest, manifestDigest }), "utf8");
}

function createEd25519PublicKey(publicKeyBytes: Buffer): ReturnType<typeof createPublicKey> | null {
  try {
    return createPublicKey(publicKeyBytes.toString("utf8"));
  } catch {
    // Try DER encodings below.
  }

  try {
    return createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    // Try raw Ed25519 public key bytes below.
  }

  if (publicKeyBytes.length === 32) {
    const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    try {
      return createPublicKey({
        key: Buffer.concat([ed25519SpkiPrefix, publicKeyBytes]),
        format: "der",
        type: "spki",
      });
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Verify a package signature against the trust store.
 *
 * This verifies both trust metadata and a cryptographic Ed25519 signature
 * over the canonical package digest payload.
 *
 * @param signature - The package signature to verify
 * @param manifestDigest - The computed manifest digest
 * @param archiveDigest - The computed archive digest
 * @param trustedKeys - Available trusted keys for verification
 * @param now - Current timestamp for expiry checks
 */
export function verifySignatureLogical(
  signature: FridayPackageSignature,
  manifestDigest: string,
  archiveDigest: string,
  trustedKeys: readonly FridayPackageTrustedKey[],
  now: ISODateTime,
): FridayPackageVerificationResult {
  const startTime = Date.now();

  const buildResult = (
    valid: boolean,
    outcome: FridayPackageVerificationOutcome,
    message: string,
  ): FridayPackageVerificationResult => ({
    valid,
    outcome,
    message,
    keyId: signature.keyId,
    verifiedAt: now,
    durationMs: Date.now() - startTime,
  });

  // Find the trusted key
  const trustedKey = trustedKeys.find((k) => k.keyId === signature.keyId);
  if (!trustedKey) {
    return buildResult(false, "untrusted_key", `Signing key "${signature.keyId}" is not in the trust store`);
  }

  // Check if key is revoked
  if (trustedKey.revokedAt) {
    return buildResult(false, "key_revoked", `Signing key "${signature.keyId}" has been revoked`);
  }

  // Check if key has expired
  if (trustedKey.expiresAt && trustedKey.expiresAt < now) {
    return buildResult(false, "untrusted_key", `Signing key "${signature.keyId}" has expired`);
  }

  // Check signature expiry
  if (signature.expiresAt < now) {
    return buildResult(false, "expired_signature", "Package signature has expired");
  }

  // Check archive digest
  if (signature.digest !== archiveDigest) {
    return buildResult(
      false,
      "digest_mismatch",
      `Archive digest mismatch: expected ${signature.digest}, got ${archiveDigest}`,
    );
  }

  // Check manifest digest
  if (signature.manifestDigest !== manifestDigest) {
    return buildResult(
      false,
      "manifest_tampered",
      `Manifest digest mismatch: expected ${signature.manifestDigest}, got ${manifestDigest}`,
    );
  }

  // Verify algorithm matches trusted key (do NOT trust signature.publicKey — use trusted key only)
  if (trustedKey.algorithm !== signature.algorithm) {
    return buildResult(
      false,
      "signature_invalid",
      `Signature algorithm mismatch for key "${signature.keyId}"`,
    );
  }

  // Use ONLY the trusted key material from server-side config, never from the package signature
  const trustedKeyBytes = decodeBase64Bytes(trustedKey.publicKey);
  if (!trustedKeyBytes) {
    return buildResult(
      false,
      "signature_invalid",
      `Trusted key "${signature.keyId}" is not valid base64 key material`,
    );
  }

  const signatureBytes = decodeBase64Bytes(signature.signature);
  if (!signatureBytes) {
    return buildResult(false, "signature_invalid", "Signature is not valid base64-encoded bytes");
  }

  const trustedPublicKey = createEd25519PublicKey(trustedKeyBytes);
  if (!trustedPublicKey) {
    return buildResult(
      false,
      "signature_invalid",
      `Trusted key "${signature.keyId}" is not valid Ed25519 public key material`,
    );
  }

  const payload = buildSignaturePayload(archiveDigest, manifestDigest);
  if (!verify(null, payload, trustedPublicKey, signatureBytes)) {
    return buildResult(false, "signature_invalid", "Cryptographic signature verification failed");
  }

  return buildResult(true, "valid", "Package signature verified successfully");
}

/**
 * Validate that a manifest's fridayVersionRange is compatible with
 * the current platform version.
 */
export function validatePlatformCompatibility(
  manifest: FridayPackageManifest,
  platformVersion: string,
): ManifestValidationError[] {
  if (!isValidSemver(platformVersion)) {
    return [{ path: "fridayVersionRange", message: `Invalid platform version: ${platformVersion}` }];
  }
  if (!satisfiesRange(platformVersion, manifest.fridayVersionRange)) {
    return [
      {
        path: "fridayVersionRange",
        message: `Package requires Friday ${manifest.fridayVersionRange}, but current version is ${platformVersion}`,
      },
    ];
  }
  return [];
}
