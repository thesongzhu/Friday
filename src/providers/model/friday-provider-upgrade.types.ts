export type FridayProviderCompatibilityStatus =
  | "unknown"
  | "compatible"
  | "adaptation_required"
  | "blocked";

export type FridayProviderPromotionChannel =
  | "none"
  | "shadow"
  | "canary"
  | "active"
  | "rolled_back";

export interface FridayProviderCanaryStats {
  sampleSize: number;
  successCount: number;
  failureCount: number;
  rollbackCount: number;
  lastEvaluatedAt?: string;
}

export interface FridayProviderUpgradeFields {
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayProviderCompatibilityStatus;
  promotionChannel: FridayProviderPromotionChannel;
  shadowVersionId?: string;
  canaryStats?: FridayProviderCanaryStats;
}

export interface FridayProviderUpgradePatch {
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus?: FridayProviderCompatibilityStatus;
  promotionChannel?: FridayProviderPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayProviderCanaryStats | null;
}

type FridayProviderUpgradeCurrent = {
  lastVerifiedAt?: string | null;
  lastVerifiedRuntimeVersion?: string | null;
  lastVerifiedProviderModel?: string | null;
  compatibilityStatus?: FridayProviderCompatibilityStatus;
  promotionChannel?: FridayProviderPromotionChannel;
  shadowVersionId?: string | null;
  canaryStats?: FridayProviderCanaryStats | null;
};

export function defaultFridayProviderUpgradeFields(): FridayProviderUpgradeFields {
  return {
    compatibilityStatus: "unknown",
    promotionChannel: "none",
  };
}

export function mergeFridayProviderUpgradeFields(
  current: FridayProviderUpgradeCurrent | undefined,
  patch: FridayProviderUpgradePatch,
): FridayProviderUpgradeFields {
  const defaults = defaultFridayProviderUpgradeFields();
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
