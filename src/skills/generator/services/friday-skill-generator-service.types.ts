import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";
import type { FridayHarnessQaVerdictV1, FridayTemplateHarnessSummary } from "#harness";

import type {
  FridayGeneratedSkillDraft,
  FridaySkillGenerationExplicitTestSummary,
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
  FridaySkillGenerationTurnRequest,
  FridaySkillGenerationTurnResponse,
  FridayStartSkillGenerationRequest,
} from "../model/friday-skill-generator.types.js";

// ─── Service interface ───

export interface FridaySkillGeneratorService {
  startSession(
    input: FridayStartSkillGenerationRequest,
  ): Promise<FridaySkillGenerationTurnResponse>;

  submitTurn(
    sessionId: string,
    input: FridaySkillGenerationTurnRequest,
  ): Promise<FridaySkillGenerationTurnResponse>;

  getSession(sessionId: string): Promise<{
    session: FridaySkillGenerationSession;
    turns: FridaySkillGenerationTurn[];
    draft?: FridayGeneratedSkillDraft;
  } | null>;

  generateDraft(
    sessionId: string,
    requestedModel?: string,
  ): Promise<FridayGeneratedSkillDraft>;

  recordExplicitTestResult(
    sessionId: string,
    test: FridaySkillGenerationExplicitTestSummary,
  ): Promise<void>;

  getQaVerdict(sessionId: string): Promise<FridayHarnessQaVerdictV1 | null>;

  getHarnessSummary(sessionId: string): Promise<FridayTemplateHarnessSummary | null>;

  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    skillId: string;
    skillDir: string;
    savedFiles: string[];
    registryRefreshed: boolean;
    promotionStage: "stabilized";
    promotedManifestTags: string[];
    evidence: {
      packageLoaded: boolean;
      packageValidated: boolean;
      registryRefreshed: boolean;
    };
    harness?: FridayTemplateHarnessSummary | null;
    qaVerdict?: FridayHarnessQaVerdictV1 | null;
  }>;

  cancelSession(sessionId: string): Promise<void>;
}

// ─── Service dependencies ───

export interface CreateFridaySkillGeneratorServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  registry: FridaySkillRegistry;
  configManager: FridayHubConfigManagerService;
  memoryStateService: FridayHubMemoryStateService;
  idGenerator: () => string;
  nowIso: () => string;
  userRulesContextProvider?: (input: {
    task: string;
    userId?: string;
    channel?: string;
    surface: "skill_generator";
  }) => string | null | Promise<string | null>;
}
