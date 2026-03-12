import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createFridayMarketplaceCommerceRoutes } from "../../../src/api/http/routes/friday-marketplace-commerce-routes.js";
import { createFridayWorkflowRunRoutes } from "../../../src/api/http/routes/friday-workflow-run-routes.js";
import { assertListingExecutionReady } from "../../../src/marketplace/engine/entitlement-guard.js";
import { createFridayMarketplaceCommercePersistence } from "../../../src/marketplace/persistence/friday-marketplace-commerce-persistence.js";
import { fridayMoney } from "../../../src/marketplace/model/friday-marketplace.types.js";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

describe("Marketplace workflow one-time run guard (integration)", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("requires install before workflow run and allows run after install", async () => {
    const idGenerator = createTestIdGenerator();
    const now = "2026-03-01T13:00:00.000Z";
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
      id: "listing-workflow-1",
      publisherId: "pub-1",
      slug: "workflow-a",
      status: "published",
      currentVersionId: "version-workflow-1",
      pendingVersionId: null,
      tenantId: null,
      tags: ["workflow"],
      createdAt: now,
      updatedAt: now,
    });

    await store.saveListingVersion({
      id: "version-workflow-1",
      listingId: "listing-workflow-1",
      versionNumber: 1,
      status: "approved",
      title: "Workflow A",
      description: "desc",
      longDescription: null,
      screenshotUrls: [],
      packageName: "@friday/workflow-a",
      packageVersion: "1.0.0",
      assetType: "workflow",
      pricingPlan: {
        type: "one_time",
        price: fridayMoney(2999, "USD"),
      },
      releaseNotes: null,
      createdAt: now,
    });

    await store.savePricingPlan({
      id: "plan-workflow-1",
      listingId: "listing-workflow-1",
      plan: {
        type: "one_time",
        price: fridayMoney(2999, "USD"),
      },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });

    const commerceRoutes = createFridayMarketplaceCommerceRoutes({
      generateId: idGenerator,
      now: () => now,
      ...store,
    });
    const checkoutRoute = commerceRoutes.find((route) => route.operationId === "marketplace.checkout.initiate");
    const completeRoute = commerceRoutes.find((route) => route.operationId === "marketplace.purchases.complete");
    const installRoute = commerceRoutes.find((route) => route.operationId === "marketplace.listings.install");
    expect(checkoutRoute).toBeDefined();
    expect(completeRoute).toBeDefined();
    expect(installRoute).toBeDefined();

    const checkoutResponse = await checkoutRoute!.handler({
      params: {},
      query: {},
      body: {
        listingId: "listing-workflow-1",
        versionId: "version-workflow-1",
        pricingPlanId: "plan-workflow-1",
        idempotencyKey: "checkout-workflow-1",
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
    expect((checkoutResponse as { purchase: { amount: { amount: number } } }).purchase.amount.amount).toBe(2999);

    // Simulate payment-complete webhook via purchase completion callback route.
    const purchases = await store.listPurchases({
      buyerTenantId: "tenant-buyer",
      listingId: "listing-workflow-1",
    });
    expect(purchases.length).toBeGreaterThan(0);
    await completeRoute!.handler({
      params: { id: purchases[0].id },
      query: {},
      body: { externalPaymentId: "pi-workflow-1" },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["marketplace.write"],
        tokenId: "token-complete",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-complete",
      receivedAt: now,
    } as never);

    const startRun = vi.fn(async () => ({ run: { id: "run-1", workflowId: "wf-1", status: "pending" } }));
    const runRoutes = createFridayWorkflowRunRoutes({
      assertListingEntitled: async (listingId, principal) => {
        const principalId = principal?.principalId;
        if (!principalId) {
          throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
        }
        const result = await assertListingExecutionReady(
          {
            listingId,
            principalId,
          },
          {
            listEntitlements: store.listEntitlements,
            listInstallations: store.listInstallations,
            requireInstallation: true,
          },
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, {
            httpStatus: result.error.httpStatus,
          });
        }
      },
      startRun,
      getRun: () => ({ run: { id: "run-1", workflowId: "wf-1", status: "pending" } } as never),
      listRunNodes: () => ({ items: [] }),
      getRunTimeline: () => ({ items: [] }),
      getRunEvidence: () => ({ run: { id: "run-1" }, events: [] } as never),
      listRunEvidenceExports: () => ({ items: [] }),
      exportRunEvidence: () => ({ export: { exportId: "exp-1" }, evidence: { run: { id: "run-1" } } } as never),
      getRunEvidenceExport: () => ({ export: { exportId: "exp-1" }, evidence: { run: { id: "run-1" } } } as never),
      downloadRunEvidenceExport: () => ({ export: { exportId: "exp-1" }, file: { uri: "x", exists: false }, content: "{}" } as never),
      cancelRun: async () => ({ run: { id: "run-1" } } as never),
      retryRun: async () => ({ run: { id: "run-1" }, retriedNodes: [] } as never),
      resumeRun: async () => ({ run: { id: "run-1" } } as never),
    });
    const startRoute = runRoutes.find((route) => route.operationId === "runs.start");
    expect(startRoute).toBeDefined();

    await expect(startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: "wf-1",
        marketplaceListingId: "listing-workflow-1",
      },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["workflow.run"],
        tokenId: "token-run-before-install",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-run-before-install",
      receivedAt: now,
    } as never)).rejects.toThrow(FridayDomainError);

    await installRoute!.handler({
      params: { id: "listing-workflow-1" },
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
    } as never);

    await expect(startRoute!.handler({
      params: {},
      query: {},
      body: {
        workflowId: "wf-1",
        marketplaceListingId: "listing-workflow-1",
      },
      headers: {},
      principal: {
        principalType: "user",
        principalId: "tenant-buyer",
        role: "viewer",
        scopes: ["workflow.run"],
        tokenId: "token-run-after-install",
        tokenKind: "access",
        issuedAt: now,
      },
      requestId: "req-run-after-install",
      receivedAt: now,
    } as never)).resolves.toMatchObject({
      run: {
        id: "run-1",
      },
    });

    expect(startRun).toHaveBeenCalledTimes(1);
  });
});
