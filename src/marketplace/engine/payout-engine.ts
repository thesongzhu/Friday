/**
 * Payout Engine — Earnings tracking, batch payouts, platform fee calculation.
 *
 * Manages the payout ledger including per-transaction earnings entries,
 * batch payout aggregation, earnings summaries, and refund clawbacks.
 *
 * @module marketplace/engine/payout-engine
 */

import type {
  FridayCurrencyCode,
  FridayEarningsSummary,
  FridayMoneyAmount,
  FridayPayoutBatch,
  FridayPayoutBatchStatus,
  FridayPayoutEntry,
  FridayPayoutEntryStatus,
  FridayPublisher,
  FridayPurchase,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

import { fridayMoney, fridayMoneyCents, fridayMoneyCurrency } from "../model/friday-marketplace.types.js";
import { bankersRound, calculatePlatformFee } from "./pricing-engine.js";
import { MARKETPLACE_SYSTEM_ACTOR } from "./audit-events.js";
import type { MarketplaceAuditEventMetadata, MarketplaceAuditEventSink } from "./audit-events.js";

// ─── Error Types ───

export const PAYOUT_ERROR_CODES = {
  BATCH_NOT_FOUND: "PAYOUT_BATCH_NOT_FOUND",
  BELOW_THRESHOLD: "PAYOUT_BELOW_THRESHOLD",
  NO_PENDING_ENTRIES: "PAYOUT_NO_PENDING_ENTRIES",
  INVALID_TRANSITION: "PAYOUT_INVALID_TRANSITION",
  RECONCILIATION_FAILED: "PAYOUT_RECONCILIATION_FAILED",
  CURRENCY_MISMATCH: "PAYOUT_CURRENCY_MISMATCH",
} as const;

export type PayoutErrorCode =
  (typeof PAYOUT_ERROR_CODES)[keyof typeof PAYOUT_ERROR_CODES];

export interface PayoutError {
  readonly code: PayoutErrorCode;
  readonly message: string;
}

export type PayoutResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PayoutError };

// ─── Configuration ───

/** Default minimum payout threshold in cents (USD). */
export const DEFAULT_MIN_PAYOUT_THRESHOLD_CENTS = 5000; // $50.00

/** Default tax withholding rate in basis points (0% for verified publishers). */
export const DEFAULT_TAX_WITHHOLDING_BPS = 0;

/** Backup withholding rate for unverified publishers (24% US backup). */
export const BACKUP_TAX_WITHHOLDING_BPS = 2400;

// ─── Deps ───

export interface PayoutDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly emitAuditEvent?: MarketplaceAuditEventSink;
  readonly defaultActor?: string;
}

// ─── Payout Entry Management ───

/**
 * Creates a payout entry for a completed purchase.
 *
 * Computes platform fee, tax withholding, and net amount using the
 * publisher's fee rate and verification status.
 */
export function createPayoutEntry(
  purchase: FridayPurchase,
  publisher: FridayPublisher,
  listingId: UUID,
  deps: PayoutDeps,
): PayoutResult<FridayPayoutEntry> {
  if (purchase.status !== "completed") {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.INVALID_TRANSITION,
        message: `Purchase must be "completed" to create payout entry, current status: "${purchase.status}"`,
      },
    };
  }

  if (listingId !== purchase.listingId) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.INVALID_TRANSITION,
        message: "Listing ID does not match purchase listing",
      },
    };
  }

  const grossCents = fridayMoneyCents(purchase.amount);
  const currency = fridayMoneyCurrency(purchase.amount) as FridayCurrencyCode;

  // Calculate platform fee
  const { fee: platformFee, net: grossAfterFee } = calculatePlatformFee(
    grossCents,
    publisher.platformFeeBps,
    currency,
  );

  // Calculate tax withholding
  const taxBps = publisher.verificationStatus === "verified"
    ? DEFAULT_TAX_WITHHOLDING_BPS
    : BACKUP_TAX_WITHHOLDING_BPS;
  const taxWithholdingCents = bankersRound(
    (fridayMoneyCents(grossAfterFee) * taxBps) / 10_000,
  );
  const taxWithholding = fridayMoney(taxWithholdingCents, currency);

  // Net amount = gross - platform fee - tax withholding
  const netCents = fridayMoneyCents(grossAfterFee) - taxWithholdingCents;
  const netAmount = fridayMoney(netCents, currency);

  const now = deps.now();

  const entry: FridayPayoutEntry = {
    id: deps.generateId(),
    publisherId: publisher.id,
    purchaseId: purchase.id,
    listingId,
    grossAmount: purchase.amount,
    platformFee,
    netAmount,
    taxWithholding,
    payoutBatchId: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "payout_entry",
    entityId: entry.id,
    action: "payout_entry.created",
    fromState: null,
    toState: entry.status,
    timestamp: now,
    actor: publisher.id,
    metadata: {
      purchaseId: entry.purchaseId,
      listingId: entry.listingId,
    },
  });

  return { ok: true, value: entry };
}

/**
 * Creates a clawback (negative) payout entry for a refund.
 *
 * The clawback reverses the original earnings proportionally.
 */
export function createClawbackEntry(
  originalEntry: FridayPayoutEntry,
  refundAmountCents: number,
  deps: PayoutDeps,
): PayoutResult<FridayPayoutEntry> {
  const grossCents = fridayMoneyCents(originalEntry.grossAmount);
  const ratio = grossCents > 0 ? refundAmountCents / grossCents : 0;

  const clawbackFeeCents = bankersRound(fridayMoneyCents(originalEntry.platformFee) * ratio);
  const clawbackTaxCents = bankersRound(fridayMoneyCents(originalEntry.taxWithholding) * ratio);
  const clawbackNetCents = bankersRound(fridayMoneyCents(originalEntry.netAmount) * ratio);

  const currency = fridayMoneyCurrency(originalEntry.grossAmount) as FridayCurrencyCode;
  const now = deps.now();

  const entry: FridayPayoutEntry = {
    id: deps.generateId(),
    publisherId: originalEntry.publisherId,
    purchaseId: originalEntry.purchaseId,
    listingId: originalEntry.listingId,
    grossAmount: fridayMoney(-refundAmountCents, currency),
    platformFee: fridayMoney(-clawbackFeeCents, currency),
    netAmount: fridayMoney(-clawbackNetCents, currency),
    taxWithholding: fridayMoney(-clawbackTaxCents, currency),
    payoutBatchId: null,
    status: "clawed_back",
    createdAt: now,
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "payout_entry",
    entityId: entry.id,
    action: "payout_entry.clawback_created",
    fromState: null,
    toState: entry.status,
    timestamp: now,
    actor: originalEntry.publisherId,
    metadata: {
      purchaseId: entry.purchaseId,
      listingId: entry.listingId,
      refundAmountCents,
    },
  });

  return { ok: true, value: entry };
}

// ─── Payout Batch Management ───

/**
 * Creates a payout batch from pending entries for a publisher.
 *
 * Aggregates all pending payout entries within the specified period
 * into a single batch. Validates minimum payout threshold.
 */
export function createPayoutBatch(
  publisherId: UUID,
  pendingEntries: readonly FridayPayoutEntry[],
  periodStart: ISODateTime,
  periodEnd: ISODateTime,
  minThresholdCents: number = DEFAULT_MIN_PAYOUT_THRESHOLD_CENTS,
  deps: PayoutDeps,
): PayoutResult<{ batch: FridayPayoutBatch; entries: readonly FridayPayoutEntry[] }> {
  const eligibleEntries = pendingEntries.filter(
    (e) => e.publisherId === publisherId && e.status === "pending",
  );

  if (eligibleEntries.length === 0) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.NO_PENDING_ENTRIES,
        message: "No pending payout entries found for this publisher",
      },
    };
  }

  // Determine currency from first entry (all entries for a publisher should share currency)
  const currency = fridayMoneyCurrency(eligibleEntries[0].netAmount) as FridayCurrencyCode;
  const mixedCurrency = eligibleEntries.some(
    (entry) => fridayMoneyCurrency(entry.netAmount) !== currency,
  );
  if (mixedCurrency) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.CURRENCY_MISMATCH,
        message: "Cannot create payout batch with mixed entry currencies",
      },
    };
  }

  const totalNetCents = eligibleEntries.reduce(
    (sum, e) => sum + fridayMoneyCents(e.netAmount),
    0,
  );

  if (totalNetCents < minThresholdCents) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.BELOW_THRESHOLD,
        message: `Total pending amount (${totalNetCents} cents) is below minimum threshold (${minThresholdCents} cents)`,
      },
    };
  }

  const now = deps.now();
  const batchId = deps.generateId();

  const batch: FridayPayoutBatch = {
    id: batchId,
    publisherId,
    status: "pending",
    totalAmount: fridayMoney(totalNetCents, currency),
    entryCount: eligibleEntries.length,
    periodStart,
    periodEnd,
    externalPayoutId: null,
    initiatedAt: now,
    completedAt: null,
    failedReason: null,
  };

  // Assign entries to batch
  const batchedEntries = eligibleEntries.map((e) => ({
    ...e,
    payoutBatchId: batchId,
    status: "processing" as FridayPayoutEntryStatus,
    updatedAt: now,
  }));

  emitTransitionAudit(deps, {
    entityType: "payout_batch",
    entityId: batch.id,
    action: "payout_batch.created",
    fromState: null,
    toState: batch.status,
    timestamp: now,
    actor: publisherId,
    metadata: {
      entryCount: batch.entryCount,
    },
  });
  for (const originalEntry of eligibleEntries) {
    emitTransitionAudit(deps, {
      entityType: "payout_entry",
      entityId: originalEntry.id,
      action: "payout_entry.batched",
      fromState: originalEntry.status,
      toState: "processing",
      timestamp: now,
      actor: publisherId,
      metadata: {
        payoutBatchId: batch.id,
      },
    });
  }

  return { ok: true, value: { batch, entries: batchedEntries } };
}

/**
 * Completes a payout batch.
 */
export function completePayoutBatch(
  batch: FridayPayoutBatch,
  entries: readonly FridayPayoutEntry[],
  externalPayoutId: string | null,
  deps: PayoutDeps,
): PayoutResult<{ batch: FridayPayoutBatch; entries: readonly FridayPayoutEntry[] }> {
  if (batch.status !== "pending" && batch.status !== "processing") {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot complete batch from status "${batch.status}"`,
      },
    };
  }

  // Reconciliation check
  const reconciliation = reconcileBatch(batch, entries);
  if (!reconciliation.ok) return reconciliation;

  const now = deps.now();

  const completedBatch: FridayPayoutBatch = {
    ...batch,
    status: "completed",
    externalPayoutId,
    completedAt: now,
  };

  const batchEntries = entries.filter((e) => e.payoutBatchId === batch.id);
  const completedEntries = batchEntries
    .map((e) => ({
      ...e,
      status: "completed" as FridayPayoutEntryStatus,
      updatedAt: now,
    }));

  emitTransitionAudit(deps, {
    entityType: "payout_batch",
    entityId: batch.id,
    action: "payout_batch.completed",
    fromState: batch.status,
    toState: completedBatch.status,
    timestamp: now,
    actor: batch.publisherId,
    metadata: {
      entryCount: completedEntries.length,
    },
  });
  for (const entry of batchEntries) {
    emitTransitionAudit(deps, {
      entityType: "payout_entry",
      entityId: entry.id,
      action: "payout_entry.completed",
      fromState: entry.status,
      toState: "completed",
      timestamp: now,
      actor: batch.publisherId,
      metadata: {
        payoutBatchId: batch.id,
      },
    });
  }

  return { ok: true, value: { batch: completedBatch, entries: completedEntries } };
}

/**
 * Fails a payout batch.
 */
export function failPayoutBatch(
  batch: FridayPayoutBatch,
  entries: readonly FridayPayoutEntry[],
  reason: string,
  deps: PayoutDeps,
): PayoutResult<{ batch: FridayPayoutBatch; entries: readonly FridayPayoutEntry[] }> {
  if (batch.status !== "pending" && batch.status !== "processing") {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.INVALID_TRANSITION,
        message: `Cannot fail batch from status "${batch.status}"`,
      },
    };
  }

  const now = deps.now();

  const failedBatch: FridayPayoutBatch = {
    ...batch,
    status: "failed",
    failedReason: reason,
    completedAt: now,
  };

  // Reset entries back to pending so they can be re-batched
  const batchEntries = entries.filter((e) => e.payoutBatchId === batch.id);
  const resetEntries = batchEntries
    .map((e) => ({
      ...e,
      payoutBatchId: null as UUID | null,
      status: "pending" as FridayPayoutEntryStatus,
      updatedAt: now,
    }));

  emitTransitionAudit(deps, {
    entityType: "payout_batch",
    entityId: batch.id,
    action: "payout_batch.failed",
    fromState: batch.status,
    toState: failedBatch.status,
    timestamp: now,
    actor: batch.publisherId,
    metadata: {
      reason,
      entryCount: resetEntries.length,
    },
  });
  for (const entry of batchEntries) {
    emitTransitionAudit(deps, {
      entityType: "payout_entry",
      entityId: entry.id,
      action: "payout_entry.requeued",
      fromState: entry.status,
      toState: "pending",
      timestamp: now,
      actor: batch.publisherId,
      metadata: {
        payoutBatchId: batch.id,
      },
    });
  }

  return { ok: true, value: { batch: failedBatch, entries: resetEntries } };
}

// ─── Earnings Summary ───

/**
 * Computes an earnings summary for a publisher from their payout entries and batches.
 */
export function computeEarningsSummary(
  publisherId: UUID,
  entries: readonly FridayPayoutEntry[],
  batches: readonly FridayPayoutBatch[],
  deps: PayoutDeps,
): PayoutResult<FridayEarningsSummary> {
  const publisherEntries = entries.filter((e) => e.publisherId === publisherId);

  const currency = publisherEntries.length > 0
    ? (fridayMoneyCurrency(publisherEntries[0].grossAmount) as FridayCurrencyCode)
    : ("USD" as FridayCurrencyCode);

  // Reject mixed currencies
  const mixedCurrency = publisherEntries.find(
    (e) => fridayMoneyCurrency(e.grossAmount) !== currency,
  );
  if (mixedCurrency) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.CURRENCY_MISMATCH,
        message: `Mixed currencies in entries: expected "${currency}", found "${fridayMoneyCurrency(mixedCurrency.grossAmount)}"`,
      },
    };
  }

  const totalGross = sumMoney(publisherEntries, (e) => e.grossAmount, currency);
  const totalPlatformFee = sumMoney(publisherEntries, (e) => e.platformFee, currency);
  const totalNet = sumMoney(publisherEntries, (e) => e.netAmount, currency);
  const totalTaxWithheld = sumMoney(publisherEntries, (e) => e.taxWithholding, currency);

  // Total paid out from completed batches
  const completedBatches = batches.filter(
    (b) => b.publisherId === publisherId && b.status === "completed",
  );
  const totalPaidOutCents = completedBatches.reduce(
    (sum, b) => sum + fridayMoneyCents(b.totalAmount),
    0,
  );

  // Pending = net total - paid out
  const pendingPayoutCents = fridayMoneyCents(totalNet) - totalPaidOutCents;

  return {
    ok: true,
    value: {
      publisherId,
      totalGross,
      totalPlatformFee,
      totalNet,
      totalTaxWithheld,
      totalPaidOut: fridayMoney(totalPaidOutCents, currency),
      pendingPayout: fridayMoney(Math.max(0, pendingPayoutCents), currency),
      asOf: deps.now(),
    },
  };
}

// ─── Reconciliation ───

/**
 * Validates that a batch's total matches the sum of its entries' net amounts.
 *
 * Tolerance: exact match required (integer cents).
 */
export function reconcileBatch(
  batch: FridayPayoutBatch,
  entries: readonly FridayPayoutEntry[],
): PayoutResult<void> {
  const batchEntries = entries.filter((e) => e.payoutBatchId === batch.id);
  const batchCurrency = fridayMoneyCurrency(batch.totalAmount);
  const mixedCurrency = batchEntries.some(
    (entry) => fridayMoneyCurrency(entry.netAmount) !== batchCurrency,
  );
  if (mixedCurrency) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.CURRENCY_MISMATCH,
        message: "Batch and entry currencies must match during reconciliation",
      },
    };
  }

  const sumNetCents = batchEntries.reduce(
    (sum, e) => sum + fridayMoneyCents(e.netAmount),
    0,
  );
  const batchTotalCents = fridayMoneyCents(batch.totalAmount);

  if (sumNetCents !== batchTotalCents) {
    return {
      ok: false,
      error: {
        code: PAYOUT_ERROR_CODES.RECONCILIATION_FAILED,
        message: `Batch total (${batchTotalCents}) does not match sum of entries (${sumNetCents})`,
      },
    };
  }

  return { ok: true, value: undefined };
}

// ─── Internal Helpers ───

function sumMoney(
  entries: readonly FridayPayoutEntry[],
  getter: (e: FridayPayoutEntry) => FridayMoneyAmount,
  currency: FridayCurrencyCode,
): FridayMoneyAmount {
  const totalCents = entries.reduce((sum, e) => sum + fridayMoneyCents(getter(e)), 0);
  return fridayMoney(totalCents, currency);
}

function emitTransitionAudit(
  deps: PayoutDeps,
  event: {
    readonly entityType: "payout_entry" | "payout_batch";
    readonly entityId: UUID;
    readonly action: string;
    readonly fromState: string | null;
    readonly toState: string;
    readonly timestamp: ISODateTime;
    readonly actor?: string;
    readonly metadata?: MarketplaceAuditEventMetadata;
  },
): void {
  if (!deps.emitAuditEvent) return;
  deps.emitAuditEvent({
    ...event,
    actor: event.actor ?? deps.defaultActor ?? MARKETPLACE_SYSTEM_ACTOR,
  });
}
