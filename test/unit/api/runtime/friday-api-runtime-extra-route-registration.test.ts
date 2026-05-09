import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import type { FridayHubConfigManagerService } from "#hub";
import type {
  FridayAutoFixRoutesDeps,
  FridayAgentLoopRoutesDeps,
  CreateFridayApiRuntimeDeps,
  FridayAuthPrincipal,
  FridayDesktopRoutesDeps,
  FridayChannelRoutesDeps,
  FridayDiagnosisRoutesDeps,
  FridayDiscoveryRoutesDeps,
  FridayMcpServerRoutesDeps,
  FridayMultiTenantSecurityRoutesDeps,
  FridayObservabilityRoutesDeps,
  FridaySatellitePairingRoutesDeps,
  FridaySatelliteRuntimeRoutesDeps,
  FridaySystemRoutesDeps,
  FridayUixRoutesDeps,
} from "#api";
import { FridayDomainError } from "#errors";
import type { FridayProviderService } from "#providers";
import type { FridayProviderProfile } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { signFridayCanonicalApproval } from "../../../../src/security/friday-mutating-action-gate.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-02-27T00:00:00.000Z";
const allocatedDbs: FridaySqliteLayer[] = [];
const providerBody = {
  kind: "openai" as const,
  name: "OpenAI",
  baseUrl: "https://api.openai.com",
  authMode: "api-key" as const,
  api: "openai-completions" as const,
  supportedModels: ["gpt-4o"],
};

function sampleProviderProfile(input: Partial<FridayProviderProfile> = {}): FridayProviderProfile {
  return {
    id: "p-1",
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
    ...input,
  };
}

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => sampleProviderProfile()),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: {
        id: "p-1",
        kind: "openai" as const,
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: "openai-completions" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-4o"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

function makeMockConfigManager(): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn(async () => ({ channels: {} } as never)),
    getConfig: vi.fn(async () => ({ revision: 1, settings: {} })),
    validatePatch: vi.fn(async () => ({ valid: true, errors: [] })),
    applyPatch: vi.fn(async () => ({ revision: 2, changedKeys: ["flag"] })),
    listRevisions: vi.fn(async () => ({ items: [] })),
    revertToRevision: vi.fn(async () => ({ revision: 3, changedKeys: ["flag"], revertedFrom: 2 })),
    getSkillRegistrySettings: vi.fn(async () => ({
      workspaceDir: ".",
      bundledSkillsDir: "skills",
      managedSkillsDir: "managed-skills",
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    })),
    getSkillSecurityProfile: vi.fn(async () => ({})),
  };
}

function makeBaseDeps(): CreateFridayApiRuntimeDeps {
  const db = createTestDb();
  allocatedDbs.push(db);
  return {
    db,
    idGenerator: () => "id-1",
    nowIso: () => NOW,
    providerService: makeMockProviderService(),
    tokenSecret: "test-secret", // pragma: allowlist secret
    computeChecksum: (content: string) => `checksum-${content.length}`,
    resolveSkill: () => null,
    invokeSkill: async () => ({}),
    skillLifecycle: {
      listSkills: vi.fn(() => []),
      listCatalog: vi.fn(() => ({ items: [], nextCursor: undefined, total: 0 })),
      getSkill: vi.fn(() => null),
      install: vi.fn(),
      update: vi.fn(),
      deleteSkill: vi.fn(),
      verifySkill: vi.fn(),
      validateManifest: vi.fn(() => ({ ok: true, issues: [] })),
    } as never,
  };
}

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "tenant-a",
    userId: "user-1",
    role: "viewer",
    scopes: ["workflow.read"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    expiresAt: NOW,
    ...overrides,
  };
}

describe("API Runtime — Extended Route Registration", () => {
  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("keeps stable disabled route surfaces while leaving unrelated optional families unregistered when deps are omitted", () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const operationIds = runtime.routes.getRoutes().map((route) => route.operationId);

    expect(operationIds).toContain("version.get");
    expect(operationIds).toContain("tui.status.get");
    expect(operationIds).toContain("tui.jobs.list");
    expect(operationIds).toContain("secrets.list");
    expect(operationIds).toContain("skills.catalog.list");
    expect(operationIds).toContain("skills.install");
    expect(operationIds).toContain("skills.verify");
    expect(operationIds.some((id) => id.startsWith("security.tenants."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("observability."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("config."))).toBe(false);
    expect(operationIds).not.toContain("audit.logs.list");
    expect(operationIds.some((id) => id.startsWith("desktop."))).toBe(false);
    expect(operationIds).toContain("channels.webhooks.line");
    expect(operationIds).toContain("channels.webhooks.whatsapp.verify");
    expect(operationIds).toContain("channels.webhooks.whatsapp");
    expect(operationIds).toContain("channels.webhooks.lark");
    expect(operationIds.some((id) => id.startsWith("channels.") && !id.startsWith("channels.webhooks."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("system."))).toBe(false);
    expect(operationIds).toContain("discovery.status");
    expect(operationIds).toContain("mcp.server.rpc");
    expect(operationIds).toContain("packaging.packages.list");
    expect(operationIds.some((id) => id.startsWith("satellites."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("diagnosis."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("autofix."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("agent.loop."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("uix."))).toBe(false);
  });

  it("does not require provider setup canonical approval when canonical gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.create")!;

    await route.handler({
      requestId: "req-provider-create-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: providerBody,
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(providerService.createProvider).toHaveBeenCalledWith(providerBody);
  });

  it("requires signed provider setup canonical approval when runtime canonical gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.create")!;
    const baseCtx = {
      requestId: "req-provider-create-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        ...providerBody,
        planDigest: "provider-runtime-plan-1",
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    };

    let actionDigest = "";
    await route.handler(baseCtx).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domainError = error as FridayDomainError;
      expect(domainError.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const gate = domainError.details.canonicalGate as { actionDigest?: string } | undefined;
      actionDigest = gate?.actionDigest ?? "";
    });
    expect(actionDigest).toBeTruthy();
    expect(providerService.createProvider).not.toHaveBeenCalled();

    const result = await route.handler({
      ...baseCtx,
      body: {
        ...baseCtx.body,
        canonicalApproval: signFridayCanonicalApproval({
          decision: "approved",
          approvalId: "provider-runtime-approval",
          decidedByPrincipalId: "tenant-a",
          actionDigest,
          expiresAt: "2026-02-27T01:00:00.000Z",
        }, "test-secret"),
      },
    });

    expect(providerService.createProvider).toHaveBeenCalledWith(providerBody);
    expect(result).toHaveProperty("canonicalGate.ticketId");
  });

  it("does not require provider-template deeplink canonical approval when provider gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "deeplink.apply")!;

    await route.handler({
      requestId: "req-deeplink-provider-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        confirmed: true,
        payload: {
          version: 1,
          type: "provider-template",
          label: "Imported OpenAI",
          providerTemplate: {
            providerKind: "openai",
            apiKey: "sk-test", // pragma: allowlist secret -- fixture value for deeplink provider import coverage
            model: "gpt-4o-mini",
          },
        },
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(providerService.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      kind: "openai",
      name: "Imported OpenAI",
      validateOnSave: false,
    }));
  });

  it("requires provider-template deeplink canonical approval when provider gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "deeplink.apply")!;

    await expect(route.handler({
      requestId: "req-deeplink-provider-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        confirmed: true,
        planDigest: "deeplink-provider-runtime-plan-1",
        payload: {
          version: 1,
          type: "provider-template",
          label: "Imported OpenAI",
          providerTemplate: {
            providerKind: "openai",
            apiKey: "sk-test", // pragma: allowlist secret -- fixture value for deeplink provider import coverage
            model: "gpt-4o-mini",
          },
        },
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    })).rejects.toMatchObject({
      code: "CANONICAL_APPROVAL_REQUIRED",
    });
    expect(providerService.createProvider).not.toHaveBeenCalled();
  });

  it("does not require model-routing canonical approval when canonical gate profile is off", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: false,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.routing.set")!;
    const routingBody = {
      defaultProviderId: "p-1",
      fallbackProviderIds: [],
    };

    await route.handler({
      requestId: "req-routing-off",
      receivedAt: NOW,
      params: {},
      query: {},
      body: routingBody,
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    });

    expect(providerService.setRoutingConfig).toHaveBeenCalledWith(routingBody);
  });

  it("requires signed model-routing canonical approval when runtime canonical gate profile is on", async () => {
    const providerService = makeMockProviderService();
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      providerService,
      canonicalMutatingActionGate: true,
    });
    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "providers.routing.set")!;
    const baseCtx = {
      requestId: "req-routing-on",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {
        defaultProviderId: "p-1",
        fallbackProviderIds: [],
        planDigest: "provider-routing-plan-1",
      },
      headers: {},
      principal: makePrincipal({ role: "admin", scopes: ["hub.admin"] }),
    };

    let actionDigest = "";
    await route.handler(baseCtx).catch((error: unknown) => {
      expect(error).toBeInstanceOf(FridayDomainError);
      const domainError = error as FridayDomainError;
      expect(domainError.code).toBe("CANONICAL_APPROVAL_REQUIRED");
      const gate = domainError.details.canonicalGate as { actionDigest?: string } | undefined;
      actionDigest = gate?.actionDigest ?? "";
    });
    expect(actionDigest).toBeTruthy();
    expect(providerService.setRoutingConfig).not.toHaveBeenCalled();

    const result = await route.handler({
      ...baseCtx,
      body: {
        ...baseCtx.body,
        canonicalApproval: signFridayCanonicalApproval({
          decision: "approved",
          approvalId: "provider-routing-runtime-approval",
          decidedByPrincipalId: "tenant-a",
          actionDigest,
          expiresAt: "2026-02-27T01:00:00.000Z",
        }, "test-secret"),
      },
    });

    expect(providerService.setRoutingConfig).toHaveBeenCalledWith({
      defaultProviderId: "p-1",
      fallbackProviderIds: [],
    });
    expect(result).toHaveProperty("canonicalGate.ticketId");
  });

  it("derives health enabled channel kinds from a live runtime getter", async () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      supportedChannelKinds: ["webchat", "irc"],
      enabledChannelKinds: () => ["webchat"],
    });

    const route = runtime.routes.getRoutes().find((entry) => entry.operationId === "health.capabilities");
    expect(route).toBeDefined();

    const result = await route!.handler({
      params: {},
      query: {},
      body: null,
      headers: {},
      principal: null,
      requestId: "req-health-runtime-1",
      receivedAt: NOW,
    } as never) as {
      capabilities: {
        channels: {
          supportedKinds: string[];
          enabledKinds: string[];
          webhookEndpoints?: {
            line: boolean;
            whatsapp: boolean;
            lark: boolean;
          };
        };
        mcp?: { enabled: boolean };
        packaging?: { enabled: boolean };
      };
    };

    expect(result.capabilities.channels.supportedKinds).toEqual(["webchat", "irc"]);
    expect(result.capabilities.channels.enabledKinds).toEqual(["webchat"]);
    expect(result.capabilities.channels.webhookEndpoints).toEqual({
      line: false,
      whatsapp: false,
      lark: false,
    });
    expect(result.capabilities.mcp?.enabled).toBe(false);
    expect(result.capabilities.packaging?.enabled).toBe(false);
  });

  it("registers optional extended route families when deps are provided", () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      configManager: makeMockConfigManager(),
      multiTenantSecurity: {} as FridayMultiTenantSecurityRoutesDeps,
      observability: {} as FridayObservabilityRoutesDeps,
      desktop: {} as FridayDesktopRoutesDeps,
      channels: {
        registry: {
          listViews: vi.fn(() => []),
          describe: vi.fn(() => undefined),
        },
      } as unknown as FridayChannelRoutesDeps,
      system: {} as FridaySystemRoutesDeps,
      discovery: {} as FridayDiscoveryRoutesDeps,
      mcpServer: {} as FridayMcpServerRoutesDeps,
      satellitePairing: {} as FridaySatellitePairingRoutesDeps,
      satelliteRuntime: {
        recordHeartbeat: vi.fn(),
        updateCapabilities: vi.fn(),
        pullSync: vi.fn(),
        pushSync: vi.fn(),
        pollCommands: vi.fn(() => []),
        ackCommand: vi.fn(() => ({ acked: true })),
      } as unknown as Omit<FridaySatelliteRuntimeRoutesDeps, "pullEvents" | "getCheckpoint">,
      diagnosis: {
        service: {
          listIncidents: vi.fn(() => []),
          getIncident: vi.fn(() => null),
          getIncidentDiagnosis: vi.fn(() => null),
          listActions: vi.fn(() => []),
          getAction: vi.fn(() => null),
          approveAction: vi.fn(),
          denyAction: vi.fn(),
          manualResolveIncident: vi.fn(),
          executeAction: vi.fn(),
          runReadyActions: vi.fn(),
          rollbackAction: vi.fn(),
          getMetrics: vi.fn(),
          listIssueCards: vi.fn(() => []),
          reportStructuredFailure: vi.fn(),
          emitProcessResults: vi.fn(),
        },
      } as unknown as FridayDiagnosisRoutesDeps,
      autoFix: {
        service: {
          listIncidents: vi.fn(() => []),
          getIncident: vi.fn(() => null),
          getIncidentDiagnosis: vi.fn(() => null),
          listActions: vi.fn(() => []),
          getAction: vi.fn(() => null),
          approveAction: vi.fn(),
          denyAction: vi.fn(),
          manualResolveIncident: vi.fn(),
          executeAction: vi.fn(),
          runReadyActions: vi.fn(),
          rollbackAction: vi.fn(),
          getMetrics: vi.fn(),
          listIssueCards: vi.fn(() => []),
          reportStructuredFailure: vi.fn(),
          emitProcessResults: vi.fn(),
        },
      } as unknown as FridayAutoFixRoutesDeps,
      agentLoop: {
        service: {
          getPolicy: vi.fn(),
          updatePolicy: vi.fn(),
          listRuns: vi.fn(() => []),
          getRun: vi.fn(() => null),
          pauseRun: vi.fn(),
          resumeRun: vi.fn(),
          cancelRun: vi.fn(),
          handleProcessResults: vi.fn(),
          syncAction: vi.fn(),
          findRunByActionId: vi.fn(() => null),
          findRunByIncidentId: vi.fn(() => null),
        },
      } as unknown as FridayAgentLoopRoutesDeps,
      uix: {
        service: {
          resolveIntent: vi.fn(),
          listTemplates: vi.fn(() => []),
          getDiagnostics: vi.fn(() => ({
            generatedAt: "2026-03-25T00:00:00.000Z",
            taskProfilePresets: [],
            recentRuns: [],
            mcpServerStates: [],
            supportedPreprocessors: [],
          })),
          executeTemplate: vi.fn(),
          startWizard: vi.fn(),
          continueWizard: vi.fn(),
          listIssues: vi.fn(() => []),
        },
      } as unknown as FridayUixRoutesDeps,
    });

    const operationIds = runtime.routes.getRoutes().map((route) => route.operationId);
    expect(operationIds).toContain("security.tenants.list");
    expect(operationIds).toContain("observability.traces.search");
    expect(operationIds).toContain("config.get");
    expect(operationIds).toContain("audit.logs.list");
    expect(operationIds).toContain("desktop.actions.execute");
    expect(operationIds).toContain("channels.list");
    expect(operationIds).toContain("system.session.get");
    expect(operationIds).toContain("discovery.scan");
    expect(operationIds).toContain("mcp.server.rpc");
    expect(operationIds).toContain("satellites.register");
    expect(operationIds).toContain("satellites.heartbeat");
    expect(operationIds).toContain("diagnosis.incidents.list");
    expect(operationIds).toContain("autofix.actions.list");
    expect(operationIds).toContain("agent.loop.policy.get");
    expect(operationIds).toContain("uix.templates.list");
  });

  it("enforces tenant boundary on multi-tenant routes for non-privileged principals", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const multiTenantSecurity = {
      tenants: {
        create: vi.fn(),
        list: vi.fn(),
        get: tenantsGet,
        update: vi.fn(),
        delete: vi.fn(),
      },
      workspaces: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      members: {
        add: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      roles: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      assignments: {
        grant: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      secrets: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        rotate: vi.fn(),
        listAccessLog: vi.fn(),
      },
      policies: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        evaluate: vi.fn(),
      },
      audit: {
        list: vi.fn(),
      },
      violations: {
        list: vi.fn(),
        resolve: vi.fn(),
      },
    } as unknown as FridayMultiTenantSecurityRoutesDeps;

    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity,
    });
    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-b",
        scopes: ["security.read"],
      }),
      requestId: "req-1",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tenantsGet).not.toHaveBeenCalled();
  });

  it("allows tenant-scoped multi-tenant route access for same-tenant principals", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-a",
        scopes: ["security.read"],
      }),
      requestId: "req-2",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      tenant: { id: "tenant-a" },
    });
    expect(tenantsGet).toHaveBeenCalledTimes(1);
  });

  it("allows privileged principals to access cross-tenant security routes", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-b",
        role: "admin",
        scopes: ["security.read"],
      }),
      requestId: "req-3",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      tenant: { id: "tenant-a" },
    });
    expect(tenantsGet).toHaveBeenCalledTimes(1);
  });

  it("blocks satellite principals from tenant-scoped security routes", async () => {
    const tenantsGet = vi.fn(() => ({ tenant: { id: "tenant-a" } }));
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      multiTenantSecurity: {
        tenants: {
          create: vi.fn(),
          list: vi.fn(),
          get: tenantsGet,
          update: vi.fn(),
          delete: vi.fn(),
        },
        workspaces: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        members: {
          add: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        roles: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        assignments: {
          grant: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
        secrets: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          rotate: vi.fn(),
          listAccessLog: vi.fn(),
        },
        policies: {
          create: vi.fn(),
          list: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          evaluate: vi.fn(),
        },
        audit: {
          list: vi.fn(),
        },
        violations: {
          list: vi.fn(),
          resolve: vi.fn(),
        },
      } as unknown as FridayMultiTenantSecurityRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "security.tenants.get");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: { tenantId: "tenant-a" },
      query: {},
      body: null,
      headers: {},
      principal: makePrincipal({
        principalType: "satellite",
        principalId: "tenant-a",
        userId: undefined,
        role: "viewer",
        scopes: ["security.read"],
      }),
      requestId: "req-4",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(tenantsGet).not.toHaveBeenCalled();
  });

});
