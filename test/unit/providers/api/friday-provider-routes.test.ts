import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFridayProviderRoutes } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayProviderProfile, FridayProviderValidationState, FridayModelRoutingConfig } from "#providers";
import type { FridayHttpContext } from "#api";

describe("FridayProviderRoutes", () => {
  const NOW = "2026-02-17T10:00:00.000Z";

  const sampleProfile: FridayProviderProfile = {
    id: "prov-001",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o"],
      validation: { status: "ok", checkedAt: NOW },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function makeMockService(): FridayProviderService {
    return {
      listProviders: vi.fn(async () => [sampleProfile]),
      getProvider: vi.fn(async (id: string) =>
        id === "prov-001" ? sampleProfile : null,
      ),
      createProvider: vi.fn(async () => sampleProfile),
      updateProvider: vi.fn(async () => sampleProfile),
      deleteProvider: vi.fn(async () => undefined),
      validateProvider: vi.fn(
        async (): Promise<FridayProviderValidationState> => ({
          status: "ok",
          checkedAt: NOW,
        }),
      ),
      getRoutingConfig: vi.fn(
        async (): Promise<FridayModelRoutingConfig> => ({
          defaultProviderId: "prov-001",
          fallbackProviderIds: [],
        }),
      ),
      setRoutingConfig: vi.fn(
        async (input: FridayModelRoutingConfig) => input,
      ),
      resolveRoute: vi.fn(async () => ({
        provider: sampleProfile,
        model: "gpt-4o",
      })),
      runWithFallback: vi.fn(async () => ({
        result: null,
        route: { provider: sampleProfile, model: "gpt-4o" },
        attempts: [],
      })),
      recordUsage: vi.fn(async () => undefined),
      getUsageSummary: vi.fn(async () => ({ groups: [] })),
      getBudgetStatus: vi.fn(async () => ({ monthlyLimitUsd: 0, monthlySpentUsd: 0, remainingUsd: 0, usagePercent: 0, budgetExceeded: false })),
      setBudgetConfig: vi.fn(async () => ({ monthlyLimitUsd: 0 })),
      initiateOAuthLogin: vi.fn(async () => ({
        providerId: "prov-001",
        oauthProvider: "anthropic" as const,
        authorizationUrl: "https://claude.ai/oauth/authorize?...",
        state: "test-state",
        codeVerifier: "test-verifier",
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      })),
      completeOAuthLogin: vi.fn(async () => ({
        providerId: "prov-001",
        oauthProvider: "anthropic" as const,
        connected: true as const,
        expiresAt: NOW,
        tokenType: "Bearer",
        scope: "org:create_api_key user:profile user:inference",
      })),
    };
  }

  it("creates 10 route definitions", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    expect(routes).toHaveLength(10);
  });

  it("has correct operation ids", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    const operationIds = routes.map((r) => r.operationId);
    expect(operationIds).toContain("providers.list");
    expect(operationIds).toContain("providers.get");
    expect(operationIds).toContain("providers.create");
    expect(operationIds).toContain("providers.update");
    expect(operationIds).toContain("providers.delete");
    expect(operationIds).toContain("providers.validate");
    expect(operationIds).toContain("providers.routing.get");
    expect(operationIds).toContain("providers.routing.set");
  });

  it("all routes require hub.admin scope", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    for (const route of routes) {
      expect(route.auth).toEqual({
        public: false,
        anyOfScopes: ["hub.admin"],
      });
    }
  });

  describe("handler behavior", () => {
    it("providers.list returns items", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const listRoute = routes.find((r) => r.operationId === "providers.list")!;

      const result = await listRoute.handler(makeCtx());
      expect(result).toEqual({ items: [sampleProfile] });
    });

    it("providers.get returns provider", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoute = routes.find((r) => r.operationId === "providers.get")!;

      const result = await getRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({ provider: sampleProfile });
    });

    it("providers.get throws on not found", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoute = routes.find((r) => r.operationId === "providers.get")!;

      await expect(
        getRoute.handler(makeCtx({ params: { providerId: "non-existent" } })),
      ).rejects.toThrow("Provider not found");
    });

    it("providers.create calls service with body", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const createRoute = routes.find(
        (r) => r.operationId === "providers.create",
      )!;

      const body = {
        kind: "openai" as const,
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key" as const,
        api: "openai-completions" as const,
        supportedModels: ["gpt-4o"],
      };

      const result = await createRoute.handler(makeCtx({ body }));
      expect(mockService.createProvider).toHaveBeenCalledWith(body);
      expect(result).toHaveProperty("provider");
    });

    it("providers.delete returns deleted true", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const deleteRoute = routes.find(
        (r) => r.operationId === "providers.delete",
      )!;

      const result = await deleteRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({ deleted: true });
    });

    it("providers.validate returns validation state", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const validateRoute = routes.find(
        (r) => r.operationId === "providers.validate",
      )!;

      const result = await validateRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({
        validation: { status: "ok", checkedAt: NOW },
      });
    });

    it("providers.routing.get returns config", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.get",
      )!;

      const result = await getRoutingRoute.handler(makeCtx());
      expect(result).toEqual({
        routing: {
          defaultProviderId: "prov-001",
          fallbackProviderIds: [],
        },
      });
    });

    it("providers.routing.set updates config", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      const body = {
        defaultProviderId: "prov-001",
        defaultModel: "gpt-4o",
        fallbackProviderIds: ["prov-002"],
      };

      const result = await setRoutingRoute.handler(makeCtx({ body }));
      expect(result).toEqual({ routing: body });
    });

    it("auth.oauth.anthropic.initiate delegates to service", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      const result = await initiateRoute.handler(
        makeCtx({ body: { providerId: "prov-001" } }),
      );

      expect(mockService.initiateOAuthLogin).toHaveBeenCalledWith({
        providerId: "prov-001",
      });
      expect(result).toHaveProperty("oauth");
    });

    it("auth.oauth.anthropic.callback delegates to service", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const callbackRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.callback",
      )!;

      const result = await callbackRoute.handler(
        makeCtx({
          body: {
            providerId: "prov-001",
            authorizationCode: "code#state",
          },
        }),
      );

      expect(mockService.completeOAuthLogin).toHaveBeenCalledWith({
        providerId: "prov-001",
        authorizationCode: "code#state",
        state: undefined,
      });
      expect(result).toHaveProperty("oauth");
    });
  });

  describe("OAuth route operation ids", () => {
    it("includes OAuth route operation ids", () => {
      const routes = createFridayProviderRoutes({
        providerService: makeMockService(),
      });
      const operationIds = routes.map((r) => r.operationId);
      expect(operationIds).toContain("auth.oauth.anthropic.initiate");
      expect(operationIds).toContain("auth.oauth.anthropic.callback");
    });
  });
});
