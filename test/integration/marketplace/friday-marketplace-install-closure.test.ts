import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceCommerceRoutes } from "../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import { assertListingExecutionReady } from "../../../src/marketplace/engine/entitlement-guard.js";
import { createFridayMarketplaceCommercePersistence } from "../../../src/marketplace/persistence/friday-marketplace-commerce-persistence.js";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

describe("Marketplace install closure (integration)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("enforces acquire -> install -> run readiness with tenant isolation", async () => {
    const idGenerator = createTestIdGenerator();
    const now = "2026-03-01T12:00:00.000Z";
    const store = createFridayMarketplaceCommercePersistence({ db });

    await store.savePublisher({
      id: "pub-1",
      tenantId: "tenant-seller",
      principalId: "tenant-seller",
      displayName: "Seller",
      bio: null,
      avatarUrl: null,
      websiteUrl: null,
      contactEmail: "seller@example.com",
      verificationStatus: "verified",
      legalName: "Seller LLC",
      taxIdLast4: "1234",
      country: "US",
      payoutMethod: "bank_transfer",
      platformFeeBps: 3000,
      createdAt: now,
      updatedAt: now,
    });

    await store.saveListing({
      id: "listing-1",
      publisherId: "pub-1",
      slug: "agent-a",
      status: "published",
      currentVersionId: "version-1",
      pendingVersionId: null,
      tenantId: null,
      tags: ["agent"],
      createdAt: now,
      updatedAt: now,
    });

    await store.saveListingVersion({
      id: "version-1",
      listingId: "listing-1",
      versionNumber: 1,
      status: "approved",
      title: "Agent A",
      description: "desc",
      longDescription: null,
      screenshotUrls: [],
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      assetType: "agent",
      pricingPlan: { type: "free" },
      releaseNotes: null,
      createdAt: now,
    });

    await store.savePricingPlan({
      id: "plan-1",
      listingId: "listing-1",
      plan: {
        type: "free",
      },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const routes = createFridayMarketplaceCommerceRoutes({
      generateId: idGenerator,
      now: () => now,
      ...store,
    });

    const checkoutRoute = routes.find((route) => route.operationId === "marketplace.checkout.initiate");
    const installRoute = routes.find((route) => route.operationId === "marketplace.listings.install");
    expect(checkoutRoute).toBeDefined();
    expect(installRoute).toBeDefined();

    const checkoutResponse = await checkoutRoute!.handler({
      params: {},
      query: {},
      body: {
        listingId: "listing-1",
        versionId: "version-1",
        pricingPlanId: "plan-1",
        idempotencyKey: "checkout-1",
      },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-1",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-checkout",
      receivedAt: now,
    } as never);

    expect((checkoutResponse as { purchase: { status: string } }).purchase.status).toBe("completed");

    const beforeInstall = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-buyer",
      },
      {
        listEntitlements: store.listEntitlements,
        listInstallations: store.listInstallations,
        requireInstallation: true,
      },
    );
    expect(beforeInstall.ok).toBe(false);
    if (!beforeInstall.ok) {
      expect(beforeInstall.error.code).toBe("MARKETPLACE_INSTALL_REQUIRED");
    }

    const installResponse = await installRoute!.handler({
      params: { id: "listing-1" },
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-2",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-install",
      receivedAt: now,
    } as never);

    expect((installResponse as { idempotent: boolean }).idempotent).toBe(false);
    expect((installResponse as { installation: { status: string } }).installation.status).toBe("installed");

    const afterInstall = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-buyer",
      },
      {
        listEntitlements: store.listEntitlements,
        listInstallations: store.listInstallations,
        requireInstallation: true,
      },
    );
    expect(afterInstall.ok).toBe(true);

    const reinstallResponse = await installRoute!.handler({
      params: { id: "listing-1" },
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-3",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-install-2",
      receivedAt: now,
    } as never);
    expect((reinstallResponse as { idempotent: boolean }).idempotent).toBe(true);

    const foreignTenant = await assertListingExecutionReady(
      {
        listingId: "listing-1",
        principalId: "tenant-foreign",
      },
      {
        listEntitlements: store.listEntitlements,
        listInstallations: store.listInstallations,
        requireInstallation: true,
      },
    );
    expect(foreignTenant.ok).toBe(false);
    if (!foreignTenant.ok) {
      expect(foreignTenant.error.code).toBe("MARKETPLACE_ENTITLEMENT_REQUIRED");
    }

    const entitlements = await store.listEntitlements({
      tenantId: "tenant-buyer",
      listingId: "listing-1",
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].status).toBe("active");

    const installations = await store.listInstallations({
      tenantId: "tenant-buyer",
      listingId: "listing-1",
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
    });
    expect(installations).toHaveLength(1);
    expect(installations[0].status).toBe("installed");
  });
});
