import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";
import { createFridayMarketplaceCommercePersistence } from "../../../../src/marketplace/persistence/friday-marketplace-commerce-persistence.js";
import { fridayMoney } from "../../../../src/marketplace/model/friday-marketplace.types.js";

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (conn: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (conn: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

describe("FridayMarketplaceCommercePersistence", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips publisher records", async () => {
    const store = createFridayMarketplaceCommercePersistence({ db });
    await store.savePublisher({
      id: "pub-1",
      tenantId: "tenant-a",
      principalId: "user-a",
      displayName: "Publisher A",
      bio: null,
      avatarUrl: null,
      websiteUrl: null,
      contactEmail: "a@example.com",
      verificationStatus: "unverified",
      legalName: null,
      taxIdLast4: null,
      country: null,
      payoutMethod: null,
      platformFeeBps: 3000,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    const publisher = await store.getPublisher("pub-1");
    expect(publisher?.displayName).toBe("Publisher A");

    const byPrincipal = await store.getPublisherByPrincipal("tenant-a", "user-a");
    expect(byPrincipal?.id).toBe("pub-1");
  });

  it("round-trips listing/version/pricing/purchase/entitlement and builds search index", async () => {
    const store = createFridayMarketplaceCommercePersistence({ db });

    await store.savePublisher({
      id: "pub-1",
      tenantId: "tenant-a",
      principalId: "user-a",
      displayName: "Publisher A",
      bio: null,
      avatarUrl: null,
      websiteUrl: null,
      contactEmail: "a@example.com",
      verificationStatus: "verified",
      legalName: "Pub A LLC",
      taxIdLast4: "1234",
      country: "US",
      payoutMethod: "bank",
      platformFeeBps: 3000,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.saveListing({
      id: "listing-1",
      publisherId: "pub-1",
      slug: "agent-a",
      status: "published",
      currentVersionId: "ver-1",
      pendingVersionId: null,
      tenantId: "tenant-a",
      tags: ["ai", "agent"],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.saveListingVersion({
      id: "ver-1",
      listingId: "listing-1",
      versionNumber: 1,
      status: "approved",
      title: "Agent A",
      description: "Agent A desc",
      longDescription: null,
      screenshotUrls: [],
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      assetType: "agent",
      pricingPlan: {
        type: "one_time",
        price: fridayMoney(1999, "USD"),
      },
      releaseNotes: null,
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    await store.savePricingPlan({
      id: "plan-1",
      listingId: "listing-1",
      plan: {
        type: "one_time",
        price: fridayMoney(1999, "USD"),
      },
      isActive: true,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.savePurchase({
      id: "purchase-1",
      buyerTenantId: "tenant-b",
      buyerPrincipalId: "user-b",
      listingId: "listing-1",
      listingVersionId: "ver-1",
      pricingPlanId: "plan-1",
      status: "completed",
      amount: fridayMoney(1999, "USD"),
      externalPaymentId: "pay-1",
      idempotencyKey: "idem-1",
      completedAt: "2026-03-01T00:05:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:05:00.000Z",
    });

    await store.saveEntitlement({
      id: "ent-1",
      tenantId: "tenant-b",
      principalId: "user-b",
      listingId: "listing-1",
      packageName: "@friday/agent-a",
      sourceType: "purchase",
      sourceId: "purchase-1",
      status: "active",
      grantedAt: "2026-03-01T00:05:00.000Z",
      expiresAt: null,
      gracePeriodEndsAt: null,
      grandfathered: false,
      createdAt: "2026-03-01T00:05:00.000Z",
      updatedAt: "2026-03-01T00:05:00.000Z",
    });

    await store.saveInstallation({
      id: "inst-1",
      tenantId: "tenant-b",
      principalId: "user-b",
      listingId: "listing-1",
      assetType: "agent",
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      status: "installed",
      lastError: null,
      installedAt: "2026-03-01T00:06:00.000Z",
      createdAt: "2026-03-01T00:06:00.000Z",
      updatedAt: "2026-03-01T00:06:00.000Z",
    });

    const listing = await store.getListing("listing-1");
    expect(listing?.slug).toBe("agent-a");

    const version = await store.getListingVersion("ver-1");
    expect(version?.assetType).toBe("agent");

    const plan = await store.getPricingPlan("plan-1");
    expect(plan?.plan.type).toBe("one_time");

    const purchase = await store.getPurchase("purchase-1");
    expect(purchase?.status).toBe("completed");

    const entitlements = await store.listEntitlements({ tenantId: "tenant-b", listingId: "listing-1" });
    expect(entitlements).toHaveLength(1);

    const installations = await store.listInstallations({
      tenantId: "tenant-b",
      listingId: "listing-1",
    });
    expect(installations).toHaveLength(1);
    expect(installations[0].status).toBe("installed");

    await store.saveInstallation({
      id: "inst-2",
      tenantId: "tenant-b",
      principalId: "user-b",
      listingId: "listing-1",
      assetType: "agent",
      packageName: "@friday/agent-a-renamed",
      packageVersion: "1.0.0",
      status: "failed",
      lastError: "checksum mismatch",
      installedAt: null,
      createdAt: "2026-03-01T00:07:00.000Z",
      updatedAt: "2026-03-01T00:07:00.000Z",
    });
    const upsertedInstallations = await store.listInstallations({
      tenantId: "tenant-b",
      listingId: "listing-1",
      packageVersion: "1.0.0",
    });
    expect(upsertedInstallations).toHaveLength(1);
    expect(upsertedInstallations[0].packageName).toBe("@friday/agent-a-renamed");
    expect(upsertedInstallations[0].status).toBe("failed");

    const index = await store.getSearchIndex();
    expect(index).toHaveLength(1);
    expect(index[0].purchaseCount).toBe(1);
    expect(index[0].version.assetType).toBe("agent");
  });

  it("round-trips payout and billing records", async () => {
    const store = createFridayMarketplaceCommercePersistence({ db });

    await store.savePublisher({
      id: "pub-1",
      tenantId: "tenant-a",
      principalId: "user-a",
      displayName: "Publisher A",
      bio: null,
      avatarUrl: null,
      websiteUrl: null,
      contactEmail: "a@example.com",
      verificationStatus: "verified",
      legalName: "Pub A LLC",
      taxIdLast4: "1234",
      country: "US",
      payoutMethod: "bank",
      platformFeeBps: 3000,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.saveListing({
      id: "listing-1",
      publisherId: "pub-1",
      slug: "agent-a",
      status: "published",
      currentVersionId: "ver-1",
      pendingVersionId: null,
      tenantId: "tenant-a",
      tags: [],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.saveListingVersion({
      id: "ver-1",
      listingId: "listing-1",
      versionNumber: 1,
      status: "approved",
      title: "Agent A",
      description: "Agent A desc",
      longDescription: null,
      screenshotUrls: [],
      packageName: "@friday/agent-a",
      packageVersion: "1.0.0",
      assetType: "agent",
      pricingPlan: {
        type: "one_time",
        price: fridayMoney(10000, "USD"),
      },
      releaseNotes: null,
      createdAt: "2026-03-01T00:00:00.000Z",
    });

    await store.savePricingPlan({
      id: "plan-1",
      listingId: "listing-1",
      plan: {
        type: "one_time",
        price: fridayMoney(10000, "USD"),
      },
      isActive: true,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    await store.savePurchase({
      id: "purchase-1",
      buyerTenantId: "tenant-b",
      buyerPrincipalId: "user-b",
      listingId: "listing-1",
      listingVersionId: "ver-1",
      pricingPlanId: "plan-1",
      status: "completed",
      amount: fridayMoney(10000, "USD"),
      externalPaymentId: "pay-1",
      idempotencyKey: "idem-1",
      completedAt: "2026-03-01T00:10:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:10:00.000Z",
    });

    await store.saveRefund({
      id: "refund-1",
      purchaseId: "purchase-1",
      amount: fridayMoney(1000, "USD"),
      reason: "duplicate charge",
      status: "pending",
      externalRefundId: "re-1",
      initiatedBy: "admin-1",
      createdAt: "2026-03-01T00:12:00.000Z",
      completedAt: null,
    });

    await store.savePayoutEntry({
      id: "entry-1",
      publisherId: "pub-1",
      purchaseId: "purchase-1",
      listingId: "listing-1",
      grossAmount: fridayMoney(10000, "USD"),
      platformFee: fridayMoney(3000, "USD"),
      netAmount: fridayMoney(6000, "USD"),
      taxWithholding: fridayMoney(1000, "USD"),
      payoutBatchId: null,
      status: "pending",
      createdAt: "2026-03-01T00:11:00.000Z",
      updatedAt: "2026-03-01T00:11:00.000Z",
    });

    await store.savePayoutBatch({
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(6000, "USD"),
      entryCount: 1,
      periodStart: "2026-03-01T00:00:00.000Z",
      periodEnd: "2026-03-31T00:00:00.000Z",
      externalPayoutId: "po-1",
      initiatedAt: "2026-03-31T01:00:00.000Z",
      completedAt: null,
      failedReason: null,
    });

    await store.savePayoutEntries([
      {
        id: "entry-1",
        publisherId: "pub-1",
        purchaseId: "purchase-1",
        listingId: "listing-1",
        grossAmount: fridayMoney(10000, "USD"),
        platformFee: fridayMoney(3000, "USD"),
        netAmount: fridayMoney(6000, "USD"),
        taxWithholding: fridayMoney(1000, "USD"),
        payoutBatchId: "batch-1",
        status: "processing",
        createdAt: "2026-03-01T00:11:00.000Z",
        updatedAt: "2026-03-31T01:00:00.000Z",
      },
    ]);

    const purchase = await store.getPurchaseByExternalPaymentId("pay-1");
    expect(purchase?.id).toBe("purchase-1");

    const refund = await store.getRefundByExternalRefundId("re-1");
    expect(refund?.id).toBe("refund-1");

    const entries = await store.listPayoutEntries({ publisherId: "pub-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0].payoutBatchId).toBe("batch-1");

    const batch = await store.getPayoutBatch("batch-1");
    expect(batch?.externalPayoutId).toBe("po-1");

    const batchEntries = await store.listPayoutBatchEntries("batch-1");
    expect(batchEntries).toHaveLength(1);
    expect(batchEntries[0].id).toBe("entry-1");

    await store.saveBillingEvent({
      id: "be-1",
      eventType: "payment.succeeded",
      source: "webhook",
      referenceType: "purchase",
      referenceId: "purchase-1",
      payload: { providerEventId: "evt_1" },
      processed: false,
      createdAt: "2026-03-31T01:01:00.000Z",
    });

    const billingEvents = await store.listBillingEvents({ eventType: "payment.succeeded" });
    expect(billingEvents).toHaveLength(1);

    const unprocessedBefore = await store.getUnprocessedBillingEvents(10);
    expect(unprocessedBefore.map((item) => item.id)).toContain("be-1");

    await store.markBillingEventProcessed("be-1");

    const unprocessedAfter = await store.getUnprocessedBillingEvents(10);
    expect(unprocessedAfter.map((item) => item.id)).not.toContain("be-1");

    await store.saveBillingWebhook({
      id: "wh-1",
      provider: "stripe",
      externalId: "evt_1",
      eventType: "payment_intent.succeeded",
      payload: { id: "evt_1" },
      signature: "sig",
      status: "processed",
      attempts: 1,
      lastError: null,
      receivedAt: "2026-03-31T01:00:30.000Z",
      processedAt: "2026-03-31T01:00:31.000Z",
    });

    const webhook = await store.getBillingWebhookByExternalId("stripe", "evt_1");
    expect(webhook?.id).toBe("wh-1");
    expect(webhook?.status).toBe("processed");
  });

  it("filters quarantined marketplace request and support rows from ordinary reads", async () => {
    const store = createFridayMarketplaceCommercePersistence({ db });

    await store.saveSupportEvent({
      id: "support-live",
      creatorId: "publisher:pub-1",
      assetId: "listing:listing-1",
      assetType: "workflow",
      supporterTenantId: "tenant-live",
      supporterPrincipalId: "principal-live",
      amount: fridayMoney(500, "USD"),
      message: "live",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    await store.saveRequest({
      id: "request-live",
      assetKind: "workflow",
      requesterTenantId: "tenant-live",
      requesterPrincipalId: "principal-live",
      title: "Need workflow",
      goal: "Automate deploys",
      desiredOutcome: "Deploy workflow",
      constraints: [],
      budgetSupportIntent: null,
      privacy: "public",
      publishability: "allow_publication",
      riskNotes: null,
      status: "accepted",
      acceptedResponseId: "response-live",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      closedAt: null,
    });
    await store.saveRequestResponse({
      id: "response-live",
      requestId: "request-live",
      responderTenantId: "tenant-creator",
      responderPrincipalId: "principal-creator",
      responderCreatorId: "publisher:pub-1",
      message: "I can build it",
      proposal: null,
      deliverableAssetId: null,
      createdAt: "2026-03-01T00:01:00.000Z",
    });

    db.writer.prepare(
      `INSERT INTO marketplace_support_events (
         id, creator_id, asset_id, asset_type, supporter_tenant_id, supporter_principal_id,
         amount_cents, currency, message, created_at, actor_schema_version, actor_quarantined, actor_quarantine_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "support-legacy",
      "publisher:pub-1",
      "listing:listing-1",
      "workflow",
      "legacy-user",
      "legacy-user",
      750,
      "USD",
      "legacy",
      "2026-03-01T00:02:00.000Z",
      1,
      1,
      "legacy_actor_tenant_unverifiable",
    );
    db.writer.prepare(
      `INSERT INTO marketplace_requests (
         id, asset_kind, requester_tenant_id, requester_principal_id, title, goal, desired_outcome,
         constraints_json, budget_support_intent, privacy, publishability, risk_notes, status,
         accepted_response_id, created_at, updated_at, closed_at, actor_schema_version, actor_quarantined, actor_quarantine_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "request-legacy",
      "workflow",
      "legacy-user",
      "legacy-user",
      "Legacy request",
      "Legacy goal",
      "Legacy outcome",
      "[]",
      null,
      "public",
      "allow_publication",
      null,
      "accepted",
      "response-legacy",
      "2026-03-01T00:03:00.000Z",
      "2026-03-01T00:03:00.000Z",
      null,
      1,
      1,
      "legacy_actor_tenant_unverifiable",
    );
    db.writer.prepare(
      `INSERT INTO marketplace_request_responses (
         id, request_id, responder_tenant_id, responder_principal_id, responder_creator_id, message,
         proposal, deliverable_asset_id, created_at, actor_schema_version, actor_quarantined, actor_quarantine_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "response-legacy",
      "request-legacy",
      "legacy-user",
      "legacy-user",
      "publisher:pub-1",
      "legacy response",
      null,
      null,
      "2026-03-01T00:04:00.000Z",
      1,
      1,
      "legacy_actor_tenant_unverifiable",
    );

    await expect(store.listSupportEvents()).resolves.toHaveLength(1);
    await expect(store.listRequests()).resolves.toHaveLength(1);
    await expect(store.getRequest("request-legacy")).resolves.toBeNull();
    await expect(store.listRequestResponses("request-legacy")).resolves.toEqual([]);
    await expect(store.listAcceptedRequestCountsByCreator()).resolves.toEqual([
      { creatorId: "publisher:pub-1", count: 1 },
    ]);
  });
});
