import { describe, it, expect, vi } from "vitest";
import { createFridayMarketplaceCommerceRoutes } from "../../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import type { FridayMarketplaceCommerceRoutesDeps } from "../../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import { FridayDomainError } from "#errors";

// ─── Test Helpers ───

function createMockDeps(overrides: Partial<FridayMarketplaceCommerceRoutesDeps> = {}): FridayMarketplaceCommerceRoutesDeps {
  return {
    generateId: () => `id-${Date.now()}`,
    now: () => "2026-02-25T00:00:00Z",
    auditSink: undefined,

    getPublisher: vi.fn().mockResolvedValue(null),
    getPublisherByPrincipal: vi.fn().mockResolvedValue(null),
    getPublisherVerification: vi.fn().mockResolvedValue(null),
    listPublishers: vi.fn().mockResolvedValue([]),

    getListing: vi.fn().mockResolvedValue(null),
    getListingBySlug: vi.fn().mockResolvedValue(null),
    listListings: vi.fn().mockResolvedValue([]),
    getListingVersion: vi.fn().mockResolvedValue(null),
    listListingVersions: vi.fn().mockResolvedValue([]),

    getPricingPlan: vi.fn().mockResolvedValue(null),
    listPricingPlans: vi.fn().mockResolvedValue([]),

    getPurchase: vi.fn().mockResolvedValue(null),
    listPurchases: vi.fn().mockResolvedValue([]),

    getEntitlement: vi.fn().mockResolvedValue(null),
    listEntitlements: vi.fn().mockResolvedValue([]),
    listInstallations: vi.fn().mockResolvedValue([]),

    listSubscriptions: vi.fn().mockResolvedValue([]),
    getSubscription: vi.fn().mockResolvedValue(null),

    listRefunds: vi.fn().mockResolvedValue([]),
    listPayoutEntries: vi.fn().mockResolvedValue([]),
    listPayoutBatches: vi.fn().mockResolvedValue([]),
    getPayoutBatch: vi.fn().mockResolvedValue(null),
    listPayoutBatchEntries: vi.fn().mockResolvedValue([]),
    listBillingEvents: vi.fn().mockResolvedValue([]),
    getSearchIndex: vi.fn().mockResolvedValue([]),

    savePublisher: vi.fn().mockResolvedValue(undefined),
    saveListing: vi.fn().mockResolvedValue(undefined),
    saveListingVersion: vi.fn().mockResolvedValue(undefined),
    savePricingPlan: vi.fn().mockResolvedValue(undefined),
    savePurchase: vi.fn().mockResolvedValue(undefined),
    saveEntitlement: vi.fn().mockResolvedValue(undefined),
    saveInstallation: vi.fn().mockResolvedValue(undefined),
    saveSubscription: vi.fn().mockResolvedValue(undefined),
    saveRefund: vi.fn().mockResolvedValue(undefined),
    savePayoutEntry: vi.fn().mockResolvedValue(undefined),
    savePayoutEntries: vi.fn().mockResolvedValue(undefined),
    savePayoutBatch: vi.fn().mockResolvedValue(undefined),

    ...overrides,
  };
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { principalId: "user-1", role: "viewer", scopes: ["marketplace.read", "marketplace.write"] },
    requestId: "req-1",
    receivedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  } as never;
}

function findRoute(routes: ReturnType<typeof createFridayMarketplaceCommerceRoutes>, operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

// ─── Route Registration Tests ───

describe("createFridayMarketplaceCommerceRoutes — registration", () => {
  const deps = createMockDeps();
  const routes = createFridayMarketplaceCommerceRoutes(deps);

  it("creates routes array", () => {
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("all routes have required fields", () => {
    for (const route of routes) {
      expect(route.operationId).toBeTruthy();
      expect(route.method).toBeTruthy();
      expect(route.path).toBeTruthy();
      expect(route.handler).toBeTypeOf("function");
      expect(route.auth).toBeDefined();
    }
  });

  it("all routes require authentication", () => {
    for (const route of routes) {
      expect(route.auth).toHaveProperty("public", false);
    }
  });

  it("all paths start with /v1/marketplace/", () => {
    for (const route of routes) {
      expect(route.path).toMatch(/^\/v1\/marketplace\//);
    }
  });

  it("has publisher routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.publishers.create")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.get")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.update")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.verification.submit")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.verification.review")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.suspend")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.publishers.reinstate")).toBe(true);
  });

  it("has listing routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.listings.create")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.get")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.list")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.review.submit")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.review")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.suspend")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.reinstate")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.archive")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.listings.install")).toBe(true);
  });

  it("has pricing routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.pricing.create")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.pricing.list")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.pricing.deactivate")).toBe(true);
  });

  it("has purchase routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.checkout.initiate")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.purchases.get")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.purchases.list")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.purchases.refund")).toBe(true);
  });

  it("has entitlement routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.entitlements.check")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.entitlements.list")).toBe(true);
  });

  it("has subscription routes", () => {
    expect(routes.some((r) => r.operationId === "marketplace.subscriptions.list")).toBe(true);
    expect(routes.some((r) => r.operationId === "marketplace.subscriptions.get")).toBe(true);
  });

  it("has search route", () => {
    expect(routes.some((r) => r.operationId === "marketplace.search")).toBe(true);
  });

  it("has earnings route", () => {
    expect(routes.some((r) => r.operationId === "marketplace.earnings.summary")).toBe(true);
  });

  it("admin-only routes require marketplace.admin scope", () => {
    const adminOps = [
      "marketplace.publishers.verification.review",
      "marketplace.publishers.suspend",
      "marketplace.publishers.reinstate",
      "marketplace.listings.review",
      "marketplace.listings.suspend",
      "marketplace.listings.reinstate",
      "marketplace.purchases.refund",
    ];
    for (const opId of adminOps) {
      const route = findRoute(routes, opId);
      const auth = route.auth as { public: false; anyOfScopes: string[] };
      expect(auth.anyOfScopes).toContain("marketplace.admin");
    }
  });

  it("write routes use marketplace.write scope", () => {
    const writeOps = [
      "marketplace.publishers.create",
      "marketplace.publishers.update",
      "marketplace.publishers.verification.submit",
      "marketplace.listings.create",
      "marketplace.listings.review.submit",
      "marketplace.listings.archive",
      "marketplace.listings.install",
      "marketplace.pricing.create",
      "marketplace.pricing.deactivate",
      "marketplace.checkout.initiate",
    ];
    for (const opId of writeOps) {
      const route = findRoute(routes, opId);
      const auth = route.auth as { public: false; anyOfScopes: string[] };
      expect(auth.anyOfScopes).toContain("marketplace.write");
    }
  });

  it("read routes use marketplace.read scope", () => {
    const readOps = [
      "marketplace.publishers.get",
      "marketplace.listings.get",
      "marketplace.listings.list",
      "marketplace.pricing.list",
      "marketplace.purchases.get",
      "marketplace.purchases.list",
      "marketplace.entitlements.check",
      "marketplace.entitlements.list",
      "marketplace.subscriptions.list",
      "marketplace.subscriptions.get",
      "marketplace.search",
      "marketplace.earnings.summary",
    ];
    for (const opId of readOps) {
      const route = findRoute(routes, opId);
      const auth = route.auth as { public: false; anyOfScopes: string[] };
      expect(auth.anyOfScopes).toContain("marketplace.read");
    }
  });
});

// ─── Publisher Handler Tests ───

describe("marketplace.publishers.create", () => {
  it("creates a publisher successfully", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.publishers.create");

    const ctx = createMockCtx({
      body: {
        displayName: "Test Publisher",
        contactEmail: "test@example.com",
      },
    });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("publisher");
    expect(deps.savePublisher).toHaveBeenCalledTimes(1);
  });

  it("rejects missing displayName", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.publishers.create");

    const ctx = createMockCtx({
      body: { contactEmail: "test@example.com" },
    });

    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects missing contactEmail", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.publishers.create");

    const ctx = createMockCtx({
      body: { displayName: "Test" },
    });

    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

describe("marketplace.publishers.get", () => {
  it("returns publisher when found", async () => {
    const mockPublisher = { id: "pub-1", displayName: "Test" };
    const deps = createMockDeps({
      getPublisher: vi.fn().mockResolvedValue(mockPublisher),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.publishers.get");

    const ctx = createMockCtx({ params: { id: "pub-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ publisher: mockPublisher });
  });

  it("throws 404 when not found", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.publishers.get");

    const ctx = createMockCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);

    try {
      await route.handler(ctx);
    } catch (err) {
      expect((err as FridayDomainError).httpStatus).toBe(404);
    }
  });
});

// ─── Listing Handler Tests ───

describe("marketplace.listings.get", () => {
  it("returns listing when found", async () => {
    const mockListing = { id: "list-1", title: "Test Listing" };
    const deps = createMockDeps({
      getListing: vi.fn().mockResolvedValue(mockListing),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.get");

    const ctx = createMockCtx({ params: { id: "list-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ listing: mockListing });
  });

  it("throws 404 when not found", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.get");

    const ctx = createMockCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

describe("marketplace.listings.list", () => {
  it("returns empty list", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.list");

    const ctx = createMockCtx();
    const result = await route.handler(ctx);
    expect(result).toEqual({ items: [], total: 0 });
  });
});

describe("marketplace.listings.create", () => {
  it("rejects missing assetType", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.create");

    const ctx = createMockCtx({
      body: {
        publisherId: "pub-1",
        slug: "agent-a",
        title: "Agent A",
        description: "desc",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
        pricingPlan: { type: "free" },
      },
    });

    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

describe("marketplace.listings.install", () => {
  it("installs when entitlement is active", async () => {
    const auditSink = vi.fn();
    const deps = createMockDeps({
      auditSink,
      getListing: vi.fn().mockResolvedValue({
        id: "list-1",
        status: "published",
        currentVersionId: "ver-1",
      } as never),
      getListingVersion: vi.fn().mockResolvedValue({
        id: "ver-1",
        listingId: "list-1",
        status: "approved",
        assetType: "agent",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
      } as never),
      listEntitlements: vi.fn().mockResolvedValue([{ id: "ent-1", status: "active" }]),
      listInstallations: vi.fn().mockResolvedValue([]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.install");

    const ctx = createMockCtx({
      params: { id: "list-1" },
      body: {},
    });
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("installation");
    expect(result).toHaveProperty("idempotent", false);
    expect(result).toHaveProperty("delivery.status", "installed");
    expect(result).toHaveProperty("delivery.reasonCode", "MARKETPLACE_INSTALL_COMMITTED");
    expect(result).toHaveProperty("delivery.rollback.attempted", false);
    expect(result).toHaveProperty("delivery.rollback.succeeded", false);
    expect(deps.saveInstallation).toHaveBeenCalledTimes(1);
    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "listing.installation.completed",
      }),
    );
  });

  it("returns idempotent install when already installed", async () => {
    const auditSink = vi.fn();
    const existing = {
      id: "inst-1",
      tenantId: "user-1",
      principalId: "user-1",
      listingId: "list-1",
      assetType: "agent",
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      status: "installed",
      lastError: null,
      installedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    };
    const deps = createMockDeps({
      auditSink,
      getListing: vi.fn().mockResolvedValue({
        id: "list-1",
        status: "published",
        currentVersionId: "ver-1",
      } as never),
      getListingVersion: vi.fn().mockResolvedValue({
        id: "ver-1",
        listingId: "list-1",
        status: "approved",
        assetType: "agent",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
      } as never),
      listEntitlements: vi.fn().mockResolvedValue([{ id: "ent-1", status: "active" }]),
      listInstallations: vi.fn().mockResolvedValue([existing]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.install");

    const ctx = createMockCtx({
      params: { id: "list-1" },
      body: {},
    });
    const result = await route.handler(ctx);
    expect(result).toEqual(expect.objectContaining({
      installation: existing,
      idempotent: true,
      delivery: expect.objectContaining({
        status: "idempotent",
        reasonCode: "MARKETPLACE_INSTALL_ALREADY_INSTALLED",
      }),
    }));
    expect(deps.saveInstallation).not.toHaveBeenCalled();
    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "listing.installation.idempotent",
      }),
    );
  });

  it("rejects install without active entitlement", async () => {
    const auditSink = vi.fn();
    const deps = createMockDeps({
      auditSink,
      getListing: vi.fn().mockResolvedValue({
        id: "list-1",
        status: "published",
        currentVersionId: "ver-1",
      } as never),
      getListingVersion: vi.fn().mockResolvedValue({
        id: "ver-1",
        listingId: "list-1",
        status: "approved",
        assetType: "agent",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
      } as never),
      listEntitlements: vi.fn().mockResolvedValue([]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.install");

    const ctx = createMockCtx({
      params: { id: "list-1" },
      body: {},
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "listing.installation.denied",
      }),
    );
  });

  it("returns installation failed when pre-persist hook throws", async () => {
    const auditSink = vi.fn();
    const deps = createMockDeps({
      auditSink,
      beforePersistInstallation: vi.fn().mockRejectedValue(new Error("forced failure")),
      getListing: vi.fn().mockResolvedValue({
        id: "list-1",
        status: "published",
        currentVersionId: "ver-1",
      } as never),
      getListingVersion: vi.fn().mockResolvedValue({
        id: "ver-1",
        listingId: "list-1",
        status: "approved",
        assetType: "agent",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
      } as never),
      listEntitlements: vi.fn().mockResolvedValue([{ id: "ent-1", status: "active" }]),
      listInstallations: vi.fn().mockResolvedValue([]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.install");

    const ctx = createMockCtx({
      params: { id: "list-1" },
      body: {},
    });
    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_INSTALLATION_FAILED",
      details: expect.objectContaining({
        reasonCode: "MARKETPLACE_INSTALL_PREPARE_FAILED",
      }),
    });
    expect(deps.saveInstallation).not.toHaveBeenCalled();
    expect(auditSink).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "listing.installation.failed",
      }),
    );
  });

  it("attempts rollback when persistence fails after prepare", async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    const deps = createMockDeps({
      beforePersistInstallation: vi.fn().mockResolvedValue({
        rollback,
        metadata: { pipeline: "mock" },
      }),
      saveInstallation: vi.fn().mockRejectedValue(new Error("db down")),
      getListing: vi.fn().mockResolvedValue({
        id: "list-1",
        status: "published",
        currentVersionId: "ver-1",
      } as never),
      getListingVersion: vi.fn().mockResolvedValue({
        id: "ver-1",
        listingId: "list-1",
        status: "approved",
        assetType: "agent",
        packageName: "@friday/agent-a",
        packageVersion: "1.0.0",
      } as never),
      listEntitlements: vi.fn().mockResolvedValue([{ id: "ent-1", status: "active" }]),
      listInstallations: vi.fn().mockResolvedValue([]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.listings.install");

    const ctx = createMockCtx({
      params: { id: "list-1" },
      body: {},
    });

    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: "MARKETPLACE_INSTALLATION_FAILED",
      details: expect.objectContaining({
        reasonCode: "MARKETPLACE_INSTALL_PERSIST_FAILED",
        rollbackAttempted: true,
        rollbackSucceeded: true,
      }),
    });
    expect(rollback).toHaveBeenCalledWith({
      reasonCode: "MARKETPLACE_INSTALL_PERSIST_FAILED",
      message: "db down",
    });
  });
});

// ─── Pricing Handler Tests ───

describe("marketplace.pricing.list", () => {
  it("returns pricing plans for a listing", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.pricing.list");

    const ctx = createMockCtx({ params: { listingId: "list-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ items: [], total: 0 });
  });
});

describe("marketplace.pricing.create", () => {
  it("rejects non-MVP pricing plan type", async () => {
    const deps = createMockDeps({
      getListing: vi.fn().mockResolvedValue({ id: "list-1" } as never),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.pricing.create");

    const ctx = createMockCtx({
      params: { listingId: "list-1" },
      body: {
        plan: {
          type: "subscription",
          intervalMonths: 1,
          trialDays: 7,
          price: { amount: 999, currency: "USD" },
        },
      },
    });

    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

// ─── Purchase Handler Tests ───

describe("marketplace.purchases.get", () => {
  it("throws 404 for missing purchase", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.get");

    const ctx = createMockCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("blocks cross-tenant purchase access for non-admin principals", async () => {
    const deps = createMockDeps({
      getPurchase: vi.fn().mockResolvedValue({
        id: "purchase-1",
        buyerTenantId: "tenant-other",
      }),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.get");

    const ctx = createMockCtx({ params: { id: "purchase-1" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("allows cross-tenant purchase access for admin principals", async () => {
    const purchase = { id: "purchase-1", buyerTenantId: "tenant-other" };
    const deps = createMockDeps({
      getPurchase: vi.fn().mockResolvedValue(purchase),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.get");

    const ctx = createMockCtx({
      params: { id: "purchase-1" },
      principal: {
        principalId: "admin-1",
        role: "admin",
        scopes: ["marketplace.read", "marketplace.admin"],
      },
    });
    await expect(route.handler(ctx)).resolves.toEqual({ purchase });
  });
});

describe("marketplace.purchases.list", () => {
  it("returns empty list", async () => {
    const listPurchases = vi.fn().mockResolvedValue([]);
    const deps = createMockDeps({
      listPurchases,
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.list");

    const ctx = createMockCtx();
    const result = await route.handler(ctx);
    expect(result).toEqual({ items: [], total: 0 });
    expect(listPurchases).toHaveBeenCalledWith({
      buyerTenantId: "user-1",
      listingId: undefined,
    });
  });
});

// ─── Entitlement Handler Tests ───

describe("marketplace.entitlements.check", () => {
  it("requires listingId query param", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.entitlements.check");

    const ctx = createMockCtx();
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("returns not entitled for empty results", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.entitlements.check");

    const ctx = createMockCtx({ query: { listingId: "list-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ entitled: false, entitlement: null });
  });

  it("returns entitled for active entitlement", async () => {
    const activeEntitlement = { id: "ent-1", status: "active", listingId: "list-1" };
    const deps = createMockDeps({
      listEntitlements: vi.fn().mockResolvedValue([activeEntitlement]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.entitlements.check");

    const ctx = createMockCtx({ query: { listingId: "list-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ entitled: true, entitlement: activeEntitlement });
  });

  it("returns entitled for grace entitlement", async () => {
    const graceEntitlement = { id: "ent-2", status: "grace", listingId: "list-1" };
    const deps = createMockDeps({
      listEntitlements: vi.fn().mockResolvedValue([graceEntitlement]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.entitlements.check");

    const ctx = createMockCtx({ query: { listingId: "list-1" } });
    const result = await route.handler(ctx);
    expect(result).toEqual({ entitled: true, entitlement: graceEntitlement });
  });
});

describe("marketplace.entitlements.list", () => {
  it("returns empty list", async () => {
    const listEntitlements = vi.fn().mockResolvedValue([]);
    const deps = createMockDeps({
      listEntitlements,
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.entitlements.list");

    const ctx = createMockCtx();
    const result = await route.handler(ctx);
    expect(result).toEqual({ items: [], total: 0 });
    expect(listEntitlements).toHaveBeenCalledWith({
      tenantId: "user-1",
      listingId: undefined,
    });
  });
});

// ─── Subscription Handler Tests ───

describe("marketplace.subscriptions.get", () => {
  it("throws 404 for missing subscription", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.subscriptions.get");

    const ctx = createMockCtx({ params: { id: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("blocks cross-tenant subscription access for non-admin principals", async () => {
    const deps = createMockDeps({
      getSubscription: vi.fn().mockResolvedValue({
        id: "sub-1",
        buyerTenantId: "tenant-other",
      }),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.subscriptions.get");

    const ctx = createMockCtx({ params: { id: "sub-1" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

describe("marketplace.subscriptions.list", () => {
  it("returns empty list", async () => {
    const listSubscriptions = vi.fn().mockResolvedValue([]);
    const deps = createMockDeps({
      listSubscriptions,
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.subscriptions.list");

    const ctx = createMockCtx();
    const result = await route.handler(ctx);
    expect(result).toEqual({ items: [], total: 0 });
    expect(listSubscriptions).toHaveBeenCalledWith({
      buyerTenantId: "user-1",
    });
  });
});

// ─── Search Handler Tests ───

describe("marketplace.search", () => {
  it("returns empty search results", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.search");

    const ctx = createMockCtx();
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("total", 0);
    expect(result).toHaveProperty("hasMore", false);
  });
});

// ─── Earnings Handler Tests ───

describe("marketplace.earnings.summary", () => {
  it("returns earnings for existing publisher", async () => {
    const mockPublisher = { id: "pub-1", tenantId: "user-1", displayName: "Test" };
    const deps = createMockDeps({
      getPublisher: vi.fn().mockResolvedValue(mockPublisher),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.earnings.summary");

    const ctx = createMockCtx({ params: { publisherId: "pub-1" } });
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("summary");
    expect((result as { summary: { publisherId: string } }).summary.publisherId).toBe("pub-1");
  });

  it("throws 404 for missing publisher", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.earnings.summary");

    const ctx = createMockCtx({ params: { publisherId: "nonexistent" } });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

describe("marketplace.payout.batches.initiate", () => {
  it("creates payout batch and persists entries", async () => {
    const deps = createMockDeps({
      getPublisher: vi.fn().mockResolvedValue({
        id: "pub-1",
        tenantId: "user-1",
      }),
      listPayoutEntries: vi.fn().mockResolvedValue([
        {
          id: "entry-1",
          publisherId: "pub-1",
          purchaseId: "purchase-1",
          listingId: "listing-1",
          grossAmount: { amount: 10000, currency: "USD" },
          platformFee: { amount: 3000, currency: "USD" },
          netAmount: { amount: 6000, currency: "USD" },
          taxWithholding: { amount: 1000, currency: "USD" },
          payoutBatchId: null,
          status: "pending",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ]),
    });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.payout.batches.initiate");

    const result = await route.handler(createMockCtx({
      params: { publisherId: "pub-1" },
      body: {
        periodStart: "2026-03-01T00:00:00.000Z",
        periodEnd: "2026-03-31T00:00:00.000Z",
        idempotencyKey: "idem-1",
      },
    }));

    expect(result).toHaveProperty("batch");
    expect(deps.savePayoutBatch).toHaveBeenCalledTimes(1);
    expect(deps.savePayoutEntries).toHaveBeenCalledTimes(1);
  });
});

describe("marketplace.billing.events.list", () => {
  it("passes parsed filters to data layer", async () => {
    const listBillingEvents = vi.fn().mockResolvedValue([
      {
        id: "evt-1",
        eventType: "payment.succeeded",
        source: "webhook",
        referenceType: "purchase",
        referenceId: "purchase-1",
        payload: {},
        processed: true,
        createdAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    const deps = createMockDeps({ listBillingEvents });
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.billing.events.list");

    const result = await route.handler(createMockCtx({
      principal: {
        principalId: "admin-1",
        role: "admin",
        scopes: ["marketplace.read", "marketplace.admin"],
      },
      query: {
        processed: "true",
        eventType: "payment.succeeded",
      },
    }));

    expect(result).toEqual({
      items: expect.any(Array),
      total: 1,
      hasMore: false,
    });
    expect(listBillingEvents).toHaveBeenCalledWith({
      eventType: "payment.succeeded",
      processed: true,
      after: undefined,
      before: undefined,
    });
  });
});

// ─── Checkout Validation Tests ───

describe("marketplace.checkout.initiate — validation", () => {
  it("rejects missing listingId", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.checkout.initiate");

    const ctx = createMockCtx({
      body: { versionId: "v-1", pricingPlanId: "pp-1" },
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects missing versionId", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.checkout.initiate");

    const ctx = createMockCtx({
      body: { listingId: "l-1", pricingPlanId: "pp-1" },
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("rejects missing pricingPlanId", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.checkout.initiate");

    const ctx = createMockCtx({
      body: { listingId: "l-1", versionId: "v-1" },
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("throws 404 for missing listing", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.checkout.initiate");

    const ctx = createMockCtx({
      body: { listingId: "l-1", versionId: "v-1", pricingPlanId: "pp-1" },
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});

// ─── Refund Validation Tests ───

describe("marketplace.purchases.refund — validation", () => {
  it("rejects missing reason", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.refund");

    const ctx = createMockCtx({ params: { id: "p-1" }, body: {} });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });

  it("throws 404 for missing purchase", async () => {
    const deps = createMockDeps();
    const routes = createFridayMarketplaceCommerceRoutes(deps);
    const route = findRoute(routes, "marketplace.purchases.refund");

    const ctx = createMockCtx({
      params: { id: "nonexistent" },
      body: { reason: "Duplicate charge" },
    });
    await expect(route.handler(ctx)).rejects.toThrow(FridayDomainError);
  });
});
