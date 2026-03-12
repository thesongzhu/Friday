import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";

import type {
  FridayGeneratedSkillDraft,
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

  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    skillId: string;
    skillDir: string;
    savedFiles: string[];
    registryRefreshed: boolean;
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
}
