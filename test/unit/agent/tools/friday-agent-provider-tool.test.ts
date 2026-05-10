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
    listAuthProfiles: vi.fn().mockResolvedValue([]),
    activateAuthProfile: vi.fn(),
    doctorProvider: vi.fn(),
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

  it("creates a CLI-backed external-session provider", async () => {
    const provider = makeProvider({
      id: "provider-codex-cli",
      kind: "openai",
      name: "Codex CLI",
      baseUrl: "",
      config: {
        api: "openai-responses",
        authMode: "external-session",
        backendKind: "cli",
        deploymentKind: "consumer-cli",
        regionTag: "global",
        keySource: { kind: "none" },
        supportedModels: ["gpt-5.4"],
        cliConfig: { backendId: "codex-cli", binaryPath: "/usr/local/bin/codex" },
        validation: { status: "never" },
      },
    });
    const providerService = createMockProviderService({
      createProvider: vi.fn().mockResolvedValue(provider),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({
      action: "create",
      kind: "openai",
      name: "Codex CLI",
      backendKind: "cli",
      cliBackendId: "codex-cli",
      cliBinaryPath: "/usr/local/bin/codex",
      supportedModels: ["gpt-5.4"],
      defaultModel: "gpt-5.4",
    }, signal());
    const parsed = JSON.parse(result.content) as Record<string, any>;

    expect(result.isError).toBeUndefined();
    expect(providerService.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "openai",
        backendKind: "cli",
        authMode: "external-session",
        deploymentKind: "consumer-cli",
        cliConfig: {
          backendId: "codex-cli",
          binaryPath: "/usr/local/bin/codex",
        },
      }),
    );
    expect(parsed.provider.backendKind).toBe("cli");
    expect(parsed.provider.authMode).toBe("external-session");
  });

  it("returns provider doctor output", async () => {
    const providerService = createMockProviderService({
      doctorProvider: vi.fn().mockResolvedValue({
        providerId: "anthropic-oauth-1",
        providerKind: "anthropic",
        backendKind: "cli",
        authMode: "external-session",
        checkedAt: "2026-03-31T00:00:00.000Z",
        backendHealth: "healthy",
        authHealth: "healthy",
        routingEligible: true,
        reasons: [],
        activeProfileKey: "default",
        cliSession: {
          backendId: "claude-cli",
          status: "healthy",
          checkedAt: "2026-03-31T00:00:00.000Z",
        },
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "doctor", providerId: "anthropic-oauth-1" }, signal());
    const parsed = JSON.parse(result.content) as Record<string, any>;

    expect(result.isError).toBeUndefined();
    expect(providerService.doctorProvider).toHaveBeenCalledWith("anthropic-oauth-1");
    expect(parsed.report.backendKind).toBe("cli");
    expect(parsed.report.cliSession.backendId).toBe("claude-cli");
  });

  it("list returns ready=true with empty blockers for a fully ready provider", async () => {
    const provider = makeProvider({
      id: "provider-ready",
      enabled: true,
      promotionChannel: "active",
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: { status: "ok", checkedAt: "2026-05-09T00:00:00.000Z" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(result.isError).toBeUndefined();
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].ready).toBe(true);
    expect(parsed.providers[0].blockers).toEqual([]);
  });

  it("list returns ready=false with validation_never blocker when validation has not run", async () => {
    const provider = makeProvider({
      id: "provider-never",
      enabled: true,
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: { status: "never" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(parsed.providers[0].ready).toBe(false);
    expect(parsed.providers[0].blockers).toEqual(["validation_never"]);
  });

  it("list returns ready=false with validation_failed blocker when validation has failed", async () => {
    const provider = makeProvider({
      id: "provider-failed-validation",
      enabled: true,
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: {
          status: "failed",
          checkedAt: "2026-05-09T00:00:00.000Z",
          errorMessage: "validator detail string must not appear anywhere in agent payload",
        },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(parsed.providers[0].ready).toBe(false);
    expect(parsed.providers[0].blockers).toEqual(["validation_failed"]);
    for (const blocker of parsed.providers[0].blockers) {
      expect(blocker).not.toContain("validator detail string");
    }
    expect(JSON.stringify(parsed.providers[0])).not.toContain("validator detail string");
  });

  it("list strips validation.errorMessage from the agent-visible payload while keeping stable validation fields", async () => {
    const provider = makeProvider({
      id: "provider-validation-whitelist",
      enabled: true,
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: {
          status: "failed",
          checkedAt: "2026-05-09T00:00:00.000Z",
          errorCode: "PROVIDER_AUTH_INVALID",
          errorMessage: "validator-free-text-payload-that-must-not-leak",
          httpStatus: 401,
        },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{
        validation: { status: string; checkedAt?: string; errorCode?: string; httpStatus?: number; errorMessage?: string };
      }>;
    };

    expect(parsed.providers[0].validation).toEqual({
      status: "failed",
      checkedAt: "2026-05-09T00:00:00.000Z",
      errorCode: "PROVIDER_AUTH_INVALID",
      httpStatus: 401,
    });
    expect(parsed.providers[0].validation).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(parsed.providers[0])).not.toContain("validator-free-text-payload-that-must-not-leak");
  });

  it("list returns ready=false with provider_disabled blocker when enabled=false", async () => {
    const provider = makeProvider({
      id: "provider-disabled",
      enabled: false,
      promotionChannel: "active",
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: { status: "ok", checkedAt: "2026-05-09T00:00:00.000Z" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(parsed.providers[0].ready).toBe(false);
    expect(parsed.providers[0].blockers).toEqual(["provider_disabled"]);
  });

  it("list returns promotion_channel_blocked blocker for shadow promotion channel", async () => {
    const provider = makeProvider({
      id: "provider-shadow",
      enabled: true,
      promotionChannel: "shadow",
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: { status: "ok", checkedAt: "2026-05-09T00:00:00.000Z" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(parsed.providers[0].ready).toBe(false);
    expect(parsed.providers[0].blockers).toEqual(["promotion_channel_blocked"]);
  });

  it("validate action returns whitelisted fields and does not echo validation.errorMessage", async () => {
    const providerService = createMockProviderService({
      validateProvider: vi.fn().mockResolvedValue({
        status: "failed",
        checkedAt: "2026-05-09T00:00:00.000Z",
        errorCode: "PROVIDER_AUTH_INVALID",
        errorMessage: "validator-detail-must-not-leak-via-validate-action",
        httpStatus: 401,
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute(
      { action: "validate", providerId: "provider-validate-x" },
      signal(),
    );
    const parsed = JSON.parse(result.content) as {
      providerId: string;
      status: string;
      checkedAt?: string;
      errorCode?: string;
      httpStatus?: number;
      errorMessage?: string;
    };

    expect(result.isError).toBeUndefined();
    expect(parsed).toEqual({
      providerId: "provider-validate-x",
      status: "failed",
      checkedAt: "2026-05-09T00:00:00.000Z",
      errorCode: "PROVIDER_AUTH_INVALID",
      httpStatus: 401,
    });
    expect(parsed).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(parsed)).not.toContain("validator-detail-must-not-leak-via-validate-action");
  });

  it("list combines multiple blockers when multiple conditions fail", async () => {
    const provider = makeProvider({
      id: "provider-multi-blocked",
      enabled: false,
      promotionChannel: "canary",
      config: {
        api: "anthropic-messages",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels: ["claude-sonnet-4-20250514"],
        validation: { status: "failed", errorMessage: "ignored" },
      },
    });
    const providerService = createMockProviderService({
      listProviders: vi.fn().mockResolvedValue([provider]),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const result = await tool.execute({ action: "list" }, signal());
    const parsed = JSON.parse(result.content) as {
      providers: Array<{ ready: boolean; blockers: string[] }>;
    };

    expect(parsed.providers[0].ready).toBe(false);
    expect(parsed.providers[0].blockers).toEqual([
      "provider_disabled",
      "validation_failed",
      "promotion_channel_blocked",
    ]);
  });

  it("lists and activates auth profiles", async () => {
    const providerService = createMockProviderService({
      listAuthProfiles: vi.fn().mockResolvedValue([
        {
          id: "auth-default",
          providerProfileId: "anthropic-oauth-1",
          providerKind: "anthropic",
          profileKey: "default",
          label: "Default",
          authMode: "oauth",
          keySource: { kind: "none" },
          isActive: true,
          metadata: {},
          createdAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      ]),
      activateAuthProfile: vi.fn().mockResolvedValue({
        id: "auth-cli",
        providerProfileId: "anthropic-oauth-1",
        providerKind: "anthropic",
        profileKey: "cli-session",
        label: "Claude CLI",
        authMode: "external-session",
        keySource: { kind: "none" },
        isActive: true,
        metadata: {},
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T01:00:00.000Z",
      }),
    });
    const tool = createFridayAgentProviderTool({ providerService });

    const listResult = await tool.execute({ action: "auth_profiles", providerId: "anthropic-oauth-1" }, signal());
    const activateResult = await tool.execute({ action: "activate_profile", providerId: "anthropic-oauth-1", profileKey: "cli-session" }, signal());

    expect(JSON.parse(listResult.content)).toMatchObject({
      providerId: "anthropic-oauth-1",
      profiles: [expect.objectContaining({ profileKey: "default" })],
    });
    expect(JSON.parse(activateResult.content)).toMatchObject({
      providerId: "anthropic-oauth-1",
      profile: expect.objectContaining({ profileKey: "cli-session", authMode: "external-session" }),
    });
  });
});
