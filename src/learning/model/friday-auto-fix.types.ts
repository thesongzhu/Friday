import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
} from "./friday-learning.types.js";
import type { FridayUtilityResult } from "../services/friday-expected-utility-calculator.js";

export type FridayAutoFixRiskTier = 0 | 1 | 2;
export type FridayAutoFixActionStatus = "planned" | "applied" | "rolled_back" | "rejected";
export type FridayAutoFixOutcome = "success" | "failed" | null;
export type FridayApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type FridayAutoFixFeedbackReasonCode =
  | "wrong_root_cause"
  | "too_risky"
  | "wrong_fix"
  | "insufficient_evidence"
  | "wrong_model_or_backend_choice";

export type FridayAutoFixStepKind =
  | "retry_node"
  | "switch_model_fallback"
  | "trim_payload"
  | "apply_config_patch"
  | "grant_permission"
  | "disable_skill"
  | "pause_workflow"
  | "regenerate_skill";

export interface FridayAutoFixPlanStep {
  stepId: string;
  kind: FridayAutoFixStepKind;
  target: string;
  payload: JsonValue;
  verify?: {
    method: "node_retry_success" | "config_reload_valid" | "error_absent" | "skill_registry_available";
    timeoutMs: number;
  };
}

export interface FridayAutoFixRollbackStep {
  stepId: string;
  kind: FridayAutoFixStepKind;
  target: string;
  payload: JsonValue;
}

export interface FridayAutoFixPlan {
  title: string;
  summary: string;
  steps: FridayAutoFixPlanStep[];
  rollbackPlan?: {
    summary: string;
    steps: FridayAutoFixRollbackStep[];
  };
  evidence: {
    fingerprint: string;
    matchedLessonIds: string[];
    diagnosisId: string;
    recurrenceCount: number;
  };
}

export interface FridayAutoFixActionRow {
  action_id: string;
  incident_id: string;
  user_id: string;
  risk_tier: 0 | 1 | 2;
  plan_json: string;
  rollback_plan_json: string | null;
  status: "planned" | "applied" | "rolled_back" | "rejected";
  outcome: "success" | "failed" | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayAutoFixActionEntity {
  actionId: UUID;
  incidentId: UUID;
  userId: UUID;
  riskTier: FridayAutoFixRiskTier;
  plan: FridayAutoFixPlan;
  rollbackPlan?: FridayAutoFixPlan["rollbackPlan"];
  status: FridayAutoFixActionStatus;
  outcome: FridayAutoFixOutcome;
  appliedAt?: ISODateTime;
  rolledBackAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayApprovalRequestRow {
  request_id: string;
  action_id: string;
  run_id: string | null;
  user_id: string;
  description: string;
  risk_tier: 2;
  plan_json: string;
  requested_at: string;
  expires_at: string;
  status: "pending" | "approved" | "rejected" | "expired";
  response_reason: string | null;
  responded_at: string | null;
  responded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayApprovalRequestEntity {
  requestId: UUID;
  actionId: UUID;
  runId?: UUID;
  userId: UUID;
  description: string;
  riskTier: 2;
  plan: FridayAutoFixPlan;
  requestedAt: ISODateTime;
  expiresAt: ISODateTime;
  status: FridayApprovalRequestStatus;
  responseReason?: string;
  respondedAt?: ISODateTime;
  respondedBy?: UUID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayDiagnosisOutcome {
  diagnosis: FridayDiagnosisRecordEntity;
  matchedLessons: FridayLearnedLessonEntity[];
  recurrenceCount: number;
  autoFixEligible: boolean;
  candidatePlans: FridayAutoFixPlan[];
}

export interface FridayRiskAssessment {
  riskTier: FridayAutoFixRiskTier;
  reasons: string[];
  requiresApproval: boolean;
  autoApplyAllowed: boolean;
  /** Expected utility analysis (when available). Informational — does not change existing decisions. */
  utilityResult?: FridayUtilityResult;
}

export interface FridayAutoFixExecutionResult {
  action: FridayAutoFixActionEntity;
  success: boolean;
  verificationPassed: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  errorMessage?: string;
}

export interface FridayAutoFixPipelineResult {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity;
  action?: FridayAutoFixActionEntity;
  approvalRequest?: FridayApprovalRequestEntity;
  execution?: FridayAutoFixExecutionResult;
  lessonUpdated?: FridayLearnedLessonEntity;
}
