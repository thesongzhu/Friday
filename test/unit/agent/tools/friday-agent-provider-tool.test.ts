import { describe, expect, it, vi } from "vitest";

import { createFridayAgentProviderTool } from "../../../../src/agent/tools/friday-agent-provider-tool.js";

import type { FridayProviderProfile } from "../../../../src/providers/model/friday-provider.types.js";
import type { FridayProviderService } from "../../../../src/providers/services/friday-provider-service.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeProvider(
  overrides: Partial<FridayProviderProfile> = {},
): FridayProviderProfile {
  const { config: overrideConfig = {}, ...restOverrides } = overrides;
  const base: FridayProviderProfile = {
    id: "provider-anthropic-oauth",
    kind: "anthropic",
    name: "Claude OAuth",
    baseUrl: "https://api.anthropic.com",
    enabled: true,
    defaultModel: "claude-sonnet-4-20250514",
    config: {
      api: "anthropic-messages",
      authMode: "oauth",
      oauthProvider: "anthropic",
      keySource: { kind: "none" },
      supportedModels: [
        "claude-sonnet-4-20250514",
        "claude-opus-4-20250514",
      ],
      validation: { status: "never" },
    },
    createdAt: "2026-03-13T00:00:00.000Z",
    updatedAt: "2026-03-13T00:00:00.000Z",
  };
  return {
    ...base,
    ...restOverrides,
    config: {
      ...base.config,
      ...overrideConfig,
    },
  };
}

function createMockProviderService(
  overrides: Partial<FridayProviderService> = {},
): FridayProviderService {
  return {
    listProviders: vi.fn().mockResolvedValue([]),
    getProvider: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn().mockResolvedValue({
      defaultProviderId: "",
      fallbackProviderIds: [],
    }),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn(),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
    initiateOAuthLogin: vi.fn(),
    completeOAuthLogin: vi.fn(),
    ...overrides,
  } as unknown as FridayProviderService;
}

describe("createFridayAgentProviderTool", () => {
  it("auto-creates an anthropic oauth provider for oauth_init when providerId is omitted", async () => {
    const provider = makeProvider({ id: "anthropic-oauth-1" });
    const providerService = createMockProviderService({
      createProvider: vi.fn().mockResolvedValue(provider),
      initiateOAuthLogin: vi.fn().mockResolvedValue({
        authorizationUrl: "https://console.anthropic.com/oauth/authorize",
        state: "oauth-state-1",
        codeVerifier: "pkce",
        scopes: ["org:create_api_key", "user:profile"],
        providerId: provider.id,
        oauthProvider: "anthropic",
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "oauth_init" }, signal());
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(providerService.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "anthropic",
        name: "Claude OAuth",
        authMode: "oauth",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-4-20250514",
        validateOnSave: false,
      }),
    );
    expect(providerService.initiateOAuthLogin).toHaveBeenCalledWith({
      providerId: "anthropic-oauth-1",
    });
    expect(parsed.providerResolution).toBe("auto-created");
    expect(parsed.providerId).toBe("anthropic-oauth-1");
  });

  it("reuses the routed default anthropic oauth provider for oauth_init", async () => {
    const providerOne = makeProvider({ id: "anthropic-oauth-1", name: "Claude OAuth A" });
    const providerTwo = makeProvider({ id: "anthropic-oauth-2", name: "Claude OAuth B" });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([providerOne, providerTwo]),
      getRoutingConfig: vi.fn().mockResolvedValue({
        defaultProviderId: "anthropic-oauth-2",
        defaultModel: "claude-sonnet-4-20250514",
        fallbackProviderIds: [],
      }),
      initiateOAuthLogin: vi.fn().mockResolvedValue({
        authorizationUrl: "https://console.anthropic.com/oauth/authorize",
        state: "oauth-state-2",
        codeVerifier: "pkce",
        scopes: ["org:create_api_key", "user:profile"],
        providerId: providerTwo.id,
        oauthProvider: "anthropic",
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "oauth_init" }, signal());
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.initiateOAuthLogin).toHaveBeenCalledWith({
      providerId: "anthropic-oauth-2",
    });
    expect(parsed.providerResolution).toBe("reused-routing-default");
  });

  it("returns a clear error when oauth_init cannot disambiguate multiple anthropic oauth providers", async () => {
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([
        makeProvider({ id: "anthropic-oauth-1", name: "Claude OAuth A" }),
        makeProvider({ id: "anthropic-oauth-2", name: "Claude OAuth B" }),
      ]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "oauth_init" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Multiple anthropic OAuth providers are available");
    expect(result.content).toContain("Specify providerId");
    expect(providerService.createProvider).not.toHaveBeenCalled();
    expect(providerService.initiateOAuthLogin).not.toHaveBeenCalled();
  });

  it("auto-selects the single anthropic oauth provider for oauth_complete when providerId is omitted", async () => {
    const provider = makeProvider({ id: "anthropic-oauth-1" });
    const updatedProvider = makeProvider({
      id: "anthropic-oauth-1",
      config: {
        ...provider.config,
        validation: { status: "ok", checkedAt: "2026-03-13T00:05:00.000Z" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
      getProvider: vi.fn().mockResolvedValue(updatedProvider),
      completeOAuthLogin: vi.fn().mockResolvedValue({
        providerId: provider.id,
        oauthProvider: "anthropic",
        connected: true as const,
        expiresAt: "2026-04-13T00:00:00.000Z",
        tokenType: "Bearer",
        scope: "org:create_api_key user:profile",
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute(
      { action: "oauth_complete", code: "test-code#oauth-state-1" },
      signal(),
    );
    const parsed = JSON.parse(result.content) as Record<string, any>;

    expect(result.isError).toBeUndefined();
    expect(providerService.completeOAuthLogin).toHaveBeenCalledWith({
      providerId: "anthropic-oauth-1",
      authorizationCode: "test-code#oauth-state-1",
      state: undefined,
    });
    expect(parsed.providerResolution).toBe("reused-existing");
    expect(parsed.nextRecommendedAction).toEqual({
      action: "set_default",
      providerId: "anthropic-oauth-1",
      defaultModel: "claude-sonnet-4-20250514",
    });
  });

  it("set_default reuses the provider defaultModel when none is supplied", async () => {
    const provider = makeProvider({ id: "anthropic-oauth-1" });
    const providerService = createMockProviderService({
      getProvider: vi.fn().mockResolvedValue(provider),
      setRoutingConfig: vi.fn().mockResolvedValue({
        defaultProviderId: provider.id,
        defaultModel: provider.defaultModel,
        fallbackProviderIds: [],
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute(
      { action: "set_default", providerId: provider.id },
      signal(),
    );
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(providerService.getProvider).toHaveBeenCalledWith("anthropic-oauth-1");
    expect(providerService.setRoutingConfig).toHaveBeenCalledWith({
      defaultProviderId: "anthropic-oauth-1",
      defaultModel: "claude-sonnet-4-20250514",
      fallbackProviderIds: [],
    });
    expect(parsed.routing.defaultModel).toBe("claude-sonnet-4-20250514");
  });

  it("set_default returns a clear error when the provider is missing", async () => {
    const providerService = createMockProviderService({
      getProvider: vi.fn().mockResolvedValue(null),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute(
      { action: "set_default", providerId: "missing-provider" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Provider "missing-provider" not found');
    expect(providerService.setRoutingConfig).not.toHaveBeenCalled();
  });
});
