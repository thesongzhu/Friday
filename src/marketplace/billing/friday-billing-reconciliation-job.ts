/**
 * Billing Reconciliation Job — Matches internal ledger with external providers.
 *
 * Periodic job that:
 * 1. Processes unprocessed billing events from the event table
 * 2. Reconciles pending payout batches against provider records
 * 3. Detects and flags stale purchases stuck in "pending" state
 * 4. Checks subscription renewals and expirations
 *
 * @module marketplace/billing/friday-billing-reconciliation-job
 */

import type {
  FridayBillingEvent,
  FridayPayoutBatch,
  FridayPayoutEntry,
  FridayPurchase,
  FridayRefund,
  FridaySubscription,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

import {
  completePurchase,
  completeRefund,
  failPurchase,
  failRefund,
} from "../engine/purchase-manager.js";

import type { PurchaseDeps } from "../engine/purchase-manager.js";

import {
  completePayoutBatch,
  failPayoutBatch,
} from "../engine/payout-engine.js";

import type { PayoutDeps } from "../engine/payout-engine.js";

// ─── Configuration ───

export interface FridayBillingReconciliationConfig {
  /** How often to run the reconciliation cycle (ms). */
  readonly intervalMs: number;
  /** Jitter to spread load (ms). */
  readonly jitterMs: number;
  /** Max backoff on consecutive failures (ms). */
  readonly maxBackoffMs: number;
  /** Age in ms after which a pending purchase is considered stale. */
  readonly stalePurchaseThresholdMs: number;
  /** Age in ms after which a pending payout batch is considered stale. */
  readonly stalePayoutThresholdMs: number;
  /** Max billing events to process per cycle. */
  readonly maxEventsPerCycle: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: FridayBillingReconciliationConfig = {
  intervalMs: 5 * 60 * 1000, // 5 minutes
  jitterMs: 30 * 1000, // 30 seconds
  maxBackoffMs: 60 * 60 * 1000, // 1 hour
  stalePurchaseThresholdMs: 30 * 60 * 1000, // 30 minutes
  stalePayoutThresholdMs: 24 * 60 * 60 * 1000, // 24 hours
  maxEventsPerCycle: 100,
};

// ─── Result ───

export interface FridayReconciliationResult {
  readonly eventsProcessed: number;
  readonly purchasesCompleted: number;
  readonly purchasesFailed: number;
  readonly refundsCompleted: number;
  readonly refundsFailed: number;
  readonly payoutBatchesCompleted: number;
  readonly payoutBatchesFailed: number;
  readonly stalePurchasesFlagged: number;
  readonly subscriptionsExpired: number;
  readonly errors: string[];
}

// ─── Deps ───

export interface FridayBillingReconciliationDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;

  // Billing event access
  readonly getUnprocessedBillingEvents: (
    limit: number,
  ) => Promise<readonly FridayBillingEvent[]>;
  readonly markBillingEventProcessed: (eventId: UUID) => Promise<void>;

  // Purchase access
  readonly getPurchaseByExternalPaymentId: (
    externalId: string,
  ) => Promise<FridayPurchase | null>;
  readonly getPurchase: (id: UUID) => Promise<FridayPurchase | null>;
  readonly savePurchase: (purchase: FridayPurchase) => Promise<void>;
  readonly getStalePendingPurchases: (
    olderThan: ISODateTime,
  ) => Promise<readonly FridayPurchase[]>;

  // Refund access
  readonly getRefundByExternalRefundId: (
    externalId: string,
  ) => Promise<FridayRefund | null>;
  readonly getRefund: (id: UUID) => Promise<FridayRefund | null>;
  readonly saveRefund: (refund: FridayRefund) => Promise<void>;
  readonly getCompletedRefundsForPurchase: (
    purchaseId: UUID,
  ) => Promise<readonly FridayRefund[]>;

  // Listing/version access (for completePurchase)
  readonly getListing: (id: UUID) => Promise<{ id: UUID; currentVersionId: UUID | null } | null>;
  readonly getListingVersion: (id: UUID) => Promise<{ id: UUID; listingId: UUID; status: string } | null>;

  // Payout access
  readonly getPendingPayoutBatches: () => Promise<readonly FridayPayoutBatch[]>;
  readonly getPayoutEntriesForBatch: (
    batchId: UUID,
  ) => Promise<readonly FridayPayoutEntry[]>;
  readonly savePayoutBatch: (batch: FridayPayoutBatch) => Promise<void>;
  readonly savePayoutEntries: (entries: readonly FridayPayoutEntry[]) => Promise<void>;

  // Subscription access
  readonly getExpiredSubscriptions: (
    before: ISODateTime,
  ) => Promise<readonly FridaySubscription[]>;
  readonly saveSubscription: (subscription: FridaySubscription) => Promise<void>;

  // Entitlement access (for completePurchase)
  readonly saveEntitlement?: (entitlement: unknown) => Promise<void>;
  readonly saveSubscriptionRecord?: (subscription: FridaySubscription) => Promise<void>;

  readonly config?: FridayBillingReconciliationConfig;
}

// ─── Interface ───

export interface FridayBillingReconciliationJob {
  /** Run a single reconciliation cycle. */
  runOnce(): Promise<FridayReconciliationResult>;
  /** Start the periodic reconciliation loop. */
  start(): void;
  /** Stop the periodic reconciliation loop. */
  stop(): void;
  /** Whether the job loop is currently active. */
  isRunning(): boolean;
}

// ─── Factory ───

export function createFridayBillingReconciliationJob(
  deps: FridayBillingReconciliationDeps,
): FridayBillingReconciliationJob {
  const config = deps.config ?? DEFAULT_RECONCILIATION_CONFIG;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  function computeDelay(): number {
    if (consecutiveFailures === 0) {
      const jitter = Math.floor(Math.random() * config.jitterMs);
      return config.intervalMs + jitter;
    }
    // Exponential backoff
    const backoff = Math.min(
      config.intervalMs * Math.pow(2, consecutiveFailures),
      config.maxBackoffMs,
    );
    const jitter = Math.floor(Math.random() * config.jitterMs);
    return backoff + jitter;
  }

  const engineDeps: PurchaseDeps & PayoutDeps = {
    generateId: deps.generateId,
    now: deps.now,
  };

  async function processBillingEvents(
    result: MutableResult,
  ): Promise<void> {
    const events = await deps.getUnprocessedBillingEvents(config.maxEventsPerCycle);

    for (const event of events) {
      try {
        await processOneEvent(event, result);
        await deps.markBillingEventProcessed(event.id);
        result.eventsProcessed++;
      } catch (err) {
        result.errors.push(
          `Failed to process billing event ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async function processOneEvent(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    switch (event.eventType) {
      case "payment.succeeded": {
        await handlePaymentSucceeded(event, result);
        break;
      }
      case "payment.failed": {
        await handlePaymentFailed(event, result);
        break;
      }
      case "refund.completed": {
        await handleRefundCompleted(event, result);
        break;
      }
      case "payout.completed": {
        await handlePayoutCompleted(event, result);
        break;
      }
      case "payout.failed": {
        await handlePayoutFailed(event, result);
        break;
      }
      // Other event types are logged but not actively reconciled
      default:
        break;
    }
  }

  async function handlePaymentSucceeded(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    const externalId = extractExternalId(event);
    if (!externalId) return;

    const purchase = await deps.getPurchaseByExternalPaymentId(externalId);
    if (!purchase || purchase.status !== "pending") return;

    const listing = await deps.getListing(purchase.listingId);
    if (!listing) return;
    const versionId = listing.currentVersionId;
    if (!versionId) return;
    const version = await deps.getListingVersion(versionId);
    if (!version) return;

    const completeResult = completePurchase(
      purchase,
      listing as any,
      version as any,
      { externalPaymentId: externalId },
      engineDeps,
    );

    if (completeResult.ok) {
      await deps.savePurchase(completeResult.value.purchase);
      result.purchasesCompleted++;
    } else {
      result.errors.push(
        `Failed to complete purchase ${purchase.id}: ${completeResult.error.message}`,
      );
    }
  }

  async function handlePaymentFailed(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    const externalId = extractExternalId(event);
    if (!externalId) return;

    const purchase = await deps.getPurchaseByExternalPaymentId(externalId);
    if (!purchase || purchase.status !== "pending") return;

    const failResult = failPurchase(purchase, engineDeps);
    if (failResult.ok) {
      await deps.savePurchase(failResult.value);
      result.purchasesFailed++;
    }
  }

  async function handleRefundCompleted(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    const externalId = extractExternalId(event);
    if (!externalId) return;

    const refund = await deps.getRefundByExternalRefundId(externalId);
    if (!refund || refund.status !== "pending") return;

    const purchase = await deps.getPurchase(refund.purchaseId);
    if (!purchase) return;

    const existingCompleted = await deps.getCompletedRefundsForPurchase(refund.purchaseId);

    const completeResult = completeRefund(
      refund,
      purchase,
      { externalRefundId: externalId, existingCompletedRefunds: existingCompleted },
      engineDeps,
    );

    if (completeResult.ok) {
      await deps.saveRefund(completeResult.value.refund);
      await deps.savePurchase(completeResult.value.purchase);
      result.refundsCompleted++;
    } else {
      result.errors.push(
        `Failed to complete refund ${refund.id}: ${completeResult.error.message}`,
      );
    }
  }

  async function handlePayoutCompleted(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    const externalId = extractExternalId(event);
    if (!externalId) return;

    // Find payout batch by external payout ID
    const batches = await deps.getPendingPayoutBatches();
    const batch = batches.find((b) => b.externalPayoutId === externalId);
    if (!batch) return;

    const entries = await deps.getPayoutEntriesForBatch(batch.id);
    const completeResult = completePayoutBatch(batch, entries, externalId, engineDeps);

    if (completeResult.ok) {
      await deps.savePayoutBatch(completeResult.value.batch);
      await deps.savePayoutEntries(completeResult.value.entries);
      result.payoutBatchesCompleted++;
    } else {
      result.errors.push(
        `Failed to complete payout batch ${batch.id}: ${completeResult.error.message}`,
      );
    }
  }

  async function handlePayoutFailed(
    event: FridayBillingEvent,
    result: MutableResult,
  ): Promise<void> {
    const externalId = extractExternalId(event);
    if (!externalId) return;

    const batches = await deps.getPendingPayoutBatches();
    const batch = batches.find((b) => b.externalPayoutId === externalId);
    if (!batch) return;

    const entries = await deps.getPayoutEntriesForBatch(batch.id);
    const reason = extractFailureReason(event);
    const failResult = failPayoutBatch(batch, entries, reason, engineDeps);

    if (failResult.ok) {
      await deps.savePayoutBatch(failResult.value.batch);
      await deps.savePayoutEntries(failResult.value.entries);
      result.payoutBatchesFailed++;
    }
  }

  async function flagStalePurchases(result: MutableResult): Promise<void> {
    const threshold = new Date(
      Date.now() - config.stalePurchaseThresholdMs,
    ).toISOString() as ISODateTime;

    const stalePurchases = await deps.getStalePendingPurchases(threshold);

    for (const purchase of stalePurchases) {
      const failResult = failPurchase(purchase, engineDeps);
      if (failResult.ok) {
        await deps.savePurchase(failResult.value);
        result.stalePurchasesFlagged++;
      }
    }
  }

  async function expireSubscriptions(result: MutableResult): Promise<void> {
    const now = deps.now();
    const expired = await deps.getExpiredSubscriptions(now);

    for (const subscription of expired) {
      if (subscription.status !== "active" && subscription.status !== "past_due") continue;

      const updated: FridaySubscription = {
        ...subscription,
        status: "expired",
        updatedAt: now,
      };
      await deps.saveSubscription(updated);
      result.subscriptionsExpired++;
    }
  }

  async function runCycle(): Promise<void> {
    if (!running) return;

    try {
      await job.runOnce();
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
    }

    if (running) {
      timer = setTimeout(() => void runCycle(), computeDelay());
    }
  }

  const job: FridayBillingReconciliationJob = {
    async runOnce() {
      const result: MutableResult = {
        eventsProcessed: 0,
        purchasesCompleted: 0,
        purchasesFailed: 0,
        refundsCompleted: 0,
        refundsFailed: 0,
        payoutBatchesCompleted: 0,
        payoutBatchesFailed: 0,
        stalePurchasesFlagged: 0,
        subscriptionsExpired: 0,
        errors: [],
      };

      // Phase 1: Process billing events from webhooks
      await processBillingEvents(result);

      // Phase 2: Flag stale pending purchases
      await flagStalePurchases(result);

      // Phase 3: Expire overdue subscriptions
      await expireSubscriptions(result);

      return result;
    },

    start() {
      if (running) return;
      running = true;
      consecutiveFailures = 0;
      timer = setTimeout(() => void runCycle(), 1000);
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isRunning() {
      return running;
    },
  };

  return job;
}

// ─── Internal helpers ───

interface MutableResult {
  eventsProcessed: number;
  purchasesCompleted: number;
  purchasesFailed: number;
  refundsCompleted: number;
  refundsFailed: number;
  payoutBatchesCompleted: number;
  payoutBatchesFailed: number;
  stalePurchasesFlagged: number;
  subscriptionsExpired: number;
  errors: string[];
}

function extractExternalId(event: FridayBillingEvent): string | null {
  const payload = event.payload;
  if (typeof payload["id"] === "string") return payload["id"];
  const data = payload["data"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = (data as Record<string, unknown>)["object"];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const id = (obj as Record<string, unknown>)["id"];
      if (typeof id === "string") return id;
    }
  }
  return null;
}

function extractFailureReason(event: FridayBillingEvent): string {
  const payload = event.payload;
  if (typeof payload["failure_message"] === "string") return payload["failure_message"];
  if (typeof payload["failure_code"] === "string") return payload["failure_code"];
  return "External payout failed";
}
