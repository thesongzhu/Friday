import { createHash } from "node:crypto";

import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowCrudService } from "../../workflows/services/friday-workflow-crud-service.js";
import type { FridayWorkflowRepository } from "../../workflows/persistence/friday-workflow-repository.js";
import type { FridayAutonomyCanaryStats } from "../model/friday-autonomy-upgrade.types.js";
import type { FridayWorkflowEntity } from "../../workflows/model/friday-workflow.types.js";
import {
  createFridayMutatingActionDigest,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionActor,
  type FridayMutatingActionGate,
  type FridayMutatingActionRequest,
  type FridayMutatingActionRollbackScope,
  type FridayMutatingActionTicket,
} from "../../security/friday-mutating-action-gate.js";

type FridayWorkflowLifecycleAction = "shadow" | "canary" | "promote" | "rollback";

export interface FridayWorkflowLifecycleApprovalRequestInput {
  action: FridayWorkflowLifecycleAction;
  workflowId: string;
  workflowVersionId?: string;
  versionNumber?: number;
  targetVersionNumber?: number;
  success?: boolean;
  runtimeVersion: string;
  providerModel?: string;
  actor: FridayMutatingActionActor;
  surface: string;
  planDigest: string;
  idempotencyKey?: string;
  rollback?: FridayMutatingActionRollbackScope;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayWorkflowUpgradeLifecycleService {
  registerShadowVersion(input: {
    workflowId: string;
    workflowVersionId: string;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayWorkflowEntity;
  recordCanaryResult(input: {
    workflowId: string;
    success: boolean;
    runtimeVersion: string;
    providerModel?: string;
    evaluatedAt?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayWorkflowEntity;
  promote(input: {
    workflowId: string;
    versionNumber: number;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayWorkflowEntity;
  rollback(input: {
    workflowId: string;
    targetVersionNumber: number;
    runtimeVersion: string;
    providerModel?: string;
    actor: FridayMutatingActionActor;
    surface: string;
    planDigest: string;
    idempotencyKey?: string;
    canonicalApproval?: FridayCanonicalApprovalResolution;
  }): FridayWorkflowEntity;
}

export interface CreateFridayWorkflowUpgradeLifecycleServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  workflowCrud: FridayWorkflowCrudService;
  nowIso: () => string;
  canonicalMutationGate?: FridayMutatingActionGate;
}

export function createFridayWorkflowLifecycleMutatingActionRequest(
  input: FridayWorkflowLifecycleApprovalRequestInput,
): FridayMutatingActionRequest {
  const parameters = {
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    versionNumber: input.versionNumber,
    targetVersionNumber: input.targetVersionNumber,
    success: input.success,
    runtimeVersion: input.runtimeVersion,
    providerModel: input.providerModel,
  };
  return {
    action: `workflows.lifecycle.${input.action}`,
    actor: input.actor,
    surface: input.surface,
    resource: {
      type: "workflow_lifecycle",
      id: input.workflowId,
      digest: hashStableJson(parameters),
      attributes: {
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        lifecycleAction: input.action,
      },
    },
    mutating: true,
    risk: "high",
    parameters,
    planDigest: input.planDigest,
    rollback: input.rollback,
    idempotencyKey: input.idempotencyKey,
    localClaims: [
      {
        guardId: "workflow_lifecycle_guard",
        decision: "requires_approval",
        risk: "high",
        reason: `workflow_${input.action}_requires_canonical_approval`,
      },
    ],
  };
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

  function requireCanonicalLifecycleTicket(input: FridayWorkflowLifecycleApprovalRequestInput): FridayMutatingActionTicket {
    if (!deps.canonicalMutationGate) {
      throw new FridayDomainError(
        "WORKFLOW_LIFECYCLE_CANONICAL_GATE_UNAVAILABLE",
        "Workflow lifecycle actions require the canonical approval gate.",
        { httpStatus: 503 },
      );
    }
    if (!input.planDigest) {
      throw new FridayDomainError(
        "WORKFLOW_LIFECYCLE_PLAN_DIGEST_REQUIRED",
        "Workflow lifecycle actions require an approved plan digest.",
        { httpStatus: 403, details: { workflowId: input.workflowId } },
      );
    }

    const request = createFridayWorkflowLifecycleMutatingActionRequest(input);
    const gateResult = deps.canonicalMutationGate.evaluate({
      ...request,
      canonicalApproval: input.canonicalApproval,
    });
    if (gateResult.decision !== "allow" || !gateResult.ticket) {
      throw new FridayDomainError(
        gateResult.decision === "requires_approval"
          ? "CANONICAL_APPROVAL_REQUIRED"
          : "CANONICAL_APPROVAL_DENIED",
        gateResult.decision === "requires_approval"
          ? `Workflow lifecycle ${input.action} requires canonical approval before any mutation.`
          : `Workflow lifecycle ${input.action} was blocked by the canonical approval gate: ${gateResult.reason}`,
        {
          httpStatus: 403,
          details: {
            canonicalGate: gateResult.evidenceRecord,
            actionDigest: createFridayMutatingActionDigest(request),
          },
        },
      );
    }
    return gateResult.ticket;
  }

  return {
    registerShadowVersion(input) {
      requireCanonicalLifecycleTicket({
        action: "shadow",
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
      return updateWorkflow(input.workflowId, {
        compatibilityStatus: "compatible",
        promotionChannel: "shadow",
        shadowVersionId: input.workflowVersionId,
        lastVerifiedRuntimeVersion: input.runtimeVersion,
        lastVerifiedProviderModel: input.providerModel,
      });
    },

    recordCanaryResult(input) {
      requireCanonicalLifecycleTicket({
        action: "canary",
        workflowId: input.workflowId,
        success: input.success,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
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
      requireCanonicalLifecycleTicket({
        action: "promote",
        workflowId: input.workflowId,
        versionNumber: input.versionNumber,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
      });
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
      requireCanonicalLifecycleTicket({
        action: "rollback",
        workflowId: input.workflowId,
        targetVersionNumber: input.targetVersionNumber,
        runtimeVersion: input.runtimeVersion,
        providerModel: input.providerModel,
        actor: input.actor,
        surface: input.surface,
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
        canonicalApproval: input.canonicalApproval,
        rollback: {
          planned: true,
          planDigest: input.planDigest,
          actions: ["workflows.lifecycle.promote"],
        },
      });
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

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
