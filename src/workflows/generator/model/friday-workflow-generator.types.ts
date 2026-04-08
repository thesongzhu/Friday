import type {
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowSpecEdgeWhen,
  FridayWorkflowSpecInput,
  FridayWorkflowSpecOutput,
  FridayWorkflowSpecTestCase,
  FridayWorkflowSpecTrigger,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
  WorkflowFailurePolicyV2,
} from "#workflows";
import type {
  FridayHarnessQaVerdictV1,
  FridayTemplateHarnessStage,
  FridayTemplateHarnessSummary,
} from "#harness";
import type { FridayProviderTenantContext } from "#providers";

// ─── Session status ───

export type FridayWorkflowGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "retryable_provider_failure"
  | "draft_ready_needs_repair"
  | "terminal_failed"
  | "cancelled";

// ─── Session entity ───

export interface FridayWorkflowGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  tenantContext?: FridayProviderTenantContext;
  status: FridayWorkflowGeneratorSessionStatus;
  goal: string;
  requirementsSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftWorkflowId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  harnessStage?: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Turn entity ───

export interface FridayWorkflowGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

// ─── Request / response types ───

export interface FridayStartWorkflowGenerationRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
  tenantContext?: FridayProviderTenantContext;
}

export interface FridayWorkflowGenerationTurnRequest {
  message: string;
  requestedModel?: string;
}

export type FridayWorkflowGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "draft_needs_repair"
  | "retryable_provider_failure"
  | "generation_failed";

// ─── Skill context for prompts ───

export interface FridayWorkflowGeneratorSkillContext {
  id: string;
  name: string;
  description: string;
  inputs: Array<{ key: string; type: string; required: boolean }>;
  outputs: Array<{ key: string; type: string }>;
}

// ─── Requirements ───

export interface FridayWorkflowGenerationRequirements {
  goal: string;
  trigger: FridayWorkflowSpecTrigger;
  inputs: FridayWorkflowSpecInput[];
  plannedSteps: Array<{
    id: string;
    intent: string;
    nodeTypeHint: "action" | "condition" | "data" | "ai" | "approval";
    preferredSkillId?: string;
    condition?: string;
  }>;
  outputs: FridayWorkflowSpecOutput[];
  errorPolicy: WorkflowFailurePolicyV2;
  assumptions: string[];
  testScenarios: Array<{ name: string; description?: string }>;
}

// ─── Validation types ───

export type FridayGeneratedWorkflowValidationStage =
  | "requirements"
  | "spec"
  | "visual"
  | "tests"
  | "compile"
  | "graph"
  | "skill_refs"
  | "draft_consistency";

export interface FridayGeneratedWorkflowValidationIssue {
  code: string;
  stage: FridayGeneratedWorkflowValidationStage;
  severity: "error" | "warning";
  message: string;
  path?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: FridayWorkflowSpecEdgeWhen };
}

export interface FridayGeneratedWorkflowValidationReport {
  ok: boolean;
  issues: FridayGeneratedWorkflowValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}

// ─── Draft artifact ───

export interface FridayGeneratedWorkflowDraft {
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  tests: FridayWorkflowSpecTestCase[];
  compiledGraph: FridayCompiledWorkflowGraphV2;
  validation: FridayGeneratedWorkflowValidationReport;
}

// ─── Turn response ───

export interface FridayWorkflowGenerationTurnResponse {
  session: FridayWorkflowGenerationSession;
  mode: FridayWorkflowGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedWorkflowDraft;
  errors?: FridayGeneratedWorkflowValidationIssue[];
}

export interface FridayWorkflowGenerationHarnessSnapshot {
  harness?: FridayTemplateHarnessSummary | null;
  qaVerdict?: FridayHarnessQaVerdictV1 | null;
}
