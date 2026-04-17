import type {
  FridayDiagnosisIncidentRecord,
  FridayDiagnosisSummary,
  FridayFixPlanRecord,
} from "../../model/friday-api-self-healing.types.js";
import type { FridayDiagnosisRecordEntity } from "../../../learning/model/friday-learning.types.js";
import type {
  FridayIncidentDiagnosisDetails,
  FridaySelfHealingActionDetails,
} from "../../../learning/services/friday-self-healing-api-service.js";

function readSuggestedFixes(details: FridayIncidentDiagnosisDetails): string[] {
  const suggestedFixesRaw = details.diagnosis?.diagnosis["suggestedFixes"];
  return Array.isArray(suggestedFixesRaw)
    ? suggestedFixesRaw.filter((value): value is string => typeof value === "string")
    : [];
}

function readMatchedLessonIds(details: FridayIncidentDiagnosisDetails): string[] {
  const matchedLessonIdsRaw = details.diagnosis?.diagnosis["matchedLessonIds"];
  const matchedLessonIds = Array.isArray(matchedLessonIdsRaw)
    ? matchedLessonIdsRaw.filter((value): value is string => typeof value === "string")
    : [];
  if (matchedLessonIds.length > 0) {
    return matchedLessonIds;
  }
  return details.lesson ? [details.lesson.id] : [];
}

export function toFridayDiagnosisSummary(
  details: FridayIncidentDiagnosisDetails,
  loopRunId?: string,
): FridayDiagnosisSummary {
  return {
    incidentId: details.incident.incidentId,
    loopRunId,
    diagnosisId: details.diagnosis?.id,
    confidence: details.diagnosis?.confidence,
    rootCauseSummary: details.action?.evidence.rootCauseSummary
      ?? (typeof details.diagnosis?.diagnosis["summary"] === "string"
        ? details.diagnosis.diagnosis["summary"]
        : details.incident.signature),
    matchedLessonIds: readMatchedLessonIds(details),
    suggestedFixes: readSuggestedFixes(details),
    recurrenceCount: details.recurrenceCount,
    autoFixEligible: details.autoFixEligible,
    createdAt: details.diagnosis?.createdAt,
  };
}

export function toFridayNormalizedDiagnosisRecord(
  details: FridayIncidentDiagnosisDetails,
): FridayDiagnosisRecordEntity | null {
  if (!details.diagnosis) {
    return null;
  }
  const matchedLessonIds = readMatchedLessonIds(details);
  if (matchedLessonIds.length === 0) {
    return details.diagnosis;
  }

  return {
    ...details.diagnosis,
    diagnosis: {
      ...details.diagnosis.diagnosis,
      matchedLessonIds,
    },
  };
}

export function toFridayFixPlanRecord(
  details: FridaySelfHealingActionDetails,
  loopRunId?: string,
): FridayFixPlanRecord {
  return {
    action: details.action,
    approval: details.approval,
    summary: {
      actionId: details.action.actionId,
      incidentId: details.action.incidentId,
      loopRunId,
      title: details.action.plan.title,
      summary: details.action.plan.summary,
      riskTier: details.action.riskTier,
      status: details.action.status,
      outcome: details.action.outcome,
      requiresApproval: details.risk.requiresApproval,
      autoApplyAllowed: details.risk.autoApplyAllowed,
      rollbackPlanAvailable: details.evidence.selectedPlan.rollbackPlanAvailable,
      createdAt: details.action.createdAt,
      updatedAt: details.action.updatedAt,
    },
    evidence: details.evidence,
  };
}

export function toFridayDiagnosisIncidentRecord(
  details: FridayIncidentDiagnosisDetails,
  input?: {
    incidentLoopRunId?: string;
    actionLoopRunId?: string;
  },
): FridayDiagnosisIncidentRecord {
  return {
    incident: details.incident,
    diagnosis: toFridayNormalizedDiagnosisRecord(details),
    summary: toFridayDiagnosisSummary(details, input?.incidentLoopRunId),
    action: details.action ? toFridayFixPlanRecord(details.action, input?.actionLoopRunId) : null,
  };
}
