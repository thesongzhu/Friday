import { describe, it, expect } from "vitest";
import { createFridaySkillTrustScoringService } from "#skills";
import type { FridaySignatureVerificationResult } from "#skills";
import { NOW } from "./marketplace.helper.js";

describe("FridaySkillTrustScoringService", () => {
  const service = createFridaySkillTrustScoringService();

  function validVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: true,
      checks: ["integrity:pass", "signature:pass", "key-pinning:pass"],
    };
  }

  function noSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:missing"],
    };
  }

  function failedIntegrity(): FridaySignatureVerificationResult {
    return {
      integrityValid: false,
      signatureValid: false,
      checks: ["integrity:fail"],
    };
  }

  function failedSigVerification(): FridaySignatureVerificationResult {
    return {
      integrityValid: true,
      signatureValid: false,
      checks: ["integrity:pass", "signature:fail"],
    };
  }

  describe("computeScore", () => {
    it("computes maximum score for fully valid strict source", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 10,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      // 40 (sig) + 15 (integrity) + 20 (pin) + 15 (strict) + 10 (publisher capped) + 10 (fresh) = 110
      expect(score.signature).toBe(40);
      expect(score.integrity).toBe(15);
      expect(score.keyPinning).toBe(20);
      expect(score.sourcePolicy).toBe(15);
      expect(score.publisher).toBe(10);
      expect(score.freshness).toBe(10);
      expect(score.total).toBe(110);
    });

    it("gives 0 for signature when invalid", () => {
      const score = service.computeScore({
        verification: noSigVerification(),
        trustPolicy: "warn",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 3,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.signature).toBe(0);
      expect(score.integrity).toBe(15);
      expect(score.keyPinning).toBe(10); // not configured
      expect(score.sourcePolicy).toBe(10); // warn
    });

    it("gives 0 for integrity when failed", () => {
      const score = service.computeScore({
        verification: failedIntegrity(),
        trustPolicy: "permissive",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.integrity).toBe(0);
    });

    it("reduces freshness for stale entries", () => {
      const staleDate = new Date(new Date(NOW).getTime() - 24 * 60 * 60 * 1000).toISOString();
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "warn",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: staleDate,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      // 24h old with 6h TTL → ageMs = 24h, threshold = 24h → freshness should be 0
      expect(score.freshness).toBe(0);
    });

    it("caps publisher score at 10", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 999,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.publisher).toBe(10);
    });

    it("gives 0 key pinning when configured but failed", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.keyPinning).toBe(0);
    });

    it("gives source policy 5 for permissive", () => {
      const score = service.computeScore({
        verification: validVerification(),
        trustPolicy: "permissive",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 0,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      expect(score.sourcePolicy).toBe(5);
    });
  });

  describe("evaluatePolicy", () => {
    it("strict: allows when score high and sig valid", () => {
      const breakdown = service.computeScore({
        verification: validVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: true,
        keyPinningPassed: true,
        publisherInstallCount: 5,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      const decision = service.evaluatePolicy("strict", breakdown, validVerification());
      expect(decision.allowed).toBe(true);
    });

    it("strict: rejects when signature invalid", () => {
      const breakdown = service.computeScore({
        verification: noSigVerification(),
        trustPolicy: "strict",
        hasPinnedKeys: false,
        keyPinningPassed: false,
        publisherInstallCount: 10,
        indexedAt: NOW,
        nowIso: NOW,
        cacheTtlHours: 6,
      });

      const decision = service.evaluatePolicy("strict", breakdown, noSigVerification());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("signature");
    });

    it("warn: allows with warning when score between thresholds", () => {
      const verification = validVerification();
      const breakdown = {
        total: 75,
        signature: 40,
        integrity: 15,
        keyPinning: 10,
        sourcePolicy: 10,
        publisher: 0,
        freshness: 0,
        reasons: [],
      };

      const decision = service.evaluatePolicy("warn", breakdown, verification);
      expect(decision.allowed).toBe(true);
      expect(decision.warnings.length).toBeGreaterThan(0);
    });

    it("warn: rejects when integrity fails", () => {
      const breakdown = { total: 50, signature: 0, integrity: 0, keyPinning: 10, sourcePolicy: 10, publisher: 0, freshness: 0, reasons: [] };
      const decision = service.evaluatePolicy("warn", breakdown, failedIntegrity());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("integrity");
    });

    it("permissive: rejects explicit signature fraud", () => {
      const breakdown = { total: 60, signature: 0, integrity: 15, keyPinning: 10, sourcePolicy: 5, publisher: 10, freshness: 10, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, failedSigVerification());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("tampering");
    });

    it("permissive: allows missing signature with good integrity", () => {
      const breakdown = { total: 55, signature: 0, integrity: 15, keyPinning: 10, sourcePolicy: 5, publisher: 15, freshness: 10, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
      expect(decision.allowed).toBe(true);
    });

    it("permissive: rejects below threshold", () => {
      const breakdown = { total: 20, signature: 0, integrity: 15, keyPinning: 0, sourcePolicy: 5, publisher: 0, freshness: 0, reasons: [] };
      const decision = service.evaluatePolicy("permissive", breakdown, noSigVerification());
      expect(decision.allowed).toBe(false);
    });
  });
});
