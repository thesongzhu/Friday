import type { FridayProviderKind } from "../model/friday-provider.types.js";

// ─── Constants ───

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 8;

const CONTEXT_WINDOW_BY_PROVIDER: Partial<Record<FridayProviderKind, number>> = {
  openai: 128_000,
  "openai-codex": 128_000,
  anthropic: 200_000,
  google: 131_072,
  ollama: 16_384,
  "openai-compatible": 32_768,
  openrouter: 128_000,
  xai: 128_000,
  mistral: 128_000,
  groq: 128_000,
  cerebras: 128_000,
  huggingface: 128_000,
  vllm: 32_768,
  litellm: 128_000,
};

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

// ─── Interface ───

export interface FridayProviderTokenEstimator {
  estimateTextTokens(text: string): number;
  estimateMessagesTokens(messages: ReadonlyArray<{ role: string; content: string }>): number;
  getContextWindow(providerKind: FridayProviderKind): number;
}

// ─── Factory ───

export function createFridayProviderTokenEstimator(): FridayProviderTokenEstimator {
  return {
    estimateTextTokens(text) {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    },

    estimateMessagesTokens(messages) {
      let total = 0;
      for (const msg of messages) {
        total += Math.ceil(msg.content.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
      }
      return total;
    },

    getContextWindow(providerKind) {
      return CONTEXT_WINDOW_BY_PROVIDER[providerKind] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    },
  };
}
