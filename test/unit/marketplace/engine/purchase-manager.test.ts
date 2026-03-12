import { describe, it, expect } from "vitest";
import {
  initiateCheckout,
  completePurchase,
  failPurchase,
  initiateRefund,
  completeRefund,
  failRefund,
  PURCHASE_ERROR_CODES,
} from "../../../../src/marketplace/engine/purchase-manager.js";
import type { MarketplaceAuditEvent } from "../../../../src/marketplace/engine/audit-events.js";
import type {
  FridayListing,
  FridayListingVersion,
  FridayPricingPlanRecord,
  FridayPurchase,
  FridayRefund,
} from "../../../../src/marketplace/model/friday-marketplace.types.js";
import { fridayMoney, fridayMoneyCents } from "../../../../src/marketplace/model/friday-marketplace.types.js";

// ─── Test Helpers ───

let idCounter = 0;

function resetCounter(): void {
  idCounter = 0;
}

function buildDeps(overrides?: {
  now?: () => string;
  emitAuditEvent?: (event: MarketplaceAuditEvent) => void;
}) {
  return {
    generateId: () => `id-${++idCounter}`,
    now: overrides?.now ?? (() => "2026-02-24T12:00:00.000Z"),
    emitAuditEvent: overrides?.emitAuditEvent,
    defaultActor: "system",
  };
}

function publishedListing(overrides?: Partial<FridayListing>): FridayListing {
  return {
    id: "listing-1",
    publisherId: "pub-1",
    slug: "test-listing",
    status: "published",
    currentVersionId: "ver-1",
    pendingVersionId: null,
    tenantId: null,
    tags: [],
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function version(overrides?: Partial<FridayListingVersion>): FridayListingVersion {
  return {
    id: "ver-1",
    listingId: "listing-1",
    versionNumber: 1,
    status: "approved",
    title: "Test",
    description: "Test listing",
    longDescription: null,
    screenshotUrls: [],
    packageName: "@friday/test-pkg",
    packageVersion: "1.0.0",
    assetType: "agent",
    pricingPlan: { type: "free" },
    releaseNotes: null,
    createdAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function freePlanRecord(overrides?: Partial<FridayPricingPlanRecord>): FridayPricingPlanRecord {
  return {
    id: "plan-1",
    listingId: "listing-1",
    plan: { type: "free" },
    isActive: true,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function paidPlanRecord(overrides?: Partial<FridayPricingPlanRecord>): FridayPricingPlanRecord {
  return {
    id: "plan-2",
    listingId: "listing-1",
    plan: { type: "one_time", price: fridayMoney(2999, "USD") },
    isActive: true,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function subscriptionPlanRecord(): FridayPricingPlanRecord {
  return {
    id: "plan-3",
    listingId: "listing-1",
    plan: {
      type: "subscription",
      intervalMonths: 1,
      price: fridayMoney(999, "USD"),
      trialDays: 14,
    },
    isActive: true,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
  };
}

function pendingPurchase(overrides?: Partial<FridayPurchase>): FridayPurchase {
  return {
    id: "purchase-1",
    buyerTenantId: "tenant-buyer",
    buyerPrincipalId: "buyer-1",
    listingId: "listing-1",
    listingVersionId: "ver-1",
    pricingPlanId: "plan-2",
    status: "pending",
    amount: fridayMoney(2999, "USD"),
    externalPaymentId: null,
    idempotencyKey: null,
    completedAt: null,
    createdAt: "2026-02-24T10:30:00.000Z",
    updatedAt: "2026-02-24T10:30:00.000Z",
    ...overrides,
  };
}

function completedPurchase(amount: number = 2999, overrides?: Partial<FridayPurchase>): FridayPurchase {
  return {
    id: "purchase-1",
    buyerTenantId: "tenant-buyer",
    buyerPrincipalId: "buyer-1",
    listingId: "listing-1",
    listingVersionId: "ver-1",
    pricingPlanId: "plan-2",
    status: "completed",
    amount: fridayMoney(amount, "USD"),
    externalPaymentId: "ext-pay-1",
    idempotencyKey: null,
    completedAt: "2026-02-24T11:00:00.000Z",
    createdAt: "2026-02-24T10:30:00.000Z",
    updatedAt: "2026-02-24T11:00:00.000Z",
    ...overrides,
  };
}

function pendingRefund(overrides?: Partial<FridayRefund>): FridayRefund {
  return {
    id: "refund-1",
    purchaseId: "purchase-1",
    amount: fridayMoney(1000, "USD"),
    reason: "Test",
    status: "pending",
    externalRefundId: null,
    initiatedBy: "admin-1",
    createdAt: "2026-02-24T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("initiateCheckout", () => {
  it("creates a completed purchase + entitlement for free plan", () => {
    resetCounter();
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: freePlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchase.status).toBe("completed");
    expect(fridayMoneyCents(result.value.purchase.amount)).toBe(0);
    expect(result.value.entitlement).toBeDefined();
    expect(result.value.entitlement!.status).toBe("active");
    expect(result.value.entitlement!.sourceType).toBe("purchase");
  });

  it("creates a pending purchase for paid plan", () => {
    resetCounter();
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: paidPlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchase.status).toBe("pending");
    expect(fridayMoneyCents(result.value.purchase.amount)).toBe(2999);
    expect(result.value.entitlement).toBeUndefined();
  });

  it("rejects subscription pricing plan in MVP profile", () => {
    resetCounter();
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: subscriptionPlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.PRICING_TYPE_NOT_ALLOWED_IN_MVP);
  });

  it("rejects checkout for non-published listing", () => {
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing({ status: "draft" }),
        version: version(),
        pricingPlanRecord: freePlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LISTING_NOT_PUBLISHED);
  });

  it("rejects inactive pricing plan", () => {
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: paidPlanRecord({ isActive: false }),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.INACTIVE_PRICING_PLAN);
  });

  it("rejects pricing plan not owned by listing", () => {
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: paidPlanRecord({ listingId: "listing-2" }),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LINKAGE_MISMATCH);
  });

  it("rejects version not owned by listing", () => {
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version({ listingId: "listing-2" }),
        pricingPlanRecord: freePlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LINKAGE_MISMATCH);
  });

  it("rejects non-current listing version", () => {
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing({ currentVersionId: "ver-current" }),
        version: version({ id: "ver-older" }),
        pricingPlanRecord: freePlanRecord(),
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.INELIGIBLE_VERSION);
  });
});

describe("completePurchase", () => {
  it("completes a pending purchase and creates entitlement", () => {
    resetCounter();
    const purchase = pendingPurchase();
    const result = completePurchase(
      purchase,
      publishedListing(),
      version(),
      { externalPaymentId: "ext-pay-123" },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchase.status).toBe("completed");
    expect(result.value.purchase.externalPaymentId).toBe("ext-pay-123");
    expect(result.value.entitlement.status).toBe("active");
  });

  it("rejects completing a non-pending purchase", () => {
    const result = completePurchase(
      completedPurchase(),
      publishedListing(),
      version(),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.ALREADY_COMPLETED);
  });

  it("rejects mismatched listing ID", () => {
    const result = completePurchase(
      pendingPurchase({ listingId: "listing-1" }),
      publishedListing({ id: "listing-2" }),
      version({ id: "ver-1", listingId: "listing-2" }),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LINKAGE_MISMATCH);
  });

  it("rejects mismatched version ID", () => {
    const result = completePurchase(
      pendingPurchase({ listingVersionId: "ver-1" }),
      publishedListing(),
      version({ id: "ver-2" }),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LINKAGE_MISMATCH);
  });
});

describe("failPurchase", () => {
  it("fails a pending purchase", () => {
    const result = failPurchase(pendingPurchase(), buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("failed");
  });
});

describe("initiateRefund", () => {
  it("creates a full refund but keeps purchase completed until completion", () => {
    resetCounter();
    const result = initiateRefund(
      completedPurchase(),
      [],
      { reason: "Not satisfied", initiatedBy: "admin-1" },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.refund.amount)).toBe(2999);
    expect(result.value.refund.status).toBe("pending");
    expect(result.value.purchase.status).toBe("completed");
  });

  it("creates a partial refund", () => {
    resetCounter();
    const result = initiateRefund(
      completedPurchase(),
      [],
      {
        amount: fridayMoney(1000, "USD"),
        reason: "Partial refund",
        initiatedBy: "admin-1",
      },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.refund.amount)).toBe(1000);
    expect(result.value.purchase.status).toBe("completed");
  });

  it("rejects refund exceeding purchase amount", () => {
    const result = initiateRefund(
      completedPurchase(1000),
      [],
      {
        amount: fridayMoney(2000, "USD"),
        reason: "Over-refund",
        initiatedBy: "admin-1",
      },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.REFUND_EXCEEDS_AMOUNT);
  });

  it("accounts for existing refunds", () => {
    const existingRefunds: FridayRefund[] = [
      {
        id: "refund-1",
        purchaseId: "purchase-1",
        amount: fridayMoney(2000, "USD"),
        reason: "First refund",
        status: "completed",
        externalRefundId: null,
        initiatedBy: "admin-1",
        createdAt: "2026-02-24T11:00:00.000Z",
        completedAt: "2026-02-24T11:01:00.000Z",
      },
    ];

    resetCounter();
    const result = initiateRefund(
      completedPurchase(),
      existingRefunds,
      { reason: "Remaining refund", initiatedBy: "admin-1" },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.refund.amount)).toBe(999);
  });

  it("rejects refund on non-completed purchase", () => {
    const result = initiateRefund(
      pendingPurchase(),
      [],
      { reason: "Test", initiatedBy: "admin-1" },
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.NOT_REFUNDABLE);
  });
});

describe("completeRefund / failRefund", () => {
  it("completes a pending refund and transitions purchase to refunded for full refund", () => {
    const deps = buildDeps({ now: () => "2026-02-24T13:00:00.000Z" });
    const result = completeRefund(
      pendingRefund({ amount: fridayMoney(2999, "USD") }),
      completedPurchase(),
      { externalRefundId: "ext-refund-1" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refund.status).toBe("completed");
    expect(result.value.refund.externalRefundId).toBe("ext-refund-1");
    expect(result.value.refund.completedAt).toBe("2026-02-24T13:00:00.000Z");
    expect(result.value.purchase.status).toBe("refunded");
    expect(result.value.purchase.updatedAt).toBe("2026-02-24T13:00:00.000Z");
  });

  it("completes partial refund and keeps purchase completed", () => {
    const result = completeRefund(
      pendingRefund({ amount: fridayMoney(1000, "USD") }),
      completedPurchase(),
      { existingCompletedRefunds: [] },
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchase.status).toBe("completed");
  });

  it("fails a pending refund and keeps completed purchase status", () => {
    const deps = buildDeps({ now: () => "2026-02-24T13:00:00.000Z" });
    const result = failRefund(
      pendingRefund(),
      completedPurchase(),
      {},
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refund.status).toBe("failed");
    expect(result.value.refund.completedAt).toBe("2026-02-24T13:00:00.000Z");
    expect(result.value.purchase.status).toBe("completed");
  });

  it("preserves purchase status when refund fails (no rollback)", () => {
    const result = failRefund(
      pendingRefund(),
      completedPurchase(undefined, { status: "refunded" }),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Failed refund must NOT change purchase status — it stays "refunded"
    expect(result.value.purchase.status).toBe("refunded");
  });

  it("preserves completed purchase status when refund fails", () => {
    const result = failRefund(
      pendingRefund(),
      completedPurchase(),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.purchase.status).toBe("completed");
  });

  it("rejects completing a non-pending refund", () => {
    const result = completeRefund(
      pendingRefund({ status: "completed" }),
      completedPurchase(),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects mismatched refund/purchase IDs", () => {
    const result = completeRefund(
      pendingRefund({ purchaseId: "purchase-2" }),
      completedPurchase(),
      {},
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PURCHASE_ERROR_CODES.LINKAGE_MISMATCH);
  });
});

describe("audit events", () => {
  it("emits transition audit events with timestamp and actor", () => {
    resetCounter();
    const events: MarketplaceAuditEvent[] = [];
    const result = initiateCheckout(
      {
        buyerTenantId: "tenant-buyer",
        buyerPrincipalId: "buyer-1",
        listing: publishedListing(),
        version: version(),
        pricingPlanRecord: freePlanRecord(),
      },
      buildDeps({ emitAuditEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.timestamp).toBe("2026-02-24T12:00:00.000Z");
      expect(event.actor).toBeTruthy();
      expect(event.fromState).not.toBeUndefined();
      expect(event.toState).toBeTruthy();
    }
  });
});

describe("CSV KPI assertions", () => {
  it("keeps entitlement linkage accuracy at 100%", () => {
    const total = 200;
    let accurate = 0;

    for (let i = 0; i < total; i += 1) {
      const purchase = pendingPurchase({
        id: `purchase-${i}`,
        listingId: "listing-1",
        listingVersionId: "ver-1",
      });

      const result = completePurchase(
        purchase,
        publishedListing(),
        version(),
        { externalPaymentId: `ext-${i}` },
        buildDeps(),
      );

      if (!result.ok) {
        continue;
      }

      const entitlement = result.value.entitlement;
      const linkedCorrectly =
        entitlement.listingId === purchase.listingId &&
        entitlement.packageName === version().packageName &&
        entitlement.sourceId === purchase.id;

      if (linkedCorrectly) {
        accurate += 1;
      }
    }

    expect(accurate / total).toBe(1);
  });
});
