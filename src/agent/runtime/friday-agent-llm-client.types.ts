import type {
  FridayAgentMessage,
  FridayAgentToolDefinition,
} from "../model/friday-agent.types.js";
import type { FridayProviderApi } from "#providers";

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
  /** Actual provider that served this response (IMPL-2). */
  actualProviderId?: string;
  /** Actual model used (may differ from requested). */
  actualModel?: string;
  /** Provider kind (e.g. "anthropic", "openai"). */
  actualProviderKind?: string;
  /** Provider API type (e.g. "anthropic-messages", "openai-chat"). */
  actualProviderApi?: string;
  /** Estimated cost in USD for this turn. */
  costUsd?: number;
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
  model: string;
  systemPrompt: string;
  messages: FridayAgentMessage[];
  tools: FridayAgentToolDefinition[];
  signal: AbortSignal;
}

// ─── Factory deps ───

export interface CreateFridayAgentLlmClientDeps {
  baseUrl: string;
  apiKey: string;
  /** Provider API type. Defaults to "anthropic-messages" for backwards compat. */
  api?: FridayProviderApi;
  fetchImpl?: typeof fetch;
}
