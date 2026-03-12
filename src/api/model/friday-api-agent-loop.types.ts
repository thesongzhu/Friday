import type {
  FridayAgentLoopExpertModeSummary,
  FridayAgentLoopHaltReason,
  FridayAgentLoopPolicyEntity,
  FridayAgentLoopRunEntity,
  FridayAgentLoopRunStatus,
} from "../../learning/model/friday-agent-loop.types.js";
import type {
  FridayDiagnosisIncidentRecord,
  FridayFixPlanRecord,
} from "./friday-api-self-healing.types.js";

export type { FridayAgentLoopHaltReason, FridayAgentLoopRunStatus };

export interface FridayAgentLoopPolicy extends FridayAgentLoopPolicyEntity {}

export interface FridayAgentLoopRun extends FridayAgentLoopRunEntity {}

export interface FridayAgentLoopRunRecord {
  run: FridayAgentLoopRun;
  incident: FridayDiagnosisIncidentRecord | null;
  action: FridayFixPlanRecord | null;
}

export interface FridayGetAgentLoopPolicyResponse {
  policy: FridayAgentLoopPolicy;
}

export interface FridayUpdateAgentLoopPolicyRequest {
  paused?: boolean;
  autoApplyLowRisk?: boolean;
  maxAttemptsPerFingerprint?: number;
  cooldownMinutes?: number;
  requireRollbackPlan?: boolean;
  requireAcceptanceCheck?: boolean;
}

export interface FridayUpdateAgentLoopPolicyResponse {
  policy: FridayAgentLoopPolicy;
}

export interface FridayListAgentLoopRunsResponse {
  items: FridayAgentLoopRunRecord[];
}

export interface FridayGetAgentLoopRunResponse extends FridayAgentLoopRunRecord {}

export interface FridayAgentLoopRunControlResponse {
  run: FridayAgentLoopRunRecord;
}

export interface FridayListAgentLoopRunsQuery {
  status?: FridayAgentLoopRunStatus;
  limit?: number;
}

export interface FridayAgentLoopRunParams {
  loopRunId: string;
}

export interface FridayGetAgentLoopExpertModeResponse {
  expertMode: FridayAgentLoopExpertModeSummary;
}

export interface FridayUpdateAgentLoopExpertModeRequest {
  enabled?: boolean;
  allowedUserIds?: string[];
  allowedWorkspaceIds?: string[];
  allowedEnvironments?: string[];
  contextInferenceAllowed?: boolean;
  multiStepHypothesisSearchAllowed?: boolean;
  safeProbeExecutionAllowed?: boolean;
  crossSurfaceOrchestrationAllowed?: boolean;
  highRiskFinalApprovalRequired?: boolean;
  productionDestructiveActionApprovalRequired?: boolean;
  probeBudget?: number;
  timeBudgetMinutes?: number;
}

export interface FridayUpdateAgentLoopExpertModeResponse {
  expertMode: FridayAgentLoopExpertModeSummary;
}

export interface FridayListExpertAgentLoopRunsResponse {
  items: FridayAgentLoopRunRecord[];
}

export interface FridayGetExpertAgentLoopRunResponse extends FridayAgentLoopRunRecord {}
