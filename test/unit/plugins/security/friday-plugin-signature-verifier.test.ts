import { describe, it, expect } from "vitest";
import { createFridayPluginSignatureVerifier } from "#plugins";
import { FridayDomainError } from "#errors";

describe("FridayPluginSignatureVerifier", () => {
  const MOCK_CHECKSUM = "abc123def456";
  const MOCK_FINGERPRINT = "fingerprint-sha256-mock";

  function createVerifier(overrides?: {
    computeSha256?: (data: Buffer) => string;
    verifyEd25519?: (publicKeyPem: string, sigValue: Buffer, payload: Buffer) => boolean;
  }) {
    return createFridayPluginSignatureVerifier({
      computeSha256: overrides?.computeSha256 ?? (() => MOCK_CHECKSUM),
      verifyEd25519: overrides?.verifyEd25519 ?? (() => true),
    });
  }

  // ─── computeChecksum ───

  it("computes checksum via injected SHA-256", () => {
    const verifier = createVerifier({ computeSha256: () => "deadbeef" });
    expect(verifier.computeChecksum(Buffer.from("hello"))).toBe("deadbeef");
  });

  // ─── evaluateLocalTrustOnInstall ───

  describe("evaluateLocalTrustOnInstall", () => {
    it("returns verified with fingerprint when user approved", () => {
      let callCount = 0;
      const verifier = createVerifier({
        computeSha256: () => {
          callCount++;
          return callCount === 1 ? MOCK_CHECKSUM : MOCK_FINGERPRINT;
        },
      });

      const result = verifier.evaluateLocalTrustOnInstall({
        pluginId: "friday.test.local",
        version: "1.0.0",
        packageBytes: Buffer.from("local-package"),
        userApproved: true,
      });

      expect(result.verified).toBe(true);
      expect(result.trustMode).toBe("trust_on_install");
      expect(result.fingerprint).toBe(MOCK_FINGERPRINT);
      expect(result.checksum).toBe(MOCK_CHECKSUM);
    });

    it("throws when user has not approved", () => {
      const verifier = createVerifier();

      expect(() =>
        verifier.evaluateLocalTrustOnInstall({
          pluginId: "friday.test.local",
          version: "1.0.0",
          packageBytes: Buffer.from("data"),
          userApproved: false,
        }),
      ).toThrow(FridayDomainError);
    });

    it("throws with PLUGIN_SIGNATURE_REQUIRED code when not approved", () => {
      const verifier = createVerifier();

      try {
        verifier.evaluateLocalTrustOnInstall({
          pluginId: "friday.test.local",
          version: "1.0.0",
          packageBytes: Buffer.from("data"),
          userApproved: false,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FridayDomainError);
        expect((err as FridayDomainError).code).toBe("PLUGIN_SIGNATURE_REQUIRED");
      }
    });
  });
});
