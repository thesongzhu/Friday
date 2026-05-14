import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayAutoFixLessonExtractionService } from "./friday-auto-fix-lesson-extraction-service.js";
import type { FridayAutoFixRollbackService } from "./friday-auto-fix-rollback-service.js";
import type { UUID } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixExecutionResult,
  FridayAutoFixPlan,
  FridayAutoFixPlanStep,
  FridayAutoFixRollbackStep,
  FridayAutoFixStepKind,
} from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixExecutionService {
  execute(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

export type FridayAutoFixExecutableStep =
  | FridayAutoFixPlanStep
  | FridayAutoFixRollbackStep;

function hasVerifySpec(
  step: FridayAutoFixExecutableStep,
): step is FridayAutoFixPlanStep & { verify: NonNullable<FridayAutoFixPlanStep["verify"]> } {
  return "verify" in step && step.verify != null;
}

/** A step executor returns true if the step succeeded. */
export type StepExecutor = (
  step: FridayAutoFixExecutableStep,
) => boolean | Promise<boolean>;

/** A step verifier returns true if verification passed. */
export type StepVerifier = (
  step: FridayAutoFixExecutableStep,
) => boolean | Promise<boolean>;

export interface CreateAutoFixExecutionServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonExtractionService?: FridayAutoFixLessonExtractionService;
  rollbackService: FridayAutoFixRollbackService;
  nowIso: () => string;
  /** Override executors per step kind for production use. */
  stepExecutors?: Partial<Record<FridayAutoFixStepKind, StepExecutor>>;
  /** Override verifiers per step kind for production use. */
  stepVerifiers?: Partial<Record<FridayAutoFixStepKind, StepVerifier>>;
}

/**
 * Step kinds that mutate external/runtime state and therefore require an
 * explicit rollback plan before execution can proceed.
 */
export const AUTO_FIX_STEP_KINDS_REQUIRING_ROLLBACK_PLAN: ReadonlySet<FridayAutoFixStepKind> = new Set([
  "apply_config_patch",
  "grant_permission",
  "switch_model_fallback",
  "regenerate_skill",
]);

/**
 * Default executors are intentionally limited to payload-local transforms.
 * Steps that mutate runtime or external state must be supplied by the hub via
 * `stepExecutors`; otherwise execution fails closed with "No executor".
 */
export const DEFAULT_EXECUTORS: Partial<Record<FridayAutoFixStepKind, StepExecutor>> = {
  trim_payload: (step) => {
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._trimRequested = true;
    }
    return true;
  },
};

/**
 * Default verifiers confirm that the executor left evidence of success in
 * the step payload. This is a real verification: the executor must have
 * mutated the payload with the appropriate directive marker.
 *
 * Callers can inject richer verifiers via `stepVerifiers` that check
 * external state (e.g. query the skill registry to confirm a skill is
 * disabled, or re-run a health check).
 */
export const DEFAULT_VERIFIERS: Record<FridayAutoFixStepKind, StepVerifier> = {
  retry_node: (step) => {
    if (!hasVerifySpec(step)) return true; // no verify spec → auto-pass
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._retryRequested === true;
  },
  switch_model_fallback: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._modelFallbackRequested === true;
  },
  trim_payload: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._trimRequested === true;
  },
  apply_config_patch: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._configPatchApplied === true;
  },
  grant_permission: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._permissionGranted === true;
  },
  disable_skill: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._skillDisabled === true;
  },
  pause_workflow: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._workflowPaused === true;
  },
  regenerate_skill: (step) => {
    if (!hasVerifySpec(step)) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._skillRegenerated === true;
  },
};

export function createFridayAutoFixExecutionService(
  deps: CreateAutoFixExecutionServiceDeps,
): FridayAutoFixExecutionService {
  const executors: Partial<Record<FridayAutoFixStepKind, StepExecutor>> = { ...DEFAULT_EXECUTORS, ...deps.stepExecutors };
  const verifiers = { ...DEFAULT_VERIFIERS, ...deps.stepVerifiers };

  function persistPlanEvidence(
    actionId: UUID,
    plan: FridayAutoFixPlan,
    nowIso: string,
  ): void {
    deps.db.withWriteTransaction((db) => {
      deps.actionRepo.setPlan(db, actionId, plan, nowIso);
      if (plan.rollbackPlan) {
        deps.actionRepo.setRollbackPlan(db, actionId, plan.rollbackPlan, nowIso);
      }
    });
  }

  function readPayloadRecord(payload: unknown): Record<string, unknown> | null {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  }

  function syncRollbackEvidenceFromForwardSteps(plan: FridayAutoFixPlan): void {
    const rollbackSteps = plan.rollbackPlan?.steps;
    if (!rollbackSteps || rollbackSteps.length === 0) {
      return;
    }

    for (const forwardStep of plan.steps) {
      if (forwardStep.kind !== "apply_config_patch") {
        continue;
      }
      const forwardPayload = readPayloadRecord(forwardStep.payload);
      const previousRevision = forwardPayload?._configPatchPreviousRevision;
      if (typeof previousRevision !== "number" || !Number.isFinite(previousRevision)) {
        continue;
      }
      const incidentId = typeof forwardPayload?.incidentId === "string"
        ? forwardPayload.incidentId
        : undefined;

      for (const rollbackStep of rollbackSteps) {
        if (rollbackStep.kind !== "apply_config_patch") {
          continue;
        }
        const rollbackPayload = readPayloadRecord(rollbackStep.payload);
        if (!rollbackPayload || rollbackPayload.revert !== true || rollbackPayload.toRevision !== undefined) {
          continue;
        }
        const rollbackIncidentId = typeof rollbackPayload.incidentId === "string"
          ? rollbackPayload.incidentId
          : undefined;
        const sameTarget = rollbackStep.target === forwardStep.target;
        const sameIncident = incidentId !== undefined && incidentId === rollbackIncidentId;
        if (sameTarget || sameIncident) {
          rollbackPayload.toRevision = previousRevision;
          rollbackPayload._configPatchPreviousRevision = previousRevision;
        }
      }
    }
  }

  async function finalizeFailedAction(
    actionId: UUID,
    nowIso: string,
    errorMessage: string,
    rollbackAttempted: boolean,
  ): Promise<FridayAutoFixExecutionResult> {
    return deps.db.withWriteTransaction((db) => {
      const failed = deps.actionRepo.markApplied(db, actionId, "failed", nowIso);
      if (!failed) throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found`, { httpStatus: 404 });
      return {
        action: failed,
        success: false,
        verificationPassed: false,
        rollbackAttempted,
        rollbackSucceeded: false,
        errorMessage,
      };
    });
  }

  function extractFailureLessonBestEffort(
    failedAction: FridayAutoFixActionEntity,
    nowIso: string,
  ): void {
    if (!deps.lessonExtractionService) return;
    try {
      // Re-read the action to get the updated status/outcome after finalization
      const freshAction = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, failedAction.actionId),
      ) ?? failedAction;

      const incident = deps.db.withReadConnection((db) =>
        deps.incidentRepo.listByUser(db, { userId: freshAction.userId }).find(
          (inc) => inc.incidentId === freshAction.incidentId,
        ),
      );
      const diagnosisId = freshAction.plan.evidence.diagnosisId;
      const diagnosis = diagnosisId
        ? deps.db.withReadConnection((db) =>
            deps.diagnosisRepo.listByFingerprint(
              db,
              freshAction.plan.evidence.fingerprint,
            ).find((d) => d.id === diagnosisId),
          )
        : undefined;
      if (incident && diagnosis) {
        deps.lessonExtractionService.extractFromFailure({
          incident,
          diagnosis,
          action: freshAction,
          nowIso,
        });
      }
    } catch (err) {
      console.warn(
        `[friday] Failed-fix lesson extraction failed for action ${failedAction.actionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    async execute(actionId) {
      const nowIso = deps.nowIso();

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

      const requiresRollbackPlan = action.plan.steps.some((step) =>
        AUTO_FIX_STEP_KINDS_REQUIRING_ROLLBACK_PLAN.has(step.kind));

      if (requiresRollbackPlan && !action.plan.rollbackPlan && !action.rollbackPlan) {
        return deps.db.withWriteTransaction((db) => {
          const rejected = deps.actionRepo.markRejected(db, actionId, nowIso);
          if (!rejected) throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found`, { httpStatus: 404 });
          return {
            action: rejected,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: "Tier 1+ action requires rollback plan",
          };
        });
      }

      // Execute plan steps via executor map
      let executionSucceeded = true;
      let executionFailureMessage: string | undefined;
      for (const step of action.plan.steps) {
        const executor = executors[step.kind];
        if (!executor) {
          executionSucceeded = false;
          executionFailureMessage = `No executor available for auto-fix step kind '${step.kind}'`;
          break;
        }
        if (!await executor(step)) {
          executionSucceeded = false;
          executionFailureMessage = `Auto-fix step '${step.stepId}' (${step.kind}) failed during execution`;
          break;
        }
      }

      if (!executionSucceeded) {
        syncRollbackEvidenceFromForwardSteps(action.plan);
        persistPlanEvidence(actionId, action.plan, nowIso);

        // Execution failed — attempt rollback
        const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
        if (rollbackPlan) {
          const rollbackResult = await deps.rollbackService.rollback(
            actionId,
            executionFailureMessage ?? "Forward execution failed",
          );
          if (rollbackResult.rollbackSucceeded) {
            extractFailureLessonBestEffort(action, nowIso);
            return rollbackResult;
          }
          const failedResult = await finalizeFailedAction(
            actionId,
            nowIso,
            rollbackResult.errorMessage ??
              executionFailureMessage ??
              "Step execution failed and rollback did not complete",
            true,
          );
          extractFailureLessonBestEffort(action, nowIso);
          return failedResult;
        }

        const failedResult = await finalizeFailedAction(
          actionId,
          nowIso,
          executionFailureMessage ?? "Step execution failed, no rollback plan available",
          false,
        );
        extractFailureLessonBestEffort(action, nowIso);
        return failedResult;
      }

      syncRollbackEvidenceFromForwardSteps(action.plan);
      persistPlanEvidence(actionId, action.plan, nowIso);

      // Run verification per step kind
      let verificationPassed = true;
      let verificationFailureMessage: string | undefined;
      for (const step of action.plan.steps) {
        if (step.verify) {
          const verifier = verifiers[step.kind];
          if (!verifier) {
            verificationPassed = false;
            verificationFailureMessage =
              `No verifier available for auto-fix step kind '${step.kind}'`;
            break;
          }
          if (!await verifier(step)) {
            verificationPassed = false;
            verificationFailureMessage =
              `Auto-fix step '${step.stepId}' (${step.kind}) failed verification`;
            break;
          }
        }
      }

      if (verificationPassed) {
        // Success path
        const result = deps.db.withWriteTransaction((db) => {
          const applied = deps.actionRepo.markApplied(
            db,
            actionId,
            "success",
            nowIso,
          );
          if (!applied) throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", `Action ${actionId} not found`, { httpStatus: 404 });

          // Mark incident as mitigated
          deps.incidentRepo.updateStatus(
            db,
            action.incidentId,
            "mitigated",
            nowIso,
          );

          // Mark diagnosis as resolved
          const diagnosisId = action.plan.evidence.diagnosisId;
          if (diagnosisId) {
            deps.diagnosisRepo.markResolved(db, diagnosisId, nowIso);
          }

          return {
            action: applied,
            success: true,
            verificationPassed: true,
            rollbackAttempted: false,
            rollbackSucceeded: false,
          };
        });

        // Best-effort lesson extraction after successful execution.
        // Failures are logged and swallowed — execution result stays successful.
        if (deps.lessonExtractionService) {
          try {
            const incident = deps.db.withReadConnection((db) =>
              deps.incidentRepo.listByUser(db, {
                userId: action.userId,
                status: "mitigated",
              }).find((inc) => inc.incidentId === action.incidentId),
            );
            const diagnosis = deps.db.withReadConnection((db) =>
              deps.diagnosisRepo.listByFingerprint(
                db,
                action.plan.evidence.fingerprint,
              ).find((d) => d.id === action.plan.evidence.diagnosisId),
            );

            if (incident && diagnosis) {
              deps.lessonExtractionService.extractFromSuccess({
                incident,
                diagnosis,
                action: result.action,
                nowIso,
              });
            }
          } catch (lessonError) {
            // Lesson extraction is best-effort; log and continue so execution
            // result still reports success.
            console.warn(
              `[friday] Auto-fix lesson extraction failed for action ${actionId}:`,
              lessonError instanceof Error ? lessonError.message : String(lessonError),
            );
          }
        }

        return result;
      }

      // Verification failed — attempt rollback
      const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
      if (!rollbackPlan) {
        const failedResult = await finalizeFailedAction(
          actionId,
          nowIso,
          verificationFailureMessage ?? "Verification failed, no rollback plan available",
          false,
        );
        extractFailureLessonBestEffort(action, nowIso);
        return failedResult;
      }

      const rollbackResult = await deps.rollbackService.rollback(
        actionId,
        verificationFailureMessage ?? "Verification failed",
      );
      if (rollbackResult.rollbackSucceeded) {
        extractFailureLessonBestEffort(action, nowIso);
        return rollbackResult;
      }
      const failedResult = await finalizeFailedAction(
        actionId,
        nowIso,
        rollbackResult.errorMessage ??
          verificationFailureMessage ??
          "Verification failed and rollback did not complete",
        true,
      );
      extractFailureLessonBestEffort(action, nowIso);
      return failedResult;
    },
  };
}
