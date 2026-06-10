import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry, SkillLifecycleStatus } from "#skills";
import type { FridayWorkflowCrudService } from "#workflows";
import type { FridayHarnessQaVerdictV1, FridayTemplateHarnessSummary } from "#harness";

import type {
  FridayGeneratedWorkflowDraft,
  FridayStartWorkflowGenerationRequest,
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationTurnRequest,
  FridayWorkflowGenerationTurnResponse,
} from "../model/friday-workflow-generator.types.js";

// ─── Service interface ───

export interface FridayWorkflowGeneratorPublicationBoundary {
  stage: "published_version";
  lifecyclePromotion: "not_lifecycle_promoted";
  proofBoundary: "crud_publish_only";
  summary: string;
}

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

  getQaVerdict(sessionId: string): Promise<FridayHarnessQaVerdictV1 | null>;

  getHarnessSummary(sessionId: string): Promise<FridayTemplateHarnessSummary | null>;

  approveAndSave(sessionId: string): Promise<{
    sessionId: string;
    workflowId: string;
    workflowVersionId: string;
    versionNumber: number;
    slug: string;
    published: boolean;
    publicationBoundary: FridayWorkflowGeneratorPublicationBoundary;
    harness?: FridayTemplateHarnessSummary | null;
    qaVerdict?: FridayHarnessQaVerdictV1 | null;
  }>;

  cancelSession(sessionId: string): Promise<void>;
}

// ─── Service dependencies ───

export interface CreateFridayWorkflowGeneratorServiceDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  workflowCrud: FridayWorkflowCrudService;
  skillRegistry: FridaySkillRegistry;
  getSkillLifecycleStatus?: (skillId: string) => SkillLifecycleStatus | null | undefined;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  userRulesContextProvider?: (input: {
    task: string;
    userId?: string;
    channel?: string;
    surface: "workflow_generator";
  }) => string | null | Promise<string | null>;
  /**
   * Test-oracle only: allows legacy TypeScript workflow-generator session
   * mutations (`startSession`/`submitTurn`/`generateDraft`/`approveAndSave`/
   * `cancelSession`) in isolated test/validation harnesses. Default/live runtime
   * must leave this unset so the methods fail closed for ALL callers — including
   * the agent workflow-generator tool, the UIX assistant surface, and the reflex
   * candidate pipeline, which bypass the HTTP route guard.
   */
  allowTestOnlyWorkflowGeneratorExecution?: boolean;
}
