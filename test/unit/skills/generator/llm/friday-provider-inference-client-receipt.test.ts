import { describe, it, expect, vi } from "vitest";

import { createFridayProviderInferenceClient } from "#skills/generator";
import type { FridayProviderService } from "#providers";
import type {
  FridayProviderProfile,
  FridayResolvedProviderRoute,
} from "#providers";

// BYOK-PROVIDER-COST-RECEIPT-001 — drive the REAL inference-client provider
// call-completion path with a MOCKED provider response (synthetic request-id +
// usage). No real provider call, no real key. We assert the real wiring:
//  1. the provider's request-id is captured and handed to recordUsage;
//  2. a failed/offline call is NOT charged (recordUsage never fires).
describe("inference-client provider-call receipt wiring", () => {
  function createMockProvider(recordUsage: ReturnType<typeof vi.fn>): FridayProviderService {
    const mockProfile: FridayProviderProfile = {
      id: "provider-1",
      kind: "openai",
      name: "Test Provider",
      baseUrl: "https://api.test.com",
      enabled: true,
      defaultModel: "gpt-4",
      config: {
        api: "openai-completions",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["gpt-4"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    const route: FridayResolvedProviderRoute = { provider: mockProfile, model: "gpt-4" };

    return {
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(route, "test-key"); // pragma: allowlist secret
        return { result, route, attempts: [] };
      }),
      recordUsage,
    } as unknown as FridayProviderService;
  }

  it("captures the provider response id and forwards it to recordUsage", async () => {
    const recordUsage = vi.fn().mockResolvedValue({ recorded: true, duplicate: false });
    const mockProvider = createMockProvider(recordUsage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chatcmpl-CAPTURED-42",
        choices: [{ message: { content: '{"state":"ready_for_generation","spec":{}}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({ providerService: mockProvider });
      await client.infer<{ state: string }>({
        prompt: { system: "You are a test assistant", user: "Test input" },
      });

      expect(recordUsage).toHaveBeenCalledTimes(1);
      const arg = recordUsage.mock.calls[0]![0] as { requestId?: string | null; costUsd: number };
      expect(arg.requestId).toBe("chatcmpl-CAPTURED-42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers the transport x-request-id header over the body id", async () => {
    const recordUsage = vi.fn().mockResolvedValue({ recorded: true, duplicate: false });
    const mockProvider = createMockProvider(recordUsage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (n: string) => (n === "x-request-id" ? "req-HEADER-7" : null) },
      json: async () => ({
        id: "chatcmpl-BODY-should-lose",
        choices: [{ message: { content: '{"state":"ready_for_generation","spec":{}}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({ providerService: mockProvider });
      await client.infer<{ state: string }>({
        prompt: { system: "test", user: "test" },
      });
      const arg = recordUsage.mock.calls[0]![0] as { requestId?: string | null };
      expect(arg.requestId).toBe("req-HEADER-7");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT record usage for a failed provider call (not charged)", async () => {
    const recordUsage = vi.fn().mockResolvedValue({ recorded: true, duplicate: false });
    const mockProvider = createMockProvider(recordUsage);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    try {
      const client = createFridayProviderInferenceClient({ providerService: mockProvider });
      await expect(
        client.infer({ prompt: { system: "test", user: "test" } }),
      ).rejects.toThrow("returned 500");

      // The failed call threw before any usage was produced — no charge recorded.
      expect(recordUsage).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
