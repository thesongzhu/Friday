import type { FridayProviderApi } from "../model/friday-provider.types.js";
import type { FridayProviderNormalizedUsage } from "../model/friday-provider-cost.types.js";

// ─── Interface ───

export interface FridayProviderUsageNormalizer {
  normalize(api: FridayProviderApi, responseBody: Record<string, unknown>): FridayProviderNormalizedUsage;
}

// ─── Factory ───

export function createFridayProviderUsageNormalizer(): FridayProviderUsageNormalizer {
  return {
    normalize(api, responseBody) {
      switch (api) {
        case "openai-completions":
          return normalizeOpenAiCompletions(responseBody);
        case "openai-responses":
          return normalizeOpenAiResponses(responseBody);
        case "anthropic-messages":
          return normalizeAnthropicMessages(responseBody);
        case "google-generative-ai":
          return normalizeGoogleGenerativeAi(responseBody);
        case "ollama":
          return normalizeOllama(responseBody);
      }
    },
  };
}

// ─── OpenAI Chat Completions ───

function normalizeOpenAiCompletions(body: Record<string, unknown>): FridayProviderNormalizedUsage {
  const usage = body["usage"] as Record<string, unknown> | undefined;
  if (!usage) return emptyUsage();

  const input = safeNumber(usage["prompt_tokens"]);
  const output = safeNumber(usage["completion_tokens"]);
  // OpenAI provides cache info in prompt_tokens_details
  const details = usage["prompt_tokens_details"] as Record<string, unknown> | undefined;
  const cacheRead = safeNumber(details?.["cached_tokens"]);
  const cacheWrite = 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

// ─── OpenAI Responses ───

function normalizeOpenAiResponses(body: Record<string, unknown>): FridayProviderNormalizedUsage {
  const usage = body["usage"] as Record<string, unknown> | undefined;
  if (!usage) return emptyUsage();

  const input = safeNumber(usage["input_tokens"]);
  const output = safeNumber(usage["output_tokens"]);
  // Responses API provides input_tokens_details
  const details = usage["input_tokens_details"] as Record<string, unknown> | undefined;
  const cacheRead = safeNumber(details?.["cached_tokens"]);

  const cacheWrite = 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

// ─── Anthropic Messages ───

function normalizeAnthropicMessages(body: Record<string, unknown>): FridayProviderNormalizedUsage {
  const usage = body["usage"] as Record<string, unknown> | undefined;
  if (!usage) return emptyUsage();

  const input = safeNumber(usage["input_tokens"]);
  const output = safeNumber(usage["output_tokens"]);
  const cacheRead = safeNumber(usage["cache_read_input_tokens"]);
  const cacheWrite = safeNumber(usage["cache_creation_input_tokens"]);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

// ─── Google Generative AI ───

function normalizeGoogleGenerativeAi(body: Record<string, unknown>): FridayProviderNormalizedUsage {
  const metadata = body["usageMetadata"] as Record<string, unknown> | undefined;
  if (!metadata) return emptyUsage();

  const input = safeNumber(metadata["promptTokenCount"]);
  const output = safeNumber(metadata["candidatesTokenCount"]);
  const cacheRead = safeNumber(metadata["cachedContentTokenCount"]);
  const cacheWrite = 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

// ─── Ollama ───

function normalizeOllama(body: Record<string, unknown>): FridayProviderNormalizedUsage {
  const input = safeNumber(body["prompt_eval_count"]);
  const output = safeNumber(body["eval_count"]);
  const cacheRead = 0;
  const cacheWrite = 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

// ─── Helpers ───

function safeNumber(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return 0;
}

function emptyUsage(): FridayProviderNormalizedUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
