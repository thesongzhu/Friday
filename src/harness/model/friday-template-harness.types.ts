import type { FridayAcceptanceTest } from "#acceptance";
import type { JsonValue } from "#rules";

export type FridayTemplateHarnessStage =
  | "planning_spec"
  | "delivery_contract"
  | "draft_generation"
  | "qa_verdict"
  | "handoff_ready"
  | "completed";

export type FridayHarnessScopeKind =
  | "skill_generator"
  | "workflow_generator"
  | "uix_template"
  | "uix_wizard";

export type FridayHarnessDeliverableKind = "skill" | "workflow";

export type FridayHarnessEvidenceRequirement =
  | "generator_validation"
  | "skill_self_test"
  | "skill_verification"
  | "workflow_acceptance"
  | "browser_qa";

export type FridayHarnessQaVerdict = "pass" | "fail" | "blocked";

export interface FridayHarnessPlanningSpecV1 {
  artifactId: string;
  version: 1;
  scopeKind: FridayHarnessScopeKind;
  scopeId: string;
  objective: string;
  summary: string;
  assumptions: string[];
  unknowns: string[];
  outOfScope: string[];
  constraints: string[];
  successTests: string[];
  openQuestions: string[];
  sourceTemplateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessDeliveryContractV1 {
  artifactId: string;
  version: 1;
  scopeKind: FridayHarnessScopeKind;
  scopeId: string;
  planningSpecId: string;
  deliverableKind: FridayHarnessDeliverableKind;
  deliverables: string[];
  doneDefinition: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: FridayHarnessEvidenceRequirement[];
  riskFlags: string[];
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessQaVerdictV1 {
  artifactId: string;
  version: 1;
  scopeKind: FridayHarnessScopeKind;
  scopeId: string;
  deliveryContractId: string;
  verdict: FridayHarnessQaVerdict;
  summary: string;
  passedCriteria: string[];
  failedCriteria: string[];
  blockedReasons: string[];
  warnings: string[];
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayHarnessHandoffArtifactV1 {
  artifactId: string;
  version: 1;
  scopeKind: FridayHarnessScopeKind;
  scopeId: string;
  stage: FridayTemplateHarnessStage;
  summary: string;
  completedWork: string[];
  remainingWork: string[];
  blockers: string[];
  nextActions: string[];
  artifactRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FridayTemplateHarnessSummary {
  stage: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
  verdict?: FridayHarnessQaVerdict;
  summary?: string;
}

export interface FridayTemplateHarnessAcceptanceInput {
  existingQaVerdictId?: string;
  scopeKind: FridayHarnessScopeKind;
  scopeId: string;
  deliveryContract: FridayHarnessDeliveryContractV1;
  artifactContent: JsonValue;
  tests: FridayAcceptanceTest[];
  missingEvidenceReasons?: string[];
  evidenceRefs?: string[];
}

