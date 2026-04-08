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

  const anthropicOauthProfile: FridayProviderProfile = {
    id: "anth-001",
    kind: "anthropic",
    name: "Claude OAuth",
    baseUrl: "https://api.anthropic.com",
    enabled: true,
    defaultModel: "claude-sonnet-4-20250514",
    config: {
      api: "anthropic-messages",
      authMode: "oauth",
      keySource: { kind: "none" },
      oauthProvider: "anthropic",
      supportedModels: ["claude-sonnet-4-20250514"],
      validation: { status: "never" },
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
      listProviders: vi.fn(async () => [sampleProfile, anthropicOauthProfile]),
      getProvider: vi.fn(async (id: string) =>
        id === "prov-001"
          ? sampleProfile
          : id === "anth-001"
            ? anthropicOauthProfile
            : null,
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
          defaultProviderId: "anth-001",
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
      listAuthProfiles: vi.fn(async () => [
        {
          id: "auth-default",
          providerProfileId: "prov-001",
          providerKind: "openai" as const,
          profileKey: "default",
          label: "OpenAI Default",
          authMode: "api-key" as const,
          keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
          isActive: true,
          metadata: {},
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
      activateAuthProfile: vi.fn(async () => ({
        id: "auth-default",
        providerProfileId: "prov-001",
        providerKind: "openai" as const,
        profileKey: "default",
        label: "OpenAI Default",
        authMode: "api-key" as const,
        keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
        isActive: true,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      })),
      doctorProvider: vi.fn(async () => ({
        providerId: "prov-001",
        providerKind: "openai" as const,
        backendKind: "http" as const,
        authMode: "api-key" as const,
        checkedAt: NOW,
        backendHealth: "healthy" as const,
        authHealth: "healthy" as const,
        routingEligible: true,
        reasons: [],
        activeProfileKey: "default",
      })),
      explainRouting: vi.fn(async () => ({
        requestedProviderId: "prov-001",
        requestedModel: "gpt-4o",
        requiresNativeTools: true,
        selectedBeforeLearning: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
        },
        selectedAfterLearning: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
        },
        selected: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
          originalRank: 1,
          finalRank: 1,
          selected: true,
          eligible: true,
          ineligibilityReasons: [],
          pinned: false,
          baseRankScore: 1,
          historyScore: 0,
          patternScore: 0,
          lessonScore: 0,
          routePenaltyScore: 0,
          pinBonus: 0,
          finalScore: 1,
          matchedLessonIds: [],
          matchedPatternIds: [],
        },
        candidates: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            model: "gpt-4o",
            backendKind: "http" as const,
            originalRank: 1,
            finalRank: 1,
            selected: true,
            eligible: true,
            ineligibilityReasons: [],
            pinned: false,
            baseRankScore: 1,
            historyScore: 0,
            patternScore: 0,
            lessonScore: 0,
            routePenaltyScore: 0,
            pinBonus: 0,
            finalScore: 1,
            matchedLessonIds: [],
            matchedPatternIds: [],
          },
        ],
        candidateScores: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            model: "gpt-4o",
            backendKind: "http" as const,
            originalRank: 1,
            finalRank: 1,
            selected: true,
            eligible: true,
            ineligibilityReasons: [],
            pinned: false,
            baseRankScore: 1,
            historyScore: 0,
            patternScore: 0,
            lessonScore: 0,
            routePenaltyScore: 0,
            pinBonus: 0,
            finalScore: 1,
            matchedLessonIds: [],
            matchedPatternIds: [],
          },
        ],
        learningAdjusted: false,
        learningSignalsPresent: false,
        orderingAdjusted: false,
        selectedAdjusted: false,
        reasonCode: "configured" as const,
        reason: "default route",
        reasonText: "default route",
        historyWindow: { sampleLimit: 250 },
      })),
      pinRoute: vi.fn(async () => undefined),
      clearRoutePenalty: vi.fn(async () => 1),
      initiateOAuthLogin: vi.fn(async () => ({
        providerId: "anth-001",
        oauthProvider: "anthropic" as const,
        authorizationUrl: "https://claude.ai/oauth/authorize?...",
        state: "test-state",
        codeVerifier: "test-verifier",
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      })),
      completeOAuthLogin: vi.fn(async () => ({
        providerId: "anth-001",
        oauthProvider: "anthropic" as const,
        connected: true as const,
        expiresAt: NOW,
        tokenType: "Bearer",
        scope: "org:create_api_key user:profile user:inference",
      })),
    };
  }

  it("creates 19 route definitions", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    expect(routes).toHaveLength(19);
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
    expect(operationIds).toContain("providers.doctor");
    expect(operationIds).toContain("providers.routing.explain");
    expect(operationIds).toContain("providers.routing.pin");
    expect(operationIds).toContain("providers.routing.penalty.clear");
    expect(operationIds).toContain("providers.auth.profiles.list");
    expect(operationIds).toContain("providers.auth.profiles.activate");
    expect(operationIds).toContain("providers.routing.get");
    expect(operationIds).toContain("providers.routing.set");
    expect(operationIds).toContain("providers.templates.list");
    expect(operationIds).toContain("providers.templates.get");
    expect(operationIds).toContain("providers.health.list");
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
      expect(result).toEqual({ items: [sampleProfile, anthropicOauthProfile] });
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

    it("providers.doctor returns doctor report", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const doctorRoute = routes.find(
        (r) => r.operationId === "providers.doctor",
      )!;

      const result = await doctorRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toMatchObject({
        doctor: {
          providerId: "prov-001",
          backendKind: "http",
          activeProfileKey: "default",
        },
      });
    });

    it("providers.routing.explain delegates query and principal context", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const explainRoute = routes.find(
        (r) => r.operationId === "providers.routing.explain",
      )!;

      const result = await explainRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          query: {
            requestedProviderId: "prov-001",
            requestedModel: "gpt-4o",
            taskProfileId: "review",
            estimatedInputTokens: "2048",
            complexity: "complex",
            requiresNativeTools: "true",
          },
        }),
      );

      expect(mockService.explainRouting).toHaveBeenCalledWith({
        requestedProviderId: "prov-001",
        requestedModel: "gpt-4o",
        tenantContext: {
          hubId: "default",
          userId: "user-1",
        },
        routingContext: {
          estimatedInputTokens: 2048,
          complexity: "complex",
          requiresNativeTools: true,
          taskProfileId: "review",
        },
      });
      expect(result).toHaveProperty("explain.selected.providerId", "prov-001");
    });

    it("providers.routing.pin validates and delegates", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const pinRoute = routes.find(
        (r) => r.operationId === "providers.routing.pin",
      )!;

      const result = await pinRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: {
            taskProfileId: "plan",
            providerId: "prov-001",
            model: "gpt-4o",
            backendKind: "http",
            reason: "operator pin",
          },
        }),
      );

      expect(mockService.pinRoute).toHaveBeenCalledWith({
        userId: "user-1",
        taskProfileId: "plan",
        providerId: "prov-001",
        model: "gpt-4o",
        backendKind: "http",
        reason: "operator pin",
      });
      expect(result).toEqual({ pinned: true });
    });

    it("providers.routing.penalty.clear validates and delegates", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const clearRoute = routes.find(
        (r) => r.operationId === "providers.routing.penalty.clear",
      )!;

      const result = await clearRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: {
            taskProfileId: "review",
            providerId: "prov-001",
            model: "gpt-4o",
            backendKind: "http",
          },
        }),
      );

      expect(mockService.clearRoutePenalty).toHaveBeenCalledWith({
        userId: "user-1",
        taskProfileId: "review",
        providerId: "prov-001",
        model: "gpt-4o",
        backendKind: "http",
      });
      expect(result).toEqual({ cleared: 1 });
    });

    it("providers.auth.profiles.list returns auth profiles", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const listRoute = routes.find(
        (r) => r.operationId === "providers.auth.profiles.list",
      )!;

      const result = await listRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toMatchObject({
        items: [expect.objectContaining({ profileKey: "default" })],
      });
    });

    it("providers.auth.profiles.activate switches the active profile", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const activateRoute = routes.find(
        (r) => r.operationId === "providers.auth.profiles.activate",
      )!;

      const result = await activateRoute.handler(
        makeCtx({ params: { providerId: "prov-001", profileKey: "default" } }),
      );
      expect(result).toMatchObject({
        profile: expect.objectContaining({ profileKey: "default", isActive: true }),
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
          defaultProviderId: "anth-001",
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
        makeCtx({ body: { providerId: "anth-001" } }),
      );

      expect(mockService.initiateOAuthLogin).toHaveBeenCalledWith({
        providerId: "anth-001",
      });
      expect(result).toHaveProperty("oauth");
    });

    it("auth.oauth.anthropic.initiate auto-selects the routed anthropic oauth provider when providerId is omitted", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      const result = await initiateRoute.handler(makeCtx({ body: {} }));

      expect(mockService.initiateOAuthLogin).toHaveBeenCalledWith({
        providerId: "anth-001",
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
            providerId: "anth-001",
            authorizationCode: "code#state",
          },
        }),
      );

      expect(mockService.completeOAuthLogin).toHaveBeenCalledWith({
        providerId: "anth-001",
        authorizationCode: "code#state",
        state: undefined,
      });
      expect(result).toHaveProperty("oauth");
    });

    it("auth.oauth.anthropic.callback auto-selects the routed anthropic oauth provider when providerId is omitted", async () => {
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
            authorizationCode: "code#state",
          },
        }),
      );

      expect(mockService.completeOAuthLogin).toHaveBeenCalledWith({
        providerId: "anth-001",
        authorizationCode: "code#state",
        state: undefined,
      });
      expect(result).toHaveProperty("oauth");
    });

    it("auth.oauth.anthropic.initiate returns a clear ambiguity error when multiple oauth providers match", async () => {
      const mockService = makeMockService();
      mockService.listProviders = vi.fn(async () => [
        anthropicOauthProfile,
        { ...anthropicOauthProfile, id: "anth-002", name: "Claude OAuth 2" },
      ]);
      mockService.getRoutingConfig = vi.fn(async () => ({
        defaultProviderId: "prov-001",
        fallbackProviderIds: [],
      }));
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      await expect(
        initiateRoute.handler(makeCtx({ body: {} })),
      ).rejects.toThrow("Multiple anthropic OAuth providers are available. Specify providerId.");
    });
  });

  describe("OAuth route operation ids", () => {
    it("lists provider templates", async () => {
      const routes = createFridayProviderRoutes({
        providerService: makeMockService(),
      });
      const route = routes.find((entry) => entry.operationId === "providers.templates.list")!;

      const result = await route.handler(makeCtx());

      expect(result).toHaveProperty("items");
      expect((result as { items: Array<{ id: string }> }).items.length).toBeGreaterThan(5);
      expect((result as { items: Array<{ id: string }> }).items.some((item) => item.id === "openai")).toBe(true);
    });

    it("lists provider health snapshots", async () => {
      const mockService = makeMockService();
      mockService.getRoutingConfig = vi.fn(async () => ({
        defaultProviderId: "anth-001",
        fallbackProviderIds: ["prov-001"],
      }));
      const routes = createFridayProviderRoutes({
        providerService: Object.assign(mockService, {
          getProviderFallbackState: vi.fn((providerId: string) =>
            providerId === "prov-001"
              ? { circuitState: "cooldown" as const, cooldownRemainingMs: 42_000, lastFailureAt: NOW }
              : { circuitState: "closed" as const },
          ),
        }),
      });
      const route = routes.find((entry) => entry.operationId === "providers.health.list")!;

      const result = await route.handler(makeCtx());
      const items = (result as { items: Array<{ providerId: string; lane: string; circuitState: string }> }).items;

      expect(items).toHaveLength(2);
      expect(items.find((item) => item.providerId === "prov-001")).toMatchObject({
        lane: "fallback",
        circuitState: "cooldown",
      });
      expect(items.find((item) => item.providerId === "anth-001")).toMatchObject({
        lane: "primary",
      });
    });

    it("includes OAuth route operation ids", () => {
      const routes = createFridayProviderRoutes({
        providerService: makeMockService(),
      });
      const operationIds = routes.map((r) => r.operationId);
      expect(operationIds).toContain("providers.templates.list");
      expect(operationIds).toContain("providers.health.list");
      expect(operationIds).toContain("auth.oauth.anthropic.initiate");
      expect(operationIds).toContain("auth.oauth.anthropic.callback");
    });
  });
});
