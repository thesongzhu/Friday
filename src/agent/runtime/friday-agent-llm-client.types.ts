import type {
  FridayAgentMessage,
  FridayAgentToolDefinition,
} from "../model/friday-agent.types.js";
import type {
  FridayProviderApi,
  FridayProviderAttempt,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCliConfig,
  FridayProviderRoutingDecisionTrace,
  FridayProviderTenantContext,
  FridayRuntimeCapabilityId,
} from "#providers";

// ─── Streaming event types ───

export interface FridayAgentLlmTextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface FridayAgentLlmToolUseEvent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FridayAgentLlmMessageEndEvent {
  type: "message_end";
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt cache: tokens read from cache (saves input cost). */
  cacheReadInputTokens?: number;
  /** Anthropic prompt cache: tokens written to cache on first call. */
  cacheCreationInputTokens?: number;
  /** Actual provider that served this response (IMPL-2). */
  actualProviderId?: string;
  /** Actual model used (may differ from requested). */
  actualModel?: string;
  /** Provider kind (e.g. "anthropic", "openai"). */
  actualProviderKind?: string;
  /** Provider API type (e.g. "anthropic-messages", "openai-chat"). */
  actualProviderApi?: string;
  backendKind?: FridayProviderBackendKind;
  /** Estimated cost in USD for this turn. */
  costUsd?: number;
  /**
   * The provider's own request identifier for the completed turn (x-request-id /
   * request-id header, or the response body id). Surfaced so the agent-runtime
   * usage record is idempotent on it and carries a tamper-detectable receipt.
   * Null/absent for providers that surface none (e.g. local Ollama) or backends
   * with no HTTP response (CLI) — those record without a receipt, as before.
   */
  requestId?: string | null;
  /** Ordered failed attempts before the successful route, if any. */
  attempts?: FridayProviderAttempt[];
  routingDecisionReason?: string;
  learningAdjusted?: boolean;
  routeDecisionTrace?: FridayProviderRoutingDecisionTrace;
}

export type FridayAgentLlmStreamEvent =
  | FridayAgentLlmTextDeltaEvent
  | FridayAgentLlmToolUseEvent
  | FridayAgentLlmMessageEndEvent;

// ─── Client interface ───

export interface FridayAgentLlmClient {
  stream(params: FridayAgentLlmStreamParams): AsyncIterable<FridayAgentLlmStreamEvent>;
}

export interface FridayAgentLlmStreamParams {
  providerId?: string;
  tenantContext?: FridayProviderTenantContext;
  model: string;
  systemPrompt: string;
  messages: FridayAgentMessage[];
  tools: FridayAgentToolDefinition[];
  temperature?: number;
  routingContext?: {
    estimatedInputTokens: number;
    complexity: "simple" | "medium" | "complex";
    requiresNativeTools?: boolean;
    taskProfileId?: string;
    contextWindowTokens?: number;
    dataSensitivity?: "public" | "internal" | "confidential" | "secret";
    latencyBudgetMs?: number;
    localOnly?: boolean;
    noEgress?: boolean;
    satelliteAvailable?: boolean;
    requiredCapabilities?: FridayRuntimeCapabilityId[];
  };
  signal: AbortSignal;
}

// ─── Factory deps ───

export interface CreateFridayAgentLlmClientDeps {
  baseUrl?: string;
  apiKey?: string;
  /** Provider API type. Defaults to "anthropic-messages" for backwards compat. */
  api?: FridayProviderApi;
  backendKind?: FridayProviderBackendKind;
  cliConfig?: FridayProviderCliConfig;
  /** Auth mode is needed for Anthropic bearer-based auth (oauth/setup-token) because it uses Bearer headers, not x-api-key. */
  authMode?: FridayProviderAuthMode;
  fetchImpl?: typeof fetch;
  /** Allow loopback/private addresses (for self-hosted deployments using local providers like Ollama). */
  allowPrivateNetwork?: boolean;
}
