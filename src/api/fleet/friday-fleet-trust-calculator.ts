import type {
  FridaySatelliteTrustBreakdown,
  FridayTrustBand,
} from "../model/friday-api-fleet.types.js";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
} from "#satellites";

// ─── Input ───

export interface FridayTrustCalculatorInput {
  pairingStatus: FridaySatellitePairingStatus;
  trustLevel: FridaySatelliteTrustLevel;
  hasRevokedTokens: boolean;
  hasExpiredHighPrivTokens: boolean;
  recentRevocationCount: number;
  recentSecurityFindingsCount: number;
}

// ─── Trust band from score ───

export function trustBandFromScore(score: number): FridayTrustBand {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ─── Calculator ───

export function calculateSatelliteTrust(
  input: FridayTrustCalculatorInput,
): FridaySatelliteTrustBreakdown {
  const reasons: string[] = [];

  // Identity score: trusted 40, restricted 20
  const identityScore = input.trustLevel === "trusted" ? 40 : 20;
  if (input.trustLevel === "restricted") {
    reasons.push("Satellite has restricted trust level");
  }

  // Status score
  let statusScore: number;
  switch (input.pairingStatus) {
    case "online":
      statusScore = 30;
      break;
    case "degraded":
      statusScore = 20;
      reasons.push("Satellite is in degraded state");
      break;
    case "paired":
      statusScore = 15;
      break;
    case "offline":
      statusScore = 10;
      reasons.push("Satellite is offline");
      break;
    case "pending":
      statusScore = 5;
      reasons.push("Satellite pairing is pending");
      break;
    case "revoked":
      statusScore = 0;
      reasons.push("Satellite pairing has been revoked");
      break;
    default:
      statusScore = 0;
  }

  // Hygiene score: 0..20
  let hygieneScore = 20;
  if (input.hasRevokedTokens) {
    hygieneScore -= 5;
    reasons.push("Has revoked tokens");
  }
  if (input.hasExpiredHighPrivTokens) {
    hygieneScore -= 10;
    reasons.push("Has expired high-privilege tokens");
  }
  hygieneScore = Math.max(0, hygieneScore);

  // Incident penalty: 0..40
  let incidentPenalty = 0;
  incidentPenalty += Math.min(input.recentRevocationCount * 10, 20);
  incidentPenalty += Math.min(input.recentSecurityFindingsCount * 5, 20);
  incidentPenalty = Math.min(incidentPenalty, 40);

  if (input.recentRevocationCount > 0) {
    reasons.push(`${input.recentRevocationCount} recent revocation(s)`);
  }
  if (input.recentSecurityFindingsCount > 0) {
    reasons.push(`${input.recentSecurityFindingsCount} recent security finding(s)`);
  }

  // Final score
  const rawScore = identityScore + statusScore + hygieneScore - incidentPenalty;
  const finalScore = Math.max(0, Math.min(100, rawScore));
  const band = trustBandFromScore(finalScore);

  return {
    identityScore,
    statusScore,
    hygieneScore,
    incidentPenalty,
    finalScore,
    band,
    reasons,
  };
}
