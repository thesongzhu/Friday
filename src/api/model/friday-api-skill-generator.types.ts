import type {
  FridayGeneratedSkillDraft,
  FridayGeneratedSkillValidationIssue,
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
  FridaySkillGenerationTurnMode,
} from "#skills/generator";

import type { FridaySkillUiSchemaV1 } from "#skills/generator";

// ─── Request types ───

export interface FridayStartSessionRequest {
  goal: string;
  requestedModel?: string;
  userId: string;
  channel: string;
}

export interface FridaySubmitTurnRequest {
  message: string;
  requestedModel?: string;
}

export interface FridayGenerateRequest {
  requestedModel?: string;
}

// ─── Response types ───

export interface FridayStartSessionResponse {
  session: FridaySkillGenerationSession;
  mode: FridaySkillGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedSkillDraft;
  errors?: FridayGeneratedSkillValidationIssue[];
}

export interface FridayGetSessionResponse {
  session: FridaySkillGenerationSession;
  turns: FridaySkillGenerationTurn[];
  draft?: FridayGeneratedSkillDraft;
}

export interface FridaySubmitTurnResponse {
  session: FridaySkillGenerationSession;
  mode: FridaySkillGenerationTurnMode;
  questions?: string[];
  draft?: FridayGeneratedSkillDraft;
  errors?: FridayGeneratedSkillValidationIssue[];
}

export interface FridayGenerateResponse {
  draft: FridayGeneratedSkillDraft;
}

export interface FridaySkillGeneratorTestSummary {
  ok: boolean;
  executable: boolean;
  issues: FridayGeneratedSkillValidationIssue[];
  durationMs: number;
}

export interface FridaySkillGenerationEvidence {
  sessionId: string;
  validationSummary: {
    ok: boolean;
    repaired: boolean;
    repairAttempts: number;
    issueCount: number;
  };
  repairSummary: {
    attempted: boolean;
    attempts: number;
  };
  executableTestSummary: FridaySkillGeneratorTestSummary | null;
  approvalReadiness: {
    ready: boolean;
    reason: string;
  };
  savedSkillIdentity?: {
    skillId: string;
    skillDir?: string;
  };
}

export interface FridaySkillGeneratorTestResponse {
  sessionId: string;
  test: FridaySkillGeneratorTestSummary;
}

export interface FridaySkillGeneratorEvidenceResponse {
  evidence: FridaySkillGenerationEvidence;
}

export interface FridayApproveResponse {
  sessionId: string;
  skillId: string;
  skillDir: string;
  savedFiles: string[];
  registryRefreshed: boolean;
  promotionStage: "stabilized";
  promotedManifestTags: string[];
  evidence: FridaySkillGenerationEvidence;
}

export interface FridayCancelSessionResponse {
  cancelled: true;
}

export interface FridayGetSkillUiResponse {
  ui: FridaySkillUiSchemaV1;
}
