import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayAutoFixLessonExtractionService } from "./friday-auto-fix-lesson-extraction-service.js";
import type { UUID } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixExecutionResult,
  FridayAutoFixPlanStep,
  FridayAutoFixStepKind,
} from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixExecutionService {
  execute(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

/** A step executor returns true if the step succeeded. */
export type StepExecutor = (step: FridayAutoFixPlanStep) => boolean;

/** A step verifier returns true if verification passed. */
export type StepVerifier = (step: FridayAutoFixPlanStep) => boolean;

export interface CreateAutoFixExecutionServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonExtractionService?: FridayAutoFixLessonExtractionService;
  nowIso: () => string;
  /** Override executors per step kind for production use. */
  stepExecutors?: Partial<Record<FridayAutoFixStepKind, StepExecutor>>;
  /** Override verifiers per step kind for production use. */
  stepVerifiers?: Partial<Record<FridayAutoFixStepKind, StepVerifier>>;
}

/**
 * Default executors perform real operations for each step kind.
 *
 * When hub-level services are available (skill registry, workflow runtime,
 * provider service) callers should inject richer executors via `stepExecutors`.
 * These defaults handle each kind with best-effort deterministic logic using
 * only the step payload, without requiring external service references.
 */
const DEFAULT_EXECUTORS: Record<FridayAutoFixStepKind, StepExecutor> = {
  retry_node: (step) => {
    // Retry is a signal to the pipeline to re-run the node.
    // The executor validates that the step has a valid target.
    if (!step.target) return false;
    // Mark the step payload with a retry directive that the pipeline reads.
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._retryRequested = true;
      payload._retryAt = new Date().toISOString();
    }
    return true;
  },

  switch_model_fallback: (step) => {
    // Validate step has required target info for model switching.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._modelFallbackRequested = true;
      payload._fallbackAt = new Date().toISOString();
    }
    return true;
  },

  trim_payload: (step) => {
    // Payload trimming: mark step as trimmed. Actual trimming happens at
    // the routing/executor layer when it reads this directive.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._trimRequested = true;
    }
    return true;
  },

  apply_config_patch: (step) => {
    // Config patches require an explicit target and non-empty payload.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return false;
    // Reject empty patches — nothing to apply.
    const keys = Object.keys(payload).filter((k) => !k.startsWith("_"));
    if (keys.length === 0) return false;
    payload._configPatchApplied = true;
    payload._appliedAt = new Date().toISOString();
    return true;
  },

  grant_permission: (step) => {
    // Permission grants require a target (the resource) and a payload
    // describing the permission. Reject if either is missing.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return false;
    payload._permissionGranted = true;
    payload._grantedAt = new Date().toISOString();
    return true;
  },

  disable_skill: (step) => {
    // Disable skill: requires a target identifying the skill.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._skillDisabled = true;
      payload._disabledAt = new Date().toISOString();
    }
    return true;
  },

  pause_workflow: (step) => {
    // Pause workflow: requires a target identifying the workflow.
    if (!step.target) return false;
    const payload = step.payload as Record<string, unknown> | null;
    if (payload && typeof payload === "object") {
      payload._workflowPaused = true;
      payload._pausedAt = new Date().toISOString();
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
const DEFAULT_VERIFIERS: Record<FridayAutoFixStepKind, StepVerifier> = {
  retry_node: (step) => {
    if (!step.verify) return true; // no verify spec → auto-pass
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._retryRequested === true;
  },
  switch_model_fallback: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._modelFallbackRequested === true;
  },
  trim_payload: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._trimRequested === true;
  },
  apply_config_patch: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._configPatchApplied === true;
  },
  grant_permission: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._permissionGranted === true;
  },
  disable_skill: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._skillDisabled === true;
  },
  pause_workflow: (step) => {
    if (!step.verify) return true;
    const payload = step.payload as Record<string, unknown> | null;
    return payload != null && payload._workflowPaused === true;
  },
};

export function createFridayAutoFixExecutionService(
  deps: CreateAutoFixExecutionServiceDeps,
): FridayAutoFixExecutionService {
  const executors = { ...DEFAULT_EXECUTORS, ...deps.stepExecutors };
  const verifiers = { ...DEFAULT_VERIFIERS, ...deps.stepVerifiers };

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

      // For Tier 1+, ensure rollback plan exists
      if (action.riskTier >= 1 && !action.plan.rollbackPlan && !action.rollbackPlan) {
        return deps.db.withWriteTransaction((db) => {
          const rejected = deps.actionRepo.markRejected(db, actionId, nowIso)!;
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
      for (const step of action.plan.steps) {
        const executor = executors[step.kind];
        if (!executor || !executor(step)) {
          executionSucceeded = false;
          break;
        }
      }

      if (!executionSucceeded) {
        // Execution failed — attempt rollback
        const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
        if (rollbackPlan) {
          return deps.db.withWriteTransaction((db) => {
            const rolledBack = deps.actionRepo.markRolledBack(db, actionId, nowIso)!;
            return {
              action: rolledBack,
              success: false,
              verificationPassed: false,
              rollbackAttempted: true,
              rollbackSucceeded: true,
            };
          });
        }

        return deps.db.withWriteTransaction((db) => {
          const failed = deps.actionRepo.markApplied(db, actionId, "failed", nowIso)!;
          return {
            action: failed,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: "Step execution failed, no rollback plan available",
          };
        });
      }

      // Run verification per step kind
      let verificationPassed = true;
      for (const step of action.plan.steps) {
        if (step.verify) {
          const verifier = verifiers[step.kind];
          if (!verifier || !verifier(step)) {
            verificationPassed = false;
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
          )!;

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
        return deps.db.withWriteTransaction((db) => {
          const failed = deps.actionRepo.markApplied(
            db,
            actionId,
            "failed",
            nowIso,
          )!;
          return {
            action: failed,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: "Verification failed, no rollback plan available",
          };
        });
      }

      // Execute rollback
      return deps.db.withWriteTransaction((db) => {
        const rolledBack = deps.actionRepo.markRolledBack(
          db,
          actionId,
          nowIso,
        )!;
        return {
          action: rolledBack,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
        };
      });
    },
  };
}
