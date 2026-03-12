import { describe, it, expect } from "vitest";
import {
  createPayoutEntry,
  createClawbackEntry,
  createPayoutBatch,
  completePayoutBatch,
  failPayoutBatch,
  computeEarningsSummary,
  reconcileBatch,
  DEFAULT_MIN_PAYOUT_THRESHOLD_CENTS,
  PAYOUT_ERROR_CODES,
} from "../../../../src/marketplace/engine/payout-engine.js";
import type { MarketplaceAuditEvent } from "../../../../src/marketplace/engine/audit-events.js";
import type {
  FridayPurchase,
  FridayPublisher,
  FridayPayoutEntry,
  FridayPayoutBatch,
  FridayCurrencyCode,
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
    generateId: () => `payout-${++idCounter}`,
    now: overrides?.now ?? (() => "2026-02-24T12:00:00.000Z"),
    emitAuditEvent: overrides?.emitAuditEvent,
    defaultActor: "system",
  };
}

function verifiedPublisher(overrides?: Partial<FridayPublisher>): FridayPublisher {
  return {
    id: "pub-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    displayName: "Publisher",
    bio: null,
    avatarUrl: null,
    websiteUrl: null,
    contactEmail: "pub@example.com",
    verificationStatus: "verified",
    legalName: "Publisher LLC",
    taxIdLast4: "1234",
    country: "US",
    payoutMethod: "bank_transfer",
    platformFeeBps: 3000,
    createdAt: "2026-02-24T10:00:00.000Z",
    updatedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

function purchase(status: FridayPurchase["status"], amount: number = 10000): FridayPurchase {
  return {
    id: "purchase-1",
    buyerTenantId: "tenant-buyer",
    buyerPrincipalId: "buyer-1",
    listingId: "listing-1",
    listingVersionId: "ver-1",
    pricingPlanId: "plan-1",
    status,
    amount: fridayMoney(amount, "USD"),
    externalPaymentId: "ext-pay-1",
    idempotencyKey: null,
    completedAt: status === "completed" || status === "refunded"
      ? "2026-02-24T11:00:00.000Z"
      : null,
    createdAt: "2026-02-24T10:30:00.000Z",
    updatedAt: "2026-02-24T11:00:00.000Z",
  };
}

function pendingEntry(
  netCents: number = 7000,
  id: string = "entry-1",
  currency: FridayCurrencyCode = "USD" as FridayCurrencyCode,
): FridayPayoutEntry {
  return {
    id,
    publisherId: "pub-1",
    purchaseId: "purchase-1",
    listingId: "listing-1",
    grossAmount: fridayMoney(10000, currency),
    platformFee: fridayMoney(3000, currency),
    netAmount: fridayMoney(netCents, currency),
    taxWithholding: fridayMoney(0, currency),
    payoutBatchId: null,
    status: "pending",
    createdAt: "2026-02-24T11:00:00.000Z",
    updatedAt: "2026-02-24T11:00:00.000Z",
  };
}

// ─── Tests ───

describe("createPayoutEntry", () => {
  it("creates entry with correct fee split for verified publisher", () => {
    resetCounter();
    const result = createPayoutEntry(
      purchase("completed", 10000),
      verifiedPublisher(),
      "listing-1",
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fridayMoneyCents(result.value.grossAmount)).toBe(10000);
    expect(fridayMoneyCents(result.value.platformFee)).toBe(3000);
    expect(fridayMoneyCents(result.value.netAmount)).toBe(7000);
    expect(fridayMoneyCents(result.value.taxWithholding)).toBe(0);
    expect(result.value.status).toBe("pending");
  });

  it("applies backup withholding for unverified publisher", () => {
    resetCounter();
    const unverified = verifiedPublisher({ verificationStatus: "unverified" });
    const result = createPayoutEntry(
      purchase("completed", 10000),
      unverified,
      "listing-1",
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fridayMoneyCents(result.value.platformFee)).toBe(3000);
    expect(fridayMoneyCents(result.value.taxWithholding)).toBe(1680);
    expect(fridayMoneyCents(result.value.netAmount)).toBe(5320);
  });

  it("maintains gross = fee + tax + net invariant", () => {
    resetCounter();
    const amounts = [999, 1234, 5000, 10000, 50000, 99999];
    for (const amount of amounts) {
      const result = createPayoutEntry(
        purchase("completed", amount),
        verifiedPublisher(),
        "listing-1",
        buildDeps(),
      );
      if (!result.ok) continue;
      const entry = result.value;
      const fee = fridayMoneyCents(entry.platformFee);
      const tax = fridayMoneyCents(entry.taxWithholding);
      const net = fridayMoneyCents(entry.netAmount);
      expect(fee + tax + net).toBe(amount);
    }
  });

  it("rejects payout entry for pending purchase", () => {
    const result = createPayoutEntry(
      purchase("pending"),
      verifiedPublisher(),
      "listing-1",
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects payout entry for failed purchase", () => {
    const result = createPayoutEntry(
      purchase("failed"),
      verifiedPublisher(),
      "listing-1",
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.INVALID_TRANSITION);
  });

  it("rejects payout entry for refunded purchase", () => {
    const result = createPayoutEntry(
      purchase("refunded"),
      verifiedPublisher(),
      "listing-1",
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.INVALID_TRANSITION);
  });
});

describe("createClawbackEntry", () => {
  it("creates a negative entry for full clawback", () => {
    resetCounter();
    const original = pendingEntry(7000);
    const result = createClawbackEntry(original, 10000, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.grossAmount)).toBe(-10000);
    expect(fridayMoneyCents(result.value.platformFee)).toBe(-3000);
    expect(fridayMoneyCents(result.value.netAmount)).toBe(-7000);
    expect(result.value.status).toBe("clawed_back");
  });

  it("creates proportional clawback for partial refund", () => {
    resetCounter();
    const original = pendingEntry(7000);
    const result = createClawbackEntry(original, 5000, buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.grossAmount)).toBe(-5000);
    expect(fridayMoneyCents(result.value.platformFee)).toBe(-1500);
    expect(fridayMoneyCents(result.value.netAmount)).toBe(-3500);
  });
});

describe("createPayoutBatch", () => {
  it("creates a batch from pending entries", () => {
    resetCounter();
    const entries = [
      pendingEntry(7000, "entry-1"),
      pendingEntry(3000, "entry-2"),
    ];

    const result = createPayoutBatch(
      "pub-1",
      entries,
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.000Z",
      5000,
      buildDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.batch.totalAmount)).toBe(10000);
    expect(result.value.batch.entryCount).toBe(2);
    expect(result.value.batch.status).toBe("pending");
    expect(result.value.entries.every((e) => e.status === "processing")).toBe(true);
    expect(result.value.entries.every((e) => e.payoutBatchId === result.value.batch.id)).toBe(true);
  });

  it("rejects batch below minimum threshold", () => {
    const entries = [pendingEntry(100, "entry-1")];

    const result = createPayoutBatch(
      "pub-1",
      entries,
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.000Z",
      DEFAULT_MIN_PAYOUT_THRESHOLD_CENTS,
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.BELOW_THRESHOLD);
  });

  it("rejects batch with no pending entries", () => {
    const result = createPayoutBatch(
      "pub-1",
      [],
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.000Z",
      5000,
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.NO_PENDING_ENTRIES);
  });

  it("rejects mixed currency entries", () => {
    const result = createPayoutBatch(
      "pub-1",
      [
        pendingEntry(7000, "entry-1", "USD" as FridayCurrencyCode),
        pendingEntry(3000, "entry-2", "EUR" as FridayCurrencyCode),
      ],
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.000Z",
      5000,
      buildDeps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.CURRENCY_MISMATCH);
  });
});

describe("completePayoutBatch", () => {
  it("completes a batch and its entries", () => {
    resetCounter();
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(7000, "USD"),
      entryCount: 1,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: null,
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: null,
      failedReason: null,
    };

    const entries: FridayPayoutEntry[] = [{
      ...pendingEntry(7000),
      payoutBatchId: "batch-1",
      status: "processing",
    }];

    const result = completePayoutBatch(batch, entries, "ext-payout-1", buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.batch.status).toBe("completed");
    expect(result.value.batch.externalPayoutId).toBe("ext-payout-1");
    expect(result.value.entries.every((e) => e.status === "completed")).toBe(true);
  });

  it("rejects completing an already completed batch", () => {
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "completed",
      totalAmount: fridayMoney(7000, "USD"),
      entryCount: 1,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: "ext-1",
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: "2026-02-24T13:00:00.000Z",
      failedReason: null,
    };

    const result = completePayoutBatch(batch, [], null, buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.INVALID_TRANSITION);
  });
});

describe("failPayoutBatch", () => {
  it("fails a batch and resets entries to pending", () => {
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(7000, "USD"),
      entryCount: 1,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: null,
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: null,
      failedReason: null,
    };

    const entries: FridayPayoutEntry[] = [{
      ...pendingEntry(7000),
      payoutBatchId: "batch-1",
      status: "processing",
    }];

    const result = failPayoutBatch(batch, entries, "Payment provider error", buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.batch.status).toBe("failed");
    expect(result.value.batch.failedReason).toBe("Payment provider error");
    expect(result.value.entries.every((e) => e.status === "pending")).toBe(true);
    expect(result.value.entries.every((e) => e.payoutBatchId === null)).toBe(true);
  });
});

describe("computeEarningsSummary", () => {
  it("computes correct earnings summary", () => {
    const entries: FridayPayoutEntry[] = [
      pendingEntry(7000, "entry-1"),
      pendingEntry(3500, "entry-2"),
    ];

    const completedBatch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "completed",
      totalAmount: fridayMoney(7000, "USD"),
      entryCount: 1,
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-01-31T23:59:59.000Z",
      externalPayoutId: "ext-1",
      initiatedAt: "2026-02-01T00:00:00.000Z",
      completedAt: "2026-02-02T00:00:00.000Z",
      failedReason: null,
    };

    const result = computeEarningsSummary("pub-1", entries, [completedBatch], buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value;
    expect(summary.publisherId).toBe("pub-1");
    expect(fridayMoneyCents(summary.totalGross)).toBe(20000);
    expect(fridayMoneyCents(summary.totalPlatformFee)).toBe(6000);
    expect(fridayMoneyCents(summary.totalNet)).toBe(10500);
    expect(fridayMoneyCents(summary.totalPaidOut)).toBe(7000);
    expect(fridayMoneyCents(summary.pendingPayout)).toBe(3500);
  });

  it("handles empty entries", () => {
    const result = computeEarningsSummary("pub-1", [], [], buildDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fridayMoneyCents(result.value.totalGross)).toBe(0);
    expect(fridayMoneyCents(result.value.totalNet)).toBe(0);
    expect(fridayMoneyCents(result.value.totalPaidOut)).toBe(0);
    expect(fridayMoneyCents(result.value.pendingPayout)).toBe(0);
  });

  it("rejects mixed-currency entries", () => {
    const entries: FridayPayoutEntry[] = [
      pendingEntry(7000, "entry-1"),
      { ...pendingEntry(3500, "entry-2"), grossAmount: fridayMoney(3500, "EUR"), netAmount: fridayMoney(2450, "EUR"), platformFee: fridayMoney(1050, "EUR"), taxWithholding: fridayMoney(0, "EUR") },
    ];

    const result = computeEarningsSummary("pub-1", entries, [], buildDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.CURRENCY_MISMATCH);
  });
});

describe("reconcileBatch", () => {
  it("passes when batch total matches entry sum", () => {
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(10500, "USD"),
      entryCount: 2,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: null,
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: null,
      failedReason: null,
    };

    const entries: FridayPayoutEntry[] = [
      { ...pendingEntry(7000, "entry-1"), payoutBatchId: "batch-1" },
      { ...pendingEntry(3500, "entry-2"), payoutBatchId: "batch-1" },
    ];

    const result = reconcileBatch(batch, entries);
    expect(result.ok).toBe(true);
  });

  it("fails when batch total does not match", () => {
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(9999, "USD"),
      entryCount: 1,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: null,
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: null,
      failedReason: null,
    };

    const entries: FridayPayoutEntry[] = [
      { ...pendingEntry(7000, "entry-1"), payoutBatchId: "batch-1" },
    ];

    const result = reconcileBatch(batch, entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.RECONCILIATION_FAILED);
  });

  it("fails reconciliation for mixed currencies", () => {
    const batch: FridayPayoutBatch = {
      id: "batch-1",
      publisherId: "pub-1",
      status: "processing",
      totalAmount: fridayMoney(10500, "USD"),
      entryCount: 2,
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.000Z",
      externalPayoutId: null,
      initiatedAt: "2026-02-24T12:00:00.000Z",
      completedAt: null,
      failedReason: null,
    };

    const entries: FridayPayoutEntry[] = [
      { ...pendingEntry(7000, "entry-1", "USD" as FridayCurrencyCode), payoutBatchId: "batch-1" },
      { ...pendingEntry(3500, "entry-2", "EUR" as FridayCurrencyCode), payoutBatchId: "batch-1" },
    ];

    const result = reconcileBatch(batch, entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PAYOUT_ERROR_CODES.CURRENCY_MISMATCH);
  });
});

describe("audit events", () => {
  it("emits audit events for payout batch transitions", () => {
    resetCounter();
    const events: MarketplaceAuditEvent[] = [];

    const result = createPayoutBatch(
      "pub-1",
      [
        pendingEntry(7000, "entry-1"),
        pendingEntry(3000, "entry-2"),
      ],
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T23:59:59.000Z",
      5000,
      buildDeps({ emitAuditEvent: (event) => events.push(event) }),
    );

    expect(result.ok).toBe(true);
    expect(events.length).toBe(3);
    for (const event of events) {
      expect(event.timestamp).toBe("2026-02-24T12:00:00.000Z");
      expect(event.actor).toBeTruthy();
      expect(event.fromState).not.toBeUndefined();
      expect(event.toState).toBeTruthy();
    }
  });
});

describe("CSV KPI assertions", () => {
  it("keeps payout reconciliation mismatch rate under 0.1%", () => {
    const total = 1000;
    let mismatches = 0;

    for (let i = 0; i < total; i += 1) {
      const batch: FridayPayoutBatch = {
        id: `batch-${i}`,
        publisherId: "pub-1",
        status: "processing",
        totalAmount: fridayMoney(7000, "USD"),
        entryCount: 1,
        periodStart: "2026-02-01T00:00:00.000Z",
        periodEnd: "2026-02-28T23:59:59.000Z",
        externalPayoutId: null,
        initiatedAt: "2026-02-24T12:00:00.000Z",
        completedAt: null,
        failedReason: null,
      };

      const result = reconcileBatch(batch, [
        { ...pendingEntry(7000, `entry-${i}`), payoutBatchId: `batch-${i}` },
      ]);

      if (!result.ok) {
        mismatches += 1;
      }
    }

    expect(mismatches / total).toBeLessThan(0.001);
  });
});
