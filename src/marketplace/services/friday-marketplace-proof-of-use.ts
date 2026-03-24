import type { FridayMarketplaceAssetSummary } from "./friday-marketplace-asset-catalog-service.js";
import {
  DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
  type FridayMarketplaceProofOfUsePolicy,
} from "./friday-marketplace-proof-of-use-policy.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeCount(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return clamp(value / cap, 0, 1);
}

export interface FridayMarketplaceProofSignalsInput {
  verificationStatus: "verified" | "unverified" | "unknown";
  trustScore: number | null;
  permissionCount: number;
  installCount: number;
  supportCount: number;
  requestFulfillmentCount: number;
  maintained: boolean;
}

export interface FridayMarketplaceProofSignals {
  proofOfUseScore: number;
  repeatRunRate: number;
  outcomeReliabilityScore: number;
  permissionEfficiencyScore: number;
  requestFulfillmentRate: number;
  maintenanceResponsivenessScore: number;
}

export function computeMarketplaceProofSignals(
  input: FridayMarketplaceProofSignalsInput,
  policy: FridayMarketplaceProofOfUsePolicy = DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY,
): FridayMarketplaceProofSignals {
  const verificationFactor = input.verificationStatus === "verified"
    ? policy.verificationFactors.verified
    : input.verificationStatus === "unknown"
      ? policy.verificationFactors.unknown
      : policy.verificationFactors.unverified;
  const trustFactor = input.trustScore === null
    ? policy.trustScoreFallback
    : clamp(input.trustScore / 100, 0, 1);
  const permissionEfficiency = clamp(
    1 - input.permissionCount * policy.permissionPenaltyPerPermission,
    policy.permissionEfficiencyBounds.min,
    policy.permissionEfficiencyBounds.max,
  );
  const installFactor = normalizeCount(input.installCount, policy.normalizationCaps.installs);
  const supportFactor = normalizeCount(input.supportCount, policy.normalizationCaps.supports);
  const repeatRunRate = clamp(
    installFactor * policy.repeatRunWeights.installs + supportFactor * policy.repeatRunWeights.supports,
    0,
    1,
  );
  const outcomeReliability = clamp(
    verificationFactor * policy.outcomeReliabilityWeights.verification
      + trustFactor * policy.outcomeReliabilityWeights.trust,
    0,
    1,
  );
  const requestFulfillmentRate = normalizeCount(
    input.requestFulfillmentCount,
    policy.normalizationCaps.requestFulfillments,
  );
  const maintenanceResponsivenessScore = clamp(
    (input.maintained ? policy.maintenanceBase.maintained : policy.maintenanceBase.unmaintained)
      + verificationFactor * policy.maintenanceWeights.verification
      + supportFactor * policy.maintenanceWeights.support,
    0,
    1,
  );
  const proofOfUseScore = Math.round(
    (
      outcomeReliability * policy.proofOfUseWeights.outcomeReliability
      + repeatRunRate * policy.proofOfUseWeights.repeatRun
      + permissionEfficiency * policy.proofOfUseWeights.permissionEfficiency
      + requestFulfillmentRate * policy.proofOfUseWeights.requestFulfillment
      + supportFactor * policy.proofOfUseWeights.support
    ) * 100,
  );

  return {
    proofOfUseScore,
    repeatRunRate: Number(repeatRunRate.toFixed(3)),
    outcomeReliabilityScore: Math.round(outcomeReliability * 100),
    permissionEfficiencyScore: Math.round(permissionEfficiency * 100),
    requestFulfillmentRate: Number(requestFulfillmentRate.toFixed(3)),
    maintenanceResponsivenessScore: Math.round(maintenanceResponsivenessScore * 100),
  };
}

export function sortMarketplaceAssetsByProofOfUse(
  assets: readonly FridayMarketplaceAssetSummary[],
): FridayMarketplaceAssetSummary[] {
  return [...assets].sort((left, right) =>
    (right.proofOfUseScore ?? 0) - (left.proofOfUseScore ?? 0)
    || (right.outcomeReliabilityScore ?? 0) - (left.outcomeReliabilityScore ?? 0)
    || (right.permissionEfficiencyScore ?? 0) - (left.permissionEfficiencyScore ?? 0)
    || left.title.localeCompare(right.title),
  );
}
