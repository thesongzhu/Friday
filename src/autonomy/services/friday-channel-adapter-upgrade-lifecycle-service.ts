import type { FridaySqliteLayer } from "#state";
import type { FridayChannelRegistry } from "../../channels/friday-channel-registry.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectUpgradeStateRepository } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";

export interface FridayChannelAdapterUpgradeLifecycleService {
  registerShadowVersion(input: {
    channelKind: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
  recordCanaryResult(input: {
    channelKind: string;
    success: boolean;
    evaluatedAt?: string;
  }): void;
  promote(input: {
    channelKind: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
  rollback(input: {
    channelKind: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
}

export interface CreateFridayChannelAdapterUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  stateRepo: FridayAutonomySubjectUpgradeStateRepository;
  channelRegistry: Pick<FridayChannelRegistry, "describe">;
  nowIso: () => string;
}

export function createFridayChannelAdapterUpgradeLifecycleService(
  deps: CreateFridayChannelAdapterUpgradeLifecycleServiceDeps,
): FridayChannelAdapterUpgradeLifecycleService {
  function requireChannel(channelKind: string): void {
    if (!deps.channelRegistry.describe(channelKind)) {
      throw new Error(`Channel adapter ${channelKind} not found`);
    }
  }

  function getCanaryStats(channelKind: string): FridayAutonomyCanaryStats {
    const state = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "channel_adapter", channelKind));
    return state?.canaryStats ?? {
      sampleSize: 0,
      successCount: 0,
      failureCount: 0,
      rollbackCount: 0,
    };
  }

  function update(
    channelKind: string,
    patch: Parameters<FridayAutonomySubjectUpgradeStateRepository["setUpgradeMetadata"]>[3],
  ): void {
    requireChannel(channelKind);
    deps.db.withWriteTransaction((db) => {
      deps.stateRepo.setUpgradeMetadata(db, "channel_adapter", channelKind, patch, deps.nowIso());
    });
  }

  return {
    registerShadowVersion(input) {
      update(input.channelKind, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const current = getCanaryStats(input.channelKind);
      update(input.channelKind, {
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
      const current = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "channel_adapter", input.channelKind));
      update(input.channelKind, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: current?.shadowVersionId ?? null,
        canaryStats: current?.canaryStats ?? null,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      const current = getCanaryStats(input.channelKind);
      update(input.channelKind, {
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
