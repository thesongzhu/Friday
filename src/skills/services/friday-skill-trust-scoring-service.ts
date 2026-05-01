import type {
  FridaySignatureVerificationResult,
  FridaySkillTrustPolicy,
  FridayTrustScoreBreakdown,
} from "../model/friday-skill-catalog.types.js";

// ─── Interface ───

export interface FridaySkillTrustScoringService {
  computeScore(input: FridayTrustScoreInput): FridayTrustScoreBreakdown;
  evaluatePolicy(
    trustPolicy: FridaySkillTrustPolicy,
    breakdown: FridayTrustScoreBreakdown,
    verification: FridaySignatureVerificationResult,
  ): FridayTrustPolicyDecision;
}

export interface FridayTrustScoreInput {
  verification: FridaySignatureVerificationResult;
  trustPolicy: FridaySkillTrustPolicy;
  hasPinnedKeys: boolean;
  keyPinningPassed: boolean;
  publisherInstallCount: number;
  indexedAt: string;
  nowIso: string;
  cacheTtlHours: number;
}

export interface FridayTrustPolicyDecision {
  allowed: boolean;
  warnings: string[];
  reason?: string;
}

// ─── Score Constants ───

const SCORE_SIGNATURE_VALID = 40;
const SCORE_INTEGRITY_VALID = 15;
const SCORE_KEY_PINNING_CONFIGURED_PASSED = 20;
const SCORE_KEY_PINNING_NOT_CONFIGURED = 10;

const SCORE_SOURCE_POLICY: Record<FridaySkillTrustPolicy, number> = {
  strict: 15,
  warn: 10,
  permissive: 5,
};

const MAX_PUBLISHER_SCORE = 10;
const MAX_FRESHNESS_SCORE = 10;

// ─── Thresholds ───

const THRESHOLD_STRICT = 85;
const THRESHOLD_WARN = 70;
const THRESHOLD_WARN_LOW = 85;
const THRESHOLD_PERMISSIVE = 55;

// ─── Factory ───

export function createFridaySkillTrustScoringService(): FridaySkillTrustScoringService {
  return {
    computeScore(input) {
      const reasons: string[] = [];

      // Signature
      const signature = input.verification.signatureValid ? SCORE_SIGNATURE_VALID : 0;
      if (input.verification.signatureValid) {
        reasons.push("Valid cryptographic signature (+40)");
      } else {
        reasons.push("Missing or invalid signature (+0)");
      }

      // Integrity
      const integrity = input.verification.integrityValid ? SCORE_INTEGRITY_VALID : 0;
      if (input.verification.integrityValid) {
        reasons.push("Integrity checksum verified (+15)");
      } else {
        reasons.push("Integrity check failed (+0)");
      }

      // Key pinning
      let keyPinning: number;
      if (input.hasPinnedKeys) {
        if (input.keyPinningPassed) {
          keyPinning = SCORE_KEY_PINNING_CONFIGURED_PASSED;
          reasons.push("Key pinning configured and passed (+20)");
        } else {
          keyPinning = 0;
          reasons.push("Key pinning configured but failed (+0)");
        }
      } else {
        keyPinning = SCORE_KEY_PINNING_NOT_CONFIGURED;
        reasons.push("Key pinning not configured (+10)");
      }

      // Source policy baseline
      const sourcePolicy = SCORE_SOURCE_POLICY[input.trustPolicy];
      reasons.push(`Source policy: ${input.trustPolicy} (+${sourcePolicy})`);

      // Publisher reputation (capped at 10, based on install count)
      const publisher = Math.min(input.publisherInstallCount, MAX_PUBLISHER_SCORE);
      reasons.push(`Publisher install count: ${input.publisherInstallCount} (+${publisher})`);

      // Freshness (based on age vs TTL)
      const ageMs = new Date(input.nowIso).getTime() - new Date(input.indexedAt).getTime();
      const ttlMs = input.cacheTtlHours * 60 * 60 * 1000;
      let freshness: number;
      if (ageMs <= 0) {
        freshness = MAX_FRESHNESS_SCORE;
      } else if (ageMs >= ttlMs * 4) {
        freshness = 0;
      } else {
        freshness = Math.round(MAX_FRESHNESS_SCORE * Math.max(0, 1 - ageMs / (ttlMs * 4)));
      }
      reasons.push(`Freshness score (+${freshness})`);

      const total = signature + integrity + keyPinning + sourcePolicy + publisher + freshness;

      return {
        total,
        signature,
        integrity,
        keyPinning,
        sourcePolicy,
        publisher,
        freshness,
        reasons,
      };
    },

    evaluatePolicy(trustPolicy, breakdown, verification) {
      const warnings: string[] = [];

      switch (trustPolicy) {
        case "strict": {
          if (!verification.signatureValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid signature",
            };
          }
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Strict policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_STRICT) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below strict threshold ${THRESHOLD_STRICT}`,
            };
          }
          return { allowed: true, warnings };
        }

        case "warn": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Warn policy requires valid integrity",
            };
          }
          if (breakdown.total < THRESHOLD_WARN) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below warn threshold ${THRESHOLD_WARN}`,
            };
          }
          if (breakdown.total < THRESHOLD_WARN_LOW) {
            warnings.push(`Trust score ${breakdown.total} below recommended threshold ${THRESHOLD_WARN_LOW}`);
          }
          return { allowed: true, warnings };
        }

        case "permissive": {
          if (!verification.integrityValid) {
            return {
              allowed: false,
              warnings,
              reason: "Permissive policy still requires valid integrity",
            };
          }
          // Reject explicit signature fraud (integrity OK but signature explicitly failed)
          if (
            verification.checks.includes("signature:fail") &&
            !verification.checks.includes("signature:missing")
          ) {
            return {
              allowed: false,
              warnings,
              reason: "Signature explicitly invalid (possible tampering)",
            };
          }
          if (breakdown.total < THRESHOLD_PERMISSIVE) {
            return {
              allowed: false,
              warnings,
              reason: `Trust score ${breakdown.total} below permissive threshold ${THRESHOLD_PERMISSIVE}`,
            };
          }
          return { allowed: true, warnings };
        }

        default:
          return {
            allowed: false,
            warnings,
            reason: `Unknown trust policy: ${trustPolicy}`,
          };
      }
    },
  };
}
