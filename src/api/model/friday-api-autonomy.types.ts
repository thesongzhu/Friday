import type { FridayWorkflowEntity } from "./friday-api-workflow.types.js";
import type { FridayAutonomySubjectKind } from "../../autonomy/model/friday-autonomy-subject.types.js";
import type {
  FridayAutonomyUpgradeStrategy,
  FridayAutonomyVerificationStage,
} from "../../autonomy/model/friday-autonomy-promotion.types.js";
import type {
  FridayAutonomyCanaryStats,
  FridayAutonomyCompatibilityStatus,
  FridayAutonomyPromotionChannel,
} from "../../autonomy/model/friday-autonomy-upgrade.types.js";
import type { FridayCanonicalApprovalResolution } from "../../security/friday-mutating-action-gate.js";
import type { FridayUpgradeImpactFinding } from "../../autonomy/model/friday-autonomy-impact.types.js";
import type {
  FridayAgendaItem,
  FridayAgendaRun,
  FridayAutonomyBudgetPolicy,
  FridayAutonomyMode,
  FridayAutonomyPolicy,
  FridayAutonomyRiskCategory,
  FridayCapabilityAcquisitionRun,
  FridayCreateStandingGoalInput,
  FridayStandingGoal,
  FridayUpdateStandingGoalInput,
} from "../../autonomy/model/friday-controlled-autonomy.types.js";

export interface FridayAutonomyUpgradeStatusItem {
  kind: FridayAutonomySubjectKind;
  id: string;
  displayName: string;
  status: string;
  activeVersion?: string;
  details?: Record<string, unknown>;
  lastVerifiedAt?: string;
  lastVerifiedRuntimeVersion?: string;
  lastVerifiedProviderModel?: string;
  compatibilityStatus: FridayAutonomyCompatibilityStatus;
  promotionChannel: FridayAutonomyPromotionChannel;
  shadowVersionId?: string;
  canaryStats?: FridayAutonomyCanaryStats;
  recordedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  derivedCompatibilityStatus: FridayAutonomyCompatibilityStatus;
  requiresAdaptation: boolean;
  statusDrift: boolean;
  findings: FridayUpgradeImpactFinding[];
  strategy: FridayAutonomyUpgradeStrategy;
  nextStage: FridayAutonomyVerificationStage;
  reasons: string[];
  blockerAction?: string;
}

export interface FridayGetAutonomyUpgradeStatusQuery {
  kind?: FridayAutonomySubjectKind;
  id?: string;
}

export interface FridayGetAutonomyUpgradeStatusResponse {
  items: FridayAutonomyUpgradeStatusItem[];
}

export interface FridayRegisterWorkflowShadowRequest {
  workflowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordWorkflowCanaryRequest {
  success: boolean;
  runtimeVersion: string;
  providerModel?: string;
  evaluatedAt?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRegisterSkillShadowRequest {
  candidateId: string;
  shadowVersionId?: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest?: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordSkillCanaryRequest {
  candidateId: string;
  runtimeVersion: string;
  providerModel?: string;
  input?: Record<string, unknown>;
  planDigest?: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRegisterPluginShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordPluginCanaryRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromotePluginUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackPluginUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  reason?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayReviewEnablePluginRequest {
  runtimeVersion?: string;
  providerModel?: string;
  idempotencyKey?: string;
}

export interface FridayRegisterProviderProfileShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordProviderProfileCanaryRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromoteProviderProfileUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackProviderProfileUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  reason?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRegisterMcpServerShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordMcpServerCanaryRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromoteMcpServerUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackMcpServerUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  reason?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRegisterChannelAdapterShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRecordChannelAdapterCanaryRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromoteChannelAdapterUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackChannelAdapterUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
  reason?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromoteSkillUpgradeRequest {
  candidateId: string;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackSkillUpgradeRequest {
  candidateId: string;
  runtimeVersion: string;
  providerModel?: string;
  reason?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayPromoteWorkflowUpgradeRequest {
  versionNumber: number;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayRollbackWorkflowUpgradeRequest {
  targetVersionNumber: number;
  runtimeVersion: string;
  providerModel?: string;
  planDigest: string;
  idempotencyKey?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

export interface FridayWorkflowUpgradeActionResponse {
  workflow: FridayWorkflowEntity;
  status: FridayAutonomyUpgradeStatusItem | null;
}

export interface FridaySkillUpgradeActionResponse {
  skill: {
    skillId: string;
    installedVersion?: string;
    latestVersion?: string;
    status: string;
    promotionChannel?: string;
    compatibilityStatus?: string;
    shadowVersionId?: string;
    canaryStats?: FridayAutonomyCanaryStats;
  };
  status: FridayAutonomyUpgradeStatusItem | null;
  evidence?: Record<string, unknown>;
}

export interface FridayPluginUpgradeActionResponse {
  plugin: {
    id: string;
    version: string;
    status: string;
    enabled: boolean;
    promotionChannel?: string;
    compatibilityStatus?: string;
    shadowVersionId?: string | null;
    canaryStats?: FridayAutonomyCanaryStats;
  };
  status: FridayAutonomyUpgradeStatusItem | null;
  evidence?: Record<string, unknown>;
}

export interface FridayProviderProfileUpgradeActionResponse {
  provider: {
    id: string;
    kind: string;
    name: string;
    defaultModel?: string;
    enabled: boolean;
    promotionChannel?: string;
    compatibilityStatus?: string;
    shadowVersionId?: string;
    canaryStats?: FridayAutonomyCanaryStats;
    validationStatus?: string;
  };
  status: FridayAutonomyUpgradeStatusItem | null;
  evidence?: Record<string, unknown>;
}

export interface FridayMcpServerUpgradeActionResponse {
  server: {
    id: string;
    status: string;
    transport?: string;
    toolCount?: number;
    resourceCount?: number;
    promotionChannel?: string;
    compatibilityStatus?: string;
    shadowVersionId?: string;
    canaryStats?: FridayAutonomyCanaryStats;
  };
  status: FridayAutonomyUpgradeStatusItem | null;
  evidence?: Record<string, unknown>;
}

export interface FridayChannelAdapterUpgradeActionResponse {
  channel: {
    kind: string;
    status: string;
    running?: boolean;
    credentialStatus?: string;
    authMode?: string;
    promotionChannel?: string;
    compatibilityStatus?: string;
    shadowVersionId?: string;
    canaryStats?: FridayAutonomyCanaryStats;
  };
  status: FridayAutonomyUpgradeStatusItem | null;
  evidence?: Record<string, unknown>;
}

export interface FridayCapabilityAcquisitionPlanRequest {
  goal: string;
  userId?: string;
  requiredCapabilities?: string[];
  readOnly?: boolean;
}

export interface FridayCapabilityAcquisitionPlanResponse {
  run: FridayCapabilityAcquisitionRun;
}

export interface FridayCapabilityAcquisitionRunRequest {
  goal: string;
  userId?: string;
  requiredCapabilities?: string[];
  readOnly?: boolean;
}

export interface FridayCapabilityAcquisitionRunResponse {
  run: FridayCapabilityAcquisitionRun;
}

export interface FridayAutonomyPolicyResponse {
  policy: FridayAutonomyPolicy;
}

export interface FridayPatchAutonomyPolicyRequest {
  mode?: FridayAutonomyMode;
  paused?: boolean;
  riskSwitches?: Partial<Record<FridayAutonomyRiskCategory, boolean>>;
  budget?: FridayAutonomyBudgetPolicy;
  evidenceRetentionDays?: number;
}

export interface FridayListStandingGoalsResponse {
  items: FridayStandingGoal[];
}

export interface FridayCreateStandingGoalRequest extends Omit<FridayCreateStandingGoalInput, "userId"> {
  userId?: string;
}

export interface FridayStandingGoalResponse {
  goal: FridayStandingGoal;
  agendaItem?: FridayAgendaItem;
}

export interface FridayPatchStandingGoalRequest extends FridayUpdateStandingGoalInput {}

export interface FridayListAgendaResponse {
  items: FridayAgendaItem[];
}

export interface FridayAgendaItemResponse {
  item: FridayAgendaItem;
}

export interface FridayAgendaRunResponse {
  run: FridayAgendaRun;
}
