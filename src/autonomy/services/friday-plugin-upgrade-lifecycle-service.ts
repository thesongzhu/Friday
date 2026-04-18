import type { FridaySqliteLayer } from "#state";
import type { FridayPluginRepository } from "../../plugins/persistence/friday-plugin-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayPluginEntity } from "../../plugins/model/friday-plugin.types.js";

export interface FridayPluginUpgradeLifecycleService {
  registerShadowVersion(input: {
    pluginId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayPluginEntity;
  recordCanaryResult(input: {
    pluginId: string;
    success: boolean;
    evaluatedAt?: string;
  }): FridayPluginEntity;
  promote(input: {
    pluginId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayPluginEntity;
  rollback(input: {
    pluginId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayPluginEntity;
}

export interface CreateFridayPluginUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  pluginRepo: FridayPluginRepository;
  nowIso: () => string;
}

export function createFridayPluginUpgradeLifecycleService(
  deps: CreateFridayPluginUpgradeLifecycleServiceDeps,
): FridayPluginUpgradeLifecycleService {
  function getPlugin(pluginId: string): FridayPluginEntity {
    const plugin = deps.db.withReadConnection((db) => deps.pluginRepo.getById(db, pluginId));
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    return plugin;
  }

  function updatePlugin(
    pluginId: string,
    patch: Parameters<FridayPluginRepository["setUpgradeMetadata"]>[2],
  ): FridayPluginEntity {
    return deps.db.withWriteTransaction((db) => deps.pluginRepo.setUpgradeMetadata(db, pluginId, patch, deps.nowIso()));
  }

  return {
    registerShadowVersion(input) {
      return updatePlugin(input.pluginId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const plugin = getPlugin(input.pluginId);
      const current = plugin.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updatePlugin(input.pluginId, {
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
      const plugin = getPlugin(input.pluginId);
      return updatePlugin(input.pluginId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: plugin.shadowVersionId,
        canaryStats: plugin.canaryStats,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      const plugin = getPlugin(input.pluginId);
      const current = plugin.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updatePlugin(input.pluginId, {
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
