import type { FridayProviderApi, FridayProviderService, FridayResolvedProviderRoute } from "#providers";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL, FRIDAY_MEMORY_ERROR_CODES } from "../friday-memory.constants.js";

// ─── Types ───

export interface FridayMemoryByokEmbeddingClient {
  embed(text: string): Promise<FridayMemoryEmbeddingResponse>;
}

export interface FridayMemoryEmbeddingResponse {
  vector: number[];
  model: string;
  providerId: string;
  dimensions: number;
}

export interface CreateFridayMemoryByokEmbeddingClientDeps {
  providerService: FridayProviderService;
  embeddingModel?: string;
  /**
   * Per-attempt timeout (ms) for the outbound BYOK embedding fetch.
   *
   * B3 hanging-fetch boundary: without this, a hung embedding endpoint
   * blocks every memory store/search/dedup operation that needs an
   * embedding, propagating the hang up the cognition stack. Default 30s
   * matches the typical embedding-call upper bound (shorter than full
   * LLM completions because embeddings should be fast).
   */
  fetchTimeoutMs?: number;
}

/** Default per-attempt timeout for the BYOK embedding fetch. */
const FRIDAY_DEFAULT_MEMORY_EMBEDDING_TIMEOUT_MS = 30_000;

// ─── Supported API embedding endpoints ───

const EMBEDDING_ENDPOINT_MAP: Partial<Record<FridayProviderApi, string>> = {
  "openai-completions": "/v1/embeddings",
  "openai-responses": "/v1/embeddings",
};

function isEmbeddingSupported(api: FridayProviderApi): boolean {
  return api in EMBEDDING_ENDPOINT_MAP;
}

function getEmbeddingEndpoint(api: FridayProviderApi): string {
  const endpoint = EMBEDDING_ENDPOINT_MAP[api];
  if (!endpoint) {
    throw new FridayDomainError(
      FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNSUPPORTED_PROVIDER,
      `Provider API '${api}' does not support embeddings`,
      { httpStatus: 400 },
    );
  }
  return endpoint;
}

// ─── Response parsing ───

interface OpenAiEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
}

function isOpenAiEmbeddingResponse(val: unknown): val is OpenAiEmbeddingResponse {
  if (val == null || typeof val !== "object") return false;
  const obj = val as Record<string, unknown>;
  if (!Array.isArray(obj.data)) return false;
  if (obj.data.length === 0) return false;
  const first = obj.data[0] as Record<string, unknown>;
  return Array.isArray(first.embedding);
}

// ─── Factory ───

export function createFridayMemoryByokEmbeddingClient(
  deps: CreateFridayMemoryByokEmbeddingClientDeps,
): FridayMemoryByokEmbeddingClient {
  return {
    async embed(text) {
      const outcome = await deps.providerService.runWithFallback<unknown>({
        requestedModel: deps.embeddingModel ?? FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL,
        routingContext: {
          estimatedInputTokens: text.length,
          complexity: "simple",
          requiredCapabilities: ["embedding"],
        },
        run: async (
          route: FridayResolvedProviderRoute,
          credential: string | null,
        ) => {
          const api = route.provider.config.api;

          if (!isEmbeddingSupported(api)) {
            throw new FridayDomainError(
              FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNSUPPORTED_PROVIDER,
              `Provider API '${api}' does not support embeddings`,
              { httpStatus: 400 },
            );
          }

          const endpoint = getEmbeddingEndpoint(api);
          const baseUrl = route.provider.baseUrl.replace(/\/+$/, "");
          const url = `${baseUrl}${endpoint}`;

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(route.provider.config.headers ?? {}),
          };

          if (credential) {
            headers["Authorization"] = `Bearer ${credential}`;
          }

          const model = deps.embeddingModel ?? FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL;

          const fetchTimeoutMs = deps.fetchTimeoutMs ?? FRIDAY_DEFAULT_MEMORY_EMBEDDING_TIMEOUT_MS;
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({
                input: text,
                model,
              }),
              signal: AbortSignal.timeout(fetchTimeoutMs),
            });
          } catch (fetchError) {
            // B3 hanging-fetch boundary: translate AbortSignal.timeout into
            // the existing EMBEDDING_UNAVAILABLE shape so the upstream
            // fallback chain can advance instead of blocking the memory
            // store/search/dedup pipeline indefinitely.
            if (fetchError instanceof Error && (fetchError.name === "TimeoutError" || fetchError.name === "AbortError")) {
              throw new FridayDomainError(
                FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNAVAILABLE,
                `Embedding request timed out after ${fetchTimeoutMs}ms`,
                { httpStatus: 504, retryable: true, details: { timeoutMs: fetchTimeoutMs } },
              );
            }
            throw fetchError;
          }

          if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new FridayDomainError(
              FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNAVAILABLE,
              `Embedding request failed: HTTP ${String(response.status)} — ${body}`,
              { httpStatus: 502, retryable: response.status >= 500 },
            );
          }

          return response.json();
        },
      });

      const data = outcome.result;

      if (!isOpenAiEmbeddingResponse(data)) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNAVAILABLE,
          "Unexpected embedding response format",
          { httpStatus: 502 },
        );
      }

      const vector = data.data[0].embedding;

      return {
        vector,
        model: data.model,
        providerId: outcome.route.provider.id,
        dimensions: vector.length,
      };
    },
  };
}
