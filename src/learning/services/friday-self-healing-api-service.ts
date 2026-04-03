import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestStatus,
  FridayAutoFixActionEntity,
  FridayAutoFixExecutionResult,
  FridayAutoFixFeedbackReasonCode,
} from "../model/friday-auto-fix.types.js";
import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
  FridayLearningMetricsEntity,
  FridaySelfLearningProcessResult,
  UUID,
} from "../model/friday-learning.types.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type { FridayErrorDiagnosisService } from "./friday-error-diagnosis-service.js";
import type { FridayAutoFixPlanService } from "./friday-auto-fix-plan-service.js";
import type { FridayAutoFixRiskAssessmentService } from "./friday-auto-fix-risk-assessment-service.js";
import type { FridayAutoFixExecutionService } from "./friday-auto-fix-execution-service.js";
import type { FridayAutoFixRollbackService } from "./friday-auto-fix-rollback-service.js";
import type { FridayApprovalWorkflowService } from "./friday-approval-workflow-service.js";
import type { FridayAutoFixDispatcherService } from "./friday-auto-fix-dispatcher-service.js";
import type { FridayLearningMetricsService } from "./friday-learning-metrics-service.js";
import type { FridaySelfLearningPipelineService } from "./friday-self-learning-pipeline-service.js";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";
import { safeJsonParse } from "#utilities";
import type {
  FridayProviderBackendKind,
  FridayProviderRoutingDecisionTrace,
} from "#providers";

export interface FridaySelfHealingEventPublisher {
  publish(
    streamId: string,
    event: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): void;
}

export interface FridaySelfHealingIssueCard {
  id: string;
  kind: "approval_required" | "incident" | "failed_fix";
  incidentId: string;
  actionId?: string;
  approvalRequestId?: string;
  title: string;
  summary: string;
  severity: FridayErrorIncidentEntity["severity"];
  status: string;
  createdAt: string;
  routeTarget: "/assistant";
}

export interface FridaySelfHealingActionDetails {
  action: FridayAutoFixActionEntity;
  incident: FridayErrorIncidentEntity | null;
  diagnosis: FridayDiagnosisRecordEntity | null;
  approval: FridayApprovalRequestEntity | null;
  lesson: FridayLearnedLessonEntity | null;
  risk: {
    riskTier: FridayAutoFixActionEntity["riskTier"];
    reasons: string[];
    requiresApproval: boolean;
    autoApplyAllowed: boolean;
  };
  evidence: {
    rootCauseSummary: string;
    selectedPlan: {
      title: string;
      summary: string;
      stepCount: number;
      rollbackPlanAvailable: boolean;
    };
    riskTier: FridayAutoFixActionEntity["riskTier"];
    approvalTrail?: {
      requestId: string;
      status: FridayApprovalRequestStatus;
      respondedAt?: string;
      respondedBy?: string;
      reason?: string;
    };
    executionResult: {
      status: FridayAutoFixActionEntity["status"];
      outcome: FridayAutoFixActionEntity["outcome"];
      appliedAt?: string;
    };
    rollbackResult: {
      available: boolean;
      rolledBackAt?: string;
      rollbackAttempted: boolean;
      rollbackSucceeded: boolean;
    };
    acceptanceResult: {
      passed: boolean;
      reason: string;
    };
    extractedLesson?: {
      id: string;
      title: string;
      cause: string;
      fix: string;
    };
  };
}

export interface FridayIncidentDiagnosisDetails {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity | null;
  lesson: FridayLearnedLessonEntity | null;
  action: FridaySelfHealingActionDetails | null;
  recurrenceCount: number;
  autoFixEligible: boolean;
}

export interface FridayLearningLessonRecord {
  lesson: FridayLearnedLessonEntity;
  disabled: boolean;
  disabledReason?: string;
}

export interface FridayLearningPatternRecord {
  patternId: string;
  userId: string;
  kind: string;
  description: string;
  pattern: Record<string, unknown>;
  confidence: number;
  sampleCount: number;
  lastUpdated: string;
  createdAt: string;
  demoted: boolean;
  demotionFactor?: number;
  demotionReason?: string;
}

export interface FridayLearningRouteAdjustmentRecord {
  kind: "pin" | "penalty";
  key: string;
  taskProfileId?: string;
  providerId?: string;
  model?: string;
  backendKind?: FridayProviderBackendKind;
  confidence: number;
  value: Record<string, unknown>;
}

export interface FridayLearningRouteBiasRecord extends FridayLearningRouteAdjustmentRecord {
  source: "operator_pin" | "operator_penalty";
}

export interface FridayRejectedFixRecord {
  actionId: string;
  incidentId: string;
  title: string;
  fingerprint: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayRollbackHotspotRecord {
  fingerprint: string;
  rolledBackCount: number;
  appliedCount: number;
  rejectedCount: number;
  totalCount: number;
  lastSeenAt: string;
}

export interface FridayRouteDecisionDiffRecord {
  runId: string;
  createdAt: string;
  taskProfileId?: string;
  requestedProviderId?: string;
  requestedModel?: string;
  actualProviderId?: string;
  actualModel?: string;
  reasonCode?: string;
  reasonText?: string;
  learningAdjusted: boolean;
  learningSignalsPresent: boolean;
  selectedBeforeLearning?: {
    providerId: string;
    providerKind: string;
    model: string;
    backendKind: FridayProviderBackendKind;
  };
  selectedAfterLearning?: {
    providerId: string;
    providerKind: string;
    model: string;
    backendKind: FridayProviderBackendKind;
  };
  matchedLessonIds: string[];
  matchedPatternIds: string[];
  trace: FridayProviderRoutingDecisionTrace;
}

export interface FridayBlockedRouteRecord {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: FridayProviderBackendKind;
  reasons: string[];
  count: number;
  lastSeenAt: string;
}

export interface FridayLearningCoverageSummary {
  lessons: number;
  patterns: number;
  routeAdjustments: number;
  recentDecisionDiffs: number;
  blockedRoutes: number;
  rejectedFixes: number;
  rollbackHotspots: number;
  incidents: number;
  diagnoses: number;
  autoFixActions: number;
}

export interface FridayLearningOverview {
  lessons: FridayLearningLessonRecord[];
  patterns: FridayLearningPatternRecord[];
  routeAdjustments: FridayLearningRouteAdjustmentRecord[];
  routeBiases: FridayLearningRouteBiasRecord[];
  operatorPins: FridayLearningRouteAdjustmentRecord[];
  penaltyFacts: FridayLearningRouteAdjustmentRecord[];
  recentDecisionDiffs: FridayRouteDecisionDiffRecord[];
  blockedRoutes: FridayBlockedRouteRecord[];
  rejectedFixes: FridayRejectedFixRecord[];
  recentRejectedFixes: FridayRejectedFixRecord[];
  rollbackHotspots: FridayRollbackHotspotRecord[];
  coverage: FridayLearningCoverageSummary;
}

export interface FridaySelfHealingApiService {
  listIncidents(input: {
    userId: string;
    status?: FridayErrorIncidentEntity["status"];
    limit?: number;
  }): FridayIncidentDiagnosisDetails[];
  getIncident(input: {
    incidentId: string;
  }): FridayIncidentDiagnosisDetails | null;
  getIncidentDiagnosis(input: {
    incidentId: string;
  }): FridayIncidentDiagnosisDetails | null;
  listActions(input: {
    userId: string;
    status?: FridayAutoFixActionEntity["status"];
    incidentId?: string;
    limit?: number;
  }): FridaySelfHealingActionDetails[];
  getAction(input: {
    actionId: string;
  }): FridaySelfHealingActionDetails | null;
  approveAction(input: {
    actionId: string;
    respondedBy: string;
    reason?: string;
  }): Promise<FridaySelfHealingActionDetails>;
  denyAction(input: {
    actionId: string;
    respondedBy: string;
    reason?: string;
    reasonCode?: FridayAutoFixFeedbackReasonCode;
  }): Promise<FridaySelfHealingActionDetails>;
  manualResolveIncident(input: {
    incidentId: string;
    resolvedBy: string;
    fix: string;
    title?: string;
    cause?: string;
    verificationSummary?: string;
  }): FridayIncidentDiagnosisDetails;
  getLearningOverview(input: {
    userId: string;
    limit?: number;
  }): FridayLearningOverview;
  setLessonEnabled(input: {
    userId: string;
    lessonId: string;
    enabled: boolean;
    reason?: string;
  }): FridayLearningLessonRecord;
  demotePattern(input: {
    userId: string;
    patternId: string;
    factor: number;
    reason?: string;
  }): FridayLearningPatternRecord;
  executeAction(input: {
    actionId: string;
  }): Promise<FridaySelfHealingActionDetails>;
  rollbackAction(input: {
    actionId: string;
    reason: string;
  }): Promise<FridaySelfHealingActionDetails>;
  getMetrics(input: {
    day?: string;
    fromDay?: string;
    toDay?: string;
  }): FridayLearningMetricsEntity | FridayLearningMetricsEntity[];
  listIssueCards(input: {
    userId: string;
    limit?: number;
  }): FridaySelfHealingIssueCard[];
  reportStructuredFailure(input: {
    userId: string;
    runId?: string;
    category: FridayErrorIncidentEntity["category"];
    severity: FridayErrorIncidentEntity["severity"];
    message: string;
    context?: Record<string, unknown>;
    correlationId?: string;
  }): FridaySelfLearningProcessResult;
  emitProcessResults(results: FridaySelfLearningProcessResult[], correlationId?: string): void;
}

export interface CreateFridaySelfHealingApiServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonRepo: FridayLearnedLessonRepository;
  actionRepo: FridayAutoFixActionRepository;
  approvalRepo: FridayApprovalRequestRepository;
  factRepo: FridayPreferenceFactRepository;
  diagnosisService: FridayErrorDiagnosisService;
  planService: FridayAutoFixPlanService;
  riskService: FridayAutoFixRiskAssessmentService;
  executionService: FridayAutoFixExecutionService;
  rollbackService: FridayAutoFixRollbackService;
  approvalService: FridayApprovalWorkflowService;
  autoFixDispatcher: FridayAutoFixDispatcherService;
  metricsService: FridayLearningMetricsService;
  pipeline: FridaySelfLearningPipelineService;
  publishEvent?: FridaySelfHealingEventPublisher;
  observability?: FridayObservabilityApiService;
  agentLoop?: {
    handleProcessResults(input: {
      results: FridaySelfLearningProcessResult[];
      correlationId?: string;
    }): Promise<unknown>;
    syncAction(input: {
      actionId: UUID;
      correlationId?: string;
    }): Promise<unknown>;
  };
}

function diagnosisStreamId(userId: string): string {
  return `diagnosis:${userId}`;
}

function approvalStreamId(runId?: string): string {
  return runId ? `run:${runId}` : "workflow:self-healing";
}

function summarizeRootCause(
  diagnosis: FridayDiagnosisRecordEntity | null,
  incident: FridayErrorIncidentEntity | null,
): string {
  const rankedCauses = diagnosis?.diagnosis["rankedCauses"];
  if (Array.isArray(rankedCauses) && rankedCauses.length > 0) {
    const first = rankedCauses[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "cause" in first &&
      typeof first.cause === "string"
    ) {
      return first.cause;
    }
  }
  const summary = diagnosis?.diagnosis["summary"];
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary;
  }
  if (incident) {
    return `${incident.category} incident: ${incident.signature}`;
  }
  return "Root cause unavailable";
}

function isFeedbackReasonCode(value: unknown): value is FridayAutoFixFeedbackReasonCode {
  return value === "wrong_root_cause"
    || value === "too_risky"
    || value === "wrong_fix"
    || value === "insufficient_evidence"
    || value === "wrong_model_or_backend_choice";
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return false;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeLearningKeySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createFridaySelfHealingApiService(
  deps: CreateFridaySelfHealingApiServiceDeps,
): FridaySelfHealingApiService {
  const buildActionDetails = (
    action: FridayAutoFixActionEntity,
  ): FridaySelfHealingActionDetails => {
    const incident = deps.db.withReadConnection((db) =>
      deps.incidentRepo.getById(db, action.incidentId),
    );
    const diagnosis = deps.db.withReadConnection((db) =>
      deps.diagnosisRepo.getById(db, action.plan.evidence.diagnosisId),
    );
    const approval = deps.db.withReadConnection((db) =>
      deps.approvalRepo.getByActionId(db, action.actionId),
    );
    const lesson = deps.db.withReadConnection((db) =>
      deps.lessonRepo.getByFingerprint(db, action.plan.evidence.fingerprint),
    );
    const risk = incident
      ? deps.riskService.assess({
        incident,
        plan: action.plan,
        nowIso: deps.nowIso(),
      })
      : {
        riskTier: action.riskTier,
        reasons: [],
        requiresApproval: action.riskTier >= 2,
        autoApplyAllowed: action.riskTier < 2,
      };
    const acceptancePassed = action.status === "applied" && action.outcome === "success";

    return {
      action,
      incident,
      diagnosis,
      approval,
      lesson,
      risk: {
        riskTier: risk.riskTier,
        reasons: risk.reasons,
        requiresApproval: risk.requiresApproval,
        autoApplyAllowed: risk.autoApplyAllowed,
      },
      evidence: {
        rootCauseSummary: summarizeRootCause(diagnosis, incident),
        selectedPlan: {
          title: action.plan.title,
          summary: action.plan.summary,
          stepCount: action.plan.steps.length,
          rollbackPlanAvailable: Boolean(action.rollbackPlan ?? action.plan.rollbackPlan),
        },
        riskTier: action.riskTier,
        approvalTrail: approval
          ? {
            requestId: approval.requestId,
            status: approval.status,
            respondedAt: approval.respondedAt,
            respondedBy: approval.respondedBy,
            reason: approval.responseReason,
          }
          : undefined,
        executionResult: {
          status: action.status,
          outcome: action.outcome,
          appliedAt: action.appliedAt,
        },
        rollbackResult: {
          available: Boolean(action.rollbackPlan ?? action.plan.rollbackPlan),
          rolledBackAt: action.rolledBackAt,
          rollbackAttempted: action.status === "rolled_back",
          rollbackSucceeded: action.status === "rolled_back",
        },
        acceptanceResult: {
          passed: acceptancePassed,
          reason: acceptancePassed
            ? "Mitigation applied and verification passed"
            : action.status === "rolled_back"
              ? "Mitigation failed verification and was rolled back"
              : action.status === "rejected"
                ? "Mitigation was rejected before execution"
                : "Mitigation has not completed acceptance checks",
        },
        extractedLesson: lesson
          ? {
            id: lesson.id,
            title: lesson.title,
            cause: lesson.cause,
            fix: lesson.fix,
          }
          : undefined,
      },
    };
  };

  const buildIncidentDetails = (
    incident: FridayErrorIncidentEntity,
  ): FridayIncidentDiagnosisDetails => {
    const diagnosis = deps.db.withReadConnection((db) =>
      deps.diagnosisRepo.getLatestByIncidentId(db, incident.incidentId),
    );
    const lesson = deps.db.withReadConnection((db) =>
      deps.lessonRepo.getByFingerprint(db, incident.signature),
    );
    const recurrenceCount = deps.db.withReadConnection((db) =>
      deps.incidentRepo.findRecentBySignature(db, incident.userId, incident.signature, 50).length,
    );
    const action = deps.db.withReadConnection((db) =>
      deps.actionRepo.listByUser(db, {
        userId: incident.userId,
        incidentId: incident.incidentId,
        limit: 1,
      })[0] ?? null,
    );

    return {
      incident,
      diagnosis,
      lesson,
      action: action ? buildActionDetails(action) : null,
      recurrenceCount,
      autoFixEligible: incident.autoFixEligible,
    };
  };

  const emitActionEvent = (
    event: string,
    details: FridaySelfHealingActionDetails,
    correlationId?: string,
  ) => {
    deps.publishEvent?.publish(
      approvalStreamId(details.incident?.runId),
      event,
      {
        actionId: details.action.actionId,
        incidentId: details.action.incidentId,
        runId: details.incident?.runId,
        riskTier: details.action.riskTier,
        status: details.action.status,
        outcome: details.action.outcome,
        approvalStatus: details.approval?.status,
      },
      correlationId,
    );
  };

  const emitLearningEvent = (
    payload: {
      userId: string;
      runId?: string;
      kind: "outcome_confirmed";
      details: Record<string, unknown>;
    },
    correlationId?: string,
  ): FridaySelfLearningProcessResult => {
    const result = deps.pipeline.processEvent({
      eventId: deps.idGenerator(),
      ts: deps.nowIso(),
      userId: payload.userId,
      runId: payload.runId,
      kind: payload.kind,
      payload: payload.details,
    });
    deps.observability?.recordSelfHealingProcessResults({ results: [result], correlationId });
    if (deps.agentLoop) {
      void deps.agentLoop.handleProcessResults({ results: [result], correlationId }).catch((error) => {
        console.warn(
          "[friday][self-healing-api] learning-event-handleProcessResults:",
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    return result;
  };

  const buildLearningOverview = (input: {
    userId: string;
    limit?: number;
  }): FridayLearningOverview => {
    const limit = input.limit ?? 20;
    const lessonRows = deps.db.withReadConnection((db) =>
      deps.lessonRepo.listRecent(db, limit),
    );
    const preferenceFacts = deps.db.withReadConnection((db) =>
      deps.factRepo.listByUser(db, input.userId, 0, 500),
    );
    const lessonDisableFacts = preferenceFacts.filter((fact) =>
      fact.key.startsWith("lesson_disabled:"),
    );

    const lessons = lessonRows.map((lesson) => {
      const disabledFact = lessonDisableFacts.find((fact) => fact.key === `lesson_disabled:${lesson.id}`);
      const factValue = readObject(disabledFact?.value);
      return {
        lesson,
        disabled: disabledFact ? isTruthyFlag(factValue?.disabled ?? true) : false,
        ...(disabledFact && typeof factValue?.reason === "string"
          ? { disabledReason: factValue.reason }
          : {}),
      };
    });

    const demotionFactsByKey = new Map(
      preferenceFacts
        .filter((fact) => fact.key.startsWith("pattern_demotion:"))
        .map((fact) => [fact.key, fact] as const),
    );

    const patternRows = deps.db.withReadConnection((db) =>
      db.prepare(
        `SELECT id, user_id, kind, description, pattern_json, confidence, sample_count, last_updated, created_at
         FROM friday_learned_patterns
         WHERE user_id = ?
         ORDER BY last_updated DESC
         LIMIT ?`,
      ).all(input.userId, limit) as Array<{
        id: string;
        user_id: string;
        kind: string;
        description: string;
        pattern_json: string;
        confidence: number;
        sample_count: number;
        last_updated: string;
        created_at: string;
      }>,
    );

    const patterns = patternRows.map((row) => {
      const demotionFact = demotionFactsByKey.get(`pattern_demotion:${row.id}`);
      const demotionValue = readObject(demotionFact?.value);
      const factor =
        typeof demotionValue?.factor === "number" && Number.isFinite(demotionValue.factor)
          ? Math.max(0, Math.min(1, demotionValue.factor))
          : undefined;
      return {
        patternId: row.id,
        userId: row.user_id,
        kind: row.kind,
        description: row.description,
        pattern: safeJsonParse<Record<string, unknown>>(row.pattern_json) ?? {},
        confidence: row.confidence,
        sampleCount: row.sample_count,
        lastUpdated: row.last_updated,
        createdAt: row.created_at,
        demoted: demotionFact != null,
        ...(factor !== undefined ? { demotionFactor: factor } : {}),
        ...(typeof demotionValue?.reason === "string" ? { demotionReason: demotionValue.reason } : {}),
      };
    });

    const routeAdjustments = preferenceFacts
      .filter((fact) => fact.key.startsWith("route_penalty:") || fact.key.startsWith("route_pin:"))
      .slice(0, limit)
      .map((fact): FridayLearningRouteAdjustmentRecord => {
        const parts = fact.key.split(":");
        const kind = parts[0] === "route_pin" ? "pin" : "penalty";
        const value = readObject(fact.value) ?? {};
        return {
          kind,
          key: fact.key,
          ...(parts[1] && parts[1] !== "global" ? { taskProfileId: parts[1] } : {}),
          ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
          ...(typeof value.model === "string" ? { model: value.model } : {}),
          ...(value.backendKind === "http" || value.backendKind === "cli" || value.backendKind === "sdk"
            ? { backendKind: value.backendKind }
            : {}),
          confidence: fact.confidence,
          value,
        };
      });
    const operatorPins = routeAdjustments.filter((record) => record.kind === "pin");
    const penaltyFacts = routeAdjustments.filter((record) => record.kind === "penalty");
    const routeBiases: FridayLearningRouteBiasRecord[] = routeAdjustments.map((record) => ({
      ...record,
      source: record.kind === "pin" ? "operator_pin" : "operator_penalty",
    }));

    const actionRows = deps.db.withReadConnection((db) =>
      deps.actionRepo.listByUser(db, {
        userId: input.userId,
        limit: 200,
      }),
    );
    const rejectedActionIds = actionRows
      .filter((action) => action.status === "rejected")
      .map((action) => action.actionId);
    const approvalsByActionId = new Map(
      deps.db.withReadConnection((db) => deps.approvalRepo.listByActionIds(db, rejectedActionIds))
        .map((approval) => [approval.actionId, approval] as const),
    );
    const rejectedFixes = actionRows
      .filter((action) => action.status === "rejected")
      .slice(0, limit)
      .map((action): FridayRejectedFixRecord => {
        const approval = approvalsByActionId.get(action.actionId);
        return {
          actionId: action.actionId,
          incidentId: action.incidentId,
          title: action.plan.title,
          fingerprint: action.plan.evidence.fingerprint,
          ...(approval?.responseReason ? { reason: approval.responseReason } : {}),
          createdAt: action.createdAt,
          updatedAt: action.updatedAt,
        };
      });

    const rollbackHotspotMap = new Map<string, FridayRollbackHotspotRecord>();
    for (const action of actionRows) {
      const fingerprint = action.plan.evidence.fingerprint;
      const current = rollbackHotspotMap.get(fingerprint) ?? {
        fingerprint,
        rolledBackCount: 0,
        appliedCount: 0,
        rejectedCount: 0,
        totalCount: 0,
        lastSeenAt: action.updatedAt,
      };
      current.totalCount += 1;
      if (action.status === "rolled_back") {
        current.rolledBackCount += 1;
      } else if (action.status === "applied") {
        current.appliedCount += 1;
      } else if (action.status === "rejected") {
        current.rejectedCount += 1;
      }
      if (action.updatedAt > current.lastSeenAt) {
        current.lastSeenAt = action.updatedAt;
      }
      rollbackHotspotMap.set(fingerprint, current);
    }
    const rollbackHotspots = [...rollbackHotspotMap.values()]
      .filter((item) => item.rolledBackCount > 0 || item.rejectedCount > 0)
      .sort((left, right) =>
        (right.rolledBackCount + right.rejectedCount) - (left.rolledBackCount + left.rejectedCount)
      )
      .slice(0, limit);

    const recentDecisionDiffs = deps.db.withReadConnection((db) =>
      db.prepare(
        `SELECT id, created_at, provider_id, model, task_profile_json, actual_execution_json
         FROM friday_agent_runs
         WHERE actual_execution_json IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(limit * 5) as Array<{
        id: string;
        created_at: string;
        provider_id: string | null;
        model: string | null;
        task_profile_json: string | null;
        actual_execution_json: string | null;
      }>,
    )
      .map((row): FridayRouteDecisionDiffRecord | null => {
        const actualExecution = safeJsonParse<Record<string, unknown>>(row.actual_execution_json);
        const routeDecisionTrace = safeJsonParse<FridayProviderRoutingDecisionTrace>(
          typeof actualExecution?.routeDecisionTrace === "string"
            ? actualExecution.routeDecisionTrace
            : JSON.stringify(actualExecution?.routeDecisionTrace ?? null),
        );
        if (!routeDecisionTrace || typeof routeDecisionTrace !== "object") {
          return null;
        }
        const taskProfile = safeJsonParse<Record<string, unknown>>(row.task_profile_json);
        const selectedBeforeLearning = routeDecisionTrace.selectedBeforeLearning;
        const selectedAfterLearning = routeDecisionTrace.selectedAfterLearning;
        const matchedLessonIds = Array.from(
          new Set(
            (routeDecisionTrace.candidateScores ?? []).flatMap((candidate) => candidate.matchedLessonIds ?? []),
          ),
        );
        const matchedPatternIds = Array.from(
          new Set(
            (routeDecisionTrace.candidateScores ?? []).flatMap((candidate) => candidate.matchedPatternIds ?? []),
          ),
        );
        return {
          runId: row.id,
          createdAt: row.created_at,
          ...(typeof taskProfile?.id === "string" ? { taskProfileId: taskProfile.id } : {}),
          ...(typeof actualExecution?.requestedProviderId === "string"
            ? { requestedProviderId: actualExecution.requestedProviderId }
            : {}),
          ...(typeof actualExecution?.requestedModel === "string"
            ? { requestedModel: actualExecution.requestedModel }
            : {}),
          ...(typeof actualExecution?.actualProviderId === "string"
            ? { actualProviderId: actualExecution.actualProviderId }
            : {}),
          ...(typeof actualExecution?.actualModel === "string"
            ? { actualModel: actualExecution.actualModel }
            : {}),
          ...(typeof routeDecisionTrace.reasonCode === "string" ? { reasonCode: routeDecisionTrace.reasonCode } : {}),
          ...(typeof routeDecisionTrace.reasonText === "string" ? { reasonText: routeDecisionTrace.reasonText } : {}),
          learningAdjusted: routeDecisionTrace.learningAdjusted === true,
          learningSignalsPresent: routeDecisionTrace.learningSignalsPresent === true,
          ...(selectedBeforeLearning ? { selectedBeforeLearning } : {}),
          ...(selectedAfterLearning ? { selectedAfterLearning } : {}),
          matchedLessonIds,
          matchedPatternIds,
          trace: routeDecisionTrace,
        };
      })
      .filter((record): record is FridayRouteDecisionDiffRecord => record != null)
      .slice(0, limit);

    const blockedRouteMap = new Map<string, FridayBlockedRouteRecord>();
    for (const diff of recentDecisionDiffs) {
      for (const candidate of diff.trace.candidateScores) {
        if (candidate.eligible || candidate.ineligibilityReasons.length === 0) {
          continue;
        }
        const key = [
          diff.taskProfileId ?? "global",
          candidate.providerId,
          candidate.model,
          candidate.backendKind,
          candidate.ineligibilityReasons.join(","),
        ].join("::");
        const existing = blockedRouteMap.get(key) ?? {
          ...(diff.taskProfileId ? { taskProfileId: diff.taskProfileId } : {}),
          providerId: candidate.providerId,
          model: candidate.model,
          backendKind: candidate.backendKind,
          reasons: [...candidate.ineligibilityReasons],
          count: 0,
          lastSeenAt: diff.createdAt,
        };
        existing.count += 1;
        if (diff.createdAt > existing.lastSeenAt) {
          existing.lastSeenAt = diff.createdAt;
        }
        blockedRouteMap.set(key, existing);
      }
    }
    const blockedRoutes = [...blockedRouteMap.values()]
      .sort((left, right) => right.count - left.count || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit);

    const incidentCount = deps.db.withReadConnection((db) =>
      db.prepare(`SELECT COUNT(*) AS count FROM error_incidents WHERE user_id = ?`).get(input.userId) as { count: number },
    ).count;
    const diagnosisCount = deps.db.withReadConnection((db) =>
      db.prepare(`SELECT COUNT(*) AS count FROM diagnosis_records`).get() as { count: number },
    ).count;
    const actionCount = deps.db.withReadConnection((db) =>
      db.prepare(`SELECT COUNT(*) AS count FROM auto_fix_actions WHERE user_id = ?`).get(input.userId) as { count: number },
    ).count;

    return {
      lessons,
      patterns,
      routeAdjustments,
      routeBiases,
      operatorPins,
      penaltyFacts,
      recentDecisionDiffs,
      blockedRoutes,
      rejectedFixes,
      recentRejectedFixes: rejectedFixes,
      rollbackHotspots,
      coverage: {
        lessons: lessons.length,
        patterns: patterns.length,
        routeAdjustments: routeAdjustments.length,
        recentDecisionDiffs: recentDecisionDiffs.length,
        blockedRoutes: blockedRoutes.length,
        rejectedFixes: rejectedFixes.length,
        rollbackHotspots: rollbackHotspots.length,
        incidents: incidentCount,
        diagnoses: diagnosisCount,
        autoFixActions: actionCount,
      },
    };
  };

  return {
    listIncidents(input) {
      const incidents = deps.db.withReadConnection((db) =>
        deps.incidentRepo.listByUser(db, {
          userId: input.userId,
          status: input.status,
          limit: input.limit,
        }),
      );
      return incidents.map(buildIncidentDetails);
    },

    getIncident(input) {
      const incident = deps.db.withReadConnection((db) =>
        deps.incidentRepo.getById(db, input.incidentId),
      );
      return incident ? buildIncidentDetails(incident) : null;
    },

    getIncidentDiagnosis(input) {
      const incident = deps.db.withReadConnection((db) =>
        deps.incidentRepo.getById(db, input.incidentId),
      );
      return incident ? buildIncidentDetails(incident) : null;
    },

    listActions(input) {
      const actions = deps.db.withReadConnection((db) =>
        deps.actionRepo.listByUser(db, {
          userId: input.userId,
          status: input.status,
          incidentId: input.incidentId,
          limit: input.limit,
        }),
      );
      return actions.map(buildActionDetails);
    },

    getAction(input) {
      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, input.actionId),
      );
      return action ? buildActionDetails(action) : null;
    },

    async approveAction(input) {
      const approval = deps.db.withReadConnection((db) =>
        deps.approvalRepo.getByActionId(db, input.actionId),
      );
      if (!approval) {
        throw new FridayDomainError("NOT_FOUND", `Approval request not found for action ${input.actionId}`, { httpStatus: 404 });
      }
      await deps.approvalService.approve({
        requestId: approval.requestId,
        respondedBy: input.respondedBy,
        reason: input.reason,
        nowIso: deps.nowIso(),
      });
      const details = this.getAction({ actionId: input.actionId });
      if (!details) {
        throw new FridayDomainError("NOT_FOUND", `Action ${input.actionId} not found after approval`, { httpStatus: 404 });
      }
      emitActionEvent("autofix.action.approved", details, approval.requestId);
      await deps.observability?.recordAutoFixActionEvent({
        event: "autofix.action.approved",
        details,
        actor: { type: "user", id: input.respondedBy, displayName: input.respondedBy },
        description: `Approved auto-fix action ${details.action.actionId}`,
      });
      await deps.agentLoop?.syncAction({
        actionId: details.action.actionId,
        correlationId: approval.requestId,
      });
      return details;
    },

    async denyAction(input) {
      const approval = deps.db.withReadConnection((db) =>
        deps.approvalRepo.getByActionId(db, input.actionId),
      );
      if (!approval) {
        throw new FridayDomainError("NOT_FOUND", `Approval request not found for action ${input.actionId}`, { httpStatus: 404 });
      }
      await deps.approvalService.reject({
        requestId: approval.requestId,
        respondedBy: input.respondedBy,
        reason: input.reason,
        nowIso: deps.nowIso(),
      });
      const details = this.getAction({ actionId: input.actionId });
      if (!details) {
        throw new FridayDomainError("NOT_FOUND", `Action ${input.actionId} not found after rejection`, { httpStatus: 404 });
      }
      emitActionEvent("autofix.action.rejected", details, approval.requestId);
      await deps.observability?.recordAutoFixActionEvent({
        event: "autofix.action.rejected",
        details,
        actor: { type: "user", id: input.respondedBy, displayName: input.respondedBy },
        description: `Rejected auto-fix action ${details.action.actionId}`,
      });
      if (details.incident) {
        const context = details.incident.context;
        emitLearningEvent(
          {
            userId: details.incident.userId,
            runId: details.incident.runId,
            kind: "outcome_confirmed",
            details: {
              type: "autofix_rejected",
              actionId: details.action.actionId,
              incidentId: details.incident.incidentId,
              fingerprint: details.action.plan.evidence.fingerprint,
              reasonCode: input.reasonCode,
              reason: input.reason,
              taskProfileId:
                typeof context.taskProfileId === "string" ? context.taskProfileId : undefined,
              actualProviderId:
                typeof context.actualProviderId === "string" ? context.actualProviderId : undefined,
              actualModel:
                typeof context.actualModel === "string" ? context.actualModel : undefined,
              backendKind:
                typeof context.backendKind === "string" ? context.backendKind : undefined,
            },
          },
          approval.requestId,
        );
      }
      await deps.agentLoop?.syncAction({
        actionId: details.action.actionId,
        correlationId: approval.requestId,
      });
      return details;
    },

    manualResolveIncident(input) {
      const incident = deps.db.withReadConnection((db) =>
        deps.incidentRepo.getById(db, input.incidentId),
      );
      if (!incident) {
        throw new FridayDomainError("DIAGNOSIS_INCIDENT_NOT_FOUND", `Incident ${input.incidentId} not found`, { httpStatus: 404 });
      }

      const nowIso = deps.nowIso();
      const diagnosis = deps.db.withReadConnection((db) =>
        deps.diagnosisRepo.getLatestByIncidentId(db, incident.incidentId),
      );

      const rejectedActionIds = deps.db.withWriteTransaction((db) => {
        const actions = deps.actionRepo.listByUser(db, {
          userId: incident.userId,
          incidentId: incident.incidentId,
          limit: 100,
        });
        const plannedActions = actions.filter((action) => action.status === "planned");
        for (const action of plannedActions) {
          deps.actionRepo.markRejected(db, action.actionId, nowIso);
        }

        deps.lessonRepo.upsertByFingerprint(db, {
          id: deps.idGenerator(),
          fingerprint: incident.signature,
          title: input.title ?? `Manual resolution: ${incident.category}`,
          cause: input.cause ?? summarizeRootCause(diagnosis, incident),
          fix: input.fix,
          mitigation: {
            source: "manual_resolved",
            resolvedBy: input.resolvedBy,
            ...(input.verificationSummary ? { verificationSummary: input.verificationSummary } : {}),
            rejectedActionIds: plannedActions.map((action) => action.actionId),
          },
          sourceIncidentId: incident.incidentId,
          sourceDiagnosisId: diagnosis?.id,
          nowIso,
        });

        deps.incidentRepo.updateStatus(db, incident.incidentId, "resolved", nowIso);
        if (diagnosis) {
          deps.diagnosisRepo.markResolved(db, diagnosis.id, nowIso);
        }
        return plannedActions.map((action) => action.actionId);
      });

      emitLearningEvent(
        {
          userId: incident.userId,
          runId: incident.runId,
          kind: "outcome_confirmed",
          details: {
            type: "manual_resolved",
            incidentId: incident.incidentId,
            fingerprint: incident.signature,
            resolvedBy: input.resolvedBy,
            fix: input.fix,
            cause: input.cause ?? summarizeRootCause(diagnosis, incident),
            verificationSummary: input.verificationSummary,
            rejectedActionIds,
          },
        },
        incident.incidentId,
      );

      deps.publishEvent?.publish(
        diagnosisStreamId(incident.userId),
        "diagnosis.incident.resolved",
        {
          incidentId: incident.incidentId,
          userId: incident.userId,
          runId: incident.runId,
          status: "resolved",
        },
        incident.incidentId,
      );

      const details = this.getIncident({ incidentId: incident.incidentId });
      if (!details) {
        throw new FridayDomainError("DIAGNOSIS_INCIDENT_NOT_FOUND", `Incident ${incident.incidentId} not found after manual resolution`, { httpStatus: 404 });
      }
      return details;
    },

    getLearningOverview(input) {
      return buildLearningOverview(input);
    },

    setLessonEnabled(input) {
      const overview = buildLearningOverview({ userId: input.userId, limit: 500 });
      const lessonRecord = overview.lessons.find((item) => item.lesson.id === input.lessonId);
      if (!lessonRecord) {
        throw new FridayDomainError("DIAGNOSIS_LESSON_NOT_FOUND", `Lesson ${input.lessonId} not found`, {
          httpStatus: 404,
        });
      }
      const key = `lesson_disabled:${input.lessonId}`;
      deps.db.withWriteTransaction((db) => {
        if (input.enabled) {
          deps.factRepo.deleteByUserAndKey(db, input.userId, key);
        } else {
          deps.factRepo.upsert(db, {
            factId: deps.idGenerator(),
            userId: input.userId,
            key,
            value: {
              disabled: true,
              ...(input.reason ? { reason: input.reason } : {}),
            },
            confidence: 1,
            evidenceCountDelta: 1,
            lastConfirmedAt: deps.nowIso(),
            sourceEventId: `operator:lesson:${deps.idGenerator()}`,
            nowIso: deps.nowIso(),
          });
        }
      });
      return {
        ...lessonRecord,
        disabled: !input.enabled,
        ...(input.enabled ? {} : input.reason ? { disabledReason: input.reason } : {}),
      };
    },

    demotePattern(input) {
      const overview = buildLearningOverview({ userId: input.userId, limit: 500 });
      const patternRecord = overview.patterns.find((item) => item.patternId === input.patternId);
      if (!patternRecord) {
        throw new FridayDomainError("DIAGNOSIS_PATTERN_NOT_FOUND", `Pattern ${input.patternId} not found`, {
          httpStatus: 404,
        });
      }
      const factor = Math.max(0, Math.min(1, input.factor));
      deps.db.withWriteTransaction((db) => {
        deps.factRepo.upsert(db, {
          factId: deps.idGenerator(),
          userId: input.userId,
          key: `pattern_demotion:${input.patternId}`,
          value: {
            factor,
            ...(input.reason ? { reason: input.reason } : {}),
          },
          confidence: 1,
          evidenceCountDelta: 1,
          lastConfirmedAt: deps.nowIso(),
          sourceEventId: `operator:pattern:${deps.idGenerator()}`,
          nowIso: deps.nowIso(),
        });
      });
      return {
        ...patternRecord,
        demoted: true,
        demotionFactor: factor,
        ...(input.reason ? { demotionReason: input.reason } : {}),
      };
    },

    async executeAction(input) {
      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, input.actionId),
      );
      if (!action) {
        throw new FridayDomainError("NOT_FOUND", `Action ${input.actionId} not found`, { httpStatus: 404 });
      }

      let result: FridayAutoFixExecutionResult;
      if (action.riskTier >= 2) {
        result = await deps.autoFixDispatcher.runApprovedAction(action.actionId);
      } else {
        result = await deps.executionService.execute(action.actionId);
      }

      const details = buildActionDetails(result.action);
      emitActionEvent("autofix.action.executed", details, action.actionId);
      await deps.observability?.recordAutoFixActionEvent({
        event: "autofix.action.executed",
        details,
        actor: { type: "system", id: "self-healing", displayName: "Friday Self-Healing" },
        description: `Executed auto-fix action ${details.action.actionId}`,
      });
      await deps.agentLoop?.syncAction({
        actionId: details.action.actionId,
        correlationId: details.action.actionId,
      });
      return details;
    },

    async rollbackAction(input) {
      const result = await deps.rollbackService.rollback(input.actionId, input.reason);
      const details = buildActionDetails(result.action);
      emitActionEvent("autofix.action.rolled_back", details, input.actionId);
      await deps.observability?.recordAutoFixActionEvent({
        event: "autofix.action.rolled_back",
        details,
        actor: { type: "system", id: "self-healing", displayName: "Friday Self-Healing" },
        description: `Rolled back auto-fix action ${details.action.actionId}`,
      });
      await deps.agentLoop?.syncAction({
        actionId: details.action.actionId,
        correlationId: input.actionId,
      });
      return details;
    },

    getMetrics(input) {
      if (input.fromDay && input.toDay) {
        return deps.metricsService.aggregateRange(input.fromDay, input.toDay);
      }
      return deps.metricsService.aggregateDay(
        input.day ?? deps.nowIso().slice(0, 10),
      );
    },

    listIssueCards(input) {
      const approvals = deps.db.withReadConnection((db) =>
        deps.approvalRepo.listPending(db, {
          userId: input.userId,
          limit: input.limit,
        }),
      );
      const incidents = deps.db.withReadConnection((db) =>
        deps.incidentRepo.listByUser(db, {
          userId: input.userId,
          status: "open",
          limit: input.limit,
        }),
      );
      const cards: FridaySelfHealingIssueCard[] = [];

      for (const approval of approvals) {
        const action = deps.db.withReadConnection((db) =>
          deps.actionRepo.getById(db, approval.actionId),
        );
        const incident = action
          ? deps.db.withReadConnection((db) => deps.incidentRepo.getById(db, action.incidentId))
          : null;
        cards.push({
          id: `approval:${approval.requestId}`,
          kind: "approval_required",
          incidentId: action?.incidentId ?? approval.actionId,
          actionId: action?.actionId,
          approvalRequestId: approval.requestId,
          title: action?.plan.title ?? "Approval required",
          summary: approval.description,
          severity: incident?.severity ?? "high",
          status: approval.status,
          createdAt: approval.requestedAt,
          routeTarget: "/assistant",
        });
      }

      for (const incident of incidents) {
        cards.push({
          id: `incident:${incident.incidentId}`,
          kind: "incident",
          incidentId: incident.incidentId,
          title: `Issue detected in ${incident.category}`,
          summary: incident.signature,
          severity: incident.severity,
          status: incident.status,
          createdAt: incident.createdAt,
          routeTarget: "/assistant",
        });
      }

      const failedActions = deps.db.withReadConnection((db) =>
        deps.actionRepo.listByUser(db, {
          userId: input.userId,
          status: "rolled_back",
          limit: input.limit,
        }),
      );
      for (const action of failedActions) {
        cards.push({
          id: `failed-fix:${action.actionId}`,
          kind: "failed_fix",
          incidentId: action.incidentId,
          actionId: action.actionId,
          title: action.plan.title,
          summary: "A previous remediation attempt rolled back",
          severity: "high",
          status: action.status,
          createdAt: action.updatedAt,
          routeTarget: "/assistant",
        });
      }

      return cards
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, input.limit ?? 25);
    },

    reportStructuredFailure(input) {
      const result = deps.pipeline.processEvent({
        eventId: deps.idGenerator(),
        ts: deps.nowIso(),
        userId: input.userId,
        runId: input.runId,
        kind: "error_incident",
        payload: {
          category: input.category,
          severity: input.severity,
          message: input.message,
          ...(input.context ?? {}),
        },
      });
      this.emitProcessResults([result], input.correlationId);
      return result;
    },

    emitProcessResults(results, correlationId) {
      deps.observability?.recordSelfHealingProcessResults({ results, correlationId });
      for (const result of results) {
        for (const incident of result.incidentsCreated) {
          deps.publishEvent?.publish(
            diagnosisStreamId(incident.userId),
            "diagnosis.incident.opened",
            {
              incidentId: incident.incidentId,
              userId: incident.userId,
              runId: incident.runId,
              category: incident.category,
              severity: incident.severity,
              signature: incident.signature,
              status: incident.status,
            },
            correlationId,
          );
        }

        for (const diagnosis of result.diagnosisCreated) {
          deps.publishEvent?.publish(
            diagnosisStreamId(result.incidentsCreated[0]?.userId ?? "unknown"),
            "diagnosis.recorded",
            {
              diagnosisId: diagnosis.id,
              incidentId: diagnosis.incidentId,
              confidence: diagnosis.confidence,
              errorFingerprint: diagnosis.errorFingerprint,
            },
            correlationId,
          );
        }

        for (const incident of result.incidentsCreated) {
          const plannedActions = deps.db.withReadConnection((db) =>
            deps.actionRepo.listByUser(db, {
              userId: incident.userId,
              incidentId: incident.incidentId,
              limit: 5,
            }),
          );
          for (const action of plannedActions) {
            const details = buildActionDetails(action);
            emitActionEvent("autofix.action.planned", details, correlationId);
            if (details.approval?.status === "pending") {
              emitActionEvent("autofix.action.pending_approval", details, details.approval.requestId);
            }
          }
        }
      }
      if (deps.agentLoop) {
        void deps.agentLoop.handleProcessResults({ results, correlationId }).catch((error) => {
          console.warn("[friday] agent loop processing failed", error);
        });
      }
    },
  };
}
