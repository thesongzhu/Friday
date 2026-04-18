import type { FridaySqliteLayer } from "#state";
import type { FridayMcpAdapter } from "../../agent/mcp/friday-mcp-adapter.types.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayAutonomySubjectUpgradeStateRepository } from "../persistence/friday-autonomy-subject-upgrade-state-repository.js";

export interface FridayMcpServerUpgradeLifecycleService {
  registerShadowVersion(input: {
    serverId: string;
    shadowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
  recordCanaryResult(input: {
    serverId: string;
    success: boolean;
    evaluatedAt?: string;
  }): void;
  promote(input: {
    serverId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
  rollback(input: {
    serverId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): void;
}

export interface CreateFridayMcpServerUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  stateRepo: FridayAutonomySubjectUpgradeStateRepository;
  mcpAdapter: Pick<FridayMcpAdapter, "listServers">;
  nowIso: () => string;
}

export function createFridayMcpServerUpgradeLifecycleService(
  deps: CreateFridayMcpServerUpgradeLifecycleServiceDeps,
): FridayMcpServerUpgradeLifecycleService {
  function requireServer(serverId: string): void {
    const found = deps.mcpAdapter.listServers().some((server) => server.id === serverId);
    if (!found) {
      throw new Error(`MCP server ${serverId} not found`);
    }
  }

  function getCanaryStats(serverId: string): FridayAutonomyCanaryStats {
    const state = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "mcp_server", serverId));
    return state?.canaryStats ?? {
      sampleSize: 0,
      successCount: 0,
      failureCount: 0,
      rollbackCount: 0,
    };
  }

  function update(
    serverId: string,
    patch: Parameters<FridayAutonomySubjectUpgradeStateRepository["setUpgradeMetadata"]>[3],
  ): void {
    requireServer(serverId);
    deps.db.withWriteTransaction((db) => {
      deps.stateRepo.setUpgradeMetadata(db, "mcp_server", serverId, patch, deps.nowIso());
    });
  }

  return {
    registerShadowVersion(input) {
      update(input.serverId, {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: input.shadowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const current = getCanaryStats(input.serverId);
      update(input.serverId, {
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
      const current = deps.db.withReadConnection((db) => deps.stateRepo.get(db, "mcp_server", input.serverId));
      update(input.serverId, {
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
      const current = getCanaryStats(input.serverId);
      update(input.serverId, {
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
