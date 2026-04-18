import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowCrudService } from "../../workflows/services/friday-workflow-crud-service.js";
import type { FridayWorkflowRepository } from "../../workflows/persistence/friday-workflow-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayWorkflowEntity } from "../../workflows/model/friday-workflow.types.js";

export interface FridayWorkflowUpgradeLifecycleService {
  registerShadowVersion(input: {
    workflowId: string;
    workflowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayWorkflowEntity;
  recordCanaryResult(input: {
    workflowId: string;
    success: boolean;
    evaluatedAt?: string;
  }): FridayWorkflowEntity;
  promote(input: {
    workflowId: string;
    versionNumber: number;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayWorkflowEntity;
  rollback(input: {
    workflowId: string;
    targetVersionNumber: number;
    runtimeVersion: string;
    providerModel?: string;
  }): FridayWorkflowEntity;
}

export interface CreateFridayWorkflowUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  workflowCrud: FridayWorkflowCrudService;
  nowIso: () => string;
}

export function createFridayWorkflowUpgradeLifecycleService(
  deps: CreateFridayWorkflowUpgradeLifecycleServiceDeps,
): FridayWorkflowUpgradeLifecycleService {
  function getWorkflow(workflowId: string): FridayWorkflowEntity {
    const workflow = deps.db.withReadConnection((db) => deps.workflowRepo.getWorkflowById(db, workflowId));
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }
    return workflow;
  }

  function updateWorkflow(
    workflowId: string,
    patch: Parameters<FridayWorkflowRepository["setUpgradeMetadata"]>[2],
  ): FridayWorkflowEntity {
    return deps.db.withWriteTransaction((db) =>
      deps.workflowRepo.setUpgradeMetadata(db, workflowId, patch, deps.nowIso()),
    );
  }

  return {
    registerShadowVersion(input) {
      return updateWorkflow(input.workflowId, {
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        shadowVersionId: input.workflowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      const workflow = getWorkflow(input.workflowId);
      const current = workflow.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateWorkflow(input.workflowId, {
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
      deps.workflowCrud.publishVersion(input.workflowId, input.versionNumber);
      const workflow = getWorkflow(input.workflowId);
      return updateWorkflow(input.workflowId, {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: workflow.shadowVersionId,
        canaryStats: workflow.canaryStats,
        lastVerifiedAt: deps.nowIso(),
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    rollback(input) {
      deps.workflowCrud.publishVersion(input.workflowId, input.targetVersionNumber);
      const workflow = getWorkflow(input.workflowId);
      const current = workflow.canaryStats ?? {
        sampleSize: 0,
        successCount: 0,
        failureCount: 0,
        rollbackCount: 0,
      } satisfies FridayAutonomyCanaryStats;

      return updateWorkflow(input.workflowId, {
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
