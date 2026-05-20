import type {
  FridayRuntimeCapabilityId,
  FridayRuntimeCapabilityMatrix,
  FridayRuntimeCapabilityRepairOption,
  FridayRuntimeCapabilityRisk,
} from "#providers";

export type FridayAutonomyMode = "low_risk_auto" | "max_autonomy";

export type FridayAutonomyRiskCategory =
  | "external_download"
  | "npm_github_install"
  | "mcp_install"
  | "write_config"
  | "shell"
  | "local_file_write"
  | "network_call"
  | "paid_api"
  | "oauth"
  | "api_key"
  | "login"
  | "captcha"
  | "payment"
  | "sensitive_permission"
  | "production_operation";

export type FridayCapabilityCandidateSourceType =
  | "available_runtime"
  | "builtin_catalog"
  | "setup_recipe"
  | "repair_option"
  | "skill_generator"
  | "workflow_generator"
  | "studio_artifact"
  | "mcp_registry"
  | "github"
  | "npm"
  | "openapi"
  | "web_search";

export type FridayCapabilityCandidateTrustTier =
  | "installed"
  | "official"
  | "trusted_local"
  | "generated"
  | "community"
  | "open_internet";

export type FridayCapabilityAcquisitionStatus =
  | "planned"
  | "awaiting_approval"
  | "running"
  | "verified"
  | "failed"
  | "cancelled"
  | "human_blocked";

export type FridayCapabilityVerificationStatus =
  | "not_run"
  | "passed"
  | "failed"
  | "blocked";

export type FridayCapabilityAvailabilityProofTier =
  | "already_available_runtime"
  | "live_runtime_verified"
  | "local_candidate_registered"
  | "blocked_or_unverified";

export interface FridayCapabilityAvailabilityBoundary {
  proofTier: FridayCapabilityAvailabilityProofTier;
  liveRuntimeVerified: boolean;
  localCandidateOnly: boolean;
  summary: string;
}

export interface FridayAutonomyBudgetPolicy {
  maxUsdPerRun?: number;
  maxMinutesPerRun?: number;
  maxNetworkCallsPerRun?: number;
  maxExternalDownloadsPerRun?: number;
}

export interface FridayAutonomyPolicy {
  id: "default";
  mode: FridayAutonomyMode;
  paused: boolean;
  riskSwitches: Record<FridayAutonomyRiskCategory, boolean>;
  budget: FridayAutonomyBudgetPolicy;
  evidenceRetentionDays: number;
  updatedAt: string;
}

export interface FridayAutonomyRiskDecision {
  risks: FridayAutonomyRiskCategory[];
  allowed: boolean;
  approvalRequired: boolean;
  hardHumanBlockers: string[];
  policyBlockers: string[];
}

export interface FridayCapabilityCandidate {
  id: string;
  capability: FridayRuntimeCapabilityId;
  sourceType: FridayCapabilityCandidateSourceType;
  trustTier: FridayCapabilityCandidateTrustTier;
  label: string;
  description: string;
  risks: FridayAutonomyRiskCategory[];
  requiresApproval: boolean;
  requiresHuman: boolean;
  rank: number;
  setupHref?: string;
  href?: string;
  repairOptionId?: string;
  repairOption?: FridayRuntimeCapabilityRepairOption;
}

export interface FridayCapabilityAcquisitionStep {
  id: string;
  title: string;
  action:
    | "use_available"
    | "open_setup"
    | "discover"
    | "generate"
    | "sandbox_verify"
    | "install_register"
    | "doctor_verify"
    | "execute";
  capability?: FridayRuntimeCapabilityId;
  candidateId?: string;
  status: "pending" | "blocked" | "ready" | "done";
  requiresApproval: boolean;
  requiresHuman: boolean;
  detail: string;
}

export interface FridayCapabilityVerificationResult {
  candidateId: string;
  capability: FridayRuntimeCapabilityId;
  status: FridayCapabilityVerificationStatus;
  evidence: string;
  verifiedAt?: string;
  blocker?: string;
  availabilityBoundary?: FridayCapabilityAvailabilityBoundary;
}

export interface FridayRegisteredCapabilityResult {
  capability: FridayRuntimeCapabilityId;
  sourceCandidateId: string;
  registeredAt: string;
  state: "available" | "blocked";
  note: string;
  availabilityBoundary?: FridayCapabilityAvailabilityBoundary;
}

export interface FridayCapabilityExecutionSuggestion {
  canExecute: boolean;
  reason: string;
  requiredCapabilities: FridayRuntimeCapabilityId[];
  nextAction:
    | "execute_task"
    | "approve_run"
    | "complete_human_setup"
    | "cancel_or_replan";
  availabilityBoundary?: FridayCapabilityAvailabilityBoundary;
}

export interface FridayCapabilityAcquisitionRun {
  id: string;
  userId: string;
  goal: string;
  status: FridayCapabilityAcquisitionStatus;
  requiredCapabilities: FridayRuntimeCapabilityId[];
  missingCapabilities: FridayRuntimeCapabilityId[];
  matrixSummary: FridayRuntimeCapabilityMatrix["summary"];
  policySnapshot: FridayAutonomyPolicy;
  candidates: FridayCapabilityCandidate[];
  plan: FridayCapabilityAcquisitionStep[];
  humanBlockers: string[];
  approvalReasons: string[];
  verificationResults: FridayCapabilityVerificationResult[];
  registeredCapabilities: FridayRegisteredCapabilityResult[];
  executionSuggestion: FridayCapabilityExecutionSuggestion;
  createdAt: string;
  updatedAt: string;
}

export interface FridayPlanCapabilityAcquisitionInput {
  userId: string;
  goal: string;
  requiredCapabilities?: FridayRuntimeCapabilityId[];
  readOnly?: boolean;
}

export interface FridayStartCapabilityAcquisitionInput extends FridayPlanCapabilityAcquisitionInput {
  studioArtifactCandidates?: FridayCapabilityCandidate[];
}

export type FridayStandingGoalStatus = "active" | "paused" | "archived";

export interface FridayStandingGoalTrigger {
  kind: "manual" | "schedule" | "monitor" | "event";
  value?: string;
}

export interface FridayStandingGoalScope {
  allowedTopics: string[];
  blockedTopics: string[];
  allowedResources: string[];
  blockedResources: string[];
}

export interface FridayStandingGoalSuccessCriterion {
  id: string;
  description: string;
}

export interface FridayStandingGoal {
  id: string;
  userId: string;
  title: string;
  objective: string;
  scope: FridayStandingGoalScope;
  triggers: FridayStandingGoalTrigger[];
  budget: FridayAutonomyBudgetPolicy;
  riskPolicy: Partial<Record<FridayAutonomyRiskCategory, boolean>>;
  successCriteria: FridayStandingGoalSuccessCriterion[];
  status: FridayStandingGoalStatus;
  createdAt: string;
  updatedAt: string;
}

export type FridayAgendaSource =
  | "standing_goal"
  | "monitor"
  | "self_healing"
  | "failure_retro"
  | "user_preference"
  | "manual";

export type FridayAgendaStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type FridayAgendaRiskLevel = "low" | "medium" | "high";

export interface FridayAgendaItem {
  id: string;
  userId: string;
  standingGoalId?: string;
  source: FridayAgendaSource;
  title: string;
  summary: string;
  status: FridayAgendaStatus;
  riskLevel: FridayAgendaRiskLevel;
  plan: FridayCapabilityAcquisitionStep[];
  requiredCapabilities: FridayRuntimeCapabilityId[];
  approvalRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FridayAgendaRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "rolled_back";

export interface FridayAgendaRun {
  id: string;
  agendaItemId: string;
  userId: string;
  status: FridayAgendaRunStatus;
  plan: FridayCapabilityAcquisitionStep[];
  capabilityCheck: FridayCapabilityAcquisitionRun;
  evidence: Record<string, unknown>;
  verification: {
    passed: boolean;
    summary: string;
  };
  cost: {
    usd: number;
    networkCalls: number;
    externalDownloads: number;
    runtimeMs: number;
  };
  rollback: {
    attempted: boolean;
    succeeded?: boolean;
    summary?: string;
  };
  improvementRecords: FridayImprovementRecord[];
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type FridayImprovementTargetType =
  | "memory_fact"
  | "provider_routing"
  | "setup_recipe"
  | "generated_skill"
  | "generated_workflow"
  | "eval_case"
  | "failure_lesson"
  | "source_ranking";

export interface FridayImprovementRecord {
  id: string;
  userId: string;
  sourceRunId?: string;
  sourceType: "agenda_run" | "capability_acquisition" | "self_healing" | "manual";
  targetType: FridayImprovementTargetType;
  targetId?: string;
  summary: string;
  changes: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface FridayCreateStandingGoalInput {
  userId: string;
  title?: string;
  objective: string;
  scope?: Partial<FridayStandingGoalScope>;
  triggers?: FridayStandingGoalTrigger[];
  budget?: FridayAutonomyBudgetPolicy;
  riskPolicy?: Partial<Record<FridayAutonomyRiskCategory, boolean>>;
  successCriteria?: FridayStandingGoalSuccessCriterion[];
}

export interface FridayUpdateStandingGoalInput {
  title?: string;
  objective?: string;
  scope?: Partial<FridayStandingGoalScope>;
  triggers?: FridayStandingGoalTrigger[];
  budget?: FridayAutonomyBudgetPolicy;
  riskPolicy?: Partial<Record<FridayAutonomyRiskCategory, boolean>>;
  successCriteria?: FridayStandingGoalSuccessCriterion[];
  status?: FridayStandingGoalStatus;
}

export interface FridayRuntimeRiskMappingInput {
  risks: readonly FridayRuntimeCapabilityRisk[];
}
