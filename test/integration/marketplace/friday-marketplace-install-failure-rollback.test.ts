import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayMarketplaceCommerceRoutes } from "../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import { createFridayMarketplaceCommercePersistence } from "../../../src/marketplace/persistence/friday-marketplace-commerce-persistence.js";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

describe("Marketplace install failure rollback (integration)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("does not persist installation when pre-persist phase fails", async () => {
    const idGenerator = createTestIdGenerator();
    const now = "2026-03-01T14:00:00.000Z";
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
      plan: { type: "free" },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const routes = createFridayMarketplaceCommerceRoutes({
      generateId: idGenerator,
      now: () => now,
      beforePersistInstallation: vi.fn().mockRejectedValue(new Error("forced-install-failure")),
      ...store,
    });
    const checkoutRoute = routes.find((route) => route.operationId === "marketplace.checkout.initiate");
    const installRoute = routes.find((route) => route.operationId === "marketplace.listings.install");
    expect(checkoutRoute).toBeDefined();
    expect(installRoute).toBeDefined();

    await checkoutRoute!.handler({
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
        tokenId: "token-checkout",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-checkout",
      receivedAt: now,
    } as never);

    await expect(installRoute!.handler({
      params: { id: "listing-1" },
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-install",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-install",
      receivedAt: now,
    } as never)).rejects.toThrow(FridayDomainError);

    const installs = await store.listInstallations({
      tenantId: "tenant-buyer",
      listingId: "listing-1",
    });
    expect(installs).toHaveLength(0);
  });
});
