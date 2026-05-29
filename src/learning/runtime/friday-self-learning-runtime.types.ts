import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import type { FridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import type { FridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import type { FridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import type { FridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import type { FridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import type { FridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import type { FridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import type { FridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";
import type { FridayErrorDiagnosisService } from "../services/friday-error-diagnosis-service.js";
import type { FridayAutoFixPlanService } from "../services/friday-auto-fix-plan-service.js";
import type { FridayAutoFixRiskAssessmentService } from "../services/friday-auto-fix-risk-assessment-service.js";
import type { FridayAutoFixExecutionService, StepExecutor, StepVerifier } from "../services/friday-auto-fix-execution-service.js";
import type { FridayAutoFixRollbackService } from "../services/friday-auto-fix-rollback-service.js";
import type { FridayApprovalWorkflowService } from "../services/friday-approval-workflow-service.js";
import type { FridayAutoFixDispatcherService } from "../services/friday-auto-fix-dispatcher-service.js";
import type { FridayAutoFixStepKind } from "../model/friday-auto-fix.types.js";
import type { SkillLifecycleStatus } from "#skills";

export interface FridaySelfLearningRuntime {
  events: FridayLearningEventCollectionService;
  extraction: FridayPreferenceExtractionService;
  facts: FridayPreferenceFactService;
  patterns: FridayLearningPatternRecognitionService;
  feedback: FridayLearningFeedbackLoopService;
  lifecycle: FridayLearningLifecycleService;
  context: FridayLearningContextEnrichmentService;
  metrics: FridayLearningMetricsService;
  pipeline: FridaySelfLearningPipelineService;
  diagnosis: FridayErrorDiagnosisService;
  autoFixPlan: FridayAutoFixPlanService;
  autoFixRisk: FridayAutoFixRiskAssessmentService;
  autoFixExecution: FridayAutoFixExecutionService;
  autoFixRollback: FridayAutoFixRollbackService;
  approvals: FridayApprovalWorkflowService;
  autoFixDispatcher: FridayAutoFixDispatcherService;
}

export interface CreateFridaySelfLearningRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
  /** Override auto-fix step executors for production use (e.g. wired to real services). */
  stepExecutors?: Partial<Record<FridayAutoFixStepKind, StepExecutor>>;
  /** Override auto-fix step verifiers for production use. */
  stepVerifiers?: Partial<Record<FridayAutoFixStepKind, StepVerifier>>;
  /**
   * Reads the current durable skill lifecycle status at plan-build time, so a regenerate_skill
   * rollback can restore the prior status instead of blindly enabling. Wired in the hub bootstrap
   * to the durable skills store; optional elsewhere.
   */
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | undefined;
}
