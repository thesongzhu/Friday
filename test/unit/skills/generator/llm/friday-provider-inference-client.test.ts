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
import {
  FRIDAY_ANTHROPIC_OAUTH_HEADERS,
  FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX,
} from "#providers";

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

  it("infer sends OAuth identity headers and system prefix for OAuth providers", async () => {
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

      // Verify OAuth headers are present
      expect(capturedHeaders["Authorization"]).toBe("Bearer sk-ant-oat01-test-token");
      expect(capturedHeaders["anthropic-beta"]).toContain("oauth-2025-04-20");
      expect(capturedHeaders["anthropic-beta"]).toContain("claude-code-20250219");
      expect(capturedHeaders["x-app"]).toBe("cli");
      expect(capturedHeaders["user-agent"]).toContain("claude-cli");

      // Verify system prompt includes OAuth prefix
      // System may be a string or array of content blocks (prompt caching converts to blocks)
      const systemContent = capturedBody["system"];
      const systemText = typeof systemContent === "string"
        ? systemContent
        : JSON.stringify(systemContent);
      expect(systemText).toContain(FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX);
      expect(systemText).toContain("You are a test assistant");

      // Verify anthropic-beta also includes prompt-caching flag (merged, not replaced)
      expect(capturedHeaders["anthropic-beta"]).toContain("prompt-caching-2024-07-31");
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

  it("infer with sessionContext sends OAuth headers in compaction summarize calls", async () => {
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

    // Collect ALL fetch calls (compaction summarize + main inference)
    const allFetchCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      allFetchCalls.push({ url, headers, body });
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{"state":"ready","summaryText":"summary","decisions":[],"todos":[],"openQuestions":[],"toolFailures":[],"fileOperations":[]}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    });

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

      await client.infer<{ state: string }>({
        prompt: {
          system: "You are a test assistant",
          user: "Generate the output",
        },
        sessionContext,
      });

      // Block compaction can now preserve enough relevant context to avoid a separate
      // summarization round-trip, but every provider fetch must still carry OAuth headers.
      expect(allFetchCalls.length).toBeGreaterThanOrEqual(1);

      // Verify EVERY fetch call has OAuth headers and system prefix
      for (const call of allFetchCalls) {
        expect(call.headers["Authorization"]).toBe("Bearer sk-ant-oat01-session-token");
        expect(call.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
        expect(call.headers["x-app"]).toBe("cli");
        expect(call.headers["user-agent"]).toContain("claude-cli");

        // System content should include the OAuth prefix
        const systemContent = call.body["system"];
        const systemText = typeof systemContent === "string"
          ? systemContent
          : JSON.stringify(systemContent);
        expect(systemText).toContain(FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX);
      }
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
      expect(systemText).not.toContain(FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
