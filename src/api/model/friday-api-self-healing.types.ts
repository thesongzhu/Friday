import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestStatus,
  FridayAutoFixActionEntity,
  FridayAutoFixActionStatus,
  FridayAutoFixOutcome,
  FridayAutoFixRiskTier,
} from "#learning";
import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearningMetricsEntity,
} from "#learning";

export interface FridayDiagnosisSummary {
  incidentId: string;
  loopRunId?: string;
  diagnosisId?: string;
  confidence?: number;
  rootCauseSummary: string;
  matchedLessonIds: string[];
  suggestedFixes: string[];
  recurrenceCount: number;
  autoFixEligible: boolean;
  createdAt?: string;
}

export interface FridayFixPlanSummary {
  actionId: string;
  incidentId: string;
  loopRunId?: string;
  title: string;
  summary: string;
  riskTier: FridayAutoFixRiskTier;
  status: FridayAutoFixActionStatus;
  outcome: FridayAutoFixOutcome;
  requiresApproval: boolean;
  autoApplyAllowed: boolean;
  rollbackPlanAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FridayFixExecutionEvidence {
  rootCauseSummary: string;
  selectedPlan: {
    title: string;
    summary: string;
    stepCount: number;
    rollbackPlanAvailable: boolean;
  };
  riskTier: FridayAutoFixRiskTier;
  approvalTrail?: {
    requestId: string;
    status: FridayApprovalRequestStatus;
    respondedAt?: string;
    respondedBy?: string;
    reason?: string;
  };
  executionResult: {
    status: FridayAutoFixActionStatus;
    outcome: FridayAutoFixOutcome;
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
}

export interface FridayIssueCard {
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

export interface FridayDiagnosisIncidentRecord {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity | null;
  summary: FridayDiagnosisSummary;
  action?: FridayFixPlanRecord | null;
}

export interface FridayFixPlanRecord {
  action: FridayAutoFixActionEntity;
  summary: FridayFixPlanSummary;
  approval: FridayApprovalRequestEntity | null;
  evidence: FridayFixExecutionEvidence;
}

export interface FridayListDiagnosisIncidentsResponse {
  items: FridayDiagnosisIncidentRecord[];
}

export interface FridayGetDiagnosisIncidentResponse extends FridayDiagnosisIncidentRecord {}

export interface FridayGetIncidentDiagnosisResponse {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity | null;
  summary: FridayDiagnosisSummary;
  action?: FridayFixPlanRecord | null;
}

export interface FridayListAutoFixActionsResponse {
  items: FridayFixPlanRecord[];
}

export interface FridayGetAutoFixActionResponse extends FridayFixPlanRecord {}

export interface FridayAutoFixApprovalResponse {
  approval: FridayApprovalRequestEntity | null;
  action: FridayFixPlanRecord;
}

export interface FridayAutoFixExecutionResponse {
  action: FridayFixPlanRecord;
}

export interface FridayAutoFixMetricsResponse {
  metrics: FridayLearningMetricsEntity | FridayLearningMetricsEntity[];
}
