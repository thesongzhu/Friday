export type FridayAutonomyCompatibilityStatus =
  | "unknown"
  | "compatible"
  | "adaptation_required"
  | "blocked";

export type FridayAutonomyPromotionChannel =
  | "none"
  | "shadow"
  | "canary"
  | "active"
  | "rolled_back";

export interface FridayAutonomyCanaryStats {
  sampleSize: number;
  successCount: number;
  failureCount: number;
  rollbackCount: number;
  lastEvaluatedAt?: string;
}

export interface FridayAutonomyUpgradeFields {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayAutonomyCompatibilityStatus;
  promotionChannel: FridayAutonomyPromotionChannel;
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
}

export interface FridayAutonomyUpgradePatch {
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus?: FridayAutonomyCompatibilityStatus;
  promotionChannel?: FridayAutonomyPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayAutonomyCanaryStats | null;
}

type FridayAutonomyUpgradeCurrent = {
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus?: FridayAutonomyCompatibilityStatus;
  promotionChannel?: FridayAutonomyPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayAutonomyCanaryStats | null;
};

export function defaultFridayAutonomyUpgradeFields(): FridayAutonomyUpgradeFields {
  return {
    compatibilityStatus: "unknown",
    promotionChannel: "none",
  };
}

export function mergeFridayAutonomyUpgradeFields(
  current: FridayAutonomyUpgradeCurrent | undefined,
  patch: FridayAutonomyUpgradePatch,
): FridayAutonomyUpgradeFields {
  const defaults = defaultFridayAutonomyUpgradeFields();
  const base = {
    ...defaults,
    ...current,
    lastVerifiedAt: current?.lastVerifiedAt ?? undefined,
    lastVerifiedRuntimeVersion: current?.lastVerifiedRuntimeVersion ?? undefined,
    lastVerifiedProviderModel: current?.lastVerifiedProviderModel ?? undefined,
    shadowVersionId: current?.shadowVersionId ?? undefined,
    canaryStats: current?.canaryStats ?? undefined,
    compatibilityStatus: current?.compatibilityStatus ?? defaults.compatibilityStatus,
    promotionChannel: current?.promotionChannel ?? defaults.promotionChannel,
  };
  return {
    lastVerifiedAt: patch.lastVerifiedAt === undefined ? base.lastVerifiedAt : patch.lastVerifiedAt ?? undefined,
    lastVerifiedRuntimeVersion: patch.lastVerifiedRuntimeVersion === undefined
      ? base.lastVerifiedRuntimeVersion
      : patch.lastVerifiedRuntimeVersion ?? undefined,
    lastVerifiedProviderModel: patch.lastVerifiedProviderModel === undefined
      ? base.lastVerifiedProviderModel
      : patch.lastVerifiedProviderModel ?? undefined,
    compatibilityStatus: patch.compatibilityStatus ?? base.compatibilityStatus,
    promotionChannel: patch.promotionChannel ?? base.promotionChannel,
    shadowVersionId: patch.shadowVersionId === undefined ? base.shadowVersionId : patch.shadowVersionId ?? undefined,
    canaryStats: patch.canaryStats === undefined ? base.canaryStats : patch.canaryStats ?? undefined,
  };
}
