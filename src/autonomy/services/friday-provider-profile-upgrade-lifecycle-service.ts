import type { FridaySqliteLayer } from "#state";
import type { FridayProviderProfileRepository } from "../../providers/persistence/friday-provider-profile-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayProviderProfile } from "../../providers/model/friday-provider.types.js";

export interface FridayProviderProfileUpgradeLifecycleService {
  registerShadowVersion(input: {
    providerId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayProviderProfile;
  recordCanaryResult(input: {
    providerId: string;
    success: boolean;
    evaluatedAt?: string;
  }): FridayProviderProfile;
  promote(input: {
    providerId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayProviderProfile;
  rollback(input: {
    providerId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayProviderProfile;
}

export interface CreateFridayProviderProfileUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  providerProfileRepo: FridayProviderProfileRepository;
  nowIso: () => string;
}

export function createFridayProviderProfileUpgradeLifecycleService(
  deps: CreateFridayProviderProfileUpgradeLifecycleServiceDeps,
): FridayProviderProfileUpgradeLifecycleService {
  function getProvider(providerId: string): FridayProviderProfile {
    const provider = deps.db.withReadConnection((db) => deps.providerProfileRepo.getById(db, providerId));
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    return provider;
  }

  function updateProvider(
    providerId: string,
    patch: Parameters<FridayProviderProfileRepository["setUpgradeMetadata"]>[2],
  ): FridayProviderProfile {
    return deps.db.withWriteTransaction((db) => {
      const updated = deps.providerProfileRepo.setUpgradeMetadata(db, providerId, patch, deps.nowIso());
      if (!updated) {
        throw new Error(`Provider ${providerId} not found`);
      }
      return updated;
    });
  }

  return {
    registerShadowVersion(input) {
      return updateProvider(input.providerId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const provider = getProvider(input.providerId);
      const current = provider.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateProvider(input.providerId, {
        compatibilityStatus: input.success ? "compatible" : "adaptation_required",
        promotionChannel: "canary",
        canaryStats: {
          sampleSize: current.sampleSize + 1,
          successCount: current.successCount + (input.success ? 1 : 0),
          failureCount: current.failureCount + (input.success ? 0 : 1),
          rollbackCount: current.rollbackCount,
          lastEvaluatedAt: input.evaluatedAt ?? deps.nowIso(),
        },
      });
    },

    promote(input) {
      const provider = getProvider(input.providerId);
      return updateProvider(input.providerId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: provider.shadowVersionId,
        canaryStats: provider.canaryStats,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      const provider = getProvider(input.providerId);
      const current = provider.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateProvider(input.providerId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "rolled_back",
        shadowVersionId: null,
        canaryStats: {
          sampleSize: current.sampleSize,
          successCount: current.successCount,
          failureCount: current.failureCount,
          rollbackCount: current.rollbackCount + 1,
          lastEvaluatedAt: deps.nowIso(),
        },
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },
  };
}
