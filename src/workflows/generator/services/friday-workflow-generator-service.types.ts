import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayWorkflowCrudService } from "#workflows";

import type {
  FridayGeneratedWorkflowDraft,
  FridayStartWorkflowGenerationRequest,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnResponse,
} from "../model/friday-workflow-generator.types.js";

// ─── Service interface ───

export interface FridayWorkflowGeneratorService {
  startSession(
    input: FridayStartWorkflowGenerationRequest,
  ): Promise<FridayWorkflowGenerationTurnResponse>;

  submitTurn(
    sessionId: string,
    input: FridayWorkflowGenerationTurnRequest,
  ): Promise<FridayWorkflowGenerationTurnResponse>;

  getSession(sessionId: string): Promise<{
    session: FridayWorkflowGenerationSession;
    turns: FridayWorkflowGenerationTurn[];
    draft?: FridayGeneratedWorkflowDraft;
  } | null>;

  generateDraft(
    sessionId: string,
    requestedModel?: string,
  ): Promise<FridayGeneratedWorkflowDraft>;

  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    slug: string;
    published: boolean;
  }>;

  cancelSession(sessionId: string): Promise<void>;
}

// ─── Service dependencies ───

export interface CreateFridayWorkflowGeneratorServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  workflowCrud: FridayWorkflowCrudService;
  skillRegistry: FridaySkillRegistry;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
}
