import type { FridaySkillGeneratorPrompt } from "../prompts/friday-skill-generator-prompts.js";
import type {
  FridayInferenceSessionContext,
  FridayProviderNormalizedUsage,
  FridayProviderRouteStrategy,
  FridayProviderTenantContext,
} from "#providers";
import type { FridayAgentTaskProfileId, FridayAgentTaskProfileInput } from "../../../agent/runtime/friday-agent-task-profile.js";

// ─── Inference request ───

export interface FridayInferenceRequest {
  prompt: FridaySkillGeneratorPrompt;
  requestedModel?: string;
  sessionContext?: FridayInferenceSessionContext;
  taskProfile?: FridayAgentTaskProfileId | FridayAgentTaskProfileInput;
  tenantContext?: FridayProviderTenantContext;
}

// ─── Inference result ───

export interface FridayInferenceResult<T> {
  parsed: T;
  rawText: string;
  model: string;
  providerId: string;
  usage?: FridayProviderNormalizedUsage;
  costUsd?: number;
  routeStrategy?: FridayProviderRouteStrategy;
}

// ─── Inference error ───

export interface FridayInferenceError {
  code: "PARSE_ERROR" | "PROVIDER_ERROR" | "EMPTY_RESPONSE";
  message: string;
  rawText?: string;
}

// ─── Client interface ───

export interface FridayProviderInferenceClient {
  infer<T>(request: FridayInferenceRequest): Promise<FridayInferenceResult<T>>;
}
