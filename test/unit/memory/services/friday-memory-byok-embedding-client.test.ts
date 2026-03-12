import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFridayMemoryByokEmbeddingClient } from "#memory";
import type { FridayMemoryByokEmbeddingClient } from "#memory";
import type { FridayProviderService } from "#providers";
import type { FridayResolvedProviderRoute } from "#providers";
import { FridayDomainError } from "#errors";
import { FRIDAY_MEMORY_ERROR_CODES } from "#memory";

describe("FridayMemoryByokEmbeddingClient", () => {
  let client: FridayMemoryByokEmbeddingClient;
  const originalFetch = globalThis.fetch;
  const NOW = "2026-02-17T10:00:00.000Z";

  function makeRoute(api: string): FridayResolvedProviderRoute {
    return {
      provider: {
        id: "prov-1",
        kind: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: api as FridayResolvedProviderRoute["provider"]["config"]["api"],
          authMode: "api-key",
          keySource: { kind: "none" },
          supportedModels: ["text-embedding-3-small"],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "text-embedding-3-small",
    };
  }

  function createMockProviderService(
    route: FridayResolvedProviderRoute,
    fetchResponse?: Response,
  ): FridayProviderService {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        fetchResponse ??
          new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
              model: "text-embedding-3-small",
            }),
            { status: 200 },
          ),
      ),
    ) as typeof fetch;

    return {
      runWithFallback: vi.fn().mockImplementation(async (params) => {
        const result = await params.run(route, "sk-test");
        return {
          result,
          route,
          attempts: [],
          routingDecision: {
            strategy: "direct",
            reason: "test",
            budget: { withinBudget: true, remainingUsd: 100, monthlyLimitUsd: 100, spentUsd: 0 },
          },
        };
      }),
    } as unknown as FridayProviderService;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── OpenAI-compatible embeddings ───

  it("embeds text via openai-completions API", async () => {
    const route = makeRoute("openai-completions");
    const providerService = createMockProviderService(route);
    client = createFridayMemoryByokEmbeddingClient({ providerService });

    const result = await client.embed("Hello world");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.providerId).toBe("prov-1");
    expect(result.dimensions).toBe(3);
  });

  it("embeds text via openai-responses API", async () => {
    const route = makeRoute("openai-responses");
    const providerService = createMockProviderService(route);
    client = createFridayMemoryByokEmbeddingClient({ providerService });

    const result = await client.embed("Hello world");
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it("sends correct request to embedding endpoint", async () => {
    const route = makeRoute("openai-completions");
    const providerService = createMockProviderService(route);
    client = createFridayMemoryByokEmbeddingClient({
      providerService,
      embeddingModel: "text-embedding-3-small",
    });

    await client.embed("test input");

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/embeddings");
    const body = JSON.parse((call[1]?.body ?? "{}") as string) as Record<string, unknown>;
    expect(body.input).toBe("test input");
    expect(body.model).toBe("text-embedding-3-small");
  });

  // ─── Unsupported provider ───

  it("throws for unsupported provider API (anthropic)", async () => {
    const route = makeRoute("anthropic-messages");

    const providerService = {
      runWithFallback: vi.fn().mockImplementation(async (params) => {
        const result = await params.run(route, "sk-test");
        return { result, route, attempts: [], routingDecision: {} };
      }),
    } as unknown as FridayProviderService;

    client = createFridayMemoryByokEmbeddingClient({ providerService });

    await expect(client.embed("Hello")).rejects.toThrow(FridayDomainError);
    try {
      await client.embed("Hello");
    } catch (err) {
      expect(err).toBeInstanceOf(FridayDomainError);
      expect((err as FridayDomainError).code).toBe(FRIDAY_MEMORY_ERROR_CODES.EMBEDDING_UNSUPPORTED_PROVIDER);
    }
  });

  it("throws for unsupported provider API (ollama)", async () => {
    const route = makeRoute("ollama");

    const providerService = {
      runWithFallback: vi.fn().mockImplementation(async (params) => {
        const result = await params.run(route, null);
        return { result, route, attempts: [], routingDecision: {} };
      }),
    } as unknown as FridayProviderService;

    client = createFridayMemoryByokEmbeddingClient({ providerService });

    await expect(client.embed("Hello")).rejects.toThrow(FridayDomainError);
  });

  // ─── HTTP error handling ───

  it("throws on HTTP error from embedding endpoint", async () => {
    const route = makeRoute("openai-completions");
    const errorResponse = new Response("Internal Server Error", { status: 500 });
    const providerService = createMockProviderService(route, errorResponse);
    client = createFridayMemoryByokEmbeddingClient({ providerService });

    await expect(client.embed("Hello")).rejects.toThrow(FridayDomainError);
  });

  // ─── Unexpected response format ───

  it("throws on unexpected response format", async () => {
    const route = makeRoute("openai-completions");
    const weirdResponse = new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    const providerService = createMockProviderService(route, weirdResponse);
    client = createFridayMemoryByokEmbeddingClient({ providerService });

    await expect(client.embed("Hello")).rejects.toThrow(FridayDomainError);
  });
});
