import { createHash, createPublicKey, constants as cryptoConstants, verify } from "node:crypto";
import type {
  FridaySignatureVerificationResult,
  FridaySkillPublisherKeyDocument,
  FridaySkillSignatureAlgorithm,
  FridaySkillSignatureDocument,
} from "../model/friday-skill-catalog.types.js";

// ─── Interface ───

export interface FridaySkillSignatureVerifier {
  /** Compute SHA-256 hex digest of package bytes. */
  computeChecksum(packageBytes: Buffer): string;

  /** Verify integrity (checksum) and cryptographic signature. */
  verifySignature(input: {
    packageBytes: Buffer;
    expectedChecksum: string;
    skillId: string;
    version: string;
    signatureDoc?: FridaySkillSignatureDocument;
    publisherKey?: FridaySkillPublisherKeyDocument;
    pinnedKeyIds?: string[];
  }): FridaySignatureVerificationResult;
}

// ─── Canonical Payload ───

function buildCanonicalPayload(skillId: string, version: string, checksumHex: string): Buffer {
  return Buffer.from(`friday-skill-signature-v1\n${skillId}\n${version}\n${checksumHex}`);
}

// ─── Algorithm Verify ───

function verifyByAlgorithm(
  algorithm: FridaySkillSignatureAlgorithm,
  payload: Buffer,
  publicKeyPem: string,
  signatureBuffer: Buffer,
): boolean {
  const key = createPublicKey(publicKeyPem);

  switch (algorithm) {
    case "ed25519":
      return verify(null, payload, key, signatureBuffer);

    case "rsa-sha256":
      return verify("sha256", payload, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signatureBuffer);

    case "rsa-pss-sha256":
      return verify(
        "sha256",
        payload,
        { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        signatureBuffer,
      );

    default:
      return false;
  }
}

// ─── Factory ───

export function createFridaySkillSignatureVerifier(): FridaySkillSignatureVerifier {
  return {
    computeChecksum(packageBytes) {
      return createHash("sha256").update(packageBytes).digest("hex");
    },

    verifySignature(input) {
      const checks: string[] = [];

      // 1. Integrity check
      const actualChecksum = createHash("sha256").update(input.packageBytes).digest("hex");
      const integrityValid = actualChecksum === input.expectedChecksum;

      if (integrityValid) {
        checks.push("integrity:pass");
      } else {
        checks.push("integrity:fail");
        return {
          integrityValid: false,
          signatureValid: false,
          checks,
          reason: `Checksum mismatch: expected ${input.expectedChecksum}, got ${actualChecksum}`,
        };
      }

      // 2. If no signature doc, signature cannot be validated
      if (input.signatureDoc) {
        // Cross-validate signature metadata against requested install target
        if (input.signatureDoc.skillId !== input.skillId) {
          checks.push("metadata:skill-mismatch");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            reason: `Signature skillId "${input.signatureDoc.skillId}" does not match requested "${input.skillId}"`,
          };
        }
        if (input.signatureDoc.version !== input.version) {
          checks.push("metadata:version-mismatch");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            reason: `Signature version "${input.signatureDoc.version}" does not match requested "${input.version}"`,
          };
        }
      }

      if (!input.signatureDoc) {
        checks.push("signature:missing");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          reason: "No signature document provided",
        };
      }

      // 3. If no publisher key, signature cannot be validated
      if (!input.publisherKey || !input.publisherKey.publicKeyPem) {
        checks.push("signature:no-key");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: "No publisher key available",
        };
      }

      // 4. Check key revocation
      if (input.publisherKey.revokedAt) {
        checks.push("key:revoked");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Key ${input.signatureDoc.keyId} has been revoked`,
        };
      }

      // 5. Key pinning check
      if (input.pinnedKeyIds && input.pinnedKeyIds.length > 0) {
        if (input.pinnedKeyIds.includes(input.signatureDoc.keyId)) {
          checks.push("key-pinning:pass");
        } else {
          checks.push("key-pinning:fail");
          return {
            integrityValid: true,
            signatureValid: false,
            checks,
            keyId: input.signatureDoc.keyId,
            algorithm: input.signatureDoc.algorithm,
            reason: `Key ${input.signatureDoc.keyId} is not in pinned key list`,
          };
        }
      } else {
        checks.push("key-pinning:not-configured");
      }

      // 6. Cross-validate publisher key metadata against signature document
      if (input.publisherKey.keyId !== input.signatureDoc.keyId) {
        checks.push("metadata:keyId-mismatch");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Publisher key ID "${input.publisherKey.keyId}" does not match signature key ID "${input.signatureDoc.keyId}"`,
        };
      }
      if (input.publisherKey.algorithm !== input.signatureDoc.algorithm) {
        checks.push("metadata:algorithm-mismatch");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Publisher key algorithm "${input.publisherKey.algorithm}" does not match signature algorithm "${input.signatureDoc.algorithm}"`,
        };
      }

      // 7. Cryptographic verification
      const payload = buildCanonicalPayload(input.skillId, input.version, actualChecksum);
      const signatureBuffer = Buffer.from(input.signatureDoc.value, "base64");

      try {
        const valid = verifyByAlgorithm(
          input.signatureDoc.algorithm,
          payload,
          input.publisherKey.publicKeyPem,
          signatureBuffer,
        );

        if (valid) {
          checks.push("signature:pass");
        } else {
          checks.push("signature:fail");
        }

        return {
          integrityValid: true,
          signatureValid: valid,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: valid ? undefined : "Cryptographic signature verification failed",
        };
      } catch (err) {
        checks.push("signature:error");
        return {
          integrityValid: true,
          signatureValid: false,
          checks,
          keyId: input.signatureDoc.keyId,
          algorithm: input.signatureDoc.algorithm,
          reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
