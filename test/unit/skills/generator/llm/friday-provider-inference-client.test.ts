import { describe, it, expect, vi } from "vitest";

import {
  createFridayProviderInferenceClient,
  _parseJsonFromText,
} from "#skills/generator";

import type { FridayProviderService } from "#providers";
import type {
  FridayProviderProfile,
  FridayResolvedProviderRoute,
  FridayInferenceSessionContext,
  FridayProviderContextMessage,
} from "#providers";
import { FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE } from "#providers";

// ─── parseJsonFromText tests ───

describe("_parseJsonFromText", () => {
  it("parses plain JSON object", () => {
    const result = _parseJsonFromText<{ foo: number }>('{"foo": 42}');
    expect(result).toEqual({ foo: 42 });
  });

  it("parses plain JSON array", () => {
    const result = _parseJsonFromText<number[]>("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts JSON from markdown code fence", () => {
    const input = '```json\n{"bar": "baz"}\n```';
    const result = _parseJsonFromText<{ bar: string }>(input);
    expect(result).toEqual({ bar: "baz" });
  });

  it("extracts JSON from unmarked code fence", () => {
    const input = '```\n{"bar": "baz"}\n```';
    const result = _parseJsonFromText<{ bar: string }>(input);
    expect(result).toEqual({ bar: "baz" });
  });

  it("extracts JSON embedded in prose", () => {
    const input = 'Here is the result: {"x": 1} and that is all.';
    const result = _parseJsonFromText<{ x: number }>(input);
    expect(result).toEqual({ x: 1 });
  });

  it("extracts JSON array from prose", () => {
    const input = 'The files are: [{"path": "a.js"}]';
    const result = _parseJsonFromText<Array<{ path: string }>>(input);
    expect(result).toEqual([{ path: "a.js" }]);
  });

  it("throws on completely invalid input", () => {
    expect(() => _parseJsonFromText("not json at all")).toThrow(
      "Failed to parse JSON",
    );
  });

  it("handles whitespace around JSON", () => {
    const result = _parseJsonFromText<{ a: number }>("   \n  {\"a\": 1}  \n  ");
    expect(result).toEqual({ a: 1 });
  });
});

// ─── Integration test with mocked provider ───

describe("createFridayProviderInferenceClient", () => {
  function createMockProvider(
    responseJson: Record<string, unknown>,
  ): FridayProviderService {
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

    const route: FridayResolvedProviderRoute = {
      provider: mockProfile,
      model: "gpt-4",
    };

    return {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(route, "test-key");
        return { result, route, attempts: [] };
      }),
    } as unknown as FridayProviderService;
  }

  it("infer parses JSON response from OpenAI format", async () => {
    const mockProvider = createMockProvider({});

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"state":"ready_for_generation","spec":{}}' } }],
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      const result = await client.infer<{ state: string }>({
        prompt: {
          system: "You are a test assistant",
          user: "Test input",
        },
      });

      expect(result.parsed.state).toBe("ready_for_generation");
      expect(result.model).toBe("gpt-4");
      expect(result.providerId).toBe("provider-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer throws on non-ok response", async () => {
    const mockProvider = createMockProvider({});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer({
          prompt: { system: "test", user: "test" },
        }),
      ).rejects.toThrow("returned 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streams bounded provider error bodies before surfacing failures", async () => {
    const mockProvider = createMockProvider({});
    const response = new Response("x".repeat(5000), { status: 500 });
    const textSpy = vi.spyOn(response, "text");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(response);

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer({
          prompt: { system: "test", user: "test" },
        }),
      ).rejects.toThrow("returned 500");
      expect(textSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies task-profile temperature overrides to provider requests", async () => {
    const mockProvider = createMockProvider({});

    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "{\"state\":\"ready_for_generation\",\"spec\":{}}" } }],
        }),
      };
    }) as typeof fetch;

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await client.infer<{ state: string }>({
        prompt: {
          system: "You are a test assistant",
          user: "Test input",
        },
        taskProfile: "creative",
      });

      expect(capturedBody.temperature).toBe(0.35);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards tenantContext into provider fallback routing", async () => {
    const mockProvider = createMockProvider({});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"state":"ready_for_generation","spec":{}}' } }],
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await client.infer<{ state: string }>({
        prompt: {
          system: "You are a test assistant",
          user: "Test input",
        },
        tenantContext: {
          hubId: "tenant-acme",
          userId: "user-123",
          channelKind: "assistant",
        },
      });

      expect(mockProvider.runWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantContext: {
            hubId: "tenant-acme",
            userId: "user-123",
            channelKind: "assistant",
          },
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer fails closed for Anthropic OAuth providers without issuing a request", async () => {
    const oauthProfile: FridayProviderProfile = {
      id: "oauth-provider",
      kind: "anthropic",
      name: "Anthropic OAuth",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      defaultModel: "claude-sonnet-4-20250514",
      config: {
        api: "anthropic-messages",
        authMode: "oauth",
        oauthProvider: "anthropic",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const oauthRoute: FridayResolvedProviderRoute = {
      provider: oauthProfile,
      model: "claude-sonnet-4-20250514",
    };

    const mockProvider: FridayProviderService = {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(oauthRoute, "sk-ant-oat01-test-token");
        return { result, route: oauthRoute, attempts: [] };
      }),
    } as unknown as FridayProviderService;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer<{ state: string }>({
          prompt: {
            system: "You are a test assistant",
            user: "Test input",
          },
        }),
      ).rejects.toThrow(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer does NOT add OAuth headers for api-key auth mode", async () => {
    const mockProvider = createMockProvider({});

    let capturedHeaders: Record<string, string> = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"state":"ready"}' } }],
        }),
      };
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await client.infer<{ state: string }>({
        prompt: { system: "test", user: "test" },
      });

      // Should NOT have OAuth headers
      expect(capturedHeaders["x-app"]).toBeUndefined();
      expect(capturedHeaders["Authorization"]).toBe("Bearer test-key");
      expect(capturedHeaders["anthropic-beta"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer throws on empty response content", async () => {
    const mockProvider = createMockProvider({});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "" } }],
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer({
          prompt: { system: "test", user: "test" },
        }),
      ).rejects.toThrow("Empty response");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer surfaces OpenAI Responses refusals as provider errors", async () => {
    const mockProfile: FridayProviderProfile = {
      id: "provider-responses",
      kind: "openai",
      name: "Responses Provider",
      baseUrl: "https://api.test.com",
      enabled: true,
      defaultModel: "gpt-4o",
      config: {
        api: "openai-responses",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["gpt-4o"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const route: FridayResolvedProviderRoute = {
      provider: mockProfile,
      model: "gpt-4o",
    };

    const mockProvider: FridayProviderService = {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(route, "test-key");
        return { result, route, attempts: [] };
      }),
    } as unknown as FridayProviderService;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I'm sorry, I can't assist with that request." }],
          },
        ],
      }),
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer({
          prompt: { system: "test", user: "test" },
        }),
      ).rejects.toThrow("Provider refused request");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer with sessionContext fails closed before Anthropic OAuth compaction calls", async () => {
    const oauthProfile: FridayProviderProfile = {
      id: "oauth-provider-session",
      kind: "anthropic",
      name: "Anthropic OAuth Session",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      defaultModel: "claude-sonnet-4-20250514",
      config: {
        api: "anthropic-messages",
        authMode: "oauth",
        oauthProvider: "anthropic",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const oauthRoute: FridayResolvedProviderRoute = {
      provider: oauthProfile,
      model: "claude-sonnet-4-20250514",
    };

    const mockProvider: FridayProviderService = {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(oauthRoute, "sk-ant-oat01-session-token");
        return { result, route: oauthRoute, attempts: [] };
      }),
    } as unknown as FridayProviderService; // SAFETY: mock service for testing

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    try {
      // Generate enough messages to trigger compaction (>70% of 128k tokens = ~89,600 tokens).
      // At ~4 chars/token + 8-token overhead per message, we need large messages.
      // Use 20 messages of ~20,000 chars each → ~100k tokens to ensure compaction triggers.
      const bigContent = "x".repeat(20_000);
      const sessionMessages: FridayProviderContextMessage[] = [];
      for (let i = 0; i < 20; i++) {
        sessionMessages.push({
          messageId: `msg-${String(i)}`,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `${bigContent} turn ${String(i)}`,
          createdAt: new Date(Date.now() - (20 - i) * 60_000).toISOString(),
        });
      }

      const sessionContext: FridayInferenceSessionContext = {
        sessionId: "session-123",
        specSummary: "A test spec summary",
        messages: sessionMessages,
      };

      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer<{ state: string }>({
          prompt: {
            system: "You are a test assistant",
            user: "Generate the output",
          },
          sessionContext,
        }),
      ).rejects.toThrow(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer does NOT add OAuth headers for Anthropic api-key auth mode", async () => {
    const anthropicApiKeyProfile: FridayProviderProfile = {
      id: "anthropic-apikey-provider",
      kind: "anthropic",
      name: "Anthropic API Key",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      defaultModel: "claude-sonnet-4-20250514",
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const apiKeyRoute: FridayResolvedProviderRoute = {
      provider: anthropicApiKeyProfile,
      model: "claude-sonnet-4-20250514",
    };

    const mockProvider: FridayProviderService = {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(apiKeyRoute, "sk-ant-test-key");
        return { result, route: apiKeyRoute, attempts: [] };
      }),
    } as unknown as FridayProviderService; // SAFETY: mock service for testing

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{"state":"ready"}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    });

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await client.infer<{ state: string }>({
        prompt: {
          system: "You are a test assistant",
          user: "Test input",
        },
      });

      // Should use x-api-key, NOT Authorization: Bearer
      expect(capturedHeaders["x-api-key"]).toBe("sk-ant-test-key");
      expect(capturedHeaders["Authorization"]).toBeUndefined();

      // Should NOT have OAuth identity headers
      expect(capturedHeaders["x-app"]).toBeUndefined();
      // user-agent should not contain claude-cli (OAuth identity)
      expect(capturedHeaders["user-agent"]).toBeUndefined();

      // anthropic-beta should NOT contain OAuth flags
      // (may contain prompt-caching flags, but not oauth-2025-04-20)
      if (capturedHeaders["anthropic-beta"]) {
        expect(capturedHeaders["anthropic-beta"]).not.toContain("oauth-2025-04-20");
        expect(capturedHeaders["anthropic-beta"]).not.toContain("claude-code-20250219");
      }

      // System prompt should NOT include OAuth prefix
      const systemContent = capturedBody["system"];
      const systemText = typeof systemContent === "string"
        ? systemContent
        : JSON.stringify(systemContent);
      expect(systemText).not.toContain("Claude Code");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("infer fails closed for Anthropic token auth mode without issuing a request", async () => {
    const anthropicTokenProfile: FridayProviderProfile = {
      id: "anthropic-token-provider",
      kind: "anthropic",
      name: "Anthropic Token",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      defaultModel: "claude-sonnet-4-20250514",
      config: {
        api: "anthropic-messages",
        authMode: "token",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
      },
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    const tokenRoute: FridayResolvedProviderRoute = {
      provider: anthropicTokenProfile,
      model: "claude-sonnet-4-20250514",
    };

    const mockProvider: FridayProviderService = {
      listProviders: vi.fn(),
      getProvider: vi.fn(),
      createProvider: vi.fn(),
      updateProvider: vi.fn(),
      deleteProvider: vi.fn(),
      validateProvider: vi.fn(),
      getRoutingConfig: vi.fn(),
      setRoutingConfig: vi.fn(),
      resolveRoute: vi.fn(),
      runWithFallback: vi.fn().mockImplementation(async (params: {
        run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<unknown>;
      }) => {
        const result = await params.run(tokenRoute, "sk-ant-token-live");
        return { result, route: tokenRoute, attempts: [] };
      }),
    } as unknown as FridayProviderService;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    try {
      const client = createFridayProviderInferenceClient({
        providerService: mockProvider,
      });

      await expect(
        client.infer<{ state: string }>({
          prompt: {
            system: "You are a test assistant",
            user: "Test input",
          },
        }),
      ).rejects.toThrow(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
