import type { FridayProviderApi, FridayProviderKind } from "./friday-provider.types.js";

// ─── Context message roles ───

export type FridayProviderContextRole =
  | "system"
  | "user"
  | "assistant"
  | "tool-result";

// ─── Session context message ───

export interface FridayProviderContextMessage {
  messageId: string;
  role: FridayProviderContextRole;
  content: string;
  createdAt: string;
  toolName?: string;
}

// ─── Session context for multi-turn inference ───

export interface FridayInferenceSessionContext {
  sessionId: string;
  specSummary: string;
  messages: FridayProviderContextMessage[];
}

// ─── Compaction summary extracted from pruned turns ───

export interface FridayContextCompactionSummary {
  summaryText: string;
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  toolFailures: string[];
  fileOperations: string[];
}

// ─── Result of compaction pass ───

export interface FridayContextCompactionResult {
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptMessages: FridayProviderContextMessage[];
  droppedMessages: FridayProviderContextMessage[];
  prunedMessageCount: number;
  summary?: FridayContextCompactionSummary;
}

// ─── Cache hint configuration per provider ───

export interface FridayPromptCacheHints {
  api: FridayProviderApi;
  providerKind: FridayProviderKind;
  anthropic: {
    enabled: boolean;
    systemCache: boolean;
    userStaticBlockIndexes: number[];
  };
  openaiSystemCache: {
    enabled: boolean;
  };
}

// ─── Full optimization result ───

export interface FridayContextOptimizationResult {
  systemPrompt: string;
  userPrompt: string;
  estimatedInputTokens: number;
  compaction: FridayContextCompactionResult;
  cacheHints: FridayPromptCacheHints;
}
