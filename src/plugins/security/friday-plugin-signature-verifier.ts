/**
 * Signature verification for local plugins.
 *
 * - Local: trust-on-install SHA-256 fingerprinting.
 */

import { createHash } from "node:crypto";

import { FridayDomainError } from "#errors";
import { FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";

// ─── Types ───

export interface FridayPluginSignatureVerificationResult {
  verified: boolean;
  checksum: string;
  trustMode: "signed" | "trust_on_install";
  fingerprint?: string;
  keyId?: string;
  reason?: string;
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

  /** Evaluate local trust-on-install: compute fingerprint, require user approval. */
  evaluateLocalTrustOnInstall(input: FridayPluginLocalTrustInput): FridayPluginSignatureVerificationResult;
}

export interface CreateFridayPluginSignatureVerifierDeps {
  /** Override SHA-256 computation for testing. */
  computeSha256?: (data: Buffer) => string;
}

// ─── Factory ───

export function createFridayPluginSignatureVerifier(
  deps?: CreateFridayPluginSignatureVerifierDeps,
): FridayPluginSignatureVerifier {
  const computeSha256 = deps?.computeSha256 ?? ((data: Buffer): string => {
    return createHash("sha256").update(data).digest("hex");
  });

  function computeChecksum(packageBytes: Buffer): string {
    return computeSha256(packageBytes);
  }

  return {
    computeChecksum,

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
