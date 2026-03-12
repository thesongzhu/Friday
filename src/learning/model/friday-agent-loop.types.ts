import type { ISODateTime, UUID } from "./friday-learning.types.js";
import type { FridayAutoFixRiskTier } from "./friday-auto-fix.types.js";

export type FridayAgentLoopPolicyMode = "tiered_supervised";

export type FridayExpertAutonomyRiskClass =
  | "safe_probe"
  | "bounded_repair"
  | "destructive_or_sensitive";

export type FridayAgentLoopRunStatus =
  | "awaiting_approval"
  | "running"
  | "verified"
  | "rolled_back"
  | "failed"
  | "halted"
  | "paused"
  | "cancelled"
  | "cooldown";

export type FridayAgentLoopTrigger =
  | "incident_opened"
  | "approval_granted"
  | "manual_resume"
  | "cooldown_elapsed"
  | "repeated_failure_alert";

export type FridayAgentLoopHaltReason =
  | "policy_paused"
  | "approval_required"
  | "missing_rollback_plan"
  | "missing_acceptance_check"
  | "failure_budget_exhausted"
  | "verification_failed"
  | "execution_failed"
  | "action_rejected"
  | "probe_budget_exhausted"
  | "manual_pause"
  | "manual_cancel";

export interface FridayExpertAutonomyHypothesis {
  id: string;
  summary: string;
  confidence: number;
  validationCost: "low" | "medium" | "high";
  supportingEvidence: string[];
  status: "candidate" | "validated" | "discarded" | "chosen";
}

export interface FridayExpertAutonomyProbeStep {
  id: string;
  title: string;
  kind:
    | "read_only_inspection"
    | "dry_run"
    | "sandbox_check"
    | "temporary_execution"
    | "simulation";
  summary: string;
  safe: boolean;
  status: "planned" | "completed" | "skipped" | "blocked";
  evidence?: string;
}

export interface FridayExpertAutonomyEvidence {
  objective: string;
  planSummary: string;
  assumptions: string[];
  unknowns: string[];
  hypotheses: FridayExpertAutonomyHypothesis[];
  probeSteps: FridayExpertAutonomyProbeStep[];
  evidenceGathered: string[];
  repairAttempted?: string;
  acceptanceOutcome?: string;
  rollbackOutcome?: string;
}

export interface FridayAgentLoopPolicyRow {
  id: string;
  mode: FridayAgentLoopPolicyMode;
  paused: number;
  auto_apply_low_risk: number;
  max_attempts_per_fingerprint: number;
  cooldown_minutes: number;
  require_rollback_plan: number;
  require_acceptance_check: number;
  expert_mode_enabled: number;
  expert_mode_user_ids_json: string | null;
  expert_mode_workspace_ids_json: string | null;
  expert_mode_environments_json: string | null;
  context_inference_allowed: number;
  multi_step_hypothesis_search_allowed: number;
  safe_probe_execution_allowed: number;
  cross_surface_orchestration_allowed: number;
  high_risk_final_approval_required: number;
  production_destructive_action_approval_required: number;
  probe_budget: number;
  time_budget_minutes: number;
  updated_at: string;
}

export interface FridayAgentLoopPolicyEntity {
  id: string;
  mode: FridayAgentLoopPolicyMode;
  paused: boolean;
  autoApplyLowRisk: boolean;
  maxAttemptsPerFingerprint: number;
  cooldownMinutes: number;
  requireRollbackPlan: boolean;
  requireAcceptanceCheck: boolean;
  expertModeEnabled: boolean;
  expertModeUserIds: string[];
  expertModeWorkspaceIds: string[];
  expertModeEnvironments: string[];
  contextInferenceAllowed: boolean;
  multiStepHypothesisSearchAllowed: boolean;
  safeProbeExecutionAllowed: boolean;
  crossSurfaceOrchestrationAllowed: boolean;
  highRiskFinalApprovalRequired: boolean;
  productionDestructiveActionApprovalRequired: boolean;
  probeBudget: number;
  timeBudgetMinutes: number;
  updatedAt: ISODateTime;
}

export interface FridayAgentLoopRunRow {
  loop_run_id: string;
  user_id: string;
  incident_id: string;
  action_id: string | null;
  fingerprint: string;
  trigger: FridayAgentLoopTrigger;
  status: FridayAgentLoopRunStatus;
  risk_tier: FridayAutoFixRiskTier;
  approval_required: number;
  attempt_number: number;
  verification_passed: number | null;
  rollback_attempted: number;
  rollback_succeeded: number;
  halt_reason: FridayAgentLoopHaltReason | null;
  last_error: string | null;
  lesson_id: string | null;
  correlation_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  cancelled_at: string | null;
  cooldown_until: string | null;
  expert_mode_enabled: number;
  risk_class: FridayExpertAutonomyRiskClass | null;
  requires_final_approval: number;
  assumptions_json: string | null;
  unknowns_json: string | null;
  hypotheses_json: string | null;
  probe_steps_json: string | null;
  probe_budget: number | null;
  objective: string | null;
  plan_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayAgentLoopRunEntity {
  loopRunId: UUID;
  userId: UUID;
  incidentId: UUID;
  actionId?: UUID;
  fingerprint: string;
  trigger: FridayAgentLoopTrigger;
  status: FridayAgentLoopRunStatus;
  riskTier: FridayAutoFixRiskTier;
  approvalRequired: boolean;
  attemptNumber: number;
  verificationPassed?: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  haltReason?: FridayAgentLoopHaltReason;
  lastError?: string;
  lessonId?: UUID;
  correlationId?: string;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  pausedAt?: ISODateTime;
  resumedAt?: ISODateTime;
  cancelledAt?: ISODateTime;
  cooldownUntil?: ISODateTime;
  expertModeEnabled: boolean;
  riskClass?: FridayExpertAutonomyRiskClass;
  requiresFinalApproval: boolean;
  assumptions: string[];
  unknowns: string[];
  hypotheses: FridayExpertAutonomyHypothesis[];
  probeSteps: FridayExpertAutonomyProbeStep[];
  probeBudget?: number;
  objective?: string;
  planSummary?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayAgentLoopExpertModeSummary {
  enabled: boolean;
  activeForCurrentRuntime: boolean;
  allowedUserIds: string[];
  allowedWorkspaceIds: string[];
  allowedEnvironments: string[];
  contextInferenceAllowed: boolean;
  multiStepHypothesisSearchAllowed: boolean;
  safeProbeExecutionAllowed: boolean;
  crossSurfaceOrchestrationAllowed: boolean;
  highRiskFinalApprovalRequired: boolean;
  productionDestructiveActionApprovalRequired: boolean;
  probeBudget: number;
  timeBudgetMinutes: number;
}
