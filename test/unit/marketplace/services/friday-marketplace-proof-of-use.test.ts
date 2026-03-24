import { describe, expect, it } from "vitest";

import type { FridayMarketplaceAssetSummary } from "../../../../src/marketplace/services/friday-marketplace-asset-catalog-service.js";
import { DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY } from "../../../../src/marketplace/services/friday-marketplace-proof-of-use-policy.js";
import {
  computeMarketplaceProofSignals,
  sortMarketplaceAssetsByProofOfUse,
} from "../../../../src/marketplace/services/friday-marketplace-proof-of-use.js";

function makeAsset(
  title: string,
  signals: ReturnType<typeof computeMarketplaceProofSignals>,
): FridayMarketplaceAssetSummary {
  return {
    assetId: `listing:${title.toLowerCase().replace(/\s+/g, "-")}`,
    creatorId: "publisher:test",
    assetType: "workflow",
    sourceKind: "marketplace_listing",
    distributionMode: "declarative_public",
    publicEligible: true,
    title,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    summary: `${title} summary`,
    publisherName: "Friday",
    installable: true,
    installed: false,
    enabled: false,
    verificationStatus: "verified",
    trustScore: 90,
    latestVersion: "1.0.0",
    maturity: "validated_and_keep",
    ...signals,
  };
}

describe("friday-marketplace-proof-of-use", () => {
  it("penalizes high-permission low-reliability assets even when install count is high", () => {
    const reliableLowPermission = computeMarketplaceProofSignals({
      verificationStatus: "verified",
      trustScore: 92,
      permissionCount: 1,
      installCount: 4,
      supportCount: 2,
      requestFulfillmentCount: 2,
      maintained: true,
    });
    const riskyHighPermission = computeMarketplaceProofSignals({
      verificationStatus: "unverified",
      trustScore: 28,
      permissionCount: 6,
      installCount: 12,
      supportCount: 0,
      requestFulfillmentCount: 0,
      maintained: false,
    });

    expect(reliableLowPermission.outcomeReliabilityScore).toBeGreaterThan(
      riskyHighPermission.outcomeReliabilityScore,
    );
    expect(reliableLowPermission.permissionEfficiencyScore).toBeGreaterThan(
      riskyHighPermission.permissionEfficiencyScore,
    );
    expect(reliableLowPermission.proofOfUseScore).toBeGreaterThan(
      riskyHighPermission.proofOfUseScore,
    );
  });

  it("sorts marketplace assets by proof-of-use instead of popularity alone", () => {
    const assets = sortMarketplaceAssetsByProofOfUse([
      makeAsset("Popular but risky", computeMarketplaceProofSignals({
        verificationStatus: "unverified",
        trustScore: 30,
        permissionCount: 5,
        installCount: 20,
        supportCount: 0,
        requestFulfillmentCount: 0,
        maintained: false,
      })),
      makeAsset("Reliable and efficient", computeMarketplaceProofSignals({
        verificationStatus: "verified",
        trustScore: 95,
        permissionCount: 1,
        installCount: 3,
        supportCount: 2,
        requestFulfillmentCount: 2,
        maintained: true,
      })),
    ]);

    expect(assets[0]?.title).toBe("Reliable and efficient");
    expect((assets[0]?.proofOfUseScore ?? 0)).toBeGreaterThan(
      assets[1]?.proofOfUseScore ?? 0,
    );
  });

  it("accepts a custom policy without changing the scoring function shape", () => {
    const defaultSignals = computeMarketplaceProofSignals({
      verificationStatus: "verified",
      trustScore: 80,
      permissionCount: 2,
      installCount: 5,
      supportCount: 1,
      requestFulfillmentCount: 1,
      maintained: true,
    });
    const strictPolicySignals = computeMarketplaceProofSignals(
      {
        verificationStatus: "verified",
        trustScore: 80,
        permissionCount: 2,
        installCount: 5,
        supportCount: 1,
        requestFulfillmentCount: 1,
        maintained: true,
      },
      {
        ...DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
        permissionPenaltyPerPermission: 0.2,
        proofOfUseWeights: {
          ...DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY.proofOfUseWeights,
          permissionEfficiency: 0.35,
          repeatRun: 0.1,
        },
      },
    );

    expect(strictPolicySignals.permissionEfficiencyScore).toBeLessThan(
      defaultSignals.permissionEfficiencyScore,
    );
    expect(strictPolicySignals.proofOfUseScore).toBeLessThan(
      defaultSignals.proofOfUseScore,
    );
  });
});
