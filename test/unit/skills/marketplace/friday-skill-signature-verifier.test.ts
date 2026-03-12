import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign, createSign, constants } from "node:crypto";
import { createFridaySkillSignatureVerifier } from "#skills";

describe("FridaySkillSignatureVerifier", () => {
  const verifier = createFridaySkillSignatureVerifier();

  function makePackage(content: string): Buffer {
    return Buffer.from(content);
  }

  describe("computeChecksum", () => {
    it("computes SHA-256 hex digest", () => {
      const buf = makePackage("hello world");
      const checksum = verifier.computeChecksum(buf);
      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
      // Deterministic
      expect(verifier.computeChecksum(buf)).toBe(checksum);
    });
  });

  describe("integrity checks", () => {
    it("passes when checksums match", () => {
      const buf = makePackage("test package");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(true);
      expect(result.checks).toContain("integrity:pass");
    });

    it("fails when checksums mismatch", () => {
      const buf = makePackage("test package");
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: "0000000000000000000000000000000000000000000000000000000000000000",
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(false);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("integrity:fail");
    });
  });

  describe("Ed25519 signature verification", () => {
    it("verifies a valid Ed25519 signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("ed25519 test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-ed\n1.0.0\n${checksum}`);
      const sig = sign(null, payload, privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-ed",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-ed",
          version: "1.0.0",
          keyId: "ed-key-1",
          algorithm: "ed25519",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "ed-key-1",
          algorithm: "ed25519",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
      expect(result.keyId).toBe("ed-key-1");
      expect(result.algorithm).toBe("ed25519");
    });

    it("rejects an invalid Ed25519 signature", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const { privateKey: wrongKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("tampered");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-ed\n1.0.0\n${checksum}`);
      const wrongSig = sign(null, payload, wrongKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-ed",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-ed",
          version: "1.0.0",
          keyId: "ed-key-1",
          algorithm: "ed25519",
          value: wrongSig.toString("base64"),
        },
        publisherKey: {
          keyId: "ed-key-1",
          algorithm: "ed25519",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("signature:fail");
    });
  });

  describe("RSA-SHA256 signature verification", () => {
    it("verifies a valid RSA-SHA256 signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-rsa\n1.0.0\n${checksum}`);

      const signer = createSign("SHA256");
      signer.update(payload);
      const sig = signer.sign(privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-rsa",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-rsa",
          version: "1.0.0",
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
    });

    it("rejects an invalid RSA-SHA256 signature", () => {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa invalid");
      const checksum = verifier.computeChecksum(buf);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-rsa",
        version: "1.0.0",
        signatureDoc: {
          skillId: "skill-rsa",
          version: "1.0.0",
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          value: Buffer.from("invalid-signature").toString("base64"),
        },
        publisherKey: {
          keyId: "rsa-key-1",
          algorithm: "rsa-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
    });
  });

  describe("RSA-PSS-SHA256 signature verification", () => {
    it("verifies a valid RSA-PSS signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("rsa-pss test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-pss\n2.0.0\n${checksum}`);

      const pssSigner = createSign("SHA256");
      pssSigner.update(payload);
      const sig = pssSigner.sign({ key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pss",
        version: "2.0.0",
        signatureDoc: {
          skillId: "skill-pss",
          version: "2.0.0",
          keyId: "pss-key-1",
          algorithm: "rsa-pss-sha256",
          value: sig.toString("base64"),
        },
        publisherKey: {
          keyId: "pss-key-1",
          algorithm: "rsa-pss-sha256",
          publicKeyPem: pubPem,
        },
      });

      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("signature:pass");
    });
  });

  describe("key pinning", () => {
    it("passes when key is in pinned list", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("pinned test");
      const checksum = verifier.computeChecksum(buf);
      const payload = Buffer.from(`friday-skill-signature-v1\nskill-pin\n1.0.0\n${checksum}`);
      const sig = sign(null, payload, privateKey);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pin",
        version: "1.0.0",
        signatureDoc: { skillId: "skill-pin", version: "1.0.0", keyId: "pinned-key", algorithm: "ed25519", value: sig.toString("base64") },
        publisherKey: { keyId: "pinned-key", algorithm: "ed25519", publicKeyPem: pubPem },
        pinnedKeyIds: ["pinned-key", "other-key"],
      });

      expect(result.signatureValid).toBe(true);
      expect(result.checks).toContain("key-pinning:pass");
    });

    it("rejects when key is not in pinned list", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("unpinned test");
      const checksum = verifier.computeChecksum(buf);

      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "skill-pin",
        version: "1.0.0",
        signatureDoc: { skillId: "skill-pin", version: "1.0.0", keyId: "wrong-key", algorithm: "ed25519", value: "dummysig" },
        publisherKey: { keyId: "wrong-key", algorithm: "ed25519", publicKeyPem: pubPem },
        pinnedKeyIds: ["pinned-key-only"],
      });

      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("key-pinning:fail");
      expect(result.reason).toContain("not in pinned key list");
    });
  });

  describe("edge cases", () => {
    it("handles missing signature document", () => {
      const buf = makePackage("no sig");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
      });
      expect(result.integrityValid).toBe(true);
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("signature:missing");
    });

    it("handles revoked key", () => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

      const buf = makePackage("revoked");
      const checksum = verifier.computeChecksum(buf);
      const result = verifier.verifySignature({
        packageBytes: buf,
        expectedChecksum: checksum,
        skillId: "s1",
        version: "1.0.0",
        signatureDoc: { skillId: "s1", version: "1.0.0", keyId: "k1", algorithm: "ed25519", value: "sig" },
        publisherKey: { keyId: "k1", algorithm: "ed25519", publicKeyPem: pubPem, revokedAt: "2025-01-01T00:00:00.000Z" },
      });
      expect(result.signatureValid).toBe(false);
      expect(result.checks).toContain("key:revoked");
    });
  });
});
