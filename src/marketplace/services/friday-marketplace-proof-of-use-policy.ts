export interface FridayMarketplaceProofOfUsePolicy {
  verificationFactors: Readonly<{
    verified: number;
    unknown: number;
    unverified: number;
  }>;
  trustScoreFallback: number;
  permissionPenaltyPerPermission: number;
  permissionEfficiencyBounds: Readonly<{
    min: number;
    max: number;
  }>;
  normalizationCaps: Readonly<{
    installs: number;
    supports: number;
    requestFulfillments: number;
  }>;
  repeatRunWeights: Readonly<{
    installs: number;
    supports: number;
  }>;
  outcomeReliabilityWeights: Readonly<{
    verification: number;
    trust: number;
  }>;
  maintenanceBase: Readonly<{
    maintained: number;
    unmaintained: number;
  }>;
  maintenanceWeights: Readonly<{
    verification: number;
    support: number;
  }>;
  proofOfUseWeights: Readonly<{
    outcomeReliability: number;
    repeatRun: number;
    permissionEfficiency: number;
    requestFulfillment: number;
    support: number;
  }>;
  creatorOverallWeights: Readonly<{
    proofOfUse: number;
    outcomeReliability: number;
    permissionEfficiency: number;
    supportCountPointsPerEvent: number;
    supportCountPointsCap: number;
    fulfilledRequestPointsPerEvent: number;
    fulfilledRequestPointsCap: number;
  }>;
}

export const DEFAULT_FRIDAY_MARKETPLACE_PROOF_OF_USE_POLICY: FridayMarketplaceProofOfUsePolicy = {
  verificationFactors: {
    verified: 1,
    unknown: 0.6,
    unverified: 0.25,
  },
  trustScoreFallback: 0.6,
  permissionPenaltyPerPermission: 0.12,
  permissionEfficiencyBounds: {
    min: 0.1,
    max: 0.95,
  },
  normalizationCaps: {
    installs: 6,
    supports: 4,
    requestFulfillments: 3,
  },
  repeatRunWeights: {
    installs: 0.75,
    supports: 0.25,
  },
  outcomeReliabilityWeights: {
    verification: 0.55,
    trust: 0.45,
  },
  maintenanceBase: {
    maintained: 0.55,
    unmaintained: 0.25,
  },
  maintenanceWeights: {
    verification: 0.25,
    support: 0.2,
  },
  proofOfUseWeights: {
    outcomeReliability: 0.4,
    repeatRun: 0.25,
    permissionEfficiency: 0.2,
    requestFulfillment: 0.1,
    support: 0.05,
  },
  creatorOverallWeights: {
    proofOfUse: 0.45,
    outcomeReliability: 0.2,
    permissionEfficiency: 0.15,
    supportCountPointsPerEvent: 2,
    supportCountPointsCap: 10,
    fulfilledRequestPointsPerEvent: 2,
    fulfilledRequestPointsCap: 10,
  },
};
