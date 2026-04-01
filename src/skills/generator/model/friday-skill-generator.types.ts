import type { SkillManifestV2 } from "#skills";
import type {
  FridayHarnessQaVerdictV1,
  FridayTemplateHarnessStage,
  FridayTemplateHarnessSummary,
} from "#harness";
import type { FridayProviderTenantContext } from "#providers";

import type { FridaySkillUiSchemaV1 } from "./friday-skill-ui-schema.types.js";

// ─── Session status ───

export type FridaySkillGeneratorSessionStatus =
  | "collecting_requirements"
  | "needs_clarification"
  | "generating"
  | "ready_for_review"
  | "approved"
  | "saved"
  | "failed"
  | "cancelled";

// ─── Session entity ───

export interface FridaySkillGenerationSession {
  sessionId: string;
  userId: string;
  channel: string;
  tenantContext?: FridayProviderTenantContext;
  status: FridaySkillGeneratorSessionStatus;
  goal: string;
  specSummary: string;
  openQuestions: string[];
  decisions: string[];
  draftSkillId?: string;
  explicitTest?: FridaySkillGenerationExplicitTestSummary;
  harnessStage?: FridayTemplateHarnessStage;
  planningSpecId?: string;
  deliveryContractId?: string;
  qaVerdictId?: string;
  handoffArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Turn entity ───

export interface FridaySkillGenerationTurn {
  turnId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

// ─── Request / response types ───

export interface FridayStartSkillGenerationRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
  tenantContext?: FridayProviderTenantContext;
}

export interface FridaySkillGenerationTurnRequest {
  message: string;
  requestedModel?: string;
}

export type FridaySkillGenerationTurnMode =
  | "clarification_required"
  | "preview_ready"
  | "generation_failed";

export interface FridaySkillGenerationTurnResponse {
  session: FridaySkillGenerationSession;
  mode: FridaySkillGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedSkillDraft;
  errors?: FridayGeneratedSkillValidationIssue[];
}

// ─── Generated artifacts ───

export interface FridayGeneratedSkillFile {
  path: string;
  language: "json" | "javascript" | "typescript" | "bash" | "markdown";
  executable?: boolean;
  content: string;
}

export interface FridayGeneratedSkillDraft {
  manifest: SkillManifestV2;
  files: FridayGeneratedSkillFile[];
  uiSchema: FridaySkillUiSchemaV1;
  runtimeKind: "shell" | "node";
  validation: FridayGeneratedSkillValidationReport;
}

// ─── Validation ───

export interface FridayGeneratedSkillValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface FridayGeneratedSkillValidationReport {
  ok: boolean;
  issues: FridayGeneratedSkillValidationIssue[];
  repaired: boolean;
  repairAttempts: number;
}

export interface FridaySkillGenerationExplicitTestSummary {
  ok: boolean;
  executable: boolean;
  issues: FridayGeneratedSkillValidationIssue[];
  durationMs: number;
  testedAt: string;
}

export interface FridaySkillGenerationHarnessSnapshot {
  harness?: FridayTemplateHarnessSummary | null;
  qaVerdict?: FridayHarnessQaVerdictV1 | null;
}
