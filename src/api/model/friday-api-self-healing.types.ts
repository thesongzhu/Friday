import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestStatus,
  FridayAutoFixActionEntity,
  FridayAutoFixActionStatus,
  FridayAutoFixOutcome,
  FridayAutoFixRepairOutcome,
  FridayAutoFixRiskTier,
  FridaySelfHealingRunReadySkipReason,
} from "#learning";
import type {
  FridayBlockedRouteRecord,
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearningCoverageSummary,
  FridayLearningLessonRecord,
  FridayLearningMetricsEntity,
  FridayLearningOverview,
  FridayLearningPatternRecord,
  FridayLearningRouteAdjustmentRecord,
  FridayLearningRouteBiasRecord,
  FridayRejectedFixRecord,
  FridayRollbackHotspotRecord,
  FridayRouteDecisionDiffRecord,
} from "#learning";
import type { FridayProviderRoutingExplainReport } from "#providers";

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
    /** Phase 14.5B module_28b: real changed-state classification. */
    repairOutcome: FridayAutoFixRepairOutcome;
    /** Phase 14.5B module_28b: config keys actually changed (apply_config_patch). */
    changedKeys?: string[];
  };
  rollbackResult: {
    available: boolean;
    rolledBackAt?: string;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
    rollbackAttemptedAt?: string;
    rollbackErrorMessage?: string;
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
  result: {
    success: boolean;
    verificationPassed: boolean;
    rollbackAttempted: boolean;
    rollbackSucceeded: boolean;
    errorMessage?: string;
  };
}

export interface FridayAutoFixRunReadyResponse {
  summary: {
    inspected: number;
    executed: number;
    succeeded: number;
    failed: number;
    requiresApproval: number;
    blockedByPolicy: number;
    notReady: number;
    dataProtected: true;
    maxRiskTier: 0 | 1;
    limit: number;
  };
  executed: FridayAutoFixExecutionResponse[];
  skipped: Array<{
    action: FridayFixPlanRecord;
    reason: FridaySelfHealingRunReadySkipReason;
    reasonText: string;
  }>;
}

export interface FridayAutoFixMetricsResponse {
  metrics: FridayLearningMetricsEntity | FridayLearningMetricsEntity[];
}

export interface FridayGetLearningOverviewResponse extends FridayLearningOverview {}

export interface FridaySetLessonEnabledResponse {
  lesson: FridayLearningLessonRecord;
}

export interface FridayDemotePatternResponse {
  pattern: FridayLearningPatternRecord;
}

export interface FridayPinRouteRequest {
  taskProfileId?: string;
  providerId: string;
  model: string;
  backendKind: "http" | "cli" | "sdk";
  reason?: string;
}

export type FridayProviderRoutingExplainResponse = FridayProviderRoutingExplainReport;

export interface FridayRouteAdjustmentRecord extends FridayLearningRouteAdjustmentRecord {}
export interface FridayRouteBiasRecord extends FridayLearningRouteBiasRecord {}
export interface FridayBlockedRouteListRecord extends FridayBlockedRouteRecord {}
export interface FridayRejectedFixListRecord extends FridayRejectedFixRecord {}
export interface FridayRollbackHotspotListRecord extends FridayRollbackHotspotRecord {}
export interface FridayRouteDecisionDiffListRecord extends FridayRouteDecisionDiffRecord {}
export interface FridayLearningCoverageRecord extends FridayLearningCoverageSummary {}
