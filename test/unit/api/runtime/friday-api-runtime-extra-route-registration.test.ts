import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import type { FridayHubConfigManagerService } from "#hub";
import type {
  FridayAutoFixRoutesDeps,
  FridayAgentLoopRoutesDeps,
  CreateFridayApiRuntimeDeps,
  FridayAuthPrincipal,
  FridayDesktopRoutesDeps,
  FridayDiagnosisRoutesDeps,
  FridayDiscoveryRoutesDeps,
  FridayMcpServerRoutesDeps,
  FridayMarketplaceCommerceRoutesDeps,
  FridayMarketplaceAssetRoutesDeps,
  FridayMarketplaceCreatorRoutesDeps,
  FridayMarketplaceRequestRoutesDeps,
  FridayMultiTenantSecurityRoutesDeps,
  FridayObservabilityRoutesDeps,
  FridaySatellitePairingRoutesDeps,
  FridaySatelliteRuntimeRoutesDeps,
  FridaySystemRoutesDeps,
  FridayUixRoutesDeps,
} from "#api";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-02-27T00:00:00.000Z";
const allocatedDbs: FridaySqliteLayer[] = [];

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
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

  it("does not register optional extended route families when deps are omitted", () => {
    const runtime = createFridayApiRuntime(makeBaseDeps());
    const operationIds = runtime.routes.getRoutes().map((route) => route.operationId);

    expect(operationIds).toContain("version.get");
    expect(operationIds).toContain("secrets.list");
    expect(operationIds).toContain("skills.catalog.list");
    expect(operationIds).toContain("skills.install");
    expect(operationIds).toContain("skills.verify");
    expect(operationIds.some((id) => id.startsWith("security.tenants."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("observability."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("config."))).toBe(false);
    expect(operationIds).not.toContain("audit.logs.list");
    expect(operationIds.some((id) => id.startsWith("desktop."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("system."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("discovery."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("mcp.server."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("marketplace."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("satellites."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("diagnosis."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("autofix."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("agent.loop."))).toBe(false);
    expect(operationIds.some((id) => id.startsWith("uix."))).toBe(false);
  });

  it("registers optional extended route families when deps are provided", () => {
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      configManager: makeMockConfigManager(),
      multiTenantSecurity: {} as FridayMultiTenantSecurityRoutesDeps,
      observability: {} as FridayObservabilityRoutesDeps,
      desktop: {} as FridayDesktopRoutesDeps,
      system: {} as FridaySystemRoutesDeps,
      discovery: {} as FridayDiscoveryRoutesDeps,
      mcpServer: {} as FridayMcpServerRoutesDeps,
      marketplaceCommerce: {} as FridayMarketplaceCommerceRoutesDeps,
      marketplaceAssets: {
        service: {
          listAssets: vi.fn(async () => []),
          getAsset: vi.fn(async () => null),
        },
      } as unknown as FridayMarketplaceAssetRoutesDeps,
      marketplaceCreators: {
        service: {
          listCreators: vi.fn(async () => []),
          getCreator: vi.fn(async () => null),
          recordSupport: vi.fn(async () => ({
            supportEvent: {} as never,
            creator: {} as never,
          })),
        },
      } as unknown as FridayMarketplaceCreatorRoutesDeps,
      marketplaceRequests: {
        service: {
          listRequests: vi.fn(async () => []),
          createRequest: vi.fn(),
          getRequest: vi.fn(async () => null),
          createResponse: vi.fn(),
          acceptResponse: vi.fn(),
          closeRequest: vi.fn(),
        },
      } as unknown as FridayMarketplaceRequestRoutesDeps,
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
          executeAction: vi.fn(),
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
          executeAction: vi.fn(),
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
    expect(operationIds).toContain("system.session.get");
    expect(operationIds).toContain("discovery.scan");
    expect(operationIds).toContain("mcp.server.rpc");
    expect(operationIds).toContain("marketplace.publishers.create");
    expect(operationIds).toContain("marketplace.assets.list");
    expect(operationIds).toContain("marketplace.creators.list");
    expect(operationIds).toContain("marketplace.assets.support");
    expect(operationIds).toContain("marketplace.requests.list");
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

  it("enforces tenant boundary on marketplace routes when buyerTenantId is requested", async () => {
    const listPurchasesSpy = vi.fn(async () => []);
    const marketplaceCommerce = {
      generateId: () => "id-1",
      now: () => NOW,
      getPublisher: vi.fn(async () => null),
      getPublisherByPrincipal: vi.fn(async () => null),
      getPublisherVerification: vi.fn(async () => null),
      listPublishers: vi.fn(async () => []),
      getListing: vi.fn(async () => null),
      getListingBySlug: vi.fn(async () => null),
      listListings: vi.fn(async () => []),
      getListingVersion: vi.fn(async () => null),
      listListingVersions: vi.fn(async () => []),
      getPricingPlan: vi.fn(async () => null),
      listPricingPlans: vi.fn(async () => []),
      getPurchase: vi.fn(async () => null),
      listPurchases: listPurchasesSpy,
      getEntitlement: vi.fn(async () => null),
      listEntitlements: vi.fn(async () => []),
      listSubscriptions: vi.fn(async () => []),
      getSubscription: vi.fn(async () => null),
      listRefunds: vi.fn(async () => []),
      getSearchIndex: vi.fn(async () => []),
      savePublisher: vi.fn(async () => undefined),
      saveListing: vi.fn(async () => undefined),
      saveListingVersion: vi.fn(async () => undefined),
      savePricingPlan: vi.fn(async () => undefined),
      savePurchase: vi.fn(async () => undefined),
      saveEntitlement: vi.fn(async () => undefined),
      saveSubscription: vi.fn(async () => undefined),
      saveRefund: vi.fn(async () => undefined),
    } as unknown as FridayMarketplaceCommerceRoutesDeps;

    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      marketplaceCommerce,
    });
    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "marketplace.purchases.list");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: {},
      query: {
        buyerTenantId: "tenant-a",
      },
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-b",
        scopes: ["marketplace.read"],
      }),
      requestId: "req-1",
      receivedAt: NOW,
    } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(listPurchasesSpy).not.toHaveBeenCalled();
  });

  it("allows marketplace routes when buyerTenantId matches principal", async () => {
    const listPurchasesSpy = vi.fn(async () => []);
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      marketplaceCommerce: {
        generateId: () => "id-1",
        now: () => NOW,
        getPublisher: vi.fn(async () => null),
        getPublisherByPrincipal: vi.fn(async () => null),
        getPublisherVerification: vi.fn(async () => null),
        listPublishers: vi.fn(async () => []),
        getListing: vi.fn(async () => null),
        getListingBySlug: vi.fn(async () => null),
        listListings: vi.fn(async () => []),
        getListingVersion: vi.fn(async () => null),
        listListingVersions: vi.fn(async () => []),
        getPricingPlan: vi.fn(async () => null),
        listPricingPlans: vi.fn(async () => []),
        getPurchase: vi.fn(async () => null),
        listPurchases: listPurchasesSpy,
        getEntitlement: vi.fn(async () => null),
        listEntitlements: vi.fn(async () => []),
        listSubscriptions: vi.fn(async () => []),
        getSubscription: vi.fn(async () => null),
        listRefunds: vi.fn(async () => []),
        getSearchIndex: vi.fn(async () => []),
        savePublisher: vi.fn(async () => undefined),
        saveListing: vi.fn(async () => undefined),
        saveListingVersion: vi.fn(async () => undefined),
        savePricingPlan: vi.fn(async () => undefined),
        savePurchase: vi.fn(async () => undefined),
        saveEntitlement: vi.fn(async () => undefined),
        saveSubscription: vi.fn(async () => undefined),
        saveRefund: vi.fn(async () => undefined),
      } as unknown as FridayMarketplaceCommerceRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "marketplace.purchases.list");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: {},
      query: {
        buyerTenantId: "tenant-a",
      },
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-a",
        scopes: ["marketplace.read"],
      }),
      requestId: "req-2",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      items: [],
    });

    expect(listPurchasesSpy).toHaveBeenCalledTimes(1);
  });

  it("allows privileged principals for cross-tenant marketplace queries", async () => {
    const listPurchasesSpy = vi.fn(async () => []);
    const runtime = createFridayApiRuntime({
      ...makeBaseDeps(),
      marketplaceCommerce: {
        generateId: () => "id-1",
        now: () => NOW,
        getPublisher: vi.fn(async () => null),
        getPublisherByPrincipal: vi.fn(async () => null),
        getPublisherVerification: vi.fn(async () => null),
        listPublishers: vi.fn(async () => []),
        getListing: vi.fn(async () => null),
        getListingBySlug: vi.fn(async () => null),
        listListings: vi.fn(async () => []),
        getListingVersion: vi.fn(async () => null),
        listListingVersions: vi.fn(async () => []),
        getPricingPlan: vi.fn(async () => null),
        listPricingPlans: vi.fn(async () => []),
        getPurchase: vi.fn(async () => null),
        listPurchases: listPurchasesSpy,
        getEntitlement: vi.fn(async () => null),
        listEntitlements: vi.fn(async () => []),
        listSubscriptions: vi.fn(async () => []),
        getSubscription: vi.fn(async () => null),
        listRefunds: vi.fn(async () => []),
        getSearchIndex: vi.fn(async () => []),
        savePublisher: vi.fn(async () => undefined),
        saveListing: vi.fn(async () => undefined),
        saveListingVersion: vi.fn(async () => undefined),
        savePricingPlan: vi.fn(async () => undefined),
        savePurchase: vi.fn(async () => undefined),
        saveEntitlement: vi.fn(async () => undefined),
        saveSubscription: vi.fn(async () => undefined),
        saveRefund: vi.fn(async () => undefined),
      } as unknown as FridayMarketplaceCommerceRoutesDeps,
    });

    const route = runtime.routes
      .getRoutes()
      .find((entry) => entry.operationId === "marketplace.purchases.list");
    expect(route).toBeDefined();

    await expect(route!.handler({
      params: {},
      query: {
        buyerTenantId: "tenant-a",
      },
      body: null,
      headers: {},
      principal: makePrincipal({
        principalId: "tenant-admin",
        role: "admin",
        scopes: ["marketplace.read"],
      }),
      requestId: "req-3",
      receivedAt: NOW,
    } as never)).resolves.toMatchObject({
      items: [],
    });

    expect(listPurchasesSpy).toHaveBeenCalledTimes(1);
  });
});
