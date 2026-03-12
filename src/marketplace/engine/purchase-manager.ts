/**
 * Purchase Manager — Purchase flow, license generation, refund processing.
 *
 * Manages the checkout and purchase lifecycle including free acquisitions,
 * paid purchases, subscription creation, entitlement granting, and refunds.
 *
 * @module marketplace/engine/purchase-manager
 */

import type {
  FridayEntitlement,
  FridayEntitlementSourceType,
  FridayListing,
  FridayListingVersion,
  FridayMoneyAmount,
  FridayPricingPlan,
  FridayPricingPlanRecord,
  FridayPurchase,
  FridayRefund,
  FridaySubscription,
  ISODateTime,
  UUID,
} from "../model/friday-marketplace.types.js";

import {
  FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES,
  fridayMoney,
  fridayMoneyCents,
} from "../model/friday-marketplace.types.js";
import { MARKETPLACE_SYSTEM_ACTOR } from "./audit-events.js";
import type {
  MarketplaceAuditEntityType,
  MarketplaceAuditEventMetadata,
  MarketplaceAuditEventSink,
} from "./audit-events.js";

// ─── Error Types ───

export const PURCHASE_ERROR_CODES = {
  NOT_FOUND: "PURCHASE_NOT_FOUND",
  ALREADY_COMPLETED: "PURCHASE_ALREADY_COMPLETED",
  NOT_REFUNDABLE: "PURCHASE_NOT_REFUNDABLE",
  LISTING_NOT_PUBLISHED: "LISTING_NOT_PUBLISHED",
  VALIDATION_FAILED: "PURCHASE_VALIDATION_FAILED",
  REFUND_EXCEEDS_AMOUNT: "REFUND_EXCEEDS_AMOUNT",
  INACTIVE_PRICING_PLAN: "PURCHASE_INACTIVE_PRICING_PLAN",
  LINKAGE_MISMATCH: "PURCHASE_LINKAGE_MISMATCH",
  INELIGIBLE_VERSION: "PURCHASE_INELIGIBLE_VERSION",
  PRICING_TYPE_NOT_ALLOWED_IN_MVP: "PURCHASE_PRICING_TYPE_NOT_ALLOWED_IN_MVP",
} as const;

export type PurchaseErrorCode =
  (typeof PURCHASE_ERROR_CODES)[keyof typeof PURCHASE_ERROR_CODES];

export interface PurchaseError {
  readonly code: PurchaseErrorCode;
  readonly message: string;
}

export type PurchaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PurchaseError };

// ─── Input Types ───

export interface InitiateCheckoutInput {
  readonly buyerTenantId: string;
  readonly buyerPrincipalId: string;
  readonly listing: FridayListing;
  readonly version: FridayListingVersion;
  readonly pricingPlanRecord: FridayPricingPlanRecord;
  readonly idempotencyKey?: string;
}

export interface CompletePurchaseInput {
  readonly externalPaymentId?: string;
}

export interface InitiateRefundInput {
  readonly amount?: FridayMoneyAmount;
  readonly reason: string;
  readonly initiatedBy: string;
}

export interface CompleteRefundInput {
  readonly externalRefundId?: string;
  /**
   * Completed refunds already persisted for this purchase.
   *
   * Used to deterministically determine whether this completion moves purchase
   * status to "refunded".
   */
  readonly existingCompletedRefunds?: readonly FridayRefund[];
  readonly actor?: string;
}

export interface FailRefundInput {
  readonly actor?: string;
}

// ─── Checkout Result ───

export interface CheckoutResult {
  readonly purchase: FridayPurchase;
  readonly entitlement?: FridayEntitlement;
  readonly subscription?: FridaySubscription;
}

// ─── Deps ───

export interface PurchaseDeps {
  readonly generateId: () => UUID;
  readonly now: () => ISODateTime;
  readonly emitAuditEvent?: MarketplaceAuditEventSink;
  readonly defaultActor?: string;
}

// ─── Purchase Manager ───

/**
 * Initiates a checkout for a listing.
 *
 * For free plans, the purchase is completed immediately and an entitlement
 * is granted. For paid plans, a pending purchase is created.
 */
export function initiateCheckout(
  input: InitiateCheckoutInput,
  deps: PurchaseDeps,
): PurchaseResult<CheckoutResult> {
  if (input.listing.status !== "published") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LISTING_NOT_PUBLISHED,
        message: `Listing must be published to purchase, current status: "${input.listing.status}"`,
      },
    };
  }

  if (!input.pricingPlanRecord.isActive) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.INACTIVE_PRICING_PLAN,
        message: `Pricing plan "${input.pricingPlanRecord.id}" is inactive`,
      },
    };
  }

  if (input.pricingPlanRecord.listingId !== input.listing.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Pricing plan does not belong to listing",
      },
    };
  }

  if (input.version.listingId !== input.listing.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Version does not belong to listing",
      },
    };
  }

  if (
    input.listing.currentVersionId !== input.version.id ||
    input.version.status !== "approved"
  ) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.INELIGIBLE_VERSION,
        message: "Version is not the active approved listing version",
      },
    };
  }

  const plan = input.pricingPlanRecord.plan;
  if (!(FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES as readonly string[]).includes(plan.type)) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.PRICING_TYPE_NOT_ALLOWED_IN_MVP,
        message: `Pricing plan type "${plan.type}" is not enabled in current marketplace MVP profile`,
      },
    };
  }

  const now = deps.now();
  const purchaseId = deps.generateId();
  const amount = getPlanAmount(plan);

  const purchase: FridayPurchase = {
    id: purchaseId,
    buyerTenantId: input.buyerTenantId,
    buyerPrincipalId: input.buyerPrincipalId,
    listingId: input.listing.id,
    listingVersionId: input.version.id,
    pricingPlanId: input.pricingPlanRecord.id,
    status: plan.type === "free" ? "completed" : "pending",
    amount,
    externalPaymentId: null,
    idempotencyKey: input.idempotencyKey ?? null,
    completedAt: plan.type === "free" ? now : null,
    createdAt: now,
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "purchase",
    entityId: purchase.id,
    action: "purchase.checkout_initiated",
    fromState: null,
    toState: purchase.status,
    timestamp: now,
    actor: input.buyerPrincipalId,
    metadata: {
      listingId: purchase.listingId,
      pricingPlanId: purchase.pricingPlanId,
    },
  });

  const result: CheckoutResult = { purchase };

  // Free plan: grant entitlement immediately
  if (plan.type === "free") {
    const entitlement = createEntitlement(
      input.buyerTenantId,
      input.buyerPrincipalId,
      input.listing.id,
      input.version.packageName,
      "purchase",
      purchaseId,
      null,
      deps,
    );
    emitTransitionAudit(deps, {
      entityType: "entitlement",
      entityId: entitlement.id,
      action: "entitlement.granted_from_purchase",
      fromState: null,
      toState: entitlement.status,
      timestamp: now,
      actor: input.buyerPrincipalId,
      metadata: {
        purchaseId: purchase.id,
        listingId: entitlement.listingId,
      },
    });
    return { ok: true, value: { ...result, entitlement } };
  }

  return { ok: true, value: result };
}

/**
 * Completes a pending purchase after payment confirmation.
 *
 * Creates an entitlement for the buyer.
 */
export function completePurchase(
  purchase: FridayPurchase,
  listing: FridayListing,
  version: FridayListingVersion,
  input: CompletePurchaseInput,
  deps: PurchaseDeps,
): PurchaseResult<{ purchase: FridayPurchase; entitlement: FridayEntitlement }> {
  if (purchase.status !== "pending") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.ALREADY_COMPLETED,
        message: `Purchase is "${purchase.status}", cannot complete`,
      },
    };
  }

  const linkageValidation = validatePurchaseLinkage(purchase, listing, version);
  if (!linkageValidation.ok) return linkageValidation;

  const now = deps.now();

  const updatedPurchase: FridayPurchase = {
    ...purchase,
    status: "completed",
    externalPaymentId: input.externalPaymentId ?? purchase.externalPaymentId,
    completedAt: now,
    updatedAt: now,
  };

  const entitlement = createEntitlement(
    purchase.buyerTenantId,
    purchase.buyerPrincipalId,
    listing.id,
    version.packageName,
    "purchase",
    purchase.id,
    null,
    deps,
  );

  emitTransitionAudit(deps, {
    entityType: "purchase",
    entityId: purchase.id,
    action: "purchase.completed",
    fromState: purchase.status,
    toState: updatedPurchase.status,
    timestamp: now,
    actor: purchase.buyerPrincipalId,
    metadata: {
      listingId: purchase.listingId,
      listingVersionId: purchase.listingVersionId,
    },
  });
  emitTransitionAudit(deps, {
    entityType: "entitlement",
    entityId: entitlement.id,
    action: "entitlement.granted_from_purchase",
    fromState: null,
    toState: entitlement.status,
    timestamp: now,
    actor: purchase.buyerPrincipalId,
    metadata: {
      purchaseId: purchase.id,
      listingId: entitlement.listingId,
    },
  });

  return { ok: true, value: { purchase: updatedPurchase, entitlement } };
}

/**
 * Marks a purchase as failed.
 */
export function failPurchase(
  purchase: FridayPurchase,
  deps: PurchaseDeps,
): PurchaseResult<FridayPurchase> {
  if (purchase.status !== "pending") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.ALREADY_COMPLETED,
        message: `Purchase is "${purchase.status}", cannot mark as failed`,
      },
    };
  }

  const now = deps.now();
  const failedPurchase: FridayPurchase = {
    ...purchase,
    status: "failed",
    updatedAt: now,
  };

  emitTransitionAudit(deps, {
    entityType: "purchase",
    entityId: purchase.id,
    action: "purchase.failed",
    fromState: purchase.status,
    toState: failedPurchase.status,
    timestamp: now,
  });

  return {
    ok: true,
    value: failedPurchase,
  };
}

/**
 * Initiates a refund for a completed purchase.
 *
 * Supports full or partial refunds. The refund amount must not exceed the
 * purchase amount minus any previous refunds.
 */
export function initiateRefund(
  purchase: FridayPurchase,
  existingRefunds: readonly FridayRefund[],
  input: InitiateRefundInput,
  deps: PurchaseDeps,
): PurchaseResult<{ refund: FridayRefund; purchase: FridayPurchase }> {
  if (purchase.status !== "completed") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.NOT_REFUNDABLE,
        message: `Purchase must be "completed" to refund, current status: "${purchase.status}"`,
      },
    };
  }

  const totalRefundedCents = existingRefunds
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + fridayMoneyCents(r.amount), 0);

  const refundAmountCents = input.amount
    ? fridayMoneyCents(input.amount)
    : fridayMoneyCents(purchase.amount) - totalRefundedCents;

  if (refundAmountCents <= 0) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.NOT_REFUNDABLE,
        message: "No refundable amount remaining",
      },
    };
  }

  if (refundAmountCents + totalRefundedCents > fridayMoneyCents(purchase.amount)) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.REFUND_EXCEEDS_AMOUNT,
        message: `Refund amount (${refundAmountCents}) would exceed purchase amount`,
      },
    };
  }

  const now = deps.now();
  const refundAmount = fridayMoney(refundAmountCents, purchase.amount.currency);

  const refund: FridayRefund = {
    id: deps.generateId(),
    purchaseId: purchase.id,
    amount: refundAmount,
    reason: input.reason,
    status: "pending",
    externalRefundId: null,
    initiatedBy: input.initiatedBy,
    createdAt: now,
    completedAt: null,
  };

  const updatedPurchase: FridayPurchase = { ...purchase, updatedAt: now };

  emitTransitionAudit(deps, {
    entityType: "refund",
    entityId: refund.id,
    action: "refund.initiated",
    fromState: null,
    toState: refund.status,
    timestamp: now,
    actor: input.initiatedBy,
    metadata: {
      purchaseId: purchase.id,
    },
  });

  return { ok: true, value: { refund, purchase: updatedPurchase } };
}

/**
 * Completes a pending refund.
 */
export function completeRefund(
  refund: FridayRefund,
  purchase: FridayPurchase,
  input: CompleteRefundInput,
  deps: PurchaseDeps,
): PurchaseResult<{ refund: FridayRefund; purchase: FridayPurchase }> {
  if (refund.status !== "pending") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.VALIDATION_FAILED,
        message: `Refund is "${refund.status}", cannot complete`,
      },
    };
  }

  if (refund.purchaseId !== purchase.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Refund does not belong to purchase",
      },
    };
  }

  if (purchase.status !== "completed" && purchase.status !== "refunded") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.NOT_REFUNDABLE,
        message: `Purchase must be "completed" or "refunded", current status: "${purchase.status}"`,
      },
    };
  }

  const purchaseAmountCents = fridayMoneyCents(purchase.amount);
  const completedRefundCents = (input.existingCompletedRefunds ?? [])
    .filter(
      (existing) =>
        existing.purchaseId === purchase.id &&
        existing.id !== refund.id &&
        existing.status === "completed",
    )
    .reduce((sum, existing) => sum + fridayMoneyCents(existing.amount), 0);

  const totalCompletedRefundCents = completedRefundCents + fridayMoneyCents(refund.amount);
  if (totalCompletedRefundCents > purchaseAmountCents) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.REFUND_EXCEEDS_AMOUNT,
        message: `Completed refunds (${totalCompletedRefundCents}) exceed purchase amount (${purchaseAmountCents})`,
      },
    };
  }

  const now = deps.now();
  const completedRefund: FridayRefund = {
    ...refund,
    status: "completed",
    externalRefundId: input.externalRefundId ?? refund.externalRefundId,
    completedAt: now,
  };

  const nextPurchaseStatus =
    purchase.status === "refunded" || totalCompletedRefundCents === purchaseAmountCents
      ? "refunded"
      : "completed";
  const updatedPurchase: FridayPurchase = {
    ...purchase,
    status: nextPurchaseStatus,
    updatedAt: now,
  };
  const actor = input.actor ?? refund.initiatedBy;

  emitTransitionAudit(deps, {
    entityType: "refund",
    entityId: refund.id,
    action: "refund.completed",
    fromState: refund.status,
    toState: completedRefund.status,
    timestamp: now,
    actor,
    metadata: {
      purchaseId: purchase.id,
    },
  });
  if (purchase.status !== updatedPurchase.status) {
    emitTransitionAudit(deps, {
      entityType: "purchase",
      entityId: purchase.id,
      action: "purchase.refund_completed",
      fromState: purchase.status,
      toState: updatedPurchase.status,
      timestamp: now,
      actor,
      metadata: {
        refundId: refund.id,
      },
    });
  }

  return {
    ok: true,
    value: { refund: completedRefund, purchase: updatedPurchase },
  };
}

/**
 * Fails a pending refund.
 */
export function failRefund(
  refund: FridayRefund,
  purchase: FridayPurchase,
  input: FailRefundInput,
  deps: PurchaseDeps,
): PurchaseResult<{ refund: FridayRefund; purchase: FridayPurchase }> {
  if (refund.status !== "pending") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.VALIDATION_FAILED,
        message: `Refund is "${refund.status}", cannot fail`,
      },
    };
  }

  if (refund.purchaseId !== purchase.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Refund does not belong to purchase",
      },
    };
  }

  if (purchase.status !== "completed" && purchase.status !== "refunded") {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.NOT_REFUNDABLE,
        message: `Purchase must be "completed" or "refunded", current status: "${purchase.status}"`,
      },
    };
  }

  const now = deps.now();
  const failedRefund: FridayRefund = {
    ...refund,
    status: "failed",
    completedAt: now,
  };
  // Failed refund does NOT change purchase status — the purchase remains in
  // whatever state it was in (completed or refunded from a prior refund).
  const updatedPurchase: FridayPurchase = { ...purchase, updatedAt: now };
  const actor = input.actor ?? refund.initiatedBy;

  emitTransitionAudit(deps, {
    entityType: "refund",
    entityId: refund.id,
    action: "refund.failed",
    fromState: refund.status,
    toState: failedRefund.status,
    timestamp: now,
    actor,
    metadata: {
      purchaseId: purchase.id,
    },
  });

  return {
    ok: true,
    value: { refund: failedRefund, purchase: updatedPurchase },
  };
}

// ─── Internal Helpers ───

function getPlanAmount(plan: FridayPricingPlan): FridayMoneyAmount {
  switch (plan.type) {
    case "free":
      return fridayMoney(0, "USD");
    case "one_time":
      return plan.price;
    case "subscription":
      return plan.price;
    case "usage_based":
      return fridayMoney(0, plan.currency);
  }
}

function validatePurchaseLinkage(
  purchase: FridayPurchase,
  listing: FridayListing,
  version: FridayListingVersion,
): PurchaseResult<void> {
  if (purchase.listingId !== listing.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Purchase listing ID does not match listing",
      },
    };
  }

  if (version.listingId !== listing.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Version does not belong to listing",
      },
    };
  }

  if (purchase.listingVersionId !== version.id) {
    return {
      ok: false,
      error: {
        code: PURCHASE_ERROR_CODES.LINKAGE_MISMATCH,
        message: "Purchase listing version does not match version",
      },
    };
  }

  return { ok: true, value: undefined };
}

function emitTransitionAudit(
  deps: PurchaseDeps,
  event: {
    readonly entityType: MarketplaceAuditEntityType;
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

function createEntitlement(
  tenantId: string,
  principalId: string,
  listingId: UUID,
  packageName: string,
  sourceType: FridayEntitlementSourceType,
  sourceId: UUID,
  expiresAt: ISODateTime | null,
  deps: PurchaseDeps,
): FridayEntitlement {
  const now = deps.now();
  return {
    id: deps.generateId(),
    tenantId,
    principalId,
    listingId,
    packageName,
    sourceType,
    sourceId,
    status: "active",
    grantedAt: now,
    expiresAt,
    gracePeriodEndsAt: null,
    grandfathered: false,
    createdAt: now,
    updatedAt: now,
  };
}
