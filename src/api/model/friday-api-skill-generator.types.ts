import type {
  FridayGeneratedSkillDraft,
  FridayGeneratedSkillValidationIssue,
  FridaySkillGenerationExplicitTestSummary,
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
  FridaySkillGenerationTurnMode,
} from "#skills/generator";
import type {
  FridayHarnessQaVerdictV1,
  FridayTemplateHarnessSummary,
} from "#harness";

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

export type FridaySkillGeneratorTestSummary = FridaySkillGenerationExplicitTestSummary;

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
  qaVerdict?: FridayHarnessQaVerdictV1 | null;
  harness?: FridayTemplateHarnessSummary | null;
  stagedCandidateIdentity?: {
    skillId: string;
    candidateId?: string;
    candidateDir?: string;
    filesDir?: string;
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
  candidateId: string;
  candidateDir: string;
  savedFiles: string[];
  registryRefreshed: boolean;
  promotionStage: "candidate_staged";
  candidateManifestTags: string[];
  /** @deprecated Candidate staging no longer promotes a manifest; use candidateManifestTags. */
  promotedManifestTags: string[];
  evidence: FridaySkillGenerationEvidence;
}

export interface FridayCancelSessionResponse {
  cancelled: true;
}

export interface FridayGetSkillUiResponse {
  ui: FridaySkillUiSchemaV1;
}
