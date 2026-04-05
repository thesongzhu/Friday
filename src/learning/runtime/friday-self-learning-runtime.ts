import { createFridayLearningEventLedger } from "#ledger";
import { createFridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import { createFridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import { createFridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import { createFridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import { createFridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import { createFridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import { createFridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import { createFridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import { createFridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import { createFridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import { createFridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import { createFridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import { createFridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";
import { createFridayErrorDiagnosisService } from "../services/friday-error-diagnosis-service.js";
import { createFridayAutoFixPlanService } from "../services/friday-auto-fix-plan-service.js";
import { createFridayAutoFixRiskAssessmentService } from "../services/friday-auto-fix-risk-assessment-service.js";
import { createFridayAutoFixExecutionService } from "../services/friday-auto-fix-execution-service.js";
import { createFridayAutoFixRollbackService } from "../services/friday-auto-fix-rollback-service.js";
import { createFridayApprovalWorkflowService } from "../services/friday-approval-workflow-service.js";
import { createFridayAutoFixLessonExtractionService } from "../services/friday-auto-fix-lesson-extraction-service.js";
import { createFridayAutoFixDispatcherService } from "../services/friday-auto-fix-dispatcher-service.js";
import { createFridaySessionSatisfactionRepository } from "../persistence/friday-session-satisfaction-repository.js";
import { createFridaySessionSatisfactionService } from "../services/friday-session-satisfaction-service.js";
import { createFridayDeepPatternExtractionService } from "../services/friday-deep-pattern-extraction-service.js";
import { createFridayIndividuationService } from "../services/friday-individuation-service.js";
import type {
  CreateFridaySelfLearningRuntimeDeps,
  FridaySelfLearningRuntime,
} from "./friday-self-learning-runtime.types.js";

export function createFridaySelfLearningRuntime(
  deps: CreateFridaySelfLearningRuntimeDeps,
): FridaySelfLearningRuntime {
  // 1. Reuse existing learning event ledger
  const ledger = createFridayLearningEventLedger({ db: deps.db });

  // 2. Create repositories
  const factRepo = createFridayPreferenceFactRepository();
  const incidentRepo = createFridayErrorIncidentRepository();
  const diagnosisRepo = createFridayDiagnosisRecordRepository();
  const lessonRepo = createFridayLearnedLessonRepository();
  const metricsRepo = createFridayLearningMetricsRepository();
  const actionRepo = createFridayAutoFixActionRepository();
  const approvalRepo = createFridayApprovalRequestRepository();

  // 3. Create extraction service
  const extraction = createFridayPreferenceExtractionService({
    idGenerator: deps.idGenerator,
  });

  // 4. Create fact service
  const facts = createFridayPreferenceFactService({
    db: deps.db,
    factRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 5. Create event collection service
  const events = createFridayLearningEventCollectionService({ ledger });

  // 6. Create pattern recognition service
  const patterns = createFridayLearningPatternRecognitionService({
    db: deps.db,
    incidentRepo,
    factRepo,
    idGenerator: deps.idGenerator,
  });

  // 7. Create lifecycle service
  const lifecycle = createFridayLearningLifecycleService({
    db: deps.db,
    factRepo,
  });

  // 8. Create feedback loop service
  const feedback = createFridayLearningFeedbackLoopService({
    db: deps.db,
    factRepo,
    extraction,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 9. Create context enrichment service
  const context = createFridayLearningContextEnrichmentService({
    db: deps.db,
    factService: facts,
    patternService: patterns,
    lifecycleService: lifecycle,
  });

  // 10. Create auto-fix services
  const diagnosis = createFridayErrorDiagnosisService({
    db: deps.db,
    incidentRepo,
    diagnosisRepo,
    lessonRepo,
    factRepo,
    idGenerator: deps.idGenerator,
  });

  const autoFixPlan = createFridayAutoFixPlanService({
    idGenerator: deps.idGenerator,
  });

  const autoFixRisk = createFridayAutoFixRiskAssessmentService({
    db: deps.db,
    actionRepo,
  });

  const lessonExtraction = createFridayAutoFixLessonExtractionService({
    db: deps.db,
    lessonRepo,
    incidentRepo,
    diagnosisRepo,
    idGenerator: deps.idGenerator,
  });

  const autoFixRollback = createFridayAutoFixRollbackService({
    db: deps.db,
    actionRepo,
    nowIso: deps.nowIso,
    stepExecutors: deps.stepExecutors,
    stepVerifiers: deps.stepVerifiers,
  });

  const autoFixExecution = createFridayAutoFixExecutionService({
    db: deps.db,
    actionRepo,
    incidentRepo,
    diagnosisRepo,
    lessonExtractionService: lessonExtraction,
    rollbackService: autoFixRollback,
    nowIso: deps.nowIso,
    stepExecutors: deps.stepExecutors,
    stepVerifiers: deps.stepVerifiers,
  });

  const approvals = createFridayApprovalWorkflowService({
    db: deps.db,
    approvalRepo,
    actionRepo,
    idGenerator: deps.idGenerator,
    executionService: autoFixExecution,
  });

  const autoFixDispatcher = createFridayAutoFixDispatcherService({
    db: deps.db,
    actionRepo,
    approvalRepo,
    incidentRepo,
    riskService: autoFixRisk,
    executionService: autoFixExecution,
    nowIso: deps.nowIso,
  });

  // 11. Create metrics service (with action repo for Phase 7)
  const metrics = createFridayLearningMetricsService({
    db: deps.db,
    metricsRepo,
    actionRepo,
    nowIso: deps.nowIso,
  });

  // 12. Create pipeline orchestrator (with Phase 7 services)
  const pipeline = createFridaySelfLearningPipelineService({
    db: deps.db,
    events,
    extraction,
    facts,
    lifecycle,
    incidentRepo,
    diagnosisRepo,
    lessonRepo,
    actionRepo,
    approvalRepo,
    diagnosisService: diagnosis,
    planService: autoFixPlan,
    riskService: autoFixRisk,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 13. Create satisfaction, individuation, and deep pattern services
  const satisfactionRepo = createFridaySessionSatisfactionRepository();

  const satisfaction = createFridaySessionSatisfactionService({
    db: deps.db,
    satisfactionRepo,
  });

  const individuation = createFridayIndividuationService({
    db: deps.db,
    factRepo,
    satisfactionRepo,
  });

  const deepPatterns = createFridayDeepPatternExtractionService({
    db: deps.db,
    satisfactionRepo,
    factRepo,
    idGenerator: deps.idGenerator,
  });

  // 14. Wire individuation into context enrichment
  const contextWithIndividuation = createFridayLearningContextEnrichmentService({
    db: deps.db,
    factService: facts,
    patternService: patterns,
    lifecycleService: lifecycle,
    individuationService: individuation,
  });

  return {
    events,
    extraction,
    facts,
    patterns,
    feedback,
    lifecycle,
    context: contextWithIndividuation,
    metrics,
    pipeline,
    diagnosis,
    autoFixPlan,
    autoFixRisk,
    autoFixExecution,
    autoFixRollback,
    approvals,
    autoFixDispatcher,
    satisfaction,
    deepPatterns,
    individuation,
  };
}
