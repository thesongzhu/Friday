import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayBillingReconciliationJob,
  DEFAULT_RECONCILIATION_CONFIG,
} from "../../../../src/marketplace/billing/friday-billing-reconciliation-job.js";
import type { FridayBillingReconciliationDeps } from "../../../../src/marketplace/billing/friday-billing-reconciliation-job.js";
import type {
  FridayBillingEvent,
  FridayPurchase,
  FridayRefund,
  FridayPayoutBatch,
  FridayPayoutEntry,
  FridaySubscription,
  FridayMoneyAmount,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";
import { fridayMoney } from "../../../../src/marketplace/model/friday-marketplace.types.js";

// ─── Helpers ───

let idCounter = 0;

function usd(cents: number): FridayMoneyAmount {
  return fridayMoney(cents, "USD");
}

function createMockDeps(
  overrides: Partial<FridayBillingReconciliationDeps> = {},
): FridayBillingReconciliationDeps {
  return {
    generateId: () => `rec-${++idCounter}`,
    now: () => "2026-01-15T12:00:00.000Z",
    getUnprocessedBillingEvents: vi.fn().mockResolvedValue([]),
    markBillingEventProcessed: vi.fn().mockResolvedValue(undefined),
    getPurchaseByExternalPaymentId: vi.fn().mockResolvedValue(null),
    getPurchase: vi.fn().mockResolvedValue(null),
    savePurchase: vi.fn().mockResolvedValue(undefined),
    getStalePendingPurchases: vi.fn().mockResolvedValue([]),
    getRefundByExternalRefundId: vi.fn().mockResolvedValue(null),
    getRefund: vi.fn().mockResolvedValue(null),
    saveRefund: vi.fn().mockResolvedValue(undefined),
    getCompletedRefundsForPurchase: vi.fn().mockResolvedValue([]),
    getListing: vi.fn().mockResolvedValue(null),
    getListingVersion: vi.fn().mockResolvedValue(null),
    getPendingPayoutBatches: vi.fn().mockResolvedValue([]),
    getPayoutEntriesForBatch: vi.fn().mockResolvedValue([]),
    savePayoutBatch: vi.fn().mockResolvedValue(undefined),
    savePayoutEntries: vi.fn().mockResolvedValue(undefined),
    getExpiredSubscriptions: vi.fn().mockResolvedValue([]),
    saveSubscription: vi.fn().mockResolvedValue(undefined),
    config: {
      ...DEFAULT_RECONCILIATION_CONFIG,
      intervalMs: 100,
      jitterMs: 0,
    },
    ...overrides,
  };
}

function makePendingPurchase(id: string, externalPaymentId: string): FridayPurchase {
  return {
    id,
    buyerTenantId: "tenant-1",
    buyerPrincipalId: "user-1",
    listingId: "listing-1",
    listingVersionId: "version-1",
    pricingPlanId: "plan-1",
    status: "pending",
    amount: usd(5000),
    externalPaymentId,
    idempotencyKey: null,
    completedAt: null,
    createdAt: "2026-01-15T11:00:00.000Z",
    updatedAt: "2026-01-15T11:00:00.000Z",
  };
}

function makePaymentSucceededEvent(externalId: string): FridayBillingEvent {
  return {
    id: "evt-1",
    eventType: "payment.succeeded",
    source: "webhook",
    referenceType: "purchase",
    referenceId: null,
    payload: { id: externalId },
    processed: false,
    createdAt: "2026-01-15T11:30:00.000Z",
  };
}

function makePaymentFailedEvent(externalId: string): FridayBillingEvent {
  return {
    id: "evt-2",
    eventType: "payment.failed",
    source: "webhook",
    referenceType: "purchase",
    referenceId: null,
    payload: { id: externalId },
    processed: false,
    createdAt: "2026-01-15T11:30:00.000Z",
  };
}

// ─── Tests ───

describe("FridayBillingReconciliationJob", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe("runOnce — empty state", () => {
    it("returns zero counters when nothing to process", async () => {
      const deps = createMockDeps();
      const job = createFridayBillingReconciliationJob(deps);

      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(0);
      expect(result.purchasesCompleted).toBe(0);
      expect(result.purchasesFailed).toBe(0);
      expect(result.refundsCompleted).toBe(0);
      expect(result.payoutBatchesCompleted).toBe(0);
      expect(result.stalePurchasesFlagged).toBe(0);
      expect(result.subscriptionsExpired).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("runOnce — payment.succeeded events", () => {
    it("completes a pending purchase on payment.succeeded", async () => {
      const purchase = makePendingPurchase("pur-1", "pi_ext_1");
      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([
          makePaymentSucceededEvent("pi_ext_1"),
        ]),
        getPurchaseByExternalPaymentId: vi.fn().mockResolvedValue(purchase),
        getListing: vi.fn().mockResolvedValue({
          id: "listing-1",
          currentVersionId: "version-1",
          status: "published",
        }),
        getListingVersion: vi.fn().mockResolvedValue({
          id: "version-1",
          listingId: "listing-1",
          status: "approved",
        }),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.purchasesCompleted).toBe(1);
      expect(deps.savePurchase).toHaveBeenCalled();
      expect(deps.markBillingEventProcessed).toHaveBeenCalledWith("evt-1");
    });

    it("skips already-completed purchases", async () => {
      const purchase = makePendingPurchase("pur-1", "pi_ext_1");
      const completed = { ...purchase, status: "completed" as const };
      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([
          makePaymentSucceededEvent("pi_ext_1"),
        ]),
        getPurchaseByExternalPaymentId: vi.fn().mockResolvedValue(completed),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.purchasesCompleted).toBe(0);
      expect(deps.savePurchase).not.toHaveBeenCalled();
    });
  });

  describe("runOnce — payment.failed events", () => {
    it("fails a pending purchase on payment.failed", async () => {
      const purchase = makePendingPurchase("pur-2", "pi_fail_1");
      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([
          makePaymentFailedEvent("pi_fail_1"),
        ]),
        getPurchaseByExternalPaymentId: vi.fn().mockResolvedValue(purchase),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.purchasesFailed).toBe(1);
      expect(deps.savePurchase).toHaveBeenCalled();
      const saved = (deps.savePurchase as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.status).toBe("failed");
    });
  });

  describe("runOnce — refund.completed events", () => {
    it("completes a pending refund on refund.completed", async () => {
      const refund: FridayRefund = {
        id: "ref-1",
        purchaseId: "pur-3",
        amount: usd(2000),
        reason: "Customer request",
        status: "pending",
        externalRefundId: "re_ext_1",
        initiatedBy: "admin",
        createdAt: "2026-01-15T11:00:00.000Z",
        completedAt: null,
      };
      const purchase: FridayPurchase = {
        id: "pur-3",
        buyerTenantId: "tenant-1",
        buyerPrincipalId: "user-1",
        listingId: "listing-1",
        listingVersionId: "version-1",
        pricingPlanId: "plan-1",
        status: "completed",
        amount: usd(5000),
        externalPaymentId: "pi_ext_3",
        idempotencyKey: null,
        completedAt: "2026-01-15T11:20:00.000Z",
        createdAt: "2026-01-15T11:00:00.000Z",
        updatedAt: "2026-01-15T11:20:00.000Z",
      };

      const event: FridayBillingEvent = {
        id: "evt-3",
        eventType: "refund.completed",
        source: "webhook",
        referenceType: "refund",
        referenceId: null,
        payload: { id: "re_ext_1" },
        processed: false,
        createdAt: "2026-01-15T11:30:00.000Z",
      };

      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([event]),
        getRefundByExternalRefundId: vi.fn().mockResolvedValue(refund),
        getPurchase: vi.fn().mockResolvedValue(purchase),
        getCompletedRefundsForPurchase: vi.fn().mockResolvedValue([]),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.refundsCompleted).toBe(1);
      expect(deps.saveRefund).toHaveBeenCalled();
      expect(deps.savePurchase).toHaveBeenCalled();
    });
  });

  describe("runOnce — payout events", () => {
    it("completes payout batch on payout.completed", async () => {
      const batch: FridayPayoutBatch = {
        id: "batch-1",
        publisherId: "pub-1",
        status: "processing",
        totalAmount: usd(10000),
        entryCount: 2,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-01-15T00:00:00.000Z",
        externalPayoutId: "po_ext_1",
        initiatedAt: "2026-01-15T10:00:00.000Z",
        completedAt: null,
        failedReason: null,
      };
      const entries: FridayPayoutEntry[] = [
        {
          id: "entry-1",
          publisherId: "pub-1",
          purchaseId: "pur-a",
          listingId: "listing-1",
          grossAmount: usd(6000),
          platformFee: usd(600),
          netAmount: usd(5400),
          taxWithholding: usd(0),
          payoutBatchId: "batch-1",
          status: "processing",
          createdAt: "2026-01-14T12:00:00.000Z",
          updatedAt: "2026-01-15T10:00:00.000Z",
        },
        {
          id: "entry-2",
          publisherId: "pub-1",
          purchaseId: "pur-b",
          listingId: "listing-2",
          grossAmount: usd(5100),
          platformFee: usd(510),
          netAmount: usd(4600),
          taxWithholding: usd(0),
          payoutBatchId: "batch-1",
          status: "processing",
          createdAt: "2026-01-14T13:00:00.000Z",
          updatedAt: "2026-01-15T10:00:00.000Z",
        },
      ];

      const event: FridayBillingEvent = {
        id: "evt-4",
        eventType: "payout.completed",
        source: "webhook",
        referenceType: "payout",
        referenceId: null,
        payload: { id: "po_ext_1" },
        processed: false,
        createdAt: "2026-01-15T11:30:00.000Z",
      };

      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([event]),
        getPendingPayoutBatches: vi.fn().mockResolvedValue([batch]),
        getPayoutEntriesForBatch: vi.fn().mockResolvedValue(entries),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.payoutBatchesCompleted).toBe(1);
      expect(deps.savePayoutBatch).toHaveBeenCalled();
      expect(deps.savePayoutEntries).toHaveBeenCalled();
    });

    it("fails payout batch on payout.failed", async () => {
      const batch: FridayPayoutBatch = {
        id: "batch-2",
        publisherId: "pub-1",
        status: "processing",
        totalAmount: usd(8000),
        entryCount: 1,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2026-01-15T00:00:00.000Z",
        externalPayoutId: "po_ext_fail",
        initiatedAt: "2026-01-15T10:00:00.000Z",
        completedAt: null,
        failedReason: null,
      };
      const entries: FridayPayoutEntry[] = [
        {
          id: "entry-3",
          publisherId: "pub-1",
          purchaseId: "pur-c",
          listingId: "listing-1",
          grossAmount: usd(8900),
          platformFee: usd(890),
          netAmount: usd(8000),
          taxWithholding: usd(0),
          payoutBatchId: "batch-2",
          status: "processing",
          createdAt: "2026-01-14T12:00:00.000Z",
          updatedAt: "2026-01-15T10:00:00.000Z",
        },
      ];

      const event: FridayBillingEvent = {
        id: "evt-5",
        eventType: "payout.failed",
        source: "webhook",
        referenceType: "payout",
        referenceId: null,
        payload: { id: "po_ext_fail", failure_message: "Insufficient funds" },
        processed: false,
        createdAt: "2026-01-15T11:30:00.000Z",
      };

      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue([event]),
        getPendingPayoutBatches: vi.fn().mockResolvedValue([batch]),
        getPayoutEntriesForBatch: vi.fn().mockResolvedValue(entries),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.eventsProcessed).toBe(1);
      expect(result.payoutBatchesFailed).toBe(1);
      expect(deps.savePayoutBatch).toHaveBeenCalled();
      const savedBatch = (deps.savePayoutBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedBatch.status).toBe("failed");
    });
  });

  describe("runOnce — stale purchase detection", () => {
    it("flags stale pending purchases", async () => {
      const stalePurchase = makePendingPurchase("pur-stale", "pi_stale_1");
      const deps = createMockDeps({
        getStalePendingPurchases: vi.fn().mockResolvedValue([stalePurchase]),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.stalePurchasesFlagged).toBe(1);
      expect(deps.savePurchase).toHaveBeenCalled();
      const saved = (deps.savePurchase as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.status).toBe("failed");
    });
  });

  describe("runOnce — subscription expiration", () => {
    it("expires overdue subscriptions", async () => {
      const subscription: FridaySubscription = {
        id: "sub-1",
        purchaseId: "pur-sub",
        buyerTenantId: "tenant-1",
        buyerPrincipalId: "user-1",
        listingId: "listing-1",
        pricingPlanId: "plan-1",
        status: "active",
        currentPeriodStart: "2026-01-01T00:00:00.000Z",
        currentPeriodEnd: "2026-01-14T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        externalSubscriptionId: "sub_ext_1",
        trialEndsAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const deps = createMockDeps({
        getExpiredSubscriptions: vi.fn().mockResolvedValue([subscription]),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.subscriptionsExpired).toBe(1);
      expect(deps.saveSubscription).toHaveBeenCalled();
      const saved = (deps.saveSubscription as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.status).toBe("expired");
    });

    it("skips subscriptions already cancelled", async () => {
      const subscription: FridaySubscription = {
        id: "sub-2",
        purchaseId: "pur-sub2",
        buyerTenantId: "tenant-1",
        buyerPrincipalId: "user-1",
        listingId: "listing-1",
        pricingPlanId: "plan-1",
        status: "cancelled",
        currentPeriodStart: "2026-01-01T00:00:00.000Z",
        currentPeriodEnd: "2026-01-14T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        cancelledAt: "2026-01-10T00:00:00.000Z",
        externalSubscriptionId: "sub_ext_2",
        trialEndsAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
      };
      const deps = createMockDeps({
        getExpiredSubscriptions: vi.fn().mockResolvedValue([subscription]),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      expect(result.subscriptionsExpired).toBe(0);
      expect(deps.saveSubscription).not.toHaveBeenCalled();
    });
  });

  describe("runOnce — error handling", () => {
    it("records errors but continues processing remaining events", async () => {
      const events: FridayBillingEvent[] = [
        makePaymentSucceededEvent("pi_good"),
        makePaymentSucceededEvent("pi_bad"),
      ];
      let callCount = 0;
      const deps = createMockDeps({
        getUnprocessedBillingEvents: vi.fn().mockResolvedValue(events),
        getPurchaseByExternalPaymentId: vi.fn().mockImplementation(async (extId: string) => {
          if (extId === "pi_bad") throw new Error("Database down");
          return makePendingPurchase("pur-good", "pi_good");
        }),
        getListing: vi.fn().mockResolvedValue({
          id: "listing-1",
          currentVersionId: "version-1",
          status: "published",
        }),
        getListingVersion: vi.fn().mockResolvedValue({
          id: "version-1",
          listingId: "listing-1",
          status: "approved",
        }),
        markBillingEventProcessed: vi.fn().mockImplementation(async () => {
          callCount++;
        }),
      });

      const job = createFridayBillingReconciliationJob(deps);
      const result = await job.runOnce();

      // First event processed, second errored
      expect(result.eventsProcessed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Database down");
    });
  });

  describe("start / stop lifecycle", () => {
    it("isRunning returns false before start", () => {
      const deps = createMockDeps();
      const job = createFridayBillingReconciliationJob(deps);

      expect(job.isRunning()).toBe(false);
    });

    it("isRunning returns true after start", () => {
      const deps = createMockDeps();
      const job = createFridayBillingReconciliationJob(deps);

      job.start();
      expect(job.isRunning()).toBe(true);
      job.stop();
    });

    it("isRunning returns false after stop", () => {
      const deps = createMockDeps();
      const job = createFridayBillingReconciliationJob(deps);

      job.start();
      job.stop();
      expect(job.isRunning()).toBe(false);
    });

    it("start is idempotent", () => {
      const deps = createMockDeps();
      const job = createFridayBillingReconciliationJob(deps);

      job.start();
      job.start(); // should not throw
      expect(job.isRunning()).toBe(true);
      job.stop();
    });
  });

  describe("default config", () => {
    it("has reasonable defaults", () => {
      expect(DEFAULT_RECONCILIATION_CONFIG.intervalMs).toBe(5 * 60 * 1000);
      expect(DEFAULT_RECONCILIATION_CONFIG.maxEventsPerCycle).toBe(100);
      expect(DEFAULT_RECONCILIATION_CONFIG.stalePurchaseThresholdMs).toBe(30 * 60 * 1000);
    });
  });
});
