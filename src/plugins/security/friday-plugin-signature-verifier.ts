/**
 * Signature verification for marketplace and local plugins.
 *
 * - Marketplace: Ed25519 signature verification against known public keys.
 * - Local: trust-on-install SHA-256 fingerprinting.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

import { FridayDomainError } from "#errors";
import type { FridayPluginSignature } from "../model/friday-plugin.types.js";
import { FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";

// ─── Canonical Signing Payload ───

const FRIDAY_PLUGIN_SIGNATURE_PREFIX = "friday-plugin-signature-v1";

// ─── Types ───

export interface FridayPluginSignatureVerificationResult {
  verified: boolean;
  checksum: string;
  trustMode: "signed" | "trust_on_install";
  fingerprint?: string;
  keyId?: string;
  reason?: string;
}

export interface FridayPluginMarketplaceVerifyInput {
  pluginId: string;
  version: string;
  packageBytes: Buffer;
  expectedChecksum: string;
  signature: FridayPluginSignature;
  publicKeyPem: string;
  pinnedKeyIds?: string[];
}

export interface FridayPluginLocalTrustInput {
  pluginId: string;
  version: string;
  packageBytes: Buffer;
  userApproved: boolean;
}

export interface FridayPluginSignatureVerifier {
  /** Compute SHA-256 checksum of package bytes. */
  computeChecksum(packageBytes: Buffer): string;

  /** Verify a marketplace package signature using Ed25519. */
  verifyMarketplacePackage(input: FridayPluginMarketplaceVerifyInput): FridayPluginSignatureVerificationResult;

  /** Evaluate local trust-on-install: compute fingerprint, require user approval. */
  evaluateLocalTrustOnInstall(input: FridayPluginLocalTrustInput): FridayPluginSignatureVerificationResult;
}

export interface CreateFridayPluginSignatureVerifierDeps {
  /** Override SHA-256 computation for testing. */
  computeSha256?: (data: Buffer) => string;
  /** Override Ed25519 verification for testing. */
  verifyEd25519?: (publicKeyPem: string, sigValue: Buffer, payload: Buffer) => boolean;
}

// ─── Factory ───

export function createFridayPluginSignatureVerifier(
  deps?: CreateFridayPluginSignatureVerifierDeps,
): FridayPluginSignatureVerifier {
  const computeSha256 = deps?.computeSha256 ?? ((data: Buffer): string => {
    return createHash("sha256").update(data).digest("hex");
  });

  const verifyEd25519 = deps?.verifyEd25519 ?? ((publicKeyPem: string, sigValue: Buffer, payload: Buffer): boolean => {
    try {
      const publicKey = createPublicKey(publicKeyPem);
      return verify(null, payload, publicKey, sigValue);
    } catch (err) {
      console.warn("[friday][plugin-signature-verifier] Ed25519 verification failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  });

  function computeChecksum(packageBytes: Buffer): string {
    return computeSha256(packageBytes);
  }

  function buildSigningPayload(pluginId: string, version: string, checksum: string): Buffer {
    return Buffer.from(`${FRIDAY_PLUGIN_SIGNATURE_PREFIX}\n${pluginId}\n${version}\n${checksum}`);
  }

  return {
    computeChecksum,

    verifyMarketplacePackage(input: FridayPluginMarketplaceVerifyInput): FridayPluginSignatureVerificationResult {
      const {
        pluginId,
        version,
        packageBytes,
        expectedChecksum,
        signature,
        publicKeyPem,
        pinnedKeyIds,
      } = input;

      // Verify algorithm
      if (signature.algorithm !== "ed25519") {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
          `Unsupported signature algorithm: ${signature.algorithm}`,
          { httpStatus: 400, details: { pluginId, algorithm: signature.algorithm } },
        );
      }

      // Check key pinning
      if (pinnedKeyIds && pinnedKeyIds.length > 0 && !pinnedKeyIds.includes(signature.keyId)) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
          `Signature key "${signature.keyId}" is not in pinned key set`,
          { httpStatus: 403, details: { pluginId, keyId: signature.keyId, pinnedKeyIds } },
        );
      }

      // Compute and compare checksum
      const actualChecksum = computeChecksum(packageBytes);
      if (actualChecksum !== expectedChecksum) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
          `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
          { httpStatus: 400, details: { pluginId, expectedChecksum, actualChecksum } },
        );
      }

      // Build canonical payload and verify
      const payload = buildSigningPayload(pluginId, version, actualChecksum);
      const sigBytes = Buffer.from(signature.value, "base64");
      const verified = verifyEd25519(publicKeyPem, sigBytes, payload);

      if (!verified) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
          `Ed25519 signature verification failed for plugin "${pluginId}@${version}"`,
          { httpStatus: 403, details: { pluginId, version, keyId: signature.keyId } },
        );
      }

      return {
        verified: true,
        checksum: actualChecksum,
        trustMode: "signed",
        keyId: signature.keyId,
      };
    },

    evaluateLocalTrustOnInstall(input: FridayPluginLocalTrustInput): FridayPluginSignatureVerificationResult {
      const { pluginId, version, packageBytes, userApproved } = input;

      const checksum = computeChecksum(packageBytes);
      const fingerprint = computeSha256(
        Buffer.concat([
          Buffer.from(`${pluginId}\n${version}\n`),
          packageBytes,
        ]),
      );

      if (!userApproved) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
          `Local plugin "${pluginId}@${version}" requires user approval for trust-on-install`,
          { httpStatus: 403, details: { pluginId, version, fingerprint } },
        );
      }

      return {
        verified: true,
        checksum,
        trustMode: "trust_on_install",
        fingerprint,
      };
    },
  };
}
