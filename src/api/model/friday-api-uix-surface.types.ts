import type { FridayIssueCard } from "./friday-api-self-healing.types.js";
import type { FridayAssistantWorkflowCard } from "./friday-api-workflow.types.js";
import type { FridayTemplateHarnessSummary } from "#harness";
import type {
  FridayAgentContextCostSummary,
  FridayAgentPreprocessorKind,
  FridayAgentRunStatus,
  FridayMcpServerState,
  FridayResolvedAgentTaskProfile,
} from "#agent";

export interface FridayBeginnerIntentResolution {
  intent:
    | "generate_skill"
    | "generate_workflow"
    | "deploy_workflow"
    | "export_workflow_bundle"
    | "review_issues"
    | "apply_fix"
    | "general_help";
  confidence: number;
  summary: string;
  routeTarget: "/assistant";
  suggestedTemplateIds: string[];
  state?: "ready_to_execute" | "needs_one_answer" | "blocked_by_policy" | "out_of_boundary";
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
}

export interface FridayActionTemplateSummary {
  id: string;
  label: string;
  description: string;
  category: "skills" | "workflows" | "issues" | "system";
  parameters: Array<{
    key: string;
    label: string;
    type: "text" | "boolean";
    required: boolean;
    placeholder?: string;
  }>;
}

export interface FridayGuidedWizardStepChoice {
  value: string;
  label: string;
  description: string;
  outcome: string;
  risk?: "low" | "medium" | "high";
  recommended?: boolean;
  reason?: string;
}

export interface FridayGuidedWizardStep {
  id: string;
  title: string;
  prompt: string;
  inputKey: string;
  kind?: "input" | "choice" | "investigation" | "confirmation";
  choices?: FridayGuidedWizardStepChoice[];
}

export interface FridayGuidedWizardState {
  wizardId: string;
  contextId: string;
  title: string;
  status: "awaiting_input" | "investigating" | "ready" | "completed" | "failed";
  currentStepId: string;
  steps: FridayGuidedWizardStep[];
  collectedValues: Record<string, unknown>;
  nextActionLabel?: string;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
}

export type FridayUserProfileType = "beginner" | "developer" | "creator" | "business";

export interface FridayUserProfileResponse {
  profileType: FridayUserProfileType | null;
  onboardedAt: string | null;
}

export interface FridayInvestigateRequest {
  goalCategoryId: string;
  context?: Record<string, unknown>;
  assistantSessionKey?: string;
}

export interface FridayInvestigateResponse {
  runId: string;
  wizardId: string;
}

export interface FridayUixTemplatesResponse {
  templates: FridayActionTemplateSummary[];
}

export interface FridayExecuteUixTemplateRequest {
  parameters?: Record<string, unknown>;
  assistantSessionKey?: string;
}

export interface FridayUixTemplateExecutionResponse {
  templateId: string;
  status: "preview" | "executed";
  summary: string;
  routeTarget: "/assistant";
  result?: Record<string, unknown>;
  workflow?: FridayAssistantWorkflowCard;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
  state?: FridayBeginnerIntentResolution["state"];
  harness?: FridayTemplateHarnessSummary;
}

export interface FridayUixIssuesResponse {
  items: FridayIssueCard[];
}

export interface FridayStartUixWizardRequest {
  assistantSessionKey?: string;
}

export interface FridayUixWizardResponse {
  wizard: FridayGuidedWizardState;
  summary?: string;
  result?: Record<string, unknown>;
  workflow?: FridayAssistantWorkflowCard;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
  state?: FridayBeginnerIntentResolution["state"];
  harness?: FridayTemplateHarnessSummary;
}

export interface FridayContinueUixWizardRequest {
  contextId: string;
  values?: Record<string, unknown>;
  assistantSessionKey?: string;
}

export interface FridayUixAssistantDiagnosticsRun {
  runId: string;
  task: string;
  status: FridayAgentRunStatus;
  startedAt?: string;
  completedAt?: string;
  contextCostSummary?: FridayAgentContextCostSummary;
  taskProfile?: FridayResolvedAgentTaskProfile;
}

export interface FridayUixAssistantDiagnostics {
  generatedAt: string;
  taskProfilePresets: FridayResolvedAgentTaskProfile[];
  recentRuns: FridayUixAssistantDiagnosticsRun[];
  mcpServerStates: FridayMcpServerState[];
  supportedPreprocessors: FridayAgentPreprocessorKind[];
}

export interface FridayUixDiagnosticsResponse {
  assistant: FridayUixAssistantDiagnostics;
}
