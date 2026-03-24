/**
 * Marketplace and Commerce — Domain Model and Data Contract.
 *
 * Canonical types for the Friday Marketplace system: listings, pricing plans,
 * subscriptions, entitlements, purchases, refunds, payouts, publishers,
 * billing events, and persistence schema types.
 *
 * @module marketplace/model
 */

// ─── Foundational Value Types (local; mirrors packaging/rules pattern) ───

/** UUID string identifier. */
export type UUID = string;

/** ISO 8601 date-time string. */
export type ISODateTime = string;

/** JSON-safe primitive value. */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** JSON-safe object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

// ─── Money/Currency Primitives ───

/**
 * ISO 4217 currency code (e.g., "USD", "EUR").
 *
 * Nominal/branded string for type safety — prevents accidentally passing
 * a bare string where a currency code is expected.
 */
export type FridayCurrencyCode = string & { readonly __brand?: "FridayCurrencyCode" };

/**
 * Monetary amount in the smallest currency unit (integer cents).
 *
 * Branded number type to distinguish from arbitrary numeric values.
 * Always an integer — no floating-point values.
 */
export type FridayAmountCents = number & { readonly __brand?: "FridayAmountCents" };

/**
 * A monetary amount represented as integer cents with an ISO 4217 currency code.
 *
 * All monetary values in the marketplace domain use this type for consistency.
 * Fee rounding uses banker's rounding (half-even) for deterministic results.
 *
 * @see ADR-001 in marketplace-commerce-rfc.md
 */
export interface FridayMoneyAmount {
  /** Amount in the smallest currency unit (integer cents). */
  readonly amount: FridayAmountCents;
  /** ISO 4217 currency code. */
  readonly currency: FridayCurrencyCode;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING STATUS & LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════

/**
 * All possible listing statuses.
 *
 * State transitions:
 * - draft → review (submit for review)
 * - review → published (approved)
 * - review → draft (rejected)
 * - published → suspended (policy violation / manual)
 * - published → archived (creator withdraws)
 * - suspended → published (reinstated)
 * - suspended → archived (archived while suspended)
 */
export const FRIDAY_LISTING_STATUSES = [
  "draft",
  "review",
  "published",
  "suspended",
  "archived",
] as const;

/** Listing status union type. */
export type FridayListingStatus = (typeof FRIDAY_LISTING_STATUSES)[number];

/** Marketplace asset types that can be listed in MVP. */
export const FRIDAY_MARKETPLACE_ASSET_TYPES = [
  "skill",
  "workflow",
  "agent",
] as const;

/** Marketplace asset type union. */
export type FridayMarketplaceAssetType =
  (typeof FRIDAY_MARKETPLACE_ASSET_TYPES)[number];

/**
 * Valid listing state transitions.
 */
export const FRIDAY_LISTING_STATE_TRANSITIONS: Readonly<
  Record<FridayListingStatus, readonly FridayListingStatus[]>
> = {
  draft: ["review"],
  review: ["published", "draft"],
  published: ["suspended", "archived"],
  suspended: ["published", "archived"],
  archived: [],
} as const;

/**
 * A marketplace listing — the commercial wrapper around a package.
 */
export interface FridayListing {
  /** Unique listing identifier. */
  readonly id: UUID;
  /** Publisher who owns this listing. */
  readonly publisherId: UUID;
  /** URL-friendly unique slug. */
  readonly slug: string;
  /** Current listing status. */
  readonly status: FridayListingStatus;
  /** ID of the currently active listing version. */
  readonly currentVersionId: UUID | null;
  /** ID of a version currently in review (null if none pending). */
  readonly pendingVersionId: UUID | null;
  /** Tenant ID for scoped visibility (null = global). */
  readonly tenantId: string | null;
  /** Searchable tags. */
  readonly tags: readonly string[];
  /** When this listing was created. */
  readonly createdAt: ISODateTime;
  /** When this listing was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING VERSION
// ═══════════════════════════════════════════════════════════════════════

/**
 * All possible listing version statuses (independent of parent listing status).
 *
 * State transitions:
 * - draft → in_review (creator submits version for review)
 * - in_review → approved (reviewer approves; may trigger listing publish)
 * - in_review → rejected (reviewer rejects; creator can edit and resubmit)
 */
export const FRIDAY_LISTING_VERSION_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "rejected",
] as const;

/** Listing version status union type. */
export type FridayListingVersionStatus =
  (typeof FRIDAY_LISTING_VERSION_STATUSES)[number];

/** Distribution mode for a marketplace listing version. */
export const FRIDAY_MARKETPLACE_DISTRIBUTION_MODES = [
  "declarative_public",
  "legacy_executable",
] as const;

export type FridayMarketplaceDistributionMode =
  (typeof FRIDAY_MARKETPLACE_DISTRIBUTION_MODES)[number];

/**
 * Permission manifest attached to a public marketplace asset preview.
 *
 * Public marketplace assets must declare the framework-owned permissions they
 * expect to use before installation/enablement. Legacy executable assets are
 * represented as non-public and are not shown in the ordinary catalog.
 */
export interface FridayMarketplacePermissionManifest {
  readonly permissions: readonly string[];
  readonly requiresExplicitApproval: boolean;
}

/**
 * An immutable content snapshot of a listing at a specific point in time.
 *
 * When a creator edits a published listing, a new version is created;
 * the published version remains live until the new version is approved.
 */
export interface FridayListingVersion {
  /** Unique version identifier. */
  readonly id: UUID;
  /** Parent listing ID. */
  readonly listingId: UUID;
  /** Monotonically increasing version number within the listing. */
  readonly versionNumber: number;
  /** Current version workflow status. */
  readonly status: FridayListingVersionStatus;
  /** Listing title. */
  readonly title: string;
  /** Short description (plain text, ≤ 280 chars). */
  readonly description: string;
  /** Long-form description (Markdown). */
  readonly longDescription: string | null;
  /** Screenshot/image URLs. */
  readonly screenshotUrls: readonly string[];
  /** Referenced package name from the PKG registry. */
  readonly packageName: string;
  /** Referenced package version from the PKG registry. */
  readonly packageVersion: string;
  /** Asset type exposed by this listing version. */
  readonly assetType: FridayMarketplaceAssetType;
  /** Whether this version is public declarative content or a legacy executable package. */
  readonly distributionMode: FridayMarketplaceDistributionMode;
  /** Public permission preview shown before install/enable. */
  readonly permissionManifest: FridayMarketplacePermissionManifest;
  /** Pricing plan snapshot at time of version creation. */
  readonly pricingPlan: FridayPricingPlan;
  /** Release notes for this version. */
  readonly releaseNotes: string | null;
  /** When this version was created. */
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING REVIEW
// ═══════════════════════════════════════════════════════════════════════

/** Possible review decisions. */
export const FRIDAY_LISTING_REVIEW_DECISIONS = [
  "approved",
  "rejected",
] as const;

/** Review decision union type. */
export type FridayListingReviewDecision =
  (typeof FRIDAY_LISTING_REVIEW_DECISIONS)[number];

/**
 * A review record for a listing version.
 */
export interface FridayListingReview {
  /** Unique review identifier. */
  readonly id: UUID;
  /** Listing being reviewed. */
  readonly listingId: UUID;
  /** Specific version being reviewed. */
  readonly versionId: UUID;
  /** Principal ID of the reviewer. */
  readonly reviewerId: string;
  /** Review decision. */
  readonly decision: FridayListingReviewDecision;
  /** Reviewer notes / feedback. */
  readonly notes: string | null;
  /** When the review was submitted. */
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PRICING PLANS (Discriminated Union)
// ═══════════════════════════════════════════════════════════════════════

/** All supported pricing plan types. */
export const FRIDAY_PRICING_PLAN_TYPES = [
  "free",
  "one_time",
  "subscription",
  "usage_based",
] as const;

/** Pricing plan type union. */
export type FridayPricingPlanType = (typeof FRIDAY_PRICING_PLAN_TYPES)[number];

/**
 * Pricing plan types allowed by the current marketplace MVP runtime profile.
 *
 * Non-MVP types remain in the domain model for forward compatibility but are
 * rejected by runtime validation in marketplace engines/routes.
 */
export const FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES = [
  "free",
  "one_time",
] as const;

/** Pricing plan type union allowed by MVP runtime profile. */
export type FridayMvpAllowedPricingPlanType =
  (typeof FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES)[number];

/** Free pricing plan — no charge, entitlement granted immediately. */
export interface FridayFreePricingPlan {
  readonly type: "free";
}

/** One-time purchase pricing plan — single payment, perpetual access. */
export interface FridayOneTimePricingPlan {
  readonly type: "one_time";
  /** Price as a structured money amount. */
  readonly price: FridayMoneyAmount;
}

/** Subscription pricing plan — recurring payment. */
export interface FridaySubscriptionPricingPlan {
  readonly type: "subscription";
  /** Billing interval in months (1 = monthly, 12 = yearly). */
  readonly intervalMonths: 1 | 12;
  /** Price per interval as a structured money amount. */
  readonly price: FridayMoneyAmount;
  /** Free trial period in days (0 = no trial). */
  readonly trialDays: number;
}

/**
 * A graduated pricing tier for usage-based plans.
 */
export interface FridayPricingTier {
  /** Upper bound of this tier (null = unbounded / final tier). */
  readonly upToUnits: number | null;
  /** Price per unit in cents for this tier. */
  readonly pricePerUnitCents: number;
}

/** Usage-based pricing plan — pay-per-use with graduated tiers. */
export interface FridayUsageBasedPricingPlan {
  readonly type: "usage_based";
  /** Human-readable label for the metered unit (e.g., "API call", "minute"). */
  readonly unitLabel: string;
  /** Graduated pricing tiers (ordered by upToUnits ascending). */
  readonly tiers: readonly FridayPricingTier[];
  /** ISO 4217 currency code. */
  readonly currency: FridayCurrencyCode;
}

/**
 * Pricing plan discriminated union.
 *
 * Keyed on `type` field. Each variant carries only fields relevant
 * to that pricing model.
 */
export type FridayPricingPlan =
  | FridayFreePricingPlan
  | FridayOneTimePricingPlan
  | FridaySubscriptionPricingPlan
  | FridayUsageBasedPricingPlan;

/**
 * A persisted pricing plan record attached to a listing.
 */
export interface FridayPricingPlanRecord {
  /** Unique plan identifier. */
  readonly id: UUID;
  /** Listing this plan belongs to. */
  readonly listingId: UUID;
  /** Plan configuration (discriminated union). */
  readonly plan: FridayPricingPlan;
  /** Whether this plan is currently active. */
  readonly isActive: boolean;
  /** When this plan was created. */
  readonly createdAt: ISODateTime;
  /** When this plan was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════

/** All possible subscription statuses. */
export const FRIDAY_SUBSCRIPTION_STATUSES = [
  "active",
  "past_due",
  "paused",
  "cancelled",
  "expired",
] as const;

/** Subscription status union type. */
export type FridaySubscriptionStatus =
  (typeof FRIDAY_SUBSCRIPTION_STATUSES)[number];

/**
 * A subscription record linking a buyer to a listing via a recurring payment.
 */
export interface FridaySubscription {
  /** Unique subscription identifier. */
  readonly id: UUID;
  /** Purchase that initiated this subscription. */
  readonly purchaseId: UUID;
  /** Buyer's tenant ID. */
  readonly buyerTenantId: string;
  /** Buyer's principal ID. */
  readonly buyerPrincipalId: string;
  /** Listing being subscribed to. */
  readonly listingId: UUID;
  /** Pricing plan driving this subscription. */
  readonly pricingPlanId: UUID;
  /** Current subscription status. */
  readonly status: FridaySubscriptionStatus;
  /** Start of the current billing period. */
  readonly currentPeriodStart: ISODateTime;
  /** End of the current billing period. */
  readonly currentPeriodEnd: ISODateTime;
  /** Whether to cancel at the end of the current period. */
  readonly cancelAtPeriodEnd: boolean;
  /** When the subscription was cancelled (null if not cancelled). */
  readonly cancelledAt: ISODateTime | null;
  /** External billing provider subscription ID. */
  readonly externalSubscriptionId: string | null;
  /** When the trial ends (null if no trial). */
  readonly trialEndsAt: ISODateTime | null;
  /** When this subscription was created. */
  readonly createdAt: ISODateTime;
  /** When this subscription was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// ENTITLEMENTS
// ═══════════════════════════════════════════════════════════════════════

/** All possible entitlement statuses. */
export const FRIDAY_ENTITLEMENT_STATUSES = [
  "active",
  "grace",
  "suspended",
  "revoked",
  "expired",
] as const;

/** Entitlement status union type. */
export type FridayEntitlementStatus =
  (typeof FRIDAY_ENTITLEMENT_STATUSES)[number];

/** Source types that can grant an entitlement. */
export const FRIDAY_ENTITLEMENT_SOURCE_TYPES = [
  "purchase",
  "subscription",
  "grant",
  "trial",
] as const;

/** Entitlement source type union. */
export type FridayEntitlementSourceType =
  (typeof FRIDAY_ENTITLEMENT_SOURCE_TYPES)[number];

/**
 * An entitlement granting a tenant/principal access to a listing's package.
 */
export interface FridayEntitlement {
  /** Unique entitlement identifier. */
  readonly id: UUID;
  /** Tenant that holds this entitlement. */
  readonly tenantId: string;
  /** Principal that holds this entitlement. */
  readonly principalId: string;
  /** Listing this entitlement grants access to. */
  readonly listingId: UUID;
  /** Package name this entitlement covers. */
  readonly packageName: string;
  /** How this entitlement was created. */
  readonly sourceType: FridayEntitlementSourceType;
  /** ID of the source entity (purchase, subscription, or admin grant). */
  readonly sourceId: UUID;
  /** Current entitlement status. */
  readonly status: FridayEntitlementStatus;
  /** When this entitlement was granted. */
  readonly grantedAt: ISODateTime;
  /** When this entitlement expires (null = never). */
  readonly expiresAt: ISODateTime | null;
  /** When the grace period ends (null if not in grace). */
  readonly gracePeriodEndsAt: ISODateTime | null;
  /** Whether this entitlement was grandfathered (e.g., free-to-paid conversion). */
  readonly grandfathered: boolean;
  /** When this entitlement record was created. */
  readonly createdAt: ISODateTime;
  /** When this entitlement record was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * Result of an entitlement check.
 */
export interface FridayEntitlementCheck {
  /** Whether the principal is entitled to use the package. */
  readonly entitled: boolean;
  /** Reason for the entitlement status. */
  readonly reason:
    | "active"
    | "grace_period"
    | "no_entitlement"
    | "expired"
    | "suspended"
    | "revoked";
  /** Entitlement ID (null if no entitlement found). */
  readonly entitlementId: UUID | null;
  /** When the entitlement expires (null = never or no entitlement). */
  readonly expiresAt: ISODateTime | null;
  /** When the grace period ends (null if not in grace). */
  readonly gracePeriodEndsAt: ISODateTime | null;
}

// ═══════════════════════════════════════════════════════════════════════
// PURCHASES
// ═══════════════════════════════════════════════════════════════════════

/** All possible purchase statuses. */
export const FRIDAY_PURCHASE_STATUSES = [
  "pending",
  "completed",
  "failed",
  "refunded",
  "disputed",
] as const;

/** Purchase status union type. */
export type FridayPurchaseStatus = (typeof FRIDAY_PURCHASE_STATUSES)[number];

/**
 * A purchase record representing a buyer acquiring a listing.
 */
export interface FridayPurchase {
  /** Unique purchase identifier. */
  readonly id: UUID;
  /** Buyer's tenant ID. */
  readonly buyerTenantId: string;
  /** Buyer's principal ID. */
  readonly buyerPrincipalId: string;
  /** Listing being purchased. */
  readonly listingId: UUID;
  /** Listing version at time of purchase. */
  readonly listingVersionId: UUID;
  /** Pricing plan used for this purchase. */
  readonly pricingPlanId: UUID;
  /** Current purchase status. */
  readonly status: FridayPurchaseStatus;
  /** Amount charged. */
  readonly amount: FridayMoneyAmount;
  /** External billing provider payment ID. */
  readonly externalPaymentId: string | null;
  /** Idempotency key for this purchase. */
  readonly idempotencyKey: string | null;
  /** When the purchase was completed. */
  readonly completedAt: ISODateTime | null;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════════════════════════════

/** All possible refund statuses. */
export const FRIDAY_REFUND_STATUSES = [
  "pending",
  "completed",
  "failed",
] as const;

/** Refund status union type. */
export type FridayRefundStatus = (typeof FRIDAY_REFUND_STATUSES)[number];

/**
 * A refund record for a purchase.
 */
export interface FridayRefund {
  /** Unique refund identifier. */
  readonly id: UUID;
  /** Purchase being refunded. */
  readonly purchaseId: UUID;
  /** Refund amount. */
  readonly amount: FridayMoneyAmount;
  /** Reason for the refund. */
  readonly reason: string;
  /** Current refund status. */
  readonly status: FridayRefundStatus;
  /** External billing provider refund ID. */
  readonly externalRefundId: string | null;
  /** Principal who initiated the refund. */
  readonly initiatedBy: string;
  /** When the refund was created. */
  readonly createdAt: ISODateTime;
  /** When the refund was completed (or failed). */
  readonly completedAt: ISODateTime | null;
}

// ═══════════════════════════════════════════════════════════════════════
// PAYOUTS
// ═══════════════════════════════════════════════════════════════════════

/** All possible payout entry statuses (includes `clawed_back` for refund/chargeback clawbacks). */
export const FRIDAY_PAYOUT_ENTRY_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "clawed_back",
] as const;

/** Payout entry status union type. */
export type FridayPayoutEntryStatus =
  (typeof FRIDAY_PAYOUT_ENTRY_STATUSES)[number];

/** All possible payout batch statuses (no `clawed_back` — batches are not individually clawed back). */
export const FRIDAY_PAYOUT_BATCH_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

/** Payout batch status union type. */
export type FridayPayoutBatchStatus =
  (typeof FRIDAY_PAYOUT_BATCH_STATUSES)[number];

/**
 * @deprecated Use `FridayPayoutEntryStatus` or `FridayPayoutBatchStatus` instead.
 * Kept for backward compatibility.
 */
export type FridayPayoutStatus = FridayPayoutEntryStatus;

/**
 * @deprecated Use `FRIDAY_PAYOUT_ENTRY_STATUSES` or `FRIDAY_PAYOUT_BATCH_STATUSES` instead.
 * Kept for backward compatibility.
 */
export const FRIDAY_PAYOUT_STATUSES = FRIDAY_PAYOUT_ENTRY_STATUSES;

/**
 * A single payout ledger entry — records earnings from one transaction.
 */
export interface FridayPayoutEntry {
  /** Unique payout entry identifier. */
  readonly id: UUID;
  /** Publisher who earned this payout. */
  readonly publisherId: UUID;
  /** Purchase that generated this earning. */
  readonly purchaseId: UUID;
  /** Listing that was purchased. */
  readonly listingId: UUID;
  /** Total amount charged to the buyer. */
  readonly grossAmount: FridayMoneyAmount;
  /** Platform fee deducted. */
  readonly platformFee: FridayMoneyAmount;
  /** Net amount payable to the creator. */
  readonly netAmount: FridayMoneyAmount;
  /** Tax withholding amount. */
  readonly taxWithholding: FridayMoneyAmount;
  /** Payout batch this entry belongs to (null if not yet batched). */
  readonly payoutBatchId: UUID | null;
  /** Current payout entry status. */
  readonly status: FridayPayoutEntryStatus;
  /** When this entry was created. */
  readonly createdAt: ISODateTime;
  /** When this entry was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * A payout batch aggregating pending entries for a publisher.
 */
export interface FridayPayoutBatch {
  /** Unique batch identifier. */
  readonly id: UUID;
  /** Publisher this batch pays out to. */
  readonly publisherId: UUID;
  /** Current batch status. */
  readonly status: FridayPayoutBatchStatus;
  /** Total amount in this batch (sum of net amounts). */
  readonly totalAmount: FridayMoneyAmount;
  /** Number of payout entries in this batch. */
  readonly entryCount: number;
  /** Start of the earnings period covered by this batch. */
  readonly periodStart: ISODateTime;
  /** End of the earnings period covered by this batch. */
  readonly periodEnd: ISODateTime;
  /** External billing provider payout ID. */
  readonly externalPayoutId: string | null;
  /** When this batch was initiated. */
  readonly initiatedAt: ISODateTime;
  /** When this batch was completed (or failed). */
  readonly completedAt: ISODateTime | null;
  /** Reason for failure (if status is failed). */
  readonly failedReason: string | null;
}

/**
 * Summary of a publisher's earnings.
 */
export interface FridayEarningsSummary {
  /** Publisher ID. */
  readonly publisherId: UUID;
  /** Total gross earnings (all time). */
  readonly totalGross: FridayMoneyAmount;
  /** Total platform fees (all time). */
  readonly totalPlatformFee: FridayMoneyAmount;
  /** Total net earnings (all time). */
  readonly totalNet: FridayMoneyAmount;
  /** Total tax withheld (all time). */
  readonly totalTaxWithheld: FridayMoneyAmount;
  /** Total paid out (all completed batches). */
  readonly totalPaidOut: FridayMoneyAmount;
  /** Amount pending payout (not yet batched or in pending batch). */
  readonly pendingPayout: FridayMoneyAmount;
  /** As of this timestamp. */
  readonly asOf: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLISHER
// ═══════════════════════════════════════════════════════════════════════

/** All possible publisher verification statuses. */
export const FRIDAY_PUBLISHER_VERIFICATION_STATUSES = [
  "unverified",
  "pending",
  "verified",
  "suspended",
] as const;

/** Publisher verification status union type. */
export type FridayPublisherVerificationStatus =
  (typeof FRIDAY_PUBLISHER_VERIFICATION_STATUSES)[number];

/**
 * A marketplace publisher — the commercial identity of a creator.
 */
export interface FridayPublisher {
  /** Unique publisher identifier. */
  readonly id: UUID;
  /** Tenant ID this publisher belongs to. */
  readonly tenantId: string;
  /** Principal ID of the publisher. */
  readonly principalId: string;
  /** Display name. */
  readonly displayName: string;
  /** Short bio. */
  readonly bio: string | null;
  /** Avatar image URL. */
  readonly avatarUrl: string | null;
  /** Website URL. */
  readonly websiteUrl: string | null;
  /** Verified contact email. */
  readonly contactEmail: string;
  /** Current verification status. */
  readonly verificationStatus: FridayPublisherVerificationStatus;
  /** Legal entity name (for tax/payout). */
  readonly legalName: string | null;
  /** Last 4 digits of tax ID (display only; full ID encrypted at rest). */
  readonly taxIdLast4: string | null;
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string | null;
  /** Payout method identifier (e.g., "bank_transfer", "paypal"). */
  readonly payoutMethod: string | null;
  /** Platform fee in basis points (0 = zero-commission public support model). */
  readonly platformFeeBps: number;
  /** When this publisher profile was created. */
  readonly createdAt: ISODateTime;
  /** When this publisher profile was last updated. */
  readonly updatedAt: ISODateTime;
}

/**
 * Publisher verification details submitted for review.
 */
export interface FridayPublisherVerification {
  /** Publisher ID. */
  readonly publisherId: UUID;
  /** Legal entity name. */
  readonly legalName: string;
  /** Tax identification number (last 4 digits only for display). */
  readonly taxIdLast4: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly country: string;
  /** Payout method. */
  readonly payoutMethod: string;
  /** When the verification was submitted. */
  readonly submittedAt: ISODateTime;
  /** Current verification status. */
  readonly status: FridayPublisherVerificationStatus;
  /** Reviewer notes (set on approval/rejection). */
  readonly reviewerNotes: string | null;
  /** When the verification was reviewed. */
  readonly reviewedAt: ISODateTime | null;
}

// ═══════════════════════════════════════════════════════════════════════
// BILLING EVENTS
// ═══════════════════════════════════════════════════════════════════════

/** All supported billing event types. */
export const FRIDAY_BILLING_EVENT_TYPES = [
  "checkout.completed",
  "checkout.abandoned",
  "payment.succeeded",
  "payment.failed",
  "subscription.created",
  "subscription.renewed",
  "subscription.cancelled",
  "subscription.paused",
  "subscription.resumed",
  "refund.initiated",
  "refund.completed",
  "chargeback.opened",
  "chargeback.won",
  "chargeback.lost",
  "payout.initiated",
  "payout.completed",
  "payout.failed",
] as const;

/** Billing event type union. */
export type FridayBillingEventType =
  (typeof FRIDAY_BILLING_EVENT_TYPES)[number];

/** Source of a billing event. */
export const FRIDAY_BILLING_EVENT_SOURCES = [
  "internal",
  "webhook",
] as const;

/** Billing event source union. */
export type FridayBillingEventSource =
  (typeof FRIDAY_BILLING_EVENT_SOURCES)[number];

/**
 * A billing event record capturing a state change in the billing system.
 */
export interface FridayBillingEvent {
  /** Unique event identifier. */
  readonly id: UUID;
  /** Event type. */
  readonly eventType: FridayBillingEventType;
  /** Where this event originated. */
  readonly source: FridayBillingEventSource;
  /** Type of entity this event references (e.g., "purchase", "subscription"). */
  readonly referenceType: string | null;
  /** ID of the referenced entity. */
  readonly referenceId: UUID | null;
  /** Event payload (structured data). */
  readonly payload: JsonObject;
  /** Whether this event has been processed. */
  readonly processed: boolean;
  /** When this event was created. */
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// BILLING WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════

/** All possible webhook processing statuses. */
export const FRIDAY_BILLING_WEBHOOK_STATUSES = [
  "received",
  "processing",
  "processed",
  "failed",
] as const;

/** Webhook status union type. */
export type FridayBillingWebhookStatus =
  (typeof FRIDAY_BILLING_WEBHOOK_STATUSES)[number];

/**
 * A received billing webhook from an external provider.
 */
export interface FridayBillingWebhook {
  /** Unique webhook record identifier. */
  readonly id: UUID;
  /** Billing provider name (e.g., "stripe"). */
  readonly provider: string;
  /** External event ID from the provider (for deduplication). */
  readonly externalId: string;
  /** Provider event type string. */
  readonly eventType: string;
  /** Raw webhook payload. */
  readonly payload: JsonObject;
  /** Webhook signature for verification. */
  readonly signature: string;
  /** Processing status. */
  readonly status: FridayBillingWebhookStatus;
  /** Number of processing attempts. */
  readonly attempts: number;
  /** Last processing error message. */
  readonly lastError: string | null;
  /** When the webhook was received. */
  readonly receivedAt: ISODateTime;
  /** When the webhook was successfully processed. */
  readonly processedAt: ISODateTime | null;
}

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT METHODS
// ═══════════════════════════════════════════════════════════════════════

/** Supported payment method types. */
export const FRIDAY_PAYMENT_METHOD_TYPES = [
  "card",
  "bank_account",
  "external",
] as const;

/** Payment method type union. */
export type FridayPaymentMethodType =
  (typeof FRIDAY_PAYMENT_METHOD_TYPES)[number];

/**
 * A stored payment method for a buyer.
 */
export interface FridayPaymentMethod {
  /** Unique payment method identifier. */
  readonly id: UUID;
  /** Tenant that owns this payment method. */
  readonly tenantId: string;
  /** Principal that owns this payment method. */
  readonly principalId: string;
  /** Payment method type. */
  readonly type: FridayPaymentMethodType;
  /** Billing provider name. */
  readonly provider: string;
  /** External payment method ID from the provider. */
  readonly externalMethodId: string;
  /** Human-readable display label (e.g., "Visa •••• 4242"). */
  readonly displayLabel: string;
  /** Whether this is the default payment method. */
  readonly isDefault: boolean;
  /** When this payment method expires (null = no expiry). */
  readonly expiresAt: ISODateTime | null;
  /** When this record was created. */
  readonly createdAt: ISODateTime;
  /** When this record was last updated. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALLATIONS (MVP DELIVERY TRACKING)
// ═══════════════════════════════════════════════════════════════════════

/** Installation status for marketplace assets in buyer environment. */
export const FRIDAY_INSTALLATION_STATUSES = [
  "installing",
  "installed",
  "failed",
] as const;

/** Installation status union type. */
export type FridayInstallationStatus =
  (typeof FRIDAY_INSTALLATION_STATUSES)[number];

/** A buyer installation record for a marketplace listing asset. */
export interface FridayInstallation {
  /** Unique installation identifier. */
  readonly id: UUID;
  /** Buyer tenant ID. */
  readonly tenantId: string;
  /** Buyer principal ID who triggered installation. */
  readonly principalId: string;
  /** Listing being installed. */
  readonly listingId: UUID;
  /** Asset type being installed. */
  readonly assetType: FridayMarketplaceAssetType;
  /** Package name resolved from listing version. */
  readonly packageName: string;
  /** Package version resolved from listing version. */
  readonly packageVersion: string;
  /** Current installation status. */
  readonly status: FridayInstallationStatus;
  /** Last installation error (if failed). */
  readonly lastError: string | null;
  /** Timestamp of successful installation (null until installed). */
  readonly installedAt: ISODateTime | null;
  /** Record creation timestamp. */
  readonly createdAt: ISODateTime;
  /** Record update timestamp. */
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATOR SUPPORT / REPUTATION
// ═══════════════════════════════════════════════════════════════════════

/** A user-to-creator support event for a public marketplace asset. */
export interface FridaySupportEvent {
  /** Unique support event identifier. */
  readonly id: UUID;
  /** Creator receiving the support. */
  readonly creatorId: string;
  /** Asset being supported. */
  readonly assetId: string;
  /** Asset type receiving support. */
  readonly assetType: FridayMarketplaceAssetType;
  /** Supporting tenant ID. */
  readonly supporterTenantId: string;
  /** Supporting principal ID. */
  readonly supporterPrincipalId: string;
  /** Support amount. */
  readonly amount: FridayMoneyAmount;
  /** Optional supporter message. */
  readonly message: string | null;
  /** Creation timestamp. */
  readonly createdAt: ISODateTime;
}

/** Authenticated marketplace actor context used for request/support isolation. */
export interface MarketplaceActorContext {
  readonly tenantId: string;
  readonly principalId: string;
}

/** Multi-signal creator reputation summary shown in the public marketplace. */
export interface FridayCreatorReputationSummary {
  /** Aggregate score used for ranking. */
  readonly overallScore: number;
  /** Optional user-facing rating average. */
  readonly ratingAverage: number | null;
  /** Number of rating submissions if present. */
  readonly ratingCount: number;
  /** Number of support events. */
  readonly supportCount: number;
  /** Total support amount. */
  readonly supportTotal: FridayMoneyAmount;
  /** Number of installs across public assets. */
  readonly installCount: number;
  /** Count of assets with verified state. */
  readonly verifiedAssetCount: number;
  /** Success ratio derived from verification/runtime health. */
  readonly verificationSuccessRate: number | null;
  /** Lower permissions, higher trust. */
  readonly permissionRestraintScore: number;
  /** Number of fulfilled requests attributed to the creator. */
  readonly fulfilledRequestCount: number;
  /** Proof-of-use weighted score averaged across public assets. */
  readonly proofOfUseScore: number;
  /** Average repeat-use signal across assets (0..1). */
  readonly repeatRunRate: number;
  /** Average reliability score across assets (0..100). */
  readonly outcomeReliabilityScore: number;
  /** Average permission-efficiency score across assets (0..100). */
  readonly permissionEfficiencyScore: number;
  /** Average request-fulfillment rate across assets (0..1). */
  readonly requestFulfillmentRate: number;
  /** Average maintenance responsiveness across assets (0..100). */
  readonly maintenanceResponsivenessScore: number;
}

/** A public creator profile in the skills-first marketplace. */
export interface FridayCreatorProfile {
  /** Stable creator identifier. */
  readonly id: string;
  /** Preferred display name. */
  readonly displayName: string;
  /** Optional bio shown on the creator page. */
  readonly bio: string | null;
  /** Optional avatar URL. */
  readonly avatarUrl: string | null;
  /** Optional website URL. */
  readonly websiteUrl: string | null;
  /** Assets attributed to this creator. */
  readonly assetIds: readonly string[];
  /** Reputation summary. */
  readonly reputation: FridayCreatorReputationSummary;
  /** Whether this creator is backed by a verified publisher profile. */
  readonly verifiedPublisher: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// REQUEST BOARD
// ═══════════════════════════════════════════════════════════════════════

/** Public request board asset kinds. */
export const FRIDAY_MARKETPLACE_REQUEST_ASSET_KINDS = [
  "skill",
  "workflow",
  "agent",
] as const;

export type FridayMarketplaceRequestAssetKind =
  (typeof FRIDAY_MARKETPLACE_REQUEST_ASSET_KINDS)[number];

/** Request visibility model for the public request board. */
export const FRIDAY_MARKETPLACE_REQUEST_PRIVACY_MODES = [
  "public",
  "private",
] as const;

export type FridayMarketplaceRequestPrivacyMode =
  (typeof FRIDAY_MARKETPLACE_REQUEST_PRIVACY_MODES)[number];

/** Whether a fulfilled request may be turned into a public asset later. */
export const FRIDAY_MARKETPLACE_REQUEST_PUBLISHABILITY = [
  "private_only",
  "allow_publication",
] as const;

export type FridayMarketplaceRequestPublishability =
  (typeof FRIDAY_MARKETPLACE_REQUEST_PUBLISHABILITY)[number];

/** Request lifecycle states for connector-only marketplace requests. */
export const FRIDAY_MARKETPLACE_REQUEST_STATUSES = [
  "open",
  "in_discussion",
  "submitted",
  "accepted",
  "closed",
] as const;

export type FridayMarketplaceRequestStatus =
  (typeof FRIDAY_MARKETPLACE_REQUEST_STATUSES)[number];

/** A user-authored request for a personal skill, workflow, or agent. */
export interface FridayMarketplaceRequestPost {
  readonly id: UUID;
  readonly assetKind: FridayMarketplaceRequestAssetKind;
  readonly requesterTenantId: string;
  readonly requesterPrincipalId: string;
  readonly title: string;
  readonly goal: string;
  readonly desiredOutcome: string;
  readonly constraints: readonly string[];
  readonly budgetSupportIntent: string | null;
  readonly privacy: FridayMarketplaceRequestPrivacyMode;
  readonly publishability: FridayMarketplaceRequestPublishability;
  readonly riskNotes: string | null;
  readonly status: FridayMarketplaceRequestStatus;
  readonly acceptedResponseId: UUID | null;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly closedAt: ISODateTime | null;
}

/** A response/proposal against a public request board post. */
export interface FridayMarketplaceRequestResponse {
  readonly id: UUID;
  readonly requestId: UUID;
  readonly responderTenantId: string;
  readonly responderPrincipalId: string;
  readonly responderCreatorId: string | null;
  readonly message: string;
  readonly proposal: string | null;
  readonly deliverableAssetId: string | null;
  readonly createdAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PERSISTENCE ROW TYPES (SQLite)
// ═══════════════════════════════════════════════════════════════════════

/** SQLite row shape for the `marketplace_publishers` table. */
export interface FridayPublisherRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly display_name: string;
  readonly bio: string | null;
  readonly avatar_url: string | null;
  readonly website_url: string | null;
  readonly contact_email: string;
  readonly verification_status: string;
  readonly legal_name: string | null;
  readonly tax_id_last4: string | null;
  readonly country: string | null;
  readonly payout_method: string | null;
  readonly platform_fee_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for `marketplace_support_events`. */
export interface FridaySupportEventRow {
  readonly id: string;
  readonly creator_id: string;
  readonly asset_id: string;
  readonly asset_type: string;
  readonly supporter_tenant_id: string;
  readonly supporter_principal_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly message: string | null;
  readonly created_at: string;
  readonly actor_schema_version: number;
  readonly actor_quarantined: number;
  readonly actor_quarantine_reason: string | null;
}

/** SQLite row shape for `marketplace_requests`. */
export interface FridayMarketplaceRequestRow {
  readonly id: string;
  readonly asset_kind: string;
  readonly requester_tenant_id: string;
  readonly requester_principal_id: string;
  readonly title: string;
  readonly goal: string;
  readonly desired_outcome: string;
  readonly constraints_json: string;
  readonly budget_support_intent: string | null;
  readonly privacy: string;
  readonly publishability: string;
  readonly risk_notes: string | null;
  readonly status: string;
  readonly accepted_response_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly actor_schema_version: number;
  readonly actor_quarantined: number;
  readonly actor_quarantine_reason: string | null;
}

/** SQLite row shape for `marketplace_request_responses`. */
export interface FridayMarketplaceRequestResponseRow {
  readonly id: string;
  readonly request_id: string;
  readonly responder_tenant_id: string;
  readonly responder_principal_id: string;
  readonly responder_creator_id: string | null;
  readonly message: string;
  readonly proposal: string | null;
  readonly deliverable_asset_id: string | null;
  readonly created_at: string;
  readonly actor_schema_version: number;
  readonly actor_quarantined: number;
  readonly actor_quarantine_reason: string | null;
}

/** SQLite row shape for the `marketplace_listings` table. */
export interface FridayListingRow {
  readonly id: string;
  readonly publisher_id: string;
  readonly slug: string;
  readonly status: string;
  readonly current_version_id: string | null;
  readonly pending_version_id: string | null;
  readonly tenant_id: string | null;
  readonly tags_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_listing_versions` table. */
export interface FridayListingVersionRow {
  readonly id: string;
  readonly listing_id: string;
  readonly version_number: number;
  readonly status: string;
  readonly title: string;
  readonly description: string;
  readonly long_description: string | null;
  readonly screenshot_urls_json: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly asset_type: string;
  readonly distribution_mode: string;
  readonly permission_manifest_json: string;
  readonly pricing_plan_json: string;
  readonly release_notes: string | null;
  readonly created_at: string;
}

/** SQLite row shape for the `marketplace_listing_reviews` table. */
export interface FridayListingReviewRow {
  readonly id: string;
  readonly listing_id: string;
  readonly version_id: string;
  readonly reviewer_id: string;
  readonly decision: string;
  readonly notes: string | null;
  readonly created_at: string;
}

/** SQLite row shape for the `marketplace_pricing_plans` table. */
export interface FridayPricingPlanRow {
  readonly id: string;
  readonly listing_id: string;
  readonly type: string;
  readonly currency: string | null;
  readonly price_amount_cents: number | null;
  readonly interval_months: number | null;
  readonly trial_days: number | null;
  readonly unit_label: string | null;
  readonly tiers_json: string | null;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_purchases` table. */
export interface FridayPurchaseRow {
  readonly id: string;
  readonly buyer_tenant_id: string;
  readonly buyer_principal_id: string;
  readonly listing_id: string;
  readonly listing_version_id: string;
  readonly pricing_plan_id: string;
  readonly status: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly external_payment_id: string | null;
  readonly idempotency_key: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_subscriptions` table. */
export interface FridaySubscriptionRow {
  readonly id: string;
  readonly purchase_id: string;
  readonly buyer_tenant_id: string;
  readonly buyer_principal_id: string;
  readonly listing_id: string;
  readonly pricing_plan_id: string;
  readonly status: string;
  readonly current_period_start: string;
  readonly current_period_end: string;
  readonly cancel_at_period_end: number;
  readonly cancelled_at: string | null;
  readonly external_subscription_id: string | null;
  readonly trial_ends_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_entitlements` table. */
export interface FridayEntitlementRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly listing_id: string;
  readonly package_name: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly status: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly grace_period_ends_at: string | null;
  readonly grandfathered: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_refunds` table. */
export interface FridayRefundRow {
  readonly id: string;
  readonly purchase_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly external_refund_id: string | null;
  readonly initiated_by: string;
  readonly created_at: string;
  readonly completed_at: string | null;
}

/** SQLite row shape for the `marketplace_payout_entries` table. */
export interface FridayPayoutEntryRow {
  readonly id: string;
  readonly publisher_id: string;
  readonly purchase_id: string;
  readonly listing_id: string;
  readonly gross_amount_cents: number;
  readonly platform_fee_cents: number;
  readonly net_amount_cents: number;
  readonly tax_withholding_cents: number;
  readonly currency: string;
  readonly payout_batch_id: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_payout_batches` table. */
export interface FridayPayoutBatchRow {
  readonly id: string;
  readonly publisher_id: string;
  readonly status: string;
  readonly total_amount_cents: number;
  readonly currency: string;
  readonly entry_count: number;
  readonly period_start: string;
  readonly period_end: string;
  readonly external_payout_id: string | null;
  readonly initiated_at: string;
  readonly completed_at: string | null;
  readonly failed_reason: string | null;
}

/** SQLite row shape for the `marketplace_billing_events` table. */
export interface FridayBillingEventRow {
  readonly id: string;
  readonly event_type: string;
  readonly source: string;
  readonly reference_type: string | null;
  readonly reference_id: string | null;
  readonly payload_json: string;
  readonly processed: number;
  readonly created_at: string;
}

/** SQLite row shape for the `marketplace_billing_webhooks` table. */
export interface FridayBillingWebhookRow {
  readonly id: string;
  readonly provider: string;
  readonly external_id: string;
  readonly event_type: string;
  readonly payload_json: string;
  readonly signature: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly received_at: string;
  readonly processed_at: string | null;
}

/** SQLite row shape for the `marketplace_payment_methods` table. */
export interface FridayPaymentMethodRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly type: string;
  readonly provider: string;
  readonly external_method_id: string;
  readonly display_label: string;
  readonly is_default: number;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_installations` table. */
export interface FridayInstallationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly listing_id: string;
  readonly asset_type: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly status: string;
  readonly last_error: string | null;
  readonly installed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** SQLite row shape for the `marketplace_idempotency_keys` table. */
export interface FridayMarketplaceIdempotencyKeyRow {
  readonly principal_id: string;
  readonly operation: string;
  readonly key: string;
  readonly payload_hash: string;
  readonly response_json: string;
  readonly created_at: string;
  readonly expires_at: string;
}

// ═══════════════════════════════════════════════════════════════════════
// BILLING PROVIDER ABSTRACTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parameters for creating a checkout session via the billing provider.
 */
export interface FridayBillingCheckoutParams {
  /** Unique purchase ID for correlation. */
  readonly purchaseId: UUID;
  /** Listing ID being purchased. */
  readonly listingId: UUID;
  /** Pricing plan ID. */
  readonly pricingPlanId: UUID;
  /** Buyer tenant ID. */
  readonly buyerTenantId: string;
  /** Buyer principal ID. */
  readonly buyerPrincipalId: string;
  /** Amount to charge. */
  readonly amount: FridayMoneyAmount;
  /** Optional payment method to use. */
  readonly paymentMethodId?: UUID;
  /** URL to redirect to after successful checkout. */
  readonly successUrl?: string;
  /** URL to redirect to if checkout is cancelled. */
  readonly cancelUrl?: string;
}

/**
 * Result of creating a checkout session.
 */
export interface FridayBillingCheckoutResult {
  /** External checkout session ID from the provider. */
  readonly externalSessionId: string;
  /** URL to redirect the buyer to for payment. */
  readonly checkoutUrl: string;
}

/**
 * Parameters for creating a subscription via the billing provider.
 */
export interface FridayBillingSubscriptionParams {
  /** Unique subscription ID for correlation. */
  readonly subscriptionId: UUID;
  /** Buyer tenant ID. */
  readonly buyerTenantId: string;
  /** Buyer principal ID. */
  readonly buyerPrincipalId: string;
  /** External customer ID (from billing provider). */
  readonly externalCustomerId?: string;
  /** Pricing details. */
  readonly amount: FridayMoneyAmount;
  /** Billing interval in months. */
  readonly intervalMonths: 1 | 12;
  /** Free trial period in days (0 = no trial). */
  readonly trialDays: number;
  /** Payment method to use. */
  readonly paymentMethodId?: UUID;
}

/**
 * Result of creating a subscription with the billing provider.
 */
export interface FridayBillingSubscriptionResult {
  /** External subscription ID from the provider. */
  readonly externalSubscriptionId: string;
  /** Current period start. */
  readonly currentPeriodStart: ISODateTime;
  /** Current period end. */
  readonly currentPeriodEnd: ISODateTime;
  /** External customer ID. */
  readonly externalCustomerId: string;
}

/**
 * Result of processing a refund via the billing provider.
 */
export interface FridayBillingRefundResult {
  /** External refund ID from the provider. */
  readonly externalRefundId: string;
  /** Refund status as reported by the provider. */
  readonly status: "pending" | "completed" | "failed";
  /** Refunded amount. */
  readonly amount: FridayMoneyAmount;
}

/**
 * Result of retrieving a payment method from the billing provider.
 */
export interface FridayBillingPaymentMethodResult {
  /** External payment method ID. */
  readonly externalMethodId: string;
  /** Payment method type. */
  readonly type: FridayPaymentMethodType;
  /** Human-readable display label. */
  readonly displayLabel: string;
  /** When the method expires (null = no expiry). */
  readonly expiresAt: ISODateTime | null;
}

/**
 * Provider-agnostic billing interface.
 *
 * Phase 1 defines the contract; Phase 2 implements concrete adapters (e.g., Stripe).
 * All methods return normalized result types regardless of underlying provider.
 *
 * @see ADR-004 in marketplace-commerce-rfc.md
 */
export interface FridayBillingProvider {
  /** Human-readable provider name (e.g., "stripe", "mock"). */
  readonly name: string;

  /** Creates a checkout session for a one-time purchase. */
  createCheckoutSession(
    params: FridayBillingCheckoutParams,
  ): Promise<FridayBillingCheckoutResult>;

  /** Creates a recurring subscription. */
  createSubscription(
    params: FridayBillingSubscriptionParams,
  ): Promise<FridayBillingSubscriptionResult>;

  /** Cancels an active subscription. */
  cancelSubscription(externalSubscriptionId: string): Promise<void>;

  /** Refunds a payment (partial or full). */
  refundPayment(
    externalPaymentId: string,
    amount?: FridayMoneyAmount,
  ): Promise<FridayBillingRefundResult>;

  /** Retrieves a payment method by external ID. */
  getPaymentMethod(
    externalMethodId: string,
  ): Promise<FridayBillingPaymentMethodResult>;
}

// ─── Row-to-Entity Mapper Signature ───

/** Generic row-to-entity mapper function type. */
export type FridayMarketplaceRowMapper<TRow, TEntity> = (row: TRow) => TEntity;

// ─── Row ↔ Domain Money Mapping Boundaries ───

/**
 * Constructs a `FridayMoneyAmount` from split row-level cents + currency fields.
 *
 * This is the canonical mapping boundary between SQLite row types (which store
 * `amount_cents INTEGER` + `currency TEXT` as separate columns) and domain types
 * (which use the co-located `FridayMoneyAmount` object).
 */
export function fridayMoney(amountCents: number, currency: string): FridayMoneyAmount {
  return {
    amount: amountCents as FridayAmountCents,
    currency: currency as FridayCurrencyCode,
  };
}

/**
 * Extracts the integer-cents value from a `FridayMoneyAmount` for row-level persistence.
 */
export function fridayMoneyCents(money: FridayMoneyAmount): number {
  return money.amount;
}

/**
 * Extracts the currency code string from a `FridayMoneyAmount` for row-level persistence.
 */
export function fridayMoneyCurrency(money: FridayMoneyAmount): string {
  return money.currency;
}
