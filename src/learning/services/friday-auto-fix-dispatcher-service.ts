import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayAutoFixExecutionService } from "./friday-auto-fix-execution-service.js";
import type { UUID } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixExecutionResult,
  FridayAutoFixStepKind,
} from "../model/friday-auto-fix.types.js";
import type { FridayAutoFixRiskAssessmentService } from "./friday-auto-fix-risk-assessment-service.js";

const DATA_PRESERVING_AUTO_FIX_STEPS: ReadonlySet<FridayAutoFixStepKind> = new Set([
  "retry_node",
  "switch_model_fallback",
  "trim_payload",
  "apply_config_patch",
  "grant_permission",
]);

const ROLLBACK_REQUIRED_STEPS: ReadonlySet<FridayAutoFixStepKind> = new Set([
  "switch_model_fallback",
  "apply_config_patch",
  "grant_permission",
]);

export function isFridayAutoFixDataPreservingAction(
  action: Pick<FridayAutoFixActionEntity, "plan" | "rollbackPlan">,
): boolean {
  const steps = action.plan.steps;
  const rollbackSteps = action.rollbackPlan?.steps ?? action.plan.rollbackPlan?.steps ?? [];
  const allSteps = [...steps, ...rollbackSteps];
  if (allSteps.some((step) => !DATA_PRESERVING_AUTO_FIX_STEPS.has(step.kind))) {
    return false;
  }

  const rollbackRequired = steps.some((step) => ROLLBACK_REQUIRED_STEPS.has(step.kind));
  if (rollbackRequired && rollbackSteps.length === 0) {
    return false;
  }

  return true;
}

export interface FridayAutoFixDispatcherService {
  runReadyActions(input?: {
    userId?: UUID;
    incidentIds?: UUID[];
    maxRiskTier?: 0 | 1;
    limit?: number;
  }): Promise<FridayAutoFixExecutionResult[]>;

  runApprovedAction(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixDispatcherServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  approvalRepo: FridayApprovalRequestRepository;
  incidentRepo: FridayErrorIncidentRepository;
  riskService: FridayAutoFixRiskAssessmentService;
  executionService: FridayAutoFixExecutionService;
  nowIso: () => string;
}

export function createFridayAutoFixDispatcherService(
  deps: CreateAutoFixDispatcherServiceDeps,
): FridayAutoFixDispatcherService {
  return {
    async runReadyActions(input) {
      const maxRiskTier = input?.maxRiskTier ?? 1;
      const limit = input?.limit ?? 10;

      const planned = deps.db.withReadConnection((db) =>
        deps.actionRepo.listPlanned(db, {
          userId: input?.userId,
          maxRiskTier,
          incidentIds: input?.incidentIds,
          limit,
        }),
      );

      const results: FridayAutoFixExecutionResult[] = [];
      for (const action of planned) {
        const incident = deps.db.withReadConnection((db) =>
          deps.incidentRepo.getById(db, action.incidentId),
        );
        if (!incident) {
          continue;
        }
        const risk = deps.riskService.assess({
          incident,
          plan: action.plan,
          nowIso: deps.nowIso(),
        });
        if (risk.requiresApproval || !risk.autoApplyAllowed) {
          continue;
        }
        if (!isFridayAutoFixDataPreservingAction(action)) {
          continue;
        }
        const result = await deps.executionService.execute(action.actionId);
        results.push(result);
      }

      return results;
    },

    async runApprovedAction(actionId) {
      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, actionId),
      );

      if (!action) {
        throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found`, { httpStatus: 404 });
      }

      if (action.status !== "planned") {
        throw new FridayDomainError(
          "AUTOFIX_ACTION_INVALID_STATUS",
          `Action ${actionId} is '${action.status}', expected 'planned'`,
          { httpStatus: 409 },
        );
      }

      // Validate that an approved approval request exists for this action
      const approvalRequest = deps.db.withReadConnection((db) =>
        deps.approvalRepo.getByActionId(db, actionId),
      );

      if (!approvalRequest || approvalRequest.status !== "approved") {
        throw new FridayDomainError(
          "AUTOFIX_APPROVAL_REQUIRED",
          `Action ${actionId} has no approved approval request`,
          { httpStatus: 403 },
        );
      }

      return deps.executionService.execute(actionId);
    },
  };
}
