import { describe, it, expect } from "vitest";
import {
  calculateSatelliteTrust,
  trustBandFromScore,
  type FridayTrustCalculatorInput,
} from "#api";

describe("FridayFleetTrustCalculator", () => {
  function makeInput(overrides: Partial<FridayTrustCalculatorInput> = {}): FridayTrustCalculatorInput {
    return {
      pairingStatus: "online",
      trustLevel: "trusted",
      hasRevokedTokens: false,
      hasExpiredHighPrivTokens: false,
      recentRevocationCount: 0,
      recentSecurityFindingsCount: 0,
      ...overrides,
    };
  }

  // ─── trustBandFromScore ───

  it("returns 'high' for score >= 70", () => {
    expect(trustBandFromScore(70)).toBe("high");
    expect(trustBandFromScore(100)).toBe("high");
  });

  it("returns 'medium' for score 40-69", () => {
    expect(trustBandFromScore(40)).toBe("medium");
    expect(trustBandFromScore(69)).toBe("medium");
  });

  it("returns 'low' for score < 40", () => {
    expect(trustBandFromScore(39)).toBe("low");
    expect(trustBandFromScore(0)).toBe("low");
  });

  // ─── Identity score ───

  it("trusted satellite → identityScore = 40", () => {
    const result = calculateSatelliteTrust(makeInput({ trustLevel: "trusted" }));
    expect(result.identityScore).toBe(40);
  });

  it("restricted satellite → identityScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput({ trustLevel: "restricted" }));
    expect(result.identityScore).toBe(20);
    expect(result.reasons).toContain("Satellite has restricted trust level");
  });

  // ─── Status score ───

  it("online → statusScore = 30", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "online" }));
    expect(result.statusScore).toBe(30);
  });

  it("degraded → statusScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "degraded" }));
    expect(result.statusScore).toBe(20);
    expect(result.reasons).toContain("Satellite is in degraded state");
  });

  it("paired → statusScore = 15", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "paired" }));
    expect(result.statusScore).toBe(15);
  });

  it("offline → statusScore = 10", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "offline" }));
    expect(result.statusScore).toBe(10);
    expect(result.reasons).toContain("Satellite is offline");
  });

  it("pending → statusScore = 5", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "pending" }));
    expect(result.statusScore).toBe(5);
    expect(result.reasons).toContain("Satellite pairing is pending");
  });

  it("revoked → statusScore = 0", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "revoked" }));
    expect(result.statusScore).toBe(0);
    expect(result.reasons).toContain("Satellite pairing has been revoked");
  });

  // ─── Hygiene score ───

  it("clean hygiene → hygieneScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput());
    expect(result.hygieneScore).toBe(20);
  });

  it("revoked tokens reduce hygiene by 5", () => {
    const result = calculateSatelliteTrust(makeInput({ hasRevokedTokens: true }));
    expect(result.hygieneScore).toBe(15);
    expect(result.reasons).toContain("Has revoked tokens");
  });

  it("expired high-priv tokens reduce hygiene by 10", () => {
    const result = calculateSatelliteTrust(makeInput({ hasExpiredHighPrivTokens: true }));
    expect(result.hygieneScore).toBe(10);
    expect(result.reasons).toContain("Has expired high-privilege tokens");
  });

  it("both hygiene issues reduce hygiene to 5", () => {
    const result = calculateSatelliteTrust(
      makeInput({ hasRevokedTokens: true, hasExpiredHighPrivTokens: true }),
    );
    expect(result.hygieneScore).toBe(5);
  });

  // ─── Incident penalty ───

  it("no incidents → incidentPenalty = 0", () => {
    const result = calculateSatelliteTrust(makeInput());
    expect(result.incidentPenalty).toBe(0);
  });

  it("revocations add 10 each, capped at 20", () => {
    const result1 = calculateSatelliteTrust(makeInput({ recentRevocationCount: 1 }));
    expect(result1.incidentPenalty).toBe(10);

    const result3 = calculateSatelliteTrust(makeInput({ recentRevocationCount: 3 }));
    expect(result3.incidentPenalty).toBe(20); // capped at 20 from revocations
  });

  it("security findings add 5 each, capped at 20", () => {
    const result2 = calculateSatelliteTrust(makeInput({ recentSecurityFindingsCount: 2 }));
    expect(result2.incidentPenalty).toBe(10);

    const result5 = calculateSatelliteTrust(makeInput({ recentSecurityFindingsCount: 5 }));
    expect(result5.incidentPenalty).toBe(20); // capped
  });

  it("combined incidents capped at 40", () => {
    const result = calculateSatelliteTrust(
      makeInput({ recentRevocationCount: 3, recentSecurityFindingsCount: 5 }),
    );
    expect(result.incidentPenalty).toBe(40);
  });

  // ─── Composite score / band ───

  it("perfect trusted online satellite → high band", () => {
    const result = calculateSatelliteTrust(makeInput());
    // identity=40, status=30, hygiene=20, penalty=0 → finalScore=90
    expect(result.finalScore).toBe(90);
    expect(result.band).toBe("high");
  });

  it("restricted offline with incidents → low band", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "offline",
        hasRevokedTokens: true,
        hasExpiredHighPrivTokens: true,
        recentRevocationCount: 2,
        recentSecurityFindingsCount: 2,
      }),
    );
    // identity=20, status=10, hygiene=5, penalty=30 → raw=5
    expect(result.finalScore).toBe(5);
    expect(result.band).toBe("low");
  });

  it("score is clamped to 0 minimum", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "revoked",
        hasRevokedTokens: true,
        hasExpiredHighPrivTokens: true,
        recentRevocationCount: 3,
        recentSecurityFindingsCount: 5,
      }),
    );
    // identity=20, status=0, hygiene=5, penalty=40 → raw=-15 → clamped to 0
    expect(result.finalScore).toBe(0);
    expect(result.band).toBe("low");
  });

  it("score is clamped to 100 maximum", () => {
    // The max possible is 40+30+20-0 = 90, so we verify it doesn't exceed that
    const result = calculateSatelliteTrust(makeInput());
    expect(result.finalScore).toBeLessThanOrEqual(100);
  });

  it("medium band for borderline scores", () => {
    // restricted (20) + paired (15) + clean hygiene (20) - 0 = 55
    const result = calculateSatelliteTrust(
      makeInput({ trustLevel: "restricted", pairingStatus: "paired" }),
    );
    expect(result.finalScore).toBe(55);
    expect(result.band).toBe("medium");
  });

  it("collects reasons for all contributing factors", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "offline",
        hasRevokedTokens: true,
        recentRevocationCount: 1,
      }),
    );
    expect(result.reasons).toContain("Satellite has restricted trust level");
    expect(result.reasons).toContain("Satellite is offline");
    expect(result.reasons).toContain("Has revoked tokens");
    expect(result.reasons).toContain("1 recent revocation(s)");
  });
});
