import { FridayDomainError } from "#errors";
import type { FridayAgentRuntime } from "#agent";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridayWorkflowGeneratorService, FridayWorkflowProductService } from "#workflows";
import type {
  FridayActionTemplateSummary,
  FridayBeginnerIntentResolution,
  FridayGuidedWizardState,
  FridayUixTemplateExecutionResponse,
  FridayUixWizardResponse,
} from "../../api/model/friday-api-uix-surface.types.js";
import type { FridayIssueCard } from "../../api/model/friday-api-self-healing.types.js";
import type { FridayAssistantWorkflowCard } from "../../api/model/friday-api-workflow.types.js";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";
import type {
  FridayDeleteUserPreferenceResponse,
  FridayListUserPreferencesResponse,
  FridayUpdateUserPreferencesRequest,
  FridayUpdateUserPreferencesResponse,
} from "../api/friday-uix-api.types.js";
import type { FridayUserPreference } from "../model/friday-uix.types.js";
import type { FridayUixUserPreferenceRepository } from "../persistence/friday-uix-user-preference-repository.js";
import {
  FRIDAY_COMMUNICATION_PREFERENCE_KEYS,
  FRIDAY_DEFAULT_COMMUNICATION_PERSONA,
  type FridayCommunicationPersona,
  type FridayCommunicationPersonaSettings,
  resolveFridayCommunicationPersona,
} from "./friday-communication-persona.js";

interface FridayWizardContextRecord extends FridayGuidedWizardState {
  skillSessionId?: string;
  workflowSessionId?: string;
  flowKind?: "skill" | "workflow";
  resolvedIntent?: FridayBeginnerIntentResolution["intent"];
}

export interface FridayUixSurfaceService {
  resolveIntent(input: {
    text: string;
    userId?: string;
  }): FridayBeginnerIntentResolution;
  listTemplates(): FridayActionTemplateSummary[];
  listPreferences(input: {
    userId: string;
    category?: FridayUserPreference["category"];
  }): FridayListUserPreferencesResponse;
  updatePreferences(input: {
    userId: string;
    request: FridayUpdateUserPreferencesRequest;
  }): FridayUpdateUserPreferencesResponse;
  deletePreference(input: {
    userId: string;
    preferenceId: string;
  }): FridayDeleteUserPreferenceResponse;
  getPersona(input: {
    userId: string;
  }): FridayCommunicationPersona;
  executeTemplate(input: {
    templateId: string;
    userId: string;
    parameters: Record<string, unknown>;
  }): Promise<FridayUixTemplateExecutionResponse>;
  startWizard(input: {
    wizardId: string;
    userId: string;
  }): FridayUixWizardResponse;
  continueWizard(input: {
    wizardId: string;
    contextId: string;
    userId: string;
    values: Record<string, unknown>;
  }): Promise<FridayUixWizardResponse>;
  listIssues(input: {
    userId: string;
    limit?: number;
  }): FridayIssueCard[];
}

export interface CreateFridayUixSurfaceServiceDeps {
  db?: FridaySqliteLayer;
  idGenerator: () => string;
  skillGenerator?: FridaySkillGeneratorService;
  workflowGenerator?: FridayWorkflowGeneratorService;
  workflowProduct?: FridayWorkflowProductService;
  selfHealing: FridaySelfHealingApiService;
  agentRuntime?: FridayAgentRuntime;
  observability?: FridayObservabilityApiService;
  preferenceRepo?: FridayUixUserPreferenceRepository;
  learningContextBuilder?: (input: { userId: string; nowIso: string }) => { preferences: Record<string, unknown> };
  nowIso?: () => string;
}

const TEMPLATE_DEFINITIONS: FridayActionTemplateSummary[] = [
  {
    id: "generate-skill",
    label: "Generate a skill",
    description: "Turn a plain-language goal into a tested skill draft.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Goal",
        type: "text",
        required: true,
        placeholder: "Example: Build a skill that summarizes git changes.",
      },
    ],
  },
  {
    id: "generate-workflow",
    label: "Generate a workflow",
    description: "Turn a plain-language goal into a deploy-ready workflow draft.",
    category: "workflows",
    parameters: [
      {
        key: "goal",
        label: "Goal",
        type: "text",
        required: true,
        placeholder: "Example: Watch a folder, summarize new files, and notify me.",
      },
    ],
  },
  {
    id: "deploy-workflow",
    label: "Deploy workflow",
    description: "Publish, optionally run, and track a workflow without using builder steps.",
    category: "workflows",
    parameters: [
      {
        key: "goal",
        label: "Goal or draft context",
        type: "text",
        required: false,
        placeholder: "Example: Deploy the release workflow for staging.",
      },
      {
        key: "runNow",
        label: "Run now",
        type: "boolean",
        required: false,
      },
    ],
  },
  {
    id: "export-workflow-bundle",
    label: "Export workflow bundle",
    description: "Package a workflow draft into a deployable bundle with evidence.",
    category: "workflows",
    parameters: [
      {
        key: "goal",
        label: "Goal or draft context",
        type: "text",
        required: false,
        placeholder: "Example: Package the workflow that ships release notes.",
      },
    ],
  },
  {
    id: "recover-failed-deploy",
    label: "Recover failed deploy",
    description: "Review failed workflow deploys and open the next safe fix step.",
    category: "workflows",
    parameters: [],
  },
  {
    id: "review-issues",
    label: "Review issues",
    description: "See what Friday detected and what needs approval or a fix.",
    category: "issues",
    parameters: [],
  },
  {
    id: "ask-for-help",
    label: "Get guided help",
    description: "Open a guided beginner flow to clarify what you want Friday to do.",
    category: "system",
    parameters: [],
  },
];

const HIGH_RISK_KEYWORDS = [
  "delete",
  "drop",
  "rotate credential",
  "rotate key",
  "production",
  "secret",
  "destroy",
  "wipe",
];

const OUT_OF_BOUNDARY_KEYWORDS = [
  "without approval",
  "ignore approval",
  "take over everything",
  "unrestricted autonomy",
  "fully autonomous forever",
];

type FridayAssistantGuidanceState = NonNullable<FridayBeginnerIntentResolution["state"]>;

interface FridayAssistantGuidance {
  state: FridayAssistantGuidanceState;
  objective: string;
  assumptions: string[];
  unknowns: string[];
  successTest: string;
  fallbackPath: string;
}

const COMMUNICATION_ENUMS = {
  tone: ["warm", "neutral", "analytical", "encouraging"] as const,
  verbosity: ["concise", "balanced", "detailed"] as const,
  structure: ["compact", "balanced", "structured"] as const,
  questionStyle: ["minimal", "guided", "exploratory"] as const,
  directness: ["soft", "balanced", "direct"] as const,
  emojiStyle: ["none", "light"] as const,
  jargonTolerance: ["low", "medium", "high"] as const,
  assumptionStyle: ["ask_first", "balanced", "infer_first"] as const,
  confirmationStyle: ["minimal", "balanced", "explicit"] as const,
} satisfies Record<keyof FridayCommunicationPersonaSettings, readonly string[]>;

function buildDefaultPersona(): FridayCommunicationPersona {
  return {
    category: "communication",
    mbti: null,
    settings: { ...FRIDAY_DEFAULT_COMMUNICATION_PERSONA },
    inheritedFrom: {
      mbti: "default",
      settings: {
        tone: "default",
        verbosity: "default",
        structure: "default",
        questionStyle: "default",
        directness: "default",
        emojiStyle: "default",
        jargonTolerance: "default",
        assumptionStyle: "default",
        confirmationStyle: "default",
      },
    },
    preview: {
      styleLabel: "neutral/balanced/balanced",
      sampleClarifier: "I can help with that. What outcome matters most here?",
      sampleBoundary: "This is a high-risk step. I need your approval before I continue.",
    },
  };
}

function isValidCommunicationPreference(
  key: string,
  value: unknown,
): boolean {
  if (key === FRIDAY_COMMUNICATION_PREFERENCE_KEYS.mbti) {
    return value === null || typeof value === "string";
  }
  const settingEntry = Object.entries(FRIDAY_COMMUNICATION_PREFERENCE_KEYS).find(([, mappedKey]) => mappedKey === key);
  if (!settingEntry) {
    return false;
  }
  const [settingName] = settingEntry;
  if (!(settingName in COMMUNICATION_ENUMS)) {
    return false;
  }
  const allowedValues = COMMUNICATION_ENUMS[settingName as keyof typeof COMMUNICATION_ENUMS] as readonly string[];
  return typeof value === "string" && allowedValues.includes(value);
}

function summarizeWorkflowName(goal: string): string {
  return goal.trim().length > 0 ? goal.trim() : "Workflow";
}

function normalizeGoalText(value: string): string {
  return value.trim().length > 0 ? value.trim() : "Help the user complete the requested task safely";
}

function buildAssistantGuidance(input: {
  text: string;
  intent: FridayBeginnerIntentResolution["intent"];
  questions?: string[];
  blockedByPolicy?: boolean;
  outOfBoundary?: boolean;
  assumptions?: string[];
  unknowns?: string[];
  persona?: FridayCommunicationPersona;
}): FridayAssistantGuidance {
  const text = input.text.trim();
  const lower = text.toLowerCase();
  const questions = input.questions ?? [];
  const persona = input.persona ?? buildDefaultPersona();
  const assumptions = [
    "Friday will use the current workspace and runtime defaults unless you override them.",
    "Friday will prefer rollback-backed, observable actions when it can proceed safely.",
    ...(input.assumptions ?? []),
  ];
  const unknowns = [...(input.unknowns ?? [])];
  if (questions.length > 0) {
    unknowns.push(...questions);
  }
  if (text.length < 18 && unknowns.length === 0) {
    unknowns.push("The goal is still too short to choose a single safe execution path.");
  }
  if (persona.settings.assumptionStyle === "infer_first" && unknowns.length > 1) {
    assumptions.push("Friday will infer low-risk defaults from recent context unless you correct them.");
    unknowns.splice(1);
  } else if (persona.settings.assumptionStyle === "balanced" && unknowns.length > 2) {
    assumptions.push("Friday will carry forward likely defaults when they do not materially change risk.");
    unknowns.splice(2);
  }
  let state: FridayAssistantGuidanceState = "ready_to_execute";
  if (input.outOfBoundary || OUT_OF_BOUNDARY_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    state = "out_of_boundary";
  } else if (
    input.blockedByPolicy
    || HIGH_RISK_KEYWORDS.some((keyword) => lower.includes(keyword))
  ) {
    state = "blocked_by_policy";
  } else if (unknowns.length > 0) {
    state = "needs_one_answer";
  }
  const objective = normalizeGoalText(text);
  const successLead = persona.settings.directness === "direct"
    ? "Friday will move to a verified next step."
    : persona.settings.directness === "soft"
      ? "Friday will guide the task toward a verified next step."
      : "Friday will reach a verified next step.";
  return {
    state,
    objective,
    assumptions,
    unknowns,
    successTest: `${successLead} Objective: ${objective}.`,
    fallbackPath:
      state === "blocked_by_policy"
        ? persona.settings.directness === "direct"
          ? "Explain the risk boundary, request approval, and stop before destructive actions."
          : "Explain the risk boundary, collect approval, and stop before destructive actions."
        : state === "out_of_boundary"
          ? "Explain the product boundary and redirect to a supported path."
          : persona.settings.questionStyle === "minimal"
            ? "Ask one decisive question or surface a blocked issue card with the missing detail."
            : "Ask one decisive follow-up question or surface a blocked issue card with the missing detail.",
  };
}

function applyGuidance<T extends object>(
  value: T,
  guidance: FridayAssistantGuidance,
): T & FridayAssistantGuidance {
  return {
    ...value,
    state: guidance.state,
    objective: guidance.objective,
    assumptions: guidance.assumptions,
    unknowns: guidance.unknowns,
    successTest: guidance.successTest,
    fallbackPath: guidance.fallbackPath,
  };
}

export function createFridayUixSurfaceService(
  deps: CreateFridayUixSurfaceServiceDeps,
): FridayUixSurfaceService {
  const wizardContexts = new Map<string, FridayWizardContextRecord>();
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  function listCommunicationPreferences(userId: string): FridayUserPreference[] {
    if (!deps.db || !deps.preferenceRepo) {
      return [];
    }
    return deps.db.withReadConnection((db) =>
      deps.preferenceRepo!.listByPrincipal(db, {
        principalId: userId,
        category: "communication",
      }));
  }

  function resolvePersona(userId: string): FridayCommunicationPersona {
    return resolveFridayCommunicationPersona({
      explicitPreferences: listCommunicationPreferences(userId),
      learnedPreferences: deps.learningContextBuilder?.({ userId, nowIso: nowIso() }).preferences ?? {},
    });
  }

  function makeWizard(context: FridayWizardContextRecord): FridayUixWizardResponse {
    return {
      wizard: {
        wizardId: context.wizardId,
        contextId: context.contextId,
        title: context.title,
        status: context.status,
        currentStepId: context.currentStepId,
        steps: context.steps,
        collectedValues: context.collectedValues,
        nextActionLabel: context.nextActionLabel,
      },
    };
  }

  function resolveIntentFromText(
    textInput: string,
    userId?: string,
  ): FridayBeginnerIntentResolution {
    const text = textInput.trim().toLowerCase();
    const persona = userId ? resolvePersona(userId) : undefined;
    if (
      text.includes("deploy")
      || text.includes("publish workflow")
      || text.includes("ship workflow")
    ) {
      return applyGuidance({
        intent: "deploy_workflow",
        confidence: 0.93,
        summary: "This looks like a workflow deployment request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["deploy-workflow", "generate-workflow"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "deploy_workflow",
        persona,
      }));
    }
    if (text.includes("workflow") || text.includes("automation") || text.includes("pipeline")) {
      return applyGuidance({
        intent: "generate_workflow",
        confidence: 0.89,
        summary: "This looks like a request to generate or prepare a workflow.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["generate-workflow", "deploy-workflow"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "generate_workflow",
        persona,
      }));
    }
    if (text.includes("export") && (text.includes("workflow") || text.includes("bundle"))) {
      return applyGuidance({
        intent: "export_workflow_bundle",
        confidence: 0.86,
        summary: "This looks like a request to package a workflow bundle.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["export-workflow-bundle"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "export_workflow_bundle",
        persona,
      }));
    }
    if (text.includes("skill") || text.includes("generate")) {
      return applyGuidance({
        intent: "generate_skill",
        confidence: 0.92,
        summary: "This looks like a request to generate a skill directly.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["generate-skill"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "generate_skill",
        persona,
      }));
    }
    if (text.includes("fix") || text.includes("issue") || text.includes("problem")) {
      return applyGuidance({
        intent: "review_issues",
        confidence: 0.88,
        summary: "This looks like a request to review or fix detected issues.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["review-issues"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "review_issues",
        persona,
      }));
    }
    return applyGuidance({
      intent: "general_help",
      confidence: 0.55,
      summary: persona?.settings.directness === "direct"
        ? "Friday can generate a workflow or skill, deploy it, and guide the next safe step."
        : "Friday can generate a workflow or skill, deploy it, and guide you through the next step.",
      routeTarget: "/assistant",
      suggestedTemplateIds: ["generate-workflow", "deploy-workflow", "generate-skill"],
    }, buildAssistantGuidance({
      text: textInput,
      intent: "general_help",
      persona,
    }));
  }

  function buildUserGuidance(
    userId: string | undefined,
    input: Omit<Parameters<typeof buildAssistantGuidance>[0], "persona">,
  ): FridayAssistantGuidance {
    const persona = userId ? resolvePersona(userId) : undefined;
    return buildAssistantGuidance({
      ...input,
      persona,
    });
  }

  async function startWorkflowSession(input: {
    goal: string;
    userId: string;
  }): Promise<{
    response: Awaited<ReturnType<FridayWorkflowGeneratorService["startSession"]>>;
    workflow?: ReturnType<FridayWorkflowProductService["materializeGeneratedSession"]> extends Promise<infer T>
      ? T
      : never;
  }> {
    if (!deps.workflowGenerator || !deps.workflowProduct) {
      throw new FridayDomainError(
        "UIX_WORKFLOW_GENERATOR_UNAVAILABLE",
        "Workflow generation is not available in this runtime",
        { httpStatus: 503 },
      );
    }
    const response = await deps.workflowGenerator.startSession({
      goal: input.goal,
      userId: input.userId,
      channel: "assistant",
    });
    if (response.mode === "clarification_required") {
      return { response };
    }
    const workflow = await deps.workflowProduct.materializeGeneratedSession({
      sessionId: response.session.sessionId,
      actorUserId: input.userId,
    });
    return { response, workflow };
  }

  async function continueWorkflowSession(input: {
    sessionId: string;
    message: string;
    userId: string;
  }): Promise<{
    response: Awaited<ReturnType<FridayWorkflowGeneratorService["submitTurn"]>>;
    workflow?: ReturnType<FridayWorkflowProductService["materializeGeneratedSession"]> extends Promise<infer T>
      ? T
      : never;
  }> {
    if (!deps.workflowGenerator || !deps.workflowProduct) {
      throw new FridayDomainError(
        "UIX_WORKFLOW_GENERATOR_UNAVAILABLE",
        "Workflow generation is not available in this runtime",
        { httpStatus: 503 },
      );
    }
    const response = await deps.workflowGenerator.submitTurn(input.sessionId, {
      message: input.message,
    });
    if (response.mode === "clarification_required") {
      return { response };
    }
    const workflow = await deps.workflowProduct.materializeGeneratedSession({
      sessionId: input.sessionId,
      actorUserId: input.userId,
    });
    return { response, workflow };
  }

  async function deployWorkflowCard(input: {
    workflowId: string;
    draftId: string;
    actorUserId: string;
    workflowName: string;
    runNow?: boolean;
    includeExport?: boolean;
  }): Promise<{
    deployment: Awaited<ReturnType<FridayWorkflowProductService["deployDraft"]>>;
    workflow: FridayAssistantWorkflowCard;
  }> {
    if (!deps.workflowProduct) {
      throw new FridayDomainError(
        "UIX_WORKFLOW_DEPLOY_UNAVAILABLE",
        "Workflow deployment is not available in this runtime",
        { httpStatus: 503 },
      );
    }
    const deployment = await deps.workflowProduct.deployDraft({
      workflowId: input.workflowId,
      draftId: input.draftId,
      actorUserId: input.actorUserId,
      runNow: input.runNow,
      includeExport: input.includeExport,
      resyncTriggers: true,
    });
    return {
      deployment,
      workflow: {
        kind: input.includeExport ? "export_ready" : "deployment_result",
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        draftId: input.draftId,
        summary: input.includeExport
          ? "Friday exported the workflow bundle and recorded deployment evidence."
          : "Friday published the workflow and completed the one-click deploy flow.",
        routeTarget: "/workflows" as const,
        deployReady: true,
        latestRun: deployment.run,
        exportBundle: deployment.exportBundle,
        evidence: deployment.evidence,
      } satisfies FridayAssistantWorkflowCard,
    };
  }

  function blockedWorkflowCard(input: {
    workflowName: string;
    summary: string;
    questions?: string[];
    sessionId?: string;
  }) {
    return {
      kind: "blocked" as const,
      workflowName: input.workflowName,
      summary: input.summary,
      routeTarget: "/assistant" as const,
      deployReady: false,
      questions: input.questions,
      sessionId: input.sessionId,
    };
  }

  function shouldReportAssistantFailure(error: unknown): boolean {
    return !(
      error instanceof FridayDomainError
      && (
        error.code === "VALIDATION_ERROR"
        || error.code === "UIX_TEMPLATE_NOT_FOUND"
        || error.code === "UIX_GUIDED_WORKFLOW_NOT_FOUND"
        || error.code === "UIX_GUIDED_CONTEXT_NOT_FOUND"
      )
    );
  }

  function reportAssistantFailure(input: {
    userId: string;
    scope: "template" | "wizard";
    detail: string;
    correlationId?: string;
    error: unknown;
  }): void {
    if (!shouldReportAssistantFailure(input.error)) {
      return;
    }
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    deps.selfHealing.reportStructuredFailure({
      userId: input.userId,
      runId: `assistant:${input.scope}:${deps.idGenerator()}`,
      category: "workflow",
      severity: "high",
      message,
      correlationId: input.correlationId,
      context: {
        source: "assistant",
        scope: input.scope,
        detail: input.detail,
      },
    });
  }

  return {
    resolveIntent(input) {
      const result = resolveIntentFromText(input.text, input.userId);
      void deps.observability?.recordAssistantEvent({
        userId: input.userId ?? "assistant-user",
        event: "intent_resolved",
        summary: result.summary,
        intent: result,
      });
      return result;
    },

    listTemplates() {
      return [...TEMPLATE_DEFINITIONS];
    },

    listPreferences(input) {
      const items = deps.db && deps.preferenceRepo
        ? deps.db.withReadConnection((db) =>
          deps.preferenceRepo!.listByPrincipal(db, {
            principalId: input.userId,
            category: input.category,
          }))
        : [];
      return {
        items,
        nextCursor: undefined,
      };
    },

    updatePreferences(input) {
      if (!deps.db || !deps.preferenceRepo) {
        throw new FridayDomainError(
          "UIX_PREFERENCE_PERSISTENCE_UNAVAILABLE",
          "Communication preferences are not available in this runtime",
          { httpStatus: 503 },
        );
      }
      const existingByKey = new Map(
        listCommunicationPreferences(input.userId).map((preference) => [preference.key, preference]),
      );
      let created = 0;
      let updated = 0;
      const preferences = deps.db.withWriteTransaction((db) =>
        input.request.preferences.map((preference) => {
          if (preference.category !== "communication") {
            throw new FridayDomainError(
              "UIX_PREFERENCE_VALIDATION_FAILED",
              "Only communication preferences are supported by this surface",
              { httpStatus: 400 },
            );
          }
          if (!isValidCommunicationPreference(preference.key, preference.value)) {
            throw new FridayDomainError(
              "UIX_PREFERENCE_VALIDATION_FAILED",
              `Invalid communication preference: ${preference.key}`,
              { httpStatus: 400 },
            );
          }
          const existing = existingByKey.get(preference.key);
          if (existing) {
            updated += 1;
          } else {
            created += 1;
          }
          const saved = deps.preferenceRepo!.upsert(db, {
            id: existing?.id ?? deps.idGenerator(),
            principalId: input.userId,
            category: preference.category,
            key: preference.key,
            value: preference.value,
            source: "explicit",
            confidence: 1,
            nowIso: nowIso(),
          });
          existingByKey.set(saved.key, saved);
          return saved;
        }));
      return {
        preferences,
        created,
        updated,
      };
    },

    deletePreference(input) {
      if (!deps.db || !deps.preferenceRepo) {
        throw new FridayDomainError(
          "UIX_PREFERENCE_PERSISTENCE_UNAVAILABLE",
          "Communication preferences are not available in this runtime",
          { httpStatus: 503 },
        );
      }
      deps.db.withWriteTransaction((db) =>
        deps.preferenceRepo!.deleteById(db, {
          principalId: input.userId,
          preferenceId: input.preferenceId,
        }));
      return {
        deleted: true,
        preferenceId: input.preferenceId,
      };
    },

    getPersona(input) {
      return resolvePersona(input.userId);
    },

    async executeTemplate(input) {
      try {
        const buildGuidance = (
          guidanceInput: Omit<Parameters<typeof buildAssistantGuidance>[0], "persona">,
        ): FridayAssistantGuidance => buildUserGuidance(input.userId, guidanceInput);
        switch (input.templateId) {
        case "generate-skill": {
          if (!deps.skillGenerator) {
            throw new FridayDomainError(
              "UIX_SKILL_GENERATOR_UNAVAILABLE",
              "Skill generation is not available in this runtime",
              { httpStatus: 503 },
            );
          }
          const goal = typeof input.parameters.goal === "string" ? input.parameters.goal.trim() : "";
          if (!goal) {
            throw new FridayDomainError("VALIDATION_ERROR", "goal is required", { httpStatus: 400 });
          }
          const response = await deps.skillGenerator.startSession({
            goal,
            userId: input.userId,
            channel: "assistant",
          });
          const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
            templateId: input.templateId,
            status: "executed",
            summary:
              response.mode === "clarification_required"
                ? "Friday needs one more answer before generating the skill."
                : "Friday generated a skill draft and moved it into review.",
            routeTarget: "/assistant",
            result: {
              sessionId: response.session.sessionId,
              mode: response.mode,
              questions: response.questions,
              draftSkillId: response.draft?.manifest.id,
              validationOk: response.draft?.validation.ok,
            },
          }, buildGuidance({
            text: goal,
            intent: "generate_skill",
            questions: response.questions,
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
        case "generate-workflow": {
          const sessionId = typeof input.parameters.sessionId === "string" ? input.parameters.sessionId : undefined;
          const goal = typeof input.parameters.goal === "string" ? input.parameters.goal.trim() : "";
          if (!goal && !sessionId) {
            throw new FridayDomainError("VALIDATION_ERROR", "goal is required", { httpStatus: 400 });
          }
          const response = sessionId
            ? {
              response: undefined,
              workflow: await (() => {
                if (!deps.workflowProduct) {
                  throw new FridayDomainError(
                    "UIX_WORKFLOW_GENERATOR_UNAVAILABLE",
                    "Workflow generation is not available in this runtime",
                    { httpStatus: 503 },
                  );
                }
                return deps.workflowProduct.materializeGeneratedSession({
                  sessionId,
                  actorUserId: input.userId,
                });
              })(),
            }
            : await startWorkflowSession({
              goal,
              userId: input.userId,
            });
          const previewResponse = response.response;
          const responsePayload: FridayUixTemplateExecutionResponse = response.workflow
            ? applyGuidance({
              templateId: input.templateId,
              status: "executed",
              summary: response.workflow.summary,
              routeTarget: "/assistant",
              result: {
                sessionId: response.workflow.sessionId ?? sessionId,
                mode: response.response?.mode,
              },
              workflow: response.workflow,
            }, buildGuidance({
              text: goal || response.workflow.workflowName,
              intent: "generate_workflow",
            }))
            : applyGuidance({
              templateId: input.templateId,
              status: "preview",
              summary: "Friday needs one more answer before it can generate the workflow.",
              routeTarget: "/assistant",
              result: {
                sessionId: previewResponse!.session.sessionId,
                mode: previewResponse!.mode,
                questions: previewResponse!.questions ?? [],
              },
              workflow: {
                kind: "session_started",
                workflowName: summarizeWorkflowName(goal),
                sessionId: previewResponse!.session.sessionId,
                summary: "Friday is collecting one more detail before it generates the workflow.",
                routeTarget: "/assistant",
                deployReady: false,
                questions: previewResponse!.questions ?? [],
              },
            }, buildGuidance({
              text: goal,
              intent: "generate_workflow",
              questions: previewResponse!.questions ?? [],
            }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
        case "deploy-workflow":
        case "export-workflow-bundle": {
          const goal = typeof input.parameters.goal === "string" ? input.parameters.goal.trim() : "";
          const workflowId = typeof input.parameters.workflowId === "string" ? input.parameters.workflowId : undefined;
          const draftId = typeof input.parameters.draftId === "string" ? input.parameters.draftId : undefined;
          const sessionId = typeof input.parameters.sessionId === "string" ? input.parameters.sessionId : undefined;
          const includeExport = input.templateId === "export-workflow-bundle";
          const runNow = input.templateId === "deploy-workflow"
            ? input.parameters.runNow !== false
            : false;

          if (workflowId && draftId) {
            const deployed = await deployWorkflowCard({
              workflowId,
              draftId,
              actorUserId: input.userId,
              workflowName: goal || "Workflow",
              runNow,
              includeExport,
            });
            const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
              templateId: input.templateId,
              status: "executed",
              summary: deployed.workflow.summary,
              routeTarget: "/assistant",
              result: { deployment: deployed.deployment },
              workflow: deployed.workflow,
            }, buildGuidance({
              text: goal || "Deploy workflow",
              intent: includeExport ? "export_workflow_bundle" : "deploy_workflow",
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "template_executed",
              summary: responsePayload.summary,
              result: responsePayload,
            });
            return responsePayload;
          }

          const generated = sessionId
            ? {
              response: undefined,
              workflow: await (() => {
                if (!deps.workflowProduct) {
                  throw new FridayDomainError(
                    "UIX_WORKFLOW_GENERATOR_UNAVAILABLE",
                    "Workflow generation is not available in this runtime",
                    { httpStatus: 503 },
                  );
                }
                return deps.workflowProduct.materializeGeneratedSession({
                  sessionId,
                  actorUserId: input.userId,
                });
              })(),
            }
            : goal
              ? await startWorkflowSession({ goal, userId: input.userId })
              : null;
          if (!generated) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "Provide a goal, sessionId, or workflowId/draftId to deploy a workflow",
              { httpStatus: 400 },
            );
          }
          if (!generated.workflow) {
            const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
              templateId: input.templateId,
              status: "preview",
              summary: "Friday needs one more answer before it can deploy this workflow.",
              routeTarget: "/assistant",
              result: {
                sessionId: generated.response?.session.sessionId,
                mode: generated.response?.mode,
                questions: generated.response?.questions ?? [],
              },
              workflow: blockedWorkflowCard({
                workflowName: summarizeWorkflowName(goal),
                summary: "Deploy is blocked until Friday gets the missing workflow details.",
                questions: generated.response?.questions ?? [],
                sessionId: generated.response?.session.sessionId,
              }),
            }, buildGuidance({
              text: goal,
              intent: includeExport ? "export_workflow_bundle" : "deploy_workflow",
              questions: generated.response?.questions ?? [],
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "template_executed",
              summary: responsePayload.summary,
              result: responsePayload,
            });
            return responsePayload;
          }
          if (!generated.workflow.deployReady || !generated.workflow.workflowId || !generated.workflow.draftId) {
            const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
              templateId: input.templateId,
              status: "preview",
              summary: "Friday prepared the workflow draft, but it is not yet safe to deploy.",
              routeTarget: "/assistant",
              workflow: blockedWorkflowCard({
                workflowName: generated.workflow.workflowName,
                summary: "Friday created the draft, but the workflow still needs fixes before deploy.",
                questions: generated.workflow.questions,
                sessionId: generated.workflow.sessionId,
              }),
            }, buildGuidance({
              text: goal || generated.workflow.workflowName,
              intent: includeExport ? "export_workflow_bundle" : "deploy_workflow",
              blockedByPolicy: true,
              unknowns: generated.workflow.questions,
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "template_executed",
              summary: responsePayload.summary,
              result: responsePayload,
            });
            return responsePayload;
          }

          const deployed = await deployWorkflowCard({
            workflowId: generated.workflow.workflowId,
            draftId: generated.workflow.draftId,
            actorUserId: input.userId,
            workflowName: generated.workflow.workflowName,
            runNow,
            includeExport,
          });
          const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
            templateId: input.templateId,
            status: "executed",
            summary: deployed.workflow.summary,
            routeTarget: "/assistant",
            result: {
              sessionId: generated.workflow.sessionId,
              deployment: deployed.deployment,
            },
            workflow: deployed.workflow,
          }, buildGuidance({
            text: goal || generated.workflow.workflowName,
            intent: includeExport ? "export_workflow_bundle" : "deploy_workflow",
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
        case "recover-failed-deploy": {
          const issues = deps.selfHealing.listIssueCards({ userId: input.userId, limit: 10 });
          const workflowIssue = issues.find((issue) => issue.title.toLowerCase().includes("workflow"))
            ?? issues[0]
            ?? null;
          const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
            templateId: input.templateId,
            status: "executed",
            summary: workflowIssue
              ? "Friday found a deploy-related issue card to review."
              : "Friday does not currently have a failed deploy issue to recover.",
            routeTarget: "/assistant",
            result: {
              issue: workflowIssue,
              count: issues.length,
            },
            workflow: workflowIssue
              ? blockedWorkflowCard({
                workflowName: "Workflow deploy",
                summary: workflowIssue.summary,
              })
              : undefined,
          }, buildGuidance({
            text: "Recover failed deploy",
            intent: "review_issues",
            blockedByPolicy: workflowIssue === null,
            unknowns: workflowIssue ? [] : ["No workflow deploy issue is currently open."],
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
        case "review-issues": {
          const issues = deps.selfHealing.listIssueCards({ userId: input.userId, limit: 10 });
          const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
            templateId: input.templateId,
            status: "executed",
            summary: issues.length > 0
              ? `Friday found ${issues.length} issue(s) to review.`
              : "Friday does not currently have any open issue cards for you.",
            routeTarget: "/assistant",
            result: {
              count: issues.length,
              issues,
            },
          }, buildGuidance({
            text: "Review detected issues",
            intent: "review_issues",
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
        case "ask-for-help": {
          const responsePayload: FridayUixTemplateExecutionResponse = applyGuidance({
            templateId: input.templateId,
            status: "preview",
            summary: "Start the guided assistant flow to describe what you want in plain language.",
            routeTarget: "/assistant",
            result: {
              wizardId: "guided-assistant",
            },
          }, buildGuidance({
            text: "Get guided help",
            intent: "general_help",
            questions: ["What is the one goal Friday should complete first?"],
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: responsePayload.summary,
            result: responsePayload,
          });
          return responsePayload;
        }
          default:
            throw new FridayDomainError("UIX_TEMPLATE_NOT_FOUND", "Template not found", { httpStatus: 404 });
        }
      } catch (error) {
        reportAssistantFailure({
          userId: input.userId,
          scope: "template",
          detail: input.templateId,
          correlationId: `assistant-template:${input.templateId}`,
          error,
        });
        throw error;
      }
    },

    startWizard(input) {
      if (input.wizardId !== "guided-assistant") {
        throw new FridayDomainError("UIX_GUIDED_WORKFLOW_NOT_FOUND", "Wizard not found", {
          httpStatus: 404,
        });
      }
      const initialGuidance = buildUserGuidance(input.userId, {
        text: "Help the user converge on one executable plan.",
        intent: "general_help",
        questions: ["What should Friday do first?"],
      });
      const context: FridayWizardContextRecord = {
        wizardId: input.wizardId,
        contextId: deps.idGenerator(),
        title: "Guided Assistant",
        status: "awaiting_input",
        currentStepId: "goal",
        steps: [
          {
            id: "goal",
            title: "Describe your goal",
            prompt: "Tell Friday what you want to do in one sentence.",
            inputKey: "goal",
          },
          {
            id: "clarification",
            title: "Answer a follow-up",
            prompt: "If Friday needs more detail, answer the follow-up question.",
            inputKey: "answer",
          },
        ],
        collectedValues: {},
        nextActionLabel: "Continue",
        objective: initialGuidance.objective,
        assumptions: initialGuidance.assumptions,
        unknowns: initialGuidance.unknowns,
        successTest: initialGuidance.successTest,
        fallbackPath: initialGuidance.fallbackPath,
      };
      wizardContexts.set(context.contextId, context);
      void deps.observability?.recordAssistantEvent({
        userId: input.userId,
        event: "wizard_started",
        summary: "Started the guided assistant flow.",
        result: makeWizard(context),
      });
      return makeWizard(context);
    },

    async continueWizard(input) {
      try {
        const context = wizardContexts.get(input.contextId);
        if (!context || context.wizardId !== input.wizardId) {
          throw new FridayDomainError("UIX_GUIDED_CONTEXT_NOT_FOUND", "Wizard context not found", {
            httpStatus: 404,
          });
        }

      if (context.currentStepId === "goal") {
        const goal = typeof input.values.goal === "string" ? input.values.goal.trim() : "";
        if (!goal) {
          throw new FridayDomainError("VALIDATION_ERROR", "goal is required", { httpStatus: 400 });
        }
        context.collectedValues.goal = goal;
        const resolvedIntent = resolveIntentFromText(goal, input.userId);
        Object.assign(context, buildUserGuidance(input.userId, {
          text: goal,
          intent: resolvedIntent.intent,
        }));
        context.resolvedIntent = resolvedIntent.intent;
        if (
          resolvedIntent.intent === "generate_workflow"
          || resolvedIntent.intent === "deploy_workflow"
          || resolvedIntent.intent === "export_workflow_bundle"
        ) {
          context.flowKind = "workflow";
          const response = await startWorkflowSession({ goal, userId: input.userId });
          context.workflowSessionId = response.response.session.sessionId;
          if (!response.workflow) {
            context.currentStepId = "clarification";
            context.status = "awaiting_input";
            context.collectedValues.questions = response.response.questions ?? [];
            const wizardResponse = applyGuidance({
              ...makeWizard(context),
              summary: (response.response.questions ?? []).join(" "),
              result: {
                sessionId: response.response.session.sessionId,
                mode: response.response.mode,
                questions: response.response.questions ?? [],
              },
              workflow: {
                kind: "session_started" as const,
                workflowName: summarizeWorkflowName(goal),
                sessionId: response.response.session.sessionId,
                summary: "Friday needs one more answer before it can generate the workflow.",
                routeTarget: "/assistant" as const,
                deployReady: false,
                questions: response.response.questions ?? [],
              },
            }, buildUserGuidance(input.userId, {
              text: goal,
              intent: resolvedIntent.intent,
              questions: response.response.questions ?? [],
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "wizard_continued",
              summary: wizardResponse.summary ?? "Friday needs clarification before generating the workflow.",
              result: wizardResponse,
            });
            return wizardResponse;
          }

          if (
            resolvedIntent.intent === "deploy_workflow"
            || resolvedIntent.intent === "export_workflow_bundle"
          ) {
            if (response.workflow.deployReady && response.workflow.workflowId && response.workflow.draftId) {
              const deployed = await deployWorkflowCard({
                workflowId: response.workflow.workflowId,
                draftId: response.workflow.draftId,
                actorUserId: input.userId,
                workflowName: response.workflow.workflowName,
                runNow: resolvedIntent.intent === "deploy_workflow",
                includeExport: resolvedIntent.intent === "export_workflow_bundle",
              });
              context.status = "completed";
              context.nextActionLabel = "Done";
              const wizardResponse = applyGuidance({
                ...makeWizard(context),
                summary: deployed.workflow.summary,
                result: {
                  sessionId: response.workflow.sessionId,
                  deployment: deployed.deployment,
                },
                workflow: deployed.workflow,
              }, buildUserGuidance(input.userId, {
                text: goal,
                intent: resolvedIntent.intent,
              }));
              await deps.observability?.recordAssistantEvent({
                userId: input.userId,
                event: "wizard_continued",
                summary: wizardResponse.summary ?? "Friday deployed the workflow.",
                result: wizardResponse,
              });
              return wizardResponse;
            }
            const wizardResponse = applyGuidance({
              ...makeWizard(context),
              summary: "Friday prepared the workflow draft, but it is not yet safe to deploy.",
              workflow: blockedWorkflowCard({
                workflowName: response.workflow.workflowName,
                summary: "The workflow still needs fixes before deploy.",
                questions: response.workflow.questions,
                sessionId: response.workflow.sessionId,
              }),
            }, buildUserGuidance(input.userId, {
              text: goal,
              intent: resolvedIntent.intent,
              blockedByPolicy: true,
              unknowns: response.workflow.questions,
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "wizard_continued",
              summary: wizardResponse.summary,
              result: wizardResponse,
            });
            return wizardResponse;
          }

          context.status = "completed";
          context.nextActionLabel = "Done";
          const wizardResponse = applyGuidance({
            ...makeWizard(context),
            summary: response.workflow.summary,
            workflow: response.workflow,
            result: {
              sessionId: response.workflow.sessionId,
            },
          }, buildUserGuidance(input.userId, {
            text: goal,
            intent: resolvedIntent.intent,
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "wizard_continued",
            summary: wizardResponse.summary ?? "Friday generated a workflow draft.",
            result: wizardResponse,
          });
          return wizardResponse;
        }

        context.flowKind = "skill";
        if (!deps.skillGenerator) {
          throw new FridayDomainError(
            "UIX_SKILL_GENERATOR_UNAVAILABLE",
            "Skill generation is not available in this runtime",
            { httpStatus: 503 },
          );
        }
        const response = await deps.skillGenerator.startSession({
          goal,
          userId: input.userId,
          channel: "assistant",
        });
        context.skillSessionId = response.session.sessionId;
        if (response.mode === "clarification_required") {
          context.currentStepId = "clarification";
          context.status = "awaiting_input";
          context.collectedValues.questions = response.questions ?? [];
          const wizardResponse = applyGuidance({
            ...makeWizard(context),
            summary: (response.questions ?? []).join(" "),
            result: {
              sessionId: response.session.sessionId,
              mode: response.mode,
              questions: response.questions ?? [],
            },
          }, buildUserGuidance(input.userId, {
            text: goal,
            intent: "generate_skill",
            questions: response.questions ?? [],
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "wizard_continued",
            summary: wizardResponse.summary ?? "Friday needs clarification before generating the skill.",
            result: wizardResponse,
          });
          return wizardResponse;
        }
        context.status = "completed";
        context.nextActionLabel = "Done";
        const wizardResponse = applyGuidance({
          ...makeWizard(context),
          summary: "Friday generated a skill draft and moved it into review.",
          result: {
            sessionId: response.session.sessionId,
            mode: response.mode,
            draftSkillId: response.draft?.manifest.id,
            validationOk: response.draft?.validation.ok,
          },
        }, buildUserGuidance(input.userId, {
          text: goal,
          intent: "generate_skill",
        }));
        await deps.observability?.recordAssistantEvent({
          userId: input.userId,
          event: "wizard_continued",
          summary: wizardResponse.summary ?? "Friday generated a skill draft.",
          result: wizardResponse,
        });
        return wizardResponse;
      }

      if (context.currentStepId === "clarification") {
        const answer = typeof input.values.answer === "string" ? input.values.answer.trim() : "";
        if (!answer) {
          throw new FridayDomainError("VALIDATION_ERROR", "answer is required", { httpStatus: 400 });
        }
        if (context.flowKind === "workflow") {
          if (!context.workflowSessionId) {
            throw new FridayDomainError("STATE_CONFLICT", "Wizard has no active workflow session", {
              httpStatus: 409,
            });
          }
          context.collectedValues.answer = answer;
          const response = await continueWorkflowSession({
            sessionId: context.workflowSessionId,
            message: answer,
            userId: input.userId,
          });
          if (!response.workflow) {
            context.collectedValues.questions = response.response.questions ?? [];
            const wizardResponse = applyGuidance({
              ...makeWizard(context),
              summary: (response.response.questions ?? []).join(" "),
              result: {
                sessionId: context.workflowSessionId,
                mode: response.response.mode,
                questions: response.response.questions ?? [],
              },
              workflow: {
                kind: "session_started" as const,
                workflowName: summarizeWorkflowName(String(context.collectedValues.goal ?? "Workflow")),
                sessionId: context.workflowSessionId,
                summary: "Friday still needs clarification before it can generate the workflow.",
                routeTarget: "/assistant" as const,
                deployReady: false,
                questions: response.response.questions ?? [],
              },
            }, buildUserGuidance(input.userId, {
              text: String(context.collectedValues.goal ?? "Workflow"),
              intent: context.resolvedIntent ?? "generate_workflow",
              questions: response.response.questions ?? [],
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "wizard_continued",
              summary: wizardResponse.summary ?? "Friday still needs clarification.",
              result: wizardResponse,
            });
            return wizardResponse;
          }

          if (
            context.resolvedIntent === "deploy_workflow"
            || context.resolvedIntent === "export_workflow_bundle"
          ) {
            if (response.workflow.deployReady && response.workflow.workflowId && response.workflow.draftId) {
              const deployed = await deployWorkflowCard({
                workflowId: response.workflow.workflowId,
                draftId: response.workflow.draftId,
                actorUserId: input.userId,
                workflowName: response.workflow.workflowName,
                runNow: context.resolvedIntent === "deploy_workflow",
                includeExport: context.resolvedIntent === "export_workflow_bundle",
              });
              context.status = "completed";
              context.nextActionLabel = "Done";
              const wizardResponse = applyGuidance({
                ...makeWizard(context),
                summary: deployed.workflow.summary,
                result: {
                  sessionId: context.workflowSessionId,
                  deployment: deployed.deployment,
                },
                workflow: deployed.workflow,
              }, buildUserGuidance(input.userId, {
                text: String(context.collectedValues.goal ?? "Workflow"),
                intent: context.resolvedIntent ?? "deploy_workflow",
              }));
              await deps.observability?.recordAssistantEvent({
                userId: input.userId,
                event: "wizard_continued",
                summary: wizardResponse.summary ?? "Friday deployed the workflow.",
                result: wizardResponse,
              });
              return wizardResponse;
            }
            const wizardResponse = applyGuidance({
              ...makeWizard(context),
              summary: "Friday prepared the workflow draft, but it is not yet safe to deploy.",
              workflow: blockedWorkflowCard({
                workflowName: response.workflow.workflowName,
                summary: "The workflow still needs fixes before deploy.",
                questions: response.workflow.questions,
                sessionId: response.workflow.sessionId,
              }),
            }, buildUserGuidance(input.userId, {
              text: String(context.collectedValues.goal ?? "Workflow"),
              intent: context.resolvedIntent ?? "deploy_workflow",
              blockedByPolicy: true,
              unknowns: response.workflow.questions,
            }));
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "wizard_continued",
              summary: wizardResponse.summary,
              result: wizardResponse,
            });
            return wizardResponse;
          }

          context.status = "completed";
          context.nextActionLabel = "Done";
          const wizardResponse = applyGuidance({
            ...makeWizard(context),
            summary: response.workflow.summary,
            result: {
              sessionId: context.workflowSessionId,
            },
            workflow: response.workflow,
          }, buildUserGuidance(input.userId, {
            text: String(context.collectedValues.goal ?? "Workflow"),
            intent: context.resolvedIntent ?? "generate_workflow",
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "wizard_continued",
            summary: wizardResponse.summary ?? "Friday generated a workflow draft.",
            result: wizardResponse,
          });
          return wizardResponse;
        }
        if (!context.skillSessionId) {
          throw new FridayDomainError("STATE_CONFLICT", "Wizard has no active skill session", {
            httpStatus: 409,
          });
        }
        if (!deps.skillGenerator) {
          throw new FridayDomainError(
            "UIX_SKILL_GENERATOR_UNAVAILABLE",
            "Skill generation is not available in this runtime",
            { httpStatus: 503 },
          );
        }
        context.collectedValues.answer = answer;
        const response = await deps.skillGenerator.submitTurn(context.skillSessionId, {
          message: answer,
        });
        if (response.mode === "clarification_required") {
          context.collectedValues.questions = response.questions ?? [];
          const wizardResponse = applyGuidance({
            ...makeWizard(context),
            summary: (response.questions ?? []).join(" "),
            result: {
              sessionId: context.skillSessionId,
              mode: response.mode,
              questions: response.questions ?? [],
            },
          }, buildUserGuidance(input.userId, {
            text: String(context.collectedValues.goal ?? "Skill"),
            intent: "generate_skill",
            questions: response.questions ?? [],
          }));
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "wizard_continued",
            summary: wizardResponse.summary ?? "Friday still needs clarification.",
            result: wizardResponse,
          });
          return wizardResponse;
        }
        context.status = "completed";
        context.nextActionLabel = "Done";
        const wizardResponse = applyGuidance({
          ...makeWizard(context),
          summary: "Friday generated a skill draft and moved it into review.",
          result: {
            sessionId: context.skillSessionId,
            mode: response.mode,
            draftSkillId: response.draft?.manifest.id,
            validationOk: response.draft?.validation.ok,
          },
        }, buildUserGuidance(input.userId, {
          text: String(context.collectedValues.goal ?? "Skill"),
          intent: "generate_skill",
        }));
        await deps.observability?.recordAssistantEvent({
          userId: input.userId,
          event: "wizard_continued",
          summary: wizardResponse.summary ?? "Friday generated a skill draft.",
          result: wizardResponse,
        });
        return wizardResponse;
      }

        throw new FridayDomainError("STATE_CONFLICT", "Wizard is not advanceable", {
          httpStatus: 409,
        });
      } catch (error) {
        reportAssistantFailure({
          userId: input.userId,
          scope: "wizard",
          detail: input.wizardId,
          correlationId: `assistant-wizard:${input.contextId}`,
          error,
        });
        throw error;
      }
    },

    listIssues(input) {
      return deps.selfHealing.listIssueCards(input);
    },
  };
}
