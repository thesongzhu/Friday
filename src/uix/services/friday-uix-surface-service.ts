import { FridayDomainError } from "#errors";
import type { FridayAgentRuntime } from "#agent";
import type { FridayTemplateHarnessSummary } from "#harness";
import type { FridaySessionService } from "#sessions";
import type { FridaySqliteLayer } from "#state";
import type { FridaySkillExecutor } from "#skills";
import type { FridaySkillGeneratorService } from "#skills/generator";
import type { FridayWorkflowGeneratorService, FridayWorkflowProductService } from "#workflows";
import type {
  FridayActionTemplateSummary,
  FridayBeginnerIntentResolution,
  FridayGuidedWizardState,
  FridayUixAssistantDiagnostics,
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
  assistantSessionKey?: string;
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
  getDiagnostics(input: {
    userId: string;
  }): FridayUixAssistantDiagnostics;
  executeTemplate(input: {
    templateId: string;
    userId: string;
    parameters: Record<string, unknown>;
    assistantSessionKey?: string;
  }): Promise<FridayUixTemplateExecutionResponse>;
  startWizard(input: {
    wizardId: string;
    userId: string;
    assistantSessionKey?: string;
  }): FridayUixWizardResponse;
  continueWizard(input: {
    wizardId: string;
    contextId: string;
    userId: string;
    values: Record<string, unknown>;
    assistantSessionKey?: string;
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
  skillExecutor?: FridaySkillExecutor;
  agentRuntime?: FridayAgentRuntime;
  sessionService?: FridaySessionService;
  observability?: FridayObservabilityApiService;
  preferenceRepo?: FridayUixUserPreferenceRepository;
  learningContextBuilder?: (input: { userId: string; nowIso: string }) => { preferences: Record<string, unknown> };
  diagnosticsBuilder?: (input: { userId: string }) => FridayUixAssistantDiagnostics;
  nowIso?: () => string;
}

const TEMPLATE_DEFINITIONS: FridayActionTemplateSummary[] = [
  {
    id: "workflow-builder-launch",
    label: "Open workflow builder",
    description: "Jump straight into the workflow builder with stable templates and draft controls.",
    category: "workflows",
    parameters: [],
  },
  {
    id: "integration-mode-review",
    label: "Review integration mode",
    description: "Compare CLI-backed skills, MCP-backed integrations, and stable skill paths before wiring them in.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Integration scope",
        type: "text",
        required: false,
        placeholder: "Example: Review whether this GitHub integration should stay MCP-backed or move to a CLI skill.",
      },
    ],
  },
  {
    id: "context-governance-review",
    label: "Review context governance",
    description: "Inspect context cost, path rules, MCP loading, and task-profile usage before growing the prompt surface.",
    category: "system",
    parameters: [],
  },
  {
    id: "idea-clarifier",
    label: "Clarify an idea",
    description: "Turn a vague request into a bounded objective, open questions, and a next planning step.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Goal",
        type: "text",
        required: true,
        placeholder: "Example: Help me scope this idea into a concrete first milestone.",
      },
    ],
  },
  {
    id: "implementation-plan-review",
    label: "Review implementation plan",
    description: "Review architecture, edge cases, tests, and rollback coverage before coding or shipping.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Plan Text",
        type: "text",
        required: true,
        placeholder: "Example: Review this implementation plan for missing failure paths.",
      },
    ],
  },
  {
    id: "browser-qa-report",
    label: "QA this page or app",
    description: "Open a page in Friday's browser runtime and collect a structured QA report with screenshot and console evidence.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "QA Brief or URL",
        type: "text",
        required: false,
        placeholder: "Example: QA http://127.0.0.1:5173/settings and flag console errors.",
      },
    ],
  },
  {
    id: "workspace-diff-review",
    label: "Review current changes",
    description: "Inspect the current workspace diff for risky hotspots, missing tests, and the next landing-safe action.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Review Context",
        type: "text",
        required: false,
        placeholder: "Example: Review the current changes before I land them.",
      },
    ],
  },
  {
    id: "release-doc-sync",
    label: "Sync release docs",
    description: "Prepare or apply bounded README, changelog, and architecture updates for the current workspace changes.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Release Summary",
        type: "text",
        required: false,
        placeholder: "Example: Sync the docs for the new assistant starter flows.",
      },
    ],
  },
  {
    id: "page-benchmark-report",
    label: "Benchmark this page",
    description: "Collect repeated browser timings, compare them with a saved local baseline, and surface regressions or improvements.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Benchmark Goal or URL",
        type: "text",
        required: false,
        placeholder: "Example: Benchmark http://127.0.0.1:5173/assistant after the latest UI changes.",
      },
    ],
  },
  {
    id: "release-canary-check",
    label: "Run release canary check",
    description: "Inspect one or more pages after a change, capture browser evidence, and compare the result with the previous local canary run.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Canary Goal or URL",
        type: "text",
        required: false,
        placeholder: "Example: Run a canary check on http://127.0.0.1:5173 and watch for new console errors.",
      },
    ],
  },
  {
    id: "engineering-retro",
    label: "Generate engineering retro",
    description: "Summarize recent commits, contributor shape, evidence coverage, and follow-up risks for the latest delivery window.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Retro Scope",
        type: "text",
        required: false,
        placeholder: "Example: Summarize what we shipped this sprint and where the delivery risks are clustering.",
      },
      {
        key: "sinceDays",
        label: "Since Days",
        type: "text",
        required: false,
      },
    ],
  },
  {
    id: "product-scope-review",
    label: "Review product scope",
    description: "Challenge a product idea or PRD for scope discipline, wedge clarity, differentiation, and delivery risk.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Scope Statement",
        type: "text",
        required: true,
        placeholder: "Example: Review whether this release scope is too broad for the first milestone.",
      },
    ],
  },
  {
    id: "design-plan-review",
    label: "Review design plan",
    description: "Review a UI or page plan for information hierarchy, state coverage, accessibility, responsiveness, and interaction clarity.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Design Plan",
        type: "text",
        required: true,
        placeholder: "Example: Review this page brief for missing states and accessibility gaps before implementation.",
      },
    ],
  },
  {
    id: "security-review",
    label: "Run security review",
    description: "Run a bounded static audit across auth, proxy trust, execution, marketplace, and remote-access surfaces.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Security Scope",
        type: "text",
        required: false,
        placeholder: "Example: Audit remote access and token handling before the next release.",
      },
    ],
  },
  {
    id: "browser-qa-fix",
    label: "Apply browser QA fix",
    description: "Turn readonly browser evidence into a bounded low-risk HTML metadata fix, with Friday's existing mutation guardrails.",
    category: "skills",
    parameters: [
      {
        key: "goal",
        label: "Fix Goal or URL",
        type: "text",
        required: false,
        placeholder: "Example: Fix the page title on http://127.0.0.1:5173/settings.",
      },
      {
        key: "targetFile",
        label: "Target File",
        type: "text",
        required: false,
        placeholder: "Example: ui/index.html",
      },
    ],
  },
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

function asOutputRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

  async function syncAssistantHarnessFocus(input: {
    assistantSessionKey?: string;
    harness?: FridayTemplateHarnessSummary | null;
  }): Promise<void> {
    if (!deps.sessionService || !input.assistantSessionKey || !input.harness) {
      return;
    }
    await deps.sessionService.getOrCreateSession(input.assistantSessionKey);
    const currentFocus = await deps.sessionService.getConversationFocus(input.assistantSessionKey).catch(() => null);
    await deps.sessionService.setConversationFocus(input.assistantSessionKey, {
      ...(currentFocus ?? { updatedAt: nowIso() }),
      lastHarnessStage: input.harness.stage,
      lastHandoffArtifactId: input.harness.handoffArtifactId,
      lastHarnessSummary: input.harness.summary,
      updatedAt: nowIso(),
    });
  }

  function resolveIntentFromText(
    textInput: string,
    userId?: string,
  ): FridayBeginnerIntentResolution {
    const text = textInput.trim().toLowerCase();
    const persona = userId ? resolvePersona(userId) : undefined;
    if (
      text.includes("clarify")
      || text.includes("brainstorm")
      || text.includes("scope this")
      || (text.includes("idea") && !text.includes("workflow"))
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a request to clarify or scope an idea before implementation.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["idea-clarifier", "implementation-plan-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("implementation plan")
      || text.includes("architecture review")
      || text.includes("test matrix")
      || text.includes("execution plan")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.92,
        summary: "This looks like a request to review an execution plan before coding or shipping.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["implementation-plan-review", "workspace-diff-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("qa fix")
      || text.includes("browser qa fix")
      || text.includes("fix the page title")
      || ((text.includes("fix") || text.includes("repair")) && (text.includes("page") || text.includes("browser") || text.includes("console error")))
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a bounded browser QA fix request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["browser-qa-fix", "browser-qa-report"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("qa this")
      || text.includes("browser qa")
      || text.includes("test this page")
      || text.includes("test this app")
      || text.includes("screenshot")
      || text.includes("console error")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.91,
        summary: "This looks like a browser QA request with evidence capture.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["browser-qa-report", "workspace-diff-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("benchmark")
      || text.includes("page speed")
      || text.includes("web vitals")
      || text.includes("performance regression")
      || text.includes("lighthouse")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a page benchmark or performance baseline request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["page-benchmark-report", "release-canary-check"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("canary")
      || text.includes("post deploy")
      || text.includes("post-deploy")
      || text.includes("monitor this deploy")
      || text.includes("watch production")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a release canary or post-deploy check request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["release-canary-check", "page-benchmark-report"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("retro")
      || text.includes("retrospective")
      || text.includes("what did we ship")
      || text.includes("sprint summary")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.88,
        summary: "This looks like an engineering retrospective request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["engineering-retro", "release-canary-check"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("security review")
      || text.includes("security audit")
      || text.includes("threat model")
      || text.includes("owasp")
      || text.includes("token safety")
      || text.includes("remote access audit")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.91,
        summary: "This looks like a bounded security review request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["security-review", "workspace-diff-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("design review")
      || text.includes("design critique")
      || text.includes("ui review")
      || text.includes("design plan")
      || text.includes("accessibility review")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a design-plan review request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["design-plan-review", "browser-qa-report"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("scope review")
      || text.includes("scope this product")
      || text.includes("think bigger")
      || text.includes("ceo review")
      || text.includes("founder review")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.89,
        summary: "This looks like a product scope or wedge review request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["product-scope-review", "implementation-plan-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("review current changes")
      || text.includes("review this diff")
      || text.includes("review my pr")
      || text.includes("current workspace changes")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.9,
        summary: "This looks like a request to review the current workspace diff before landing it.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["workspace-diff-review", "release-doc-sync"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
    if (
      text.includes("sync release docs")
      || text.includes("update changelog")
      || text.includes("update readme")
      || text.includes("document what shipped")
    ) {
      return applyGuidance({
        intent: "general_help",
        confidence: 0.91,
        summary: "This looks like a bounded release documentation sync request.",
        routeTarget: "/assistant",
        suggestedTemplateIds: ["release-doc-sync", "workspace-diff-review"],
      }, buildAssistantGuidance({
        text: textInput,
        intent: "general_help",
        persona,
      }));
    }
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
        suggestedTemplateIds: ["review-issues", "recover-failed-deploy"],
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

  async function loadSkillHarnessSummary(sessionId: string): Promise<FridayTemplateHarnessSummary | null> {
    if (typeof deps.skillGenerator?.getHarnessSummary !== "function") {
      return null;
    }
    return deps.skillGenerator.getHarnessSummary(sessionId);
  }

  async function loadWorkflowHarnessSummary(sessionId: string): Promise<FridayTemplateHarnessSummary | null> {
    if (typeof deps.workflowGenerator?.getHarnessSummary !== "function") {
      return null;
    }
    return deps.workflowGenerator.getHarnessSummary(sessionId);
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

  async function executeStarterSkillTemplate(input: {
    templateId: string;
    userId: string;
    skillId: string;
    parameters?: Record<string, unknown>;
    guidanceText: string;
    intent: FridayBeginnerIntentResolution["intent"];
    defaultSummary: string;
  }) {
    if (!deps.skillExecutor) {
      throw new FridayDomainError(
        "UIX_STARTER_SKILL_UNAVAILABLE",
        "Bundled starter skills are not available in this runtime",
        { httpStatus: 503 },
      );
    }
    const handle = deps.skillExecutor.execute({
      skillId: input.skillId,
      input: input.parameters ?? {},
      sessionId: `assistant-template:${input.templateId}`,
      userId: input.userId,
      channel: "assistant",
    });
    const result = await handle.result;
    if (result.status !== "completed") {
      throw new FridayDomainError(
        "UIX_STARTER_SKILL_FAILED",
        result.stderr || `Starter skill "${input.skillId}" failed`,
        { httpStatus: 422 },
      );
    }
    const output = asOutputRecord(result.output);
    const summary =
      typeof output.summary === "string" && output.summary.trim().length > 0
        ? output.summary.trim()
        : input.defaultSummary;
    return {
      response: applyGuidance({
        templateId: input.templateId,
        status: "executed" as const,
        summary,
        routeTarget: "/assistant" as const,
        result: {
          skillId: input.skillId,
          runId: result.runId,
          nextStep: output.nextStep,
          output,
        },
      }, buildUserGuidance(input.userId, {
        text: input.guidanceText,
        intent: input.intent,
      })),
      output,
      runId: result.runId,
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
    try {
      deps.selfHealing.reportStructuredFailure({
        userId: input.userId,
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
    } catch (reportError) {
      console.warn("[friday] assistant failure reporting failed", reportError);
    }
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

    getDiagnostics(input) {
      return deps.diagnosticsBuilder?.(input) ?? {
        generatedAt: nowIso(),
        taskProfilePresets: [],
        recentRuns: [],
        mcpServerStates: [],
        supportedPreprocessors: [],
      };
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
          const harness = await loadSkillHarnessSummary(response.session.sessionId);
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
            harness: harness ?? undefined,
          }, buildGuidance({
            text: goal,
            intent: "generate_skill",
            questions: response.questions,
          }));
          await syncAssistantHarnessFocus({
            assistantSessionKey: input.assistantSessionKey,
            harness,
          });
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
          const harness = previewResponse?.session.sessionId ?? sessionId
            ? await loadWorkflowHarnessSummary(previewResponse?.session.sessionId ?? sessionId!)
            : null;
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
              harness: harness ?? undefined,
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
              harness: harness ?? undefined,
            }, buildGuidance({
              text: goal,
              intent: "generate_workflow",
              questions: previewResponse!.questions ?? [],
            }));
          await syncAssistantHarnessFocus({
            assistantSessionKey: input.assistantSessionKey,
            harness,
          });
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
          try {
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
          } catch (err) {
            if (err instanceof FridayDomainError) throw err;
            throw new FridayDomainError(
              "UIX_DEPLOY_FAILED",
              err instanceof Error ? err.message : "Workflow deployment failed unexpectedly",
              { httpStatus: 422 },
            );
          }
        }
        case "recover-failed-deploy": {
          if (deps.skillExecutor) {
            const executed = await executeStarterSkillTemplate({
              templateId: input.templateId,
              userId: input.userId,
              skillId: "failed-deploy-recovery-brief",
              guidanceText: "Recover failed deploy",
              intent: "review_issues",
              defaultSummary: "Friday summarized the current failed deploy recovery path.",
            });
            const details = asOutputRecord(executed.output.details);
            const action = asOutputRecord(details.action);
            const responsePayload: FridayUixTemplateExecutionResponse = {
              ...executed.response,
              workflow: executed.output.summary
                ? blockedWorkflowCard({
                  workflowName: "Workflow deploy",
                  summary: typeof executed.output.nextStep === "string" && executed.output.nextStep.trim().length > 0
                    ? `${executed.output.summary} ${executed.output.nextStep}`.trim()
                    : executed.response.summary,
                })
                : undefined,
              result: {
                ...executed.response.result,
                requiresApproval: Boolean(action.requiresApproval),
                recommendedSkillId: details.recommendedSkillId,
                recommendedTemplateId: details.recommendedTemplateId,
              },
            };
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "template_executed",
              summary: responsePayload.summary,
              result: responsePayload,
            });
            return responsePayload;
          }
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
          if (deps.skillExecutor) {
            const executed = await executeStarterSkillTemplate({
              templateId: input.templateId,
              userId: input.userId,
              skillId: "review-open-issues",
              parameters: { limit: 10 },
              guidanceText: "Review detected issues",
              intent: "review_issues",
              defaultSummary: "Friday reviewed the current issue queue.",
            });
            await deps.observability?.recordAssistantEvent({
              userId: input.userId,
              event: "template_executed",
              summary: executed.response.summary,
              result: executed.response,
            });
            return executed.response;
          }
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
        case "idea-clarifier": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "idea-clarifier",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Clarify an idea",
            intent: "general_help",
            defaultSummary: "Friday clarified the idea and identified the next planning step.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "implementation-plan-review": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "implementation-plan-review",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Review implementation plan",
            intent: "general_help",
            defaultSummary: "Friday reviewed the implementation plan and surfaced the main execution gaps.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "browser-qa-report": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "browser-qa-report",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "QA this page or app",
            intent: "general_help",
            defaultSummary: "Friday ran a browser QA pass and collected evidence.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "workspace-diff-review": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "workspace-diff-review",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Review current changes",
            intent: "general_help",
            defaultSummary: "Friday reviewed the current workspace diff and highlighted the main landing risks.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "release-doc-sync": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "release-doc-sync",
            parameters: {
              ...input.parameters,
              apply: true,
            },
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Sync release docs",
            intent: "general_help",
            defaultSummary: "Friday synchronized the bounded release-facing docs for the current workspace changes.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "page-benchmark-report": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "page-benchmark-report",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Benchmark this page",
            intent: "general_help",
            defaultSummary: "Friday benchmarked the page and compared the result with the saved local baseline.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "release-canary-check": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "release-canary-check",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Run release canary check",
            intent: "general_help",
            defaultSummary: "Friday ran a release canary check and captured browser evidence.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "engineering-retro": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "engineering-retro",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Generate engineering retro",
            intent: "general_help",
            defaultSummary: "Friday generated an engineering retro for the latest delivery window.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "product-scope-review": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "product-scope-review",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Review product scope",
            intent: "general_help",
            defaultSummary: "Friday reviewed the product scope and highlighted wedge and delivery risks.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "design-plan-review": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "design-plan-review",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Review design plan",
            intent: "general_help",
            defaultSummary: "Friday reviewed the design plan and highlighted missing states and interaction gaps.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "security-review": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "security-review",
            parameters: input.parameters,
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Run security review",
            intent: "general_help",
            defaultSummary: "Friday ran a bounded static security review and persisted a local threat-model report.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
        }
        case "browser-qa-fix": {
          const executed = await executeStarterSkillTemplate({
            templateId: input.templateId,
            userId: input.userId,
            skillId: "browser-qa-fix",
            parameters: {
              ...input.parameters,
              apply: true,
            },
            guidanceText: typeof input.parameters.goal === "string" ? input.parameters.goal : "Apply browser QA fix",
            intent: "general_help",
            defaultSummary: "Friday prepared or applied a bounded browser QA fix using the existing mutation guardrails.",
          });
          await deps.observability?.recordAssistantEvent({
            userId: input.userId,
            event: "template_executed",
            summary: executed.response.summary,
            result: executed.response,
          });
          return executed.response;
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
      const goalWizardDefs: Record<string, { title: string; goalPrompt: string }> = {
        "guided-assistant": { title: "Guided Assistant", goalPrompt: "Tell Friday what you want to do in one sentence." },
        "build-new": { title: "Build Something New", goalPrompt: "Describe what you want to build. Friday will plan and guide you." },
        "fix-broken": { title: "Fix What's Broken", goalPrompt: "Describe the problem. Friday will diagnose and suggest fixes." },
        "ship-fast": { title: "Ship & Release", goalPrompt: "What are you shipping? Friday will run QA, checks, and docs." },
        "understand-system": { title: "Understand Your System", goalPrompt: "What do you want to understand? Friday will investigate." },
        "automate-work": { title: "Automate Repetitive Work", goalPrompt: "What task do you want automated? Friday will build the workflow." },
        "content-social": { title: "Content & Social Media", goalPrompt: "What content or social media operation? Friday will plan the flow." },
        "ecommerce": { title: "E-commerce & Cross-border", goalPrompt: "What e-commerce goal? Friday will research products, platforms, and data." },
        "team-management": { title: "Manage a Team", goalPrompt: "What team operation? Friday will set up task tracking and workflows." },
        "ai-saas-build": { title: "Build an AI App / SaaS", goalPrompt: "Describe the AI product idea. Friday will plan architecture and implementation." },
        "invest-trade": { title: "Investment & Trading", goalPrompt: "What investment goal? Friday will research and automate your analysis." },
      };

      const wizardDef = goalWizardDefs[input.wizardId];
      if (!wizardDef) {
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
        assistantSessionKey: input.assistantSessionKey,
        title: wizardDef.title,
        status: "awaiting_input",
        currentStepId: "goal",
        steps: [
          {
            id: "goal",
            title: "Describe your goal",
            prompt: wizardDef.goalPrompt,
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
        const assistantSessionKey = input.assistantSessionKey ?? context.assistantSessionKey;
        context.assistantSessionKey = assistantSessionKey;

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
          const harness = await loadWorkflowHarnessSummary(context.workflowSessionId);
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
              harness: harness ?? undefined,
            }, buildUserGuidance(input.userId, {
              text: goal,
              intent: resolvedIntent.intent,
              questions: response.response.questions ?? [],
            }));
            await syncAssistantHarnessFocus({
              assistantSessionKey,
              harness,
            });
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
                harness: harness ?? undefined,
              }, buildUserGuidance(input.userId, {
                text: goal,
                intent: resolvedIntent.intent,
              }));
              await syncAssistantHarnessFocus({
                assistantSessionKey,
                harness,
              });
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
              harness: harness ?? undefined,
            }, buildUserGuidance(input.userId, {
              text: goal,
              intent: resolvedIntent.intent,
              blockedByPolicy: true,
              unknowns: response.workflow.questions,
            }));
            await syncAssistantHarnessFocus({
              assistantSessionKey,
              harness,
            });
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
            harness: harness ?? undefined,
          }, buildUserGuidance(input.userId, {
            text: goal,
            intent: resolvedIntent.intent,
          }));
          await syncAssistantHarnessFocus({
            assistantSessionKey,
            harness,
          });
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
        const harness = await loadSkillHarnessSummary(response.session.sessionId);
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
            harness: harness ?? undefined,
          }, buildUserGuidance(input.userId, {
            text: goal,
            intent: "generate_skill",
            questions: response.questions ?? [],
          }));
          await syncAssistantHarnessFocus({
            assistantSessionKey,
            harness,
          });
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
          harness: harness ?? undefined,
        }, buildUserGuidance(input.userId, {
          text: goal,
          intent: "generate_skill",
        }));
        await syncAssistantHarnessFocus({
          assistantSessionKey,
          harness,
        });
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
          const harness = await loadWorkflowHarnessSummary(context.workflowSessionId);
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
              harness: harness ?? undefined,
            }, buildUserGuidance(input.userId, {
              text: String(context.collectedValues.goal ?? "Workflow"),
              intent: context.resolvedIntent ?? "generate_workflow",
              questions: response.response.questions ?? [],
            }));
            await syncAssistantHarnessFocus({
              assistantSessionKey,
              harness,
            });
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
              harness: harness ?? undefined,
            }, buildUserGuidance(input.userId, {
              text: String(context.collectedValues.goal ?? "Workflow"),
              intent: context.resolvedIntent ?? "deploy_workflow",
              }));
              await syncAssistantHarnessFocus({
                assistantSessionKey,
                harness,
              });
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
              harness: harness ?? undefined,
            }, buildUserGuidance(input.userId, {
              text: String(context.collectedValues.goal ?? "Workflow"),
              intent: context.resolvedIntent ?? "deploy_workflow",
              blockedByPolicy: true,
              unknowns: response.workflow.questions,
            }));
            await syncAssistantHarnessFocus({
              assistantSessionKey,
              harness,
            });
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
            harness: harness ?? undefined,
          }, buildUserGuidance(input.userId, {
            text: String(context.collectedValues.goal ?? "Workflow"),
            intent: context.resolvedIntent ?? "generate_workflow",
          }));
          await syncAssistantHarnessFocus({
            assistantSessionKey,
            harness,
          });
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
        const harness = await loadSkillHarnessSummary(context.skillSessionId);
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
            harness: harness ?? undefined,
          }, buildUserGuidance(input.userId, {
            text: String(context.collectedValues.goal ?? "Skill"),
            intent: "generate_skill",
            questions: response.questions ?? [],
          }));
          await syncAssistantHarnessFocus({
            assistantSessionKey,
            harness,
          });
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
          harness: harness ?? undefined,
        }, buildUserGuidance(input.userId, {
          text: String(context.collectedValues.goal ?? "Skill"),
          intent: "generate_skill",
        }));
        await syncAssistantHarnessFocus({
          assistantSessionKey,
          harness,
        });
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
