import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestStatus,
  FridayAutoFixActionEntity,
  FridayAutoFixExecutionResult,
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
  }): Promise<FridaySelfHealingActionDetails>;
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
      await deps.agentLoop?.syncAction({
        actionId: details.action.actionId,
        correlationId: approval.requestId,
      });
      return details;
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
