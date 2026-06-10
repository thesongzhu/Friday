import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayHubConfigManagerService, FridayHubMemoryStateService } from "#hub";
import type { FridayHarnessQaVerdictV1, FridayTemplateHarnessSummary } from "#harness";
import type { FridayMutatingActionTicket } from "../../../security/friday-mutating-action-gate.js";

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

  approveAndSave(sessionId: string, input?: {
    canonicalApprovalTicket?: FridayMutatingActionTicket;
  }): Promise<{
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
    evidence: {
      packageLoaded: boolean;
      packageValidated: boolean;
      registryRefreshed: boolean;
      candidateStaged: boolean;
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
  /**
   * TS Runtime Retirement — GAP G2 (DEFAULT-OFF / INVERTED polarity).
   *
   * Unlike the `allowTestOnly*` retirement flags (which DEFAULT the guard ON /
   * fail-closed and require an explicit opt-in to run legacy TS), THIS flag
   * DEFAULTS the guard OFF. The UIX-driven skill-generator session mutators
   * (`startSession`/`submitTurn`/`generateDraft`/`approveAndSave`) are NOT in the
   * retirement set and are an ACCEPTED-LIVE v1 feature (operator decision
   * DEC-3a). They reach this service off-route (via UIX `executeTemplate`
   * `generate-skill` and the agent skill-generator tool), bypassing the
   * route-level `allowTestOnlySkillGeneratorExecution` guard.
   *
   * When `false`/undefined (the default, INCLUDING production today) the guard is
   * INERT and these methods behave exactly as before — zero degradation. When
   * explicitly `true` the methods fail closed with a 503
   * `TS_RUNTIME_SKILL_GENERATOR_RETIRED` BEFORE any session write or provider
   * call. This is the dormant lever to flip ON later when the operator decides
   * to Rust-own skill generation (R11). Flipping it on also fail-closes the
   * agent skill-generator tool path (both share this service / R11 owns both).
   */
  enforceUixSkillExecRetirement?: boolean;
}
