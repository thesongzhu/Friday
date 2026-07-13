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
        case "openai-codex-responses":
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
    total: input + output,
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
    total: input + output,
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

// ─── Request-id extraction ───

/**
 * A response's HTTP headers, tolerant of the shapes we actually see:
 *  - a real `Headers` instance (production `fetch`) — has `.get()`
 *  - a plain object of header pairs (some test doubles)
 *  - `undefined` (test doubles that mock only `{ ok, json }`)
 */
export type FridayProviderResponseHeaders =
  | { get(name: string): string | null }
  | Record<string, string | undefined>
  | undefined
  | null;

function readHeader(
  headers: FridayProviderResponseHeaders,
  name: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? null;
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? null;
}

function safeString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val : null;
}

/**
 * Extracts the provider's own request identifier for a completed call. Prefers
 * the transport header (`x-request-id` / `request-id`) that OpenAI and
 * Anthropic emit, then falls back to the response body id the provider echoes
 * (`id` for OpenAI chat/responses and Anthropic messages; `responseId` for
 * Google). Returns null for providers that surface none (e.g. local Ollama) —
 * such a call is recorded without a receipt rather than with a fabricated one.
 */
export function extractProviderRequestId(
  api: FridayProviderApi,
  headers: FridayProviderResponseHeaders,
  responseBody: Record<string, unknown>,
): string | null {
  const headerId =
    readHeader(headers, "x-request-id") ?? readHeader(headers, "request-id");
  if (headerId) return headerId;

  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "anthropic-messages":
      return safeString(responseBody["id"]);
    case "google-generative-ai":
      return safeString(responseBody["responseId"]);
    case "ollama":
      return null;
  }
}

// ─── Helpers ───

function safeNumber(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  return 0;
}

function emptyUsage(): FridayProviderNormalizedUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
