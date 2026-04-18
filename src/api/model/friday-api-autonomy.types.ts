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
import type { FridayUpgradeImpactFinding } from "../../autonomy/model/friday-autonomy-impact.types.js";

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
}

export interface FridayRecordWorkflowCanaryRequest {
  success: boolean;
  evaluatedAt?: string;
}

export interface FridayRegisterSkillShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRecordSkillCanaryRequest {
  success: boolean;
  evaluatedAt?: string;
}

export interface FridayRegisterPluginShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRecordPluginCanaryRequest {
  success: boolean;
  evaluatedAt?: string;
}

export interface FridayPromotePluginUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRollbackPluginUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRegisterProviderProfileShadowRequest {
  shadowVersionId: string;
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRecordProviderProfileCanaryRequest {
  success: boolean;
  evaluatedAt?: string;
}

export interface FridayPromoteProviderProfileUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRollbackProviderProfileUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayPromoteSkillUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRollbackSkillUpgradeRequest {
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayPromoteWorkflowUpgradeRequest {
  versionNumber: number;
  runtimeVersion: string;
  providerModel?: string;
}

export interface FridayRollbackWorkflowUpgradeRequest {
  targetVersionNumber: number;
  runtimeVersion: string;
  providerModel?: string;
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
}
