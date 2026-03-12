import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayMarketplaceCommerceRoutes } from "../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import { fridayMoney } from "../../../src/marketplace/model/friday-marketplace.types.js";
import { createFridayMarketplaceCommercePersistence } from "../../../src/marketplace/persistence/friday-marketplace-commerce-persistence.js";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

describe("Marketplace duplicate checkout callback (integration)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("rejects duplicate callback replay and keeps entitlement grant singular", async () => {
    const idGenerator = createTestIdGenerator();
    const now = "2026-03-01T15:00:00.000Z";
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
      id: "listing-one-time-1",
      publisherId: "pub-1",
      slug: "workflow-one-time-a",
      status: "published",
      currentVersionId: "version-one-time-1",
      pendingVersionId: null,
      tenantId: null,
      tags: ["workflow"],
      createdAt: now,
      updatedAt: now,
    });

    await store.saveListingVersion({
      id: "version-one-time-1",
      listingId: "listing-one-time-1",
      versionNumber: 1,
      status: "approved",
      title: "Workflow One-time A",
      description: "desc",
      longDescription: null,
      screenshotUrls: [],
      packageName: "@friday/workflow-one-time-a",
      packageVersion: "1.0.0",
      assetType: "workflow",
      pricingPlan: {
        type: "one_time",
        price: fridayMoney(1999, "USD"),
      },
      releaseNotes: null,
      createdAt: now,
    });

    await store.savePricingPlan({
      id: "plan-one-time-1",
      listingId: "listing-one-time-1",
      plan: {
        type: "one_time",
        price: fridayMoney(1999, "USD"),
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
    const completeRoute = routes.find((route) => route.operationId === "marketplace.purchases.complete");
    expect(checkoutRoute).toBeDefined();
    expect(completeRoute).toBeDefined();

    await checkoutRoute!.handler({
      params: {},
      query: {},
      body: {
        listingId: "listing-one-time-1",
        versionId: "version-one-time-1",
        pricingPlanId: "plan-one-time-1",
        idempotencyKey: "checkout-duplicate-callback-1",
      },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-checkout",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-checkout",
      receivedAt: now,
    } as never);

    const pendingPurchases = await store.listPurchases({
      buyerTenantId: "tenant-buyer",
      listingId: "listing-one-time-1",
    });
    expect(pendingPurchases).toHaveLength(1);
    expect(pendingPurchases[0].status).toBe("pending");

    const listing = await store.getListing("listing-one-time-1");
    const version = await store.getListingVersion("version-one-time-1");
    expect(listing).toBeTruthy();
    expect(version).toBeTruthy();
    if (!listing || !version) return;

    const firstCallbackResponse = await completeRoute!.handler({
      params: { id: pendingPurchases[0].id },
      query: {},
      body: { externalPaymentId: "pi-callback-1" },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-callback-1",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-callback-1",
      receivedAt: now,
    } as never);
    expect((firstCallbackResponse as { purchase: { status: string } }).purchase.status).toBe("completed");

    const persistedAfterFirst = await store.listPurchases({
      buyerTenantId: "tenant-buyer",
      listingId: "listing-one-time-1",
    });
    expect(persistedAfterFirst).toHaveLength(1);
    expect(persistedAfterFirst[0].status).toBe("completed");
    expect(persistedAfterFirst[0].externalPaymentId).toBe("pi-callback-1");

    await expect(completeRoute!.handler({
      params: { id: persistedAfterFirst[0].id },
      query: {},
      body: { externalPaymentId: "pi-callback-1" },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-callback-2",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-callback-2",
      receivedAt: now,
    } as never)).rejects.toThrow(FridayDomainError);

    const entitlements = await store.listEntitlements({
      tenantId: "tenant-buyer",
      listingId: "listing-one-time-1",
    });
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].sourceId).toBe(persistedAfterFirst[0].id);
    expect(entitlements[0].status).toBe("active");
  });
});
