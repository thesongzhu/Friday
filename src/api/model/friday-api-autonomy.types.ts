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
