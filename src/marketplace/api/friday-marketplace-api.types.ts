/**
 * Marketplace and Commerce — API and SDK Contract.
 *
 * Request/response DTOs for the marketplace management REST API.
 * All types follow Friday API conventions: `FridayPage<T>` for pagination,
 * `FridayApiSuccessResponse<T>` / `FridayApiErrorResponse` for responses.
 *
 * @module marketplace/api
 */

import type { FridayPage, FridayPaginationQuery } from "../../api/model/friday-api-common.types.js";

// ═══════════════════════════════════════════════════════════════════════
// API-LOCAL SCALAR TYPES (no domain model imports)
// ═══════════════════════════════════════════════════════════════════════

/** UUID string identifier (API-local). */
type UUID = string;

/** ISO 8601 date-time string (API-local). */
type ISODateTime = string;

/** JSON-safe object (API-local). */
type JsonObject = { readonly [key: string]: unknown };

// ═══════════════════════════════════════════════════════════════════════
// API-LOCAL ENUM-LIKE TYPES (no domain model imports)
// ═══════════════════════════════════════════════════════════════════════

/** Listing status (API-local). */
type FridayListingStatusDto =
  | "draft"
  | "review"
  | "published"
  | "suspended"
  | "archived";

/** Listing version status (API-local). */
type FridayListingVersionStatusDto =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected";

/** Marketplace listing asset type (API-local, MVP profile). */
type FridayMarketplaceAssetTypeDto =
  | "skill"
  | "workflow"
  | "agent";

type FridayMarketplaceDistributionModeDto =
  | "declarative_public"
  | "legacy_executable";

interface FridayMarketplacePermissionManifestDto {
  readonly permissions: readonly string[];
  readonly requiresExplicitApproval: boolean;
}

/** Review decision (API-local). */
type FridayListingReviewDecisionDto = "approved" | "rejected";

/** Pricing plan type (API-local). */
type FridayPricingPlanTypeDto =
  | "free"
  | "one_time";

/** Subscription status (API-local). */
type FridaySubscriptionStatusDto =
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "expired";

/** Entitlement status (API-local). */
type FridayEntitlementStatusDto =
  | "active"
  | "grace"
  | "suspended"
  | "revoked"
  | "expired";

/** Entitlement source type (API-local). */
type FridayEntitlementSourceTypeDto =
  | "purchase"
  | "subscription"
  | "grant"
  | "trial";

/** Purchase status (API-local). */
type FridayPurchaseStatusDto =
  | "pending"
  | "completed"
  | "failed"
  | "refunded"
  | "disputed";

/** Refund status (API-local). */
type FridayRefundStatusDto = "pending" | "completed" | "failed";

/** Payout entry status (API-local; includes `clawed_back`). */
type FridayPayoutEntryStatusDto =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "clawed_back";

/** Payout batch status (API-local; excludes `clawed_back`). */
type FridayPayoutBatchStatusDto =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/** Publisher verification status (API-local). */
type FridayPublisherVerificationStatusDto =
  | "unverified"
  | "pending"
  | "verified"
  | "suspended";

/** Billing event type (API-local). */
type FridayBillingEventTypeDto =
  | "checkout.completed"
  | "checkout.abandoned"
  | "payment.succeeded"
  | "payment.failed"
  | "subscription.created"
  | "subscription.renewed"
  | "subscription.cancelled"
  | "subscription.paused"
  | "subscription.resumed"
  | "refund.initiated"
  | "refund.completed"
  | "chargeback.opened"
  | "chargeback.won"
  | "chargeback.lost"
  | "payout.initiated"
  | "payout.completed"
  | "payout.failed";

/** Payment method type (API-local). */
type FridayPaymentMethodTypeDto = "card" | "bank_account" | "external";

/** Installation status (API-local). */
type FridayInstallationStatusDto = "installing" | "installed" | "failed";

/** ISO 4217 currency code (API-local). */
type FridayCurrencyCodeDto = string;

/**
 * A monetary amount represented as integer cents with an ISO 4217 currency code (API-local).
 *
 * Fee rounding uses banker's rounding (half-even) for deterministic results.
 */
interface FridayMoneyAmountDto {
  /** Amount in the smallest currency unit (integer cents). */
  readonly amount: number;
  /** ISO 4217 currency code. */
  readonly currency: FridayCurrencyCodeDto;
}

// ═══════════════════════════════════════════════════════════════════════
// ERROR CODES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standardised error codes for the marketplace domain.
 *
 * @example
 * ```ts
 * if (error.code === FRIDAY_MARKETPLACE_ERROR_CODES.LISTING_NOT_FOUND) { ... }
 * ```
 */
export const FRIDAY_MARKETPLACE_ERROR_CODES = {
  // ─── Listings ───
  /** The requested listing does not exist. */
  LISTING_NOT_FOUND: "MARKETPLACE_LISTING_NOT_FOUND",
  /** The listing version does not exist. */
  LISTING_VERSION_NOT_FOUND: "MARKETPLACE_LISTING_VERSION_NOT_FOUND",
  /** Invalid listing state transition. */
  LISTING_INVALID_TRANSITION: "MARKETPLACE_LISTING_INVALID_TRANSITION",
  /** The listing slug is already taken. */
  LISTING_SLUG_CONFLICT: "MARKETPLACE_LISTING_SLUG_CONFLICT",
  /** The referenced package does not exist in the PKG registry. */
  PACKAGE_NOT_FOUND: "MARKETPLACE_PACKAGE_NOT_FOUND",
  /** The listing cannot be published (missing required fields, unverified publisher, etc.). */
  LISTING_NOT_PUBLISHABLE: "MARKETPLACE_LISTING_NOT_PUBLISHABLE",

  // ─── Pricing ───
  /** The pricing plan does not exist. */
  PRICING_PLAN_NOT_FOUND: "MARKETPLACE_PRICING_PLAN_NOT_FOUND",
  /** Invalid pricing plan configuration. */
  PRICING_PLAN_INVALID: "MARKETPLACE_PRICING_PLAN_INVALID",

  // ─── Purchases ───
  /** The purchase does not exist. */
  PURCHASE_NOT_FOUND: "MARKETPLACE_PURCHASE_NOT_FOUND",
  /** The purchase has already been completed. */
  PURCHASE_ALREADY_COMPLETED: "MARKETPLACE_PURCHASE_ALREADY_COMPLETED",
  /** The purchase cannot be refunded (e.g., already refunded). */
  PURCHASE_NOT_REFUNDABLE: "MARKETPLACE_PURCHASE_NOT_REFUNDABLE",
  /** The checkout session has expired. */
  CHECKOUT_EXPIRED: "MARKETPLACE_CHECKOUT_EXPIRED",

  // ─── Subscriptions ───
  /** The subscription does not exist. */
  SUBSCRIPTION_NOT_FOUND: "MARKETPLACE_SUBSCRIPTION_NOT_FOUND",
  /** Invalid subscription state transition. */
  SUBSCRIPTION_INVALID_TRANSITION: "MARKETPLACE_SUBSCRIPTION_INVALID_TRANSITION",
  /** The subscription is already cancelled. */
  SUBSCRIPTION_ALREADY_CANCELLED: "MARKETPLACE_SUBSCRIPTION_ALREADY_CANCELLED",

  // ─── Entitlements ───
  /** The entitlement does not exist. */
  ENTITLEMENT_NOT_FOUND: "MARKETPLACE_ENTITLEMENT_NOT_FOUND",
  /** An active entitlement already exists for this tenant/listing. */
  ENTITLEMENT_ALREADY_EXISTS: "MARKETPLACE_ENTITLEMENT_ALREADY_EXISTS",

  // ─── Payouts ───
  /** The payout batch does not exist. */
  PAYOUT_BATCH_NOT_FOUND: "MARKETPLACE_PAYOUT_BATCH_NOT_FOUND",
  /** The publisher's balance is below the minimum payout threshold. */
  PAYOUT_BELOW_THRESHOLD: "MARKETPLACE_PAYOUT_BELOW_THRESHOLD",

  // ─── Publishers ───
  /** The publisher profile does not exist. */
  PUBLISHER_NOT_FOUND: "MARKETPLACE_PUBLISHER_NOT_FOUND",
  /** A publisher profile already exists for this tenant/principal. */
  PUBLISHER_ALREADY_EXISTS: "MARKETPLACE_PUBLISHER_ALREADY_EXISTS",
  /** The publisher is not verified (required for this operation). */
  PUBLISHER_NOT_VERIFIED: "MARKETPLACE_PUBLISHER_NOT_VERIFIED",
  /** The publisher is suspended. */
  PUBLISHER_SUSPENDED: "MARKETPLACE_PUBLISHER_SUSPENDED",

  // ─── Billing ───
  /** The billing webhook signature is invalid. */
  WEBHOOK_SIGNATURE_INVALID: "MARKETPLACE_WEBHOOK_SIGNATURE_INVALID",
  /** Duplicate webhook delivery (already processed). */
  WEBHOOK_DUPLICATE: "MARKETPLACE_WEBHOOK_DUPLICATE",
  /** The payment method does not exist. */
  PAYMENT_METHOD_NOT_FOUND: "MARKETPLACE_PAYMENT_METHOD_NOT_FOUND",

  // ─── General ───
  /** Validation failed on the request payload. */
  VALIDATION_FAILED: "MARKETPLACE_VALIDATION_FAILED",
  /** Idempotency key reused with a different payload. */
  IDEMPOTENCY_KEY_CONFLICT: "MARKETPLACE_IDEMPOTENCY_KEY_CONFLICT",
  /** The requesting principal lacks the required scope. */
  INSUFFICIENT_SCOPE: "MARKETPLACE_INSUFFICIENT_SCOPE",
  /** The listing/resource is not visible to the requesting tenant. */
  TENANT_SCOPE_DENIED: "MARKETPLACE_TENANT_SCOPE_DENIED",
  /** Rate limit exceeded. */
  RATE_LIMIT_EXCEEDED: "MARKETPLACE_RATE_LIMIT_EXCEEDED",
} as const;

/** Union type of all marketplace error codes. */
export type FridayMarketplaceErrorCode =
  (typeof FRIDAY_MARKETPLACE_ERROR_CODES)[keyof typeof FRIDAY_MARKETPLACE_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════
// PAGINATION (reuses shared types from api/model)
// ═══════════════════════════════════════════════════════════════════════

/** Pagination query for marketplace endpoints. */
export type FridayMarketplacePaginationQuery = FridayPaginationQuery;

/** Paginated result for marketplace endpoints. */
export type FridayMarketplacePage<TItem> = FridayPage<TItem>;

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCY CONTRACT
// ═══════════════════════════════════════════════════════════════════════

/** Idempotency TTL in hours for marketplace API write operations. */
export const FRIDAY_MARKETPLACE_IDEMPOTENCY_TTL_HOURS = 24 as const;

/** Idempotency contract specification for marketplace API write operations. */
export interface FridayMarketplaceIdempotencyContract {
  /** Scope is (principalId, operationId, key). */
  readonly scope: "principal+operation+key";
  /** Keys expire after 24 hours. */
  readonly ttlHours: 24;
  /** Same payload hash returns the original response. */
  readonly replayBehavior: "same_payload_returns_original_response";
  /** Different payload hash returns 409. */
  readonly conflict: {
    readonly httpStatus: 409;
    readonly code: "MARKETPLACE_IDEMPOTENCY_KEY_CONFLICT";
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PRICING PLAN DTOs
// ═══════════════════════════════════════════════════════════════════════

/** Free pricing plan DTO. */
export interface FridayFreePricingPlanDto {
  readonly type: "free";
}

/** One-time purchase pricing plan DTO. */
export interface FridayOneTimePricingPlanDto {
  readonly type: "one_time";
  readonly price: FridayMoneyAmountDto;
}

/** Subscription pricing plan DTO. */
export interface FridaySubscriptionPricingPlanDto {
  readonly type: "subscription";
  readonly intervalMonths: 1 | 12;
  readonly price: FridayMoneyAmountDto;
  readonly trialDays: number;
}

/** Pricing tier DTO for usage-based plans. */
export interface FridayPricingTierDto {
  readonly upToUnits: number | null;
  readonly pricePerUnitCents: number;
}

/** Usage-based pricing plan DTO. */
export interface FridayUsageBasedPricingPlanDto {
  readonly type: "usage_based";
  readonly unitLabel: string;
  readonly tiers: readonly FridayPricingTierDto[];
  readonly currency: FridayCurrencyCodeDto;
}

/** Pricing plan discriminated union DTO. */
export type FridayPricingPlanDto =
  | FridayFreePricingPlanDto
  | FridayOneTimePricingPlanDto;

// ═══════════════════════════════════════════════════════════════════════
// DTO TYPES
// ═══════════════════════════════════════════════════════════════════════

/** API DTO for a publisher profile. */
export interface FridayPublisherDto {
  readonly id: UUID;
  readonly tenantId: string;
  readonly principalId: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly websiteUrl?: string;
  readonly contactEmail: string;
  readonly verificationStatus: FridayPublisherVerificationStatusDto;
  readonly country?: string;
  readonly platformFeeBps: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for publisher verification details. */
export interface FridayPublisherVerificationDto {
  readonly publisherId: UUID;
  readonly legalName: string;
  readonly taxIdLast4: string;
  readonly country: string;
  readonly payoutMethod: string;
  readonly submittedAt: ISODateTime;
  readonly status: FridayPublisherVerificationStatusDto;
  readonly reviewerNotes?: string;
  readonly reviewedAt?: ISODateTime;
}

/** API DTO for a marketplace listing. */
export interface FridayListingDto {
  readonly id: UUID;
  readonly publisherId: UUID;
  readonly slug: string;
  readonly status: FridayListingStatusDto;
  readonly currentVersionId: UUID | null;
  readonly pendingVersionId: UUID | null;
  readonly tenantId: string | null;
  readonly tags: readonly string[];
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a listing version. */
export interface FridayListingVersionDto {
  readonly id: UUID;
  readonly listingId: UUID;
  readonly versionNumber: number;
  readonly status: FridayListingVersionStatusDto;
  readonly assetType: FridayMarketplaceAssetTypeDto;
  readonly title: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly screenshotUrls: readonly string[];
  readonly packageName: string;
  readonly packageVersion: string;
  readonly distributionMode: FridayMarketplaceDistributionModeDto;
  readonly permissionManifest: FridayMarketplacePermissionManifestDto;
  readonly pricingPlan: FridayPricingPlanDto;
  readonly releaseNotes?: string;
  readonly createdAt: ISODateTime;
}

/** API DTO for a listing review. */
export interface FridayListingReviewDto {
  readonly id: UUID;
  readonly listingId: UUID;
  readonly versionId: UUID;
  readonly reviewerId: string;
  readonly decision: FridayListingReviewDecisionDto;
  readonly notes?: string;
  readonly createdAt: ISODateTime;
}

/** Summary DTO for listing list views. */
export interface FridayListingSummaryDto {
  readonly id: UUID;
  readonly publisherId: UUID;
  readonly slug: string;
  readonly status: FridayListingStatusDto;
  readonly assetType: FridayMarketplaceAssetTypeDto;
  readonly title: string;
  readonly description: string;
  readonly packageName: string;
  readonly tags: readonly string[];
  readonly pricingPlanType: FridayPricingPlanTypeDto;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a pricing plan record. */
export interface FridayPricingPlanRecordDto {
  readonly id: UUID;
  readonly listingId: UUID;
  readonly plan: FridayPricingPlanDto;
  readonly isActive: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a purchase. */
export interface FridayPurchaseDto {
  readonly id: UUID;
  readonly buyerTenantId: string;
  readonly buyerPrincipalId: string;
  readonly listingId: UUID;
  readonly listingVersionId: UUID;
  readonly pricingPlanId: UUID;
  readonly status: FridayPurchaseStatusDto;
  readonly amount: FridayMoneyAmountDto;
  readonly completedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a subscription. */
export interface FridaySubscriptionDto {
  readonly id: UUID;
  readonly purchaseId: UUID;
  readonly buyerTenantId: string;
  readonly buyerPrincipalId: string;
  readonly listingId: UUID;
  readonly pricingPlanId: UUID;
  readonly status: FridaySubscriptionStatusDto;
  readonly currentPeriodStart: ISODateTime;
  readonly currentPeriodEnd: ISODateTime;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelledAt?: ISODateTime;
  readonly trialEndsAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for an entitlement. */
export interface FridayEntitlementDto {
  readonly id: UUID;
  readonly tenantId: string;
  readonly principalId: string;
  readonly listingId: UUID;
  readonly packageName: string;
  readonly sourceType: FridayEntitlementSourceTypeDto;
  readonly sourceId: UUID;
  readonly status: FridayEntitlementStatusDto;
  readonly grantedAt: ISODateTime;
  readonly expiresAt?: ISODateTime;
  readonly gracePeriodEndsAt?: ISODateTime;
  readonly grandfathered: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for an entitlement check result. */
export interface FridayEntitlementCheckDto {
  readonly entitled: boolean;
  readonly reason:
    | "active"
    | "grace_period"
    | "no_entitlement"
    | "expired"
    | "suspended"
    | "revoked";
  readonly entitlementId: UUID | null;
  readonly expiresAt?: ISODateTime;
  readonly gracePeriodEndsAt?: ISODateTime;
}

/** API DTO for an installation record. */
export interface FridayInstallationDto {
  readonly id: UUID;
  readonly tenantId: string;
  readonly principalId: string;
  readonly listingId: UUID;
  readonly assetType: FridayMarketplaceAssetTypeDto;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly status: FridayInstallationStatusDto;
  readonly lastError?: string;
  readonly installedAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a refund. */
export interface FridayRefundDto {
  readonly id: UUID;
  readonly purchaseId: UUID;
  readonly amount: FridayMoneyAmountDto;
  readonly reason: string;
  readonly status: FridayRefundStatusDto;
  readonly initiatedBy: string;
  readonly createdAt: ISODateTime;
  readonly completedAt?: ISODateTime;
}

/** API DTO for a payout entry. */
export interface FridayPayoutEntryDto {
  readonly id: UUID;
  readonly publisherId: UUID;
  readonly purchaseId: UUID;
  readonly listingId: UUID;
  readonly grossAmount: FridayMoneyAmountDto;
  readonly platformFee: FridayMoneyAmountDto;
  readonly netAmount: FridayMoneyAmountDto;
  readonly taxWithholding: FridayMoneyAmountDto;
  readonly payoutBatchId: UUID | null;
  readonly status: FridayPayoutEntryStatusDto;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** API DTO for a payout batch. */
export interface FridayPayoutBatchDto {
  readonly id: UUID;
  readonly publisherId: UUID;
  readonly status: FridayPayoutBatchStatusDto;
  readonly totalAmount: FridayMoneyAmountDto;
  readonly entryCount: number;
  readonly periodStart: ISODateTime;
  readonly periodEnd: ISODateTime;
  readonly initiatedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
  readonly failedReason?: string;
}

/** API DTO for an earnings summary. */
export interface FridayEarningsSummaryDto {
  readonly publisherId: UUID;
  readonly totalGross: FridayMoneyAmountDto;
  readonly totalPlatformFee: FridayMoneyAmountDto;
  readonly totalNet: FridayMoneyAmountDto;
  readonly totalTaxWithheld: FridayMoneyAmountDto;
  readonly totalPaidOut: FridayMoneyAmountDto;
  readonly pendingPayout: FridayMoneyAmountDto;
  readonly asOf: ISODateTime;
}

/** API DTO for a billing event. */
export interface FridayBillingEventDto {
  readonly id: UUID;
  readonly eventType: FridayBillingEventTypeDto;
  readonly source: "internal" | "webhook";
  readonly referenceType?: string;
  readonly referenceId?: UUID;
  readonly processed: boolean;
  readonly createdAt: ISODateTime;
}

/** API DTO for a payment method. */
export interface FridayPaymentMethodDto {
  readonly id: UUID;
  readonly tenantId: string;
  readonly principalId: string;
  readonly type: FridayPaymentMethodTypeDto;
  readonly provider: string;
  readonly displayLabel: string;
  readonly isDefault: boolean;
  readonly expiresAt?: ISODateTime;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLISHER ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/marketplace/publishers`.
 *
 * Creates a new publisher profile.
 *
 * @openapi operationId: createPublisher
 */
export interface FridayCreatePublisherRequest {
  readonly displayName: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly websiteUrl?: string;
  readonly contactEmail: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/publishers`.
 *
 * @openapi operationId: createPublisher
 */
export interface FridayCreatePublisherResponse {
  readonly publisher: FridayPublisherDto;
}

/**
 * Request body for `PUT /api/marketplace/publishers/:publisherId`.
 *
 * Updates a publisher profile.
 *
 * @openapi operationId: updatePublisher
 */
export interface FridayUpdatePublisherRequest {
  readonly displayName?: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly websiteUrl?: string;
  readonly contactEmail?: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `PUT /api/marketplace/publishers/:publisherId`.
 *
 * @openapi operationId: updatePublisher
 */
export interface FridayUpdatePublisherResponse {
  readonly publisher: FridayPublisherDto;
}

/**
 * Response body for `GET /api/marketplace/publishers/:publisherId`.
 *
 * @openapi operationId: getPublisher
 */
export interface FridayGetPublisherResponse {
  readonly publisher: FridayPublisherDto;
  readonly verification?: FridayPublisherVerificationDto;
  readonly listingCount: number;
}

/**
 * Request body for `POST /api/marketplace/publishers/:publisherId/verify`.
 *
 * Submits publisher verification documents.
 *
 * @openapi operationId: submitPublisherVerification
 */
export interface FridaySubmitPublisherVerificationRequest {
  readonly legalName: string;
  readonly taxId: string;
  readonly country: string;
  readonly payoutMethod: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/publishers/:publisherId/verify`.
 *
 * @openapi operationId: submitPublisherVerification
 */
export interface FridaySubmitPublisherVerificationResponse {
  readonly verification: FridayPublisherVerificationDto;
}

/**
 * Request body for `POST /api/marketplace/publishers/:publisherId/verify/review`.
 *
 * Admin reviews a publisher verification submission.
 *
 * @openapi operationId: reviewPublisherVerification
 */
export interface FridayReviewPublisherVerificationRequest {
  readonly decision: "verified" | "rejected";
  readonly notes?: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/publishers/:publisherId/verify/review`.
 *
 * @openapi operationId: reviewPublisherVerification
 */
export interface FridayReviewPublisherVerificationResponse {
  readonly publisher: FridayPublisherDto;
  readonly verification: FridayPublisherVerificationDto;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/marketplace/listings`.
 *
 * Creates a new listing in draft status.
 *
 * @openapi operationId: createListing
 */
export interface FridayCreateListingRequest {
  readonly slug: string;
  readonly assetType: FridayMarketplaceAssetTypeDto;
  readonly title: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly screenshotUrls?: readonly string[];
  readonly packageName: string;
  readonly packageVersion: string;
  readonly pricingPlan: FridayPricingPlanDto;
  readonly tags?: readonly string[];
  readonly tenantId?: string;
  readonly releaseNotes?: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings`.
 *
 * @openapi operationId: createListing
 */
export interface FridayCreateListingResponse {
  readonly listing: FridayListingDto;
  readonly version: FridayListingVersionDto;
}

/**
 * Query parameters for `GET /api/marketplace/listings`.
 *
 * @openapi operationId: listListings
 */
export interface FridayListListingsQuery extends FridayMarketplacePaginationQuery {
  /** Filter by listing status. */
  readonly status?: FridayListingStatusDto;
  /** Filter by publisher ID. */
  readonly publisherId?: UUID;
  /** Filter by tag. */
  readonly tag?: string;
  /** Filter by pricing plan type. */
  readonly pricingType?: FridayPricingPlanTypeDto;
  /** Full-text search query. */
  readonly query?: string;
  /** Sort field. */
  readonly sortBy?: "createdAt" | "updatedAt" | "title";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/listings`.
 *
 * @openapi operationId: listListings
 */
export interface FridayListListingsResponse extends FridayMarketplacePage<FridayListingSummaryDto> {}

/**
 * Response body for `GET /api/marketplace/listings/:listingId`.
 *
 * Full listing detail including current version and pricing.
 *
 * @openapi operationId: getListing
 */
export interface FridayGetListingResponse {
  readonly listing: FridayListingDto;
  readonly currentVersion: FridayListingVersionDto | null;
  readonly publisher: FridayPublisherDto;
  readonly pricingPlans: readonly FridayPricingPlanRecordDto[];
  readonly versionCount: number;
}

/**
 * Request body for `PUT /api/marketplace/listings/:listingId`.
 *
 * Updates listing metadata (creates a new version if content changes).
 *
 * @openapi operationId: updateListing
 */
export interface FridayUpdateListingRequest {
  readonly assetType?: FridayMarketplaceAssetTypeDto;
  readonly title?: string;
  readonly description?: string;
  readonly longDescription?: string;
  readonly screenshotUrls?: readonly string[];
  readonly packageVersion?: string;
  readonly pricingPlan?: FridayPricingPlanDto;
  readonly tags?: readonly string[];
  readonly releaseNotes?: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `PUT /api/marketplace/listings/:listingId`.
 *
 * @openapi operationId: updateListing
 */
export interface FridayUpdateListingResponse {
  readonly listing: FridayListingDto;
  readonly version: FridayListingVersionDto;
}

/**
 * Request body for `POST /api/marketplace/listings/:listingId/install`.
 *
 * Installs the acquired listing version into the buyer tenant environment.
 *
 * @openapi operationId: installListing
 */
export interface FridayInstallListingRequest {
  readonly versionId?: UUID;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/install`.
 *
 * @openapi operationId: installListing
 */
export interface FridayInstallListingResponse {
  readonly installation: FridayInstallationDto;
  readonly idempotent: boolean;
  readonly delivery: {
    readonly status: "installed" | "idempotent";
    readonly reasonCode: string;
    readonly rollback: {
      readonly attempted: boolean;
      readonly succeeded: boolean;
    };
    readonly assetType: FridayMarketplaceAssetTypeDto;
    readonly packageName: string;
    readonly packageVersion: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING VERSION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/marketplace/listings/:listingId/versions`.
 *
 * @openapi operationId: listListingVersions
 */
export interface FridayListListingVersionsQuery extends FridayMarketplacePaginationQuery {}

/**
 * Response body for `GET /api/marketplace/listings/:listingId/versions`.
 *
 * @openapi operationId: listListingVersions
 */
export interface FridayListListingVersionsResponse extends FridayMarketplacePage<FridayListingVersionDto> {}

/**
 * Response body for `GET /api/marketplace/listings/:listingId/versions/:versionId`.
 *
 * @openapi operationId: getListingVersion
 */
export interface FridayGetListingVersionResponse {
  readonly version: FridayListingVersionDto;
}

// ═══════════════════════════════════════════════════════════════════════
// LISTING REVIEW / PUBLISH WORKFLOW
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/marketplace/listings/:listingId/submit`.
 *
 * Submits a listing for review (draft → review).
 *
 * @openapi operationId: submitListingForReview
 */
export interface FridaySubmitListingForReviewRequest {
  /** Version to submit for review. */
  readonly versionId: UUID;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/submit`.
 *
 * @openapi operationId: submitListingForReview
 */
export interface FridaySubmitListingForReviewResponse {
  readonly listing: FridayListingDto;
}

/**
 * Request body for `POST /api/marketplace/listings/:listingId/review`.
 *
 * Reviewer approves or rejects a listing.
 *
 * @openapi operationId: reviewListing
 */
export interface FridayReviewListingRequest {
  /** Version being reviewed. */
  readonly versionId: UUID;
  readonly decision: FridayListingReviewDecisionDto;
  readonly notes?: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/review`.
 *
 * @openapi operationId: reviewListing
 */
export interface FridayReviewListingResponse {
  readonly listing: FridayListingDto;
  readonly review: FridayListingReviewDto;
}

/**
 * Request body for `POST /api/marketplace/listings/:listingId/suspend`.
 *
 * Suspends a published listing.
 *
 * @openapi operationId: suspendListing
 */
export interface FridaySuspendListingRequest {
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/suspend`.
 *
 * @openapi operationId: suspendListing
 */
export interface FridaySuspendListingResponse {
  readonly listing: FridayListingDto;
}

/**
 * Request body for `POST /api/marketplace/listings/:listingId/reinstate`.
 *
 * Reinstates a suspended listing.
 *
 * @openapi operationId: reinstateListing
 */
export interface FridayReinstateListingRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/reinstate`.
 *
 * @openapi operationId: reinstateListing
 */
export interface FridayReinstateListingResponse {
  readonly listing: FridayListingDto;
}

/**
 * Request body for `POST /api/marketplace/listings/:listingId/archive`.
 *
 * Archives a listing (terminal state).
 *
 * @openapi operationId: archiveListing
 */
export interface FridayArchiveListingRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/archive`.
 *
 * @openapi operationId: archiveListing
 */
export interface FridayArchiveListingResponse {
  readonly listing: FridayListingDto;
}

// ═══════════════════════════════════════════════════════════════════════
// PRICING PLAN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/marketplace/listings/:listingId/pricing-plans`.
 *
 * Creates a new pricing plan for a listing.
 *
 * @openapi operationId: createPricingPlan
 */
export interface FridayCreatePricingPlanRequest {
  readonly plan: FridayPricingPlanDto;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/pricing-plans`.
 *
 * @openapi operationId: createPricingPlan
 */
export interface FridayCreatePricingPlanResponse {
  readonly pricingPlan: FridayPricingPlanRecordDto;
}

/**
 * Request body for `PUT /api/marketplace/pricing-plans/:planId`.
 *
 * Updates a pricing plan.
 *
 * @openapi operationId: updatePricingPlan
 */
export interface FridayUpdatePricingPlanRequest {
  readonly plan: FridayPricingPlanDto;
  readonly idempotencyKey: string;
}

/**
 * Response body for `PUT /api/marketplace/pricing-plans/:planId`.
 *
 * @openapi operationId: updatePricingPlan
 */
export interface FridayUpdatePricingPlanResponse {
  readonly pricingPlan: FridayPricingPlanRecordDto;
}

/**
 * Request body for `POST /api/marketplace/pricing-plans/:planId/deactivate`.
 *
 * Deactivates a pricing plan (soft delete).
 *
 * @openapi operationId: deactivatePricingPlan
 */
export interface FridayDeactivatePricingPlanRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/pricing-plans/:planId/deactivate`.
 *
 * @openapi operationId: deactivatePricingPlan
 */
export interface FridayDeactivatePricingPlanResponse {
  readonly pricingPlan: FridayPricingPlanRecordDto;
}

// ═══════════════════════════════════════════════════════════════════════
// PURCHASE / CHECKOUT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Request body for `POST /api/marketplace/listings/:listingId/checkout`.
 *
 * Initiates a checkout/purchase flow.
 *
 * @openapi operationId: initiateCheckout
 */
export interface FridayInitiateCheckoutRequest {
  readonly pricingPlanId: UUID;
  readonly paymentMethodId?: UUID;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/listings/:listingId/checkout`.
 *
 * @openapi operationId: initiateCheckout
 */
export interface FridayInitiateCheckoutResponse {
  readonly purchase: FridayPurchaseDto;
  /** URL to redirect buyer to external payment page (null for free plans). */
  readonly checkoutUrl: string | null;
  /** Subscription record (created for subscription plans). */
  readonly subscription?: FridaySubscriptionDto;
  /** Entitlement (granted immediately for free plans). */
  readonly entitlement?: FridayEntitlementDto;
}

/**
 * Query parameters for `GET /api/marketplace/purchases`.
 *
 * @openapi operationId: listPurchases
 */
export interface FridayListPurchasesQuery extends FridayMarketplacePaginationQuery {
  /** Filter by listing ID. */
  readonly listingId?: UUID;
  /** Filter by purchase status. */
  readonly status?: FridayPurchaseStatusDto;
  /** Sort field. */
  readonly sortBy?: "createdAt" | "amount";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/purchases`.
 *
 * @openapi operationId: listPurchases
 */
export interface FridayListPurchasesResponse extends FridayMarketplacePage<FridayPurchaseDto> {}

/**
 * Response body for `GET /api/marketplace/purchases/:purchaseId`.
 *
 * @openapi operationId: getPurchase
 */
export interface FridayGetPurchaseResponse {
  readonly purchase: FridayPurchaseDto;
  readonly listing: FridayListingSummaryDto;
  readonly subscription?: FridaySubscriptionDto;
  readonly refunds: readonly FridayRefundDto[];
}

/**
 * Request body for `POST /api/marketplace/purchases/:purchaseId/refund`.
 *
 * Initiates a refund for a purchase.
 *
 * @openapi operationId: refundPurchase
 */
export interface FridayRefundPurchaseRequest {
  /** Refund amount (omit for full refund). */
  readonly amount?: FridayMoneyAmountDto;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/purchases/:purchaseId/refund`.
 *
 * @openapi operationId: refundPurchase
 */
export interface FridayRefundPurchaseResponse {
  readonly refund: FridayRefundDto;
  readonly purchase: FridayPurchaseDto;
}

// ═══════════════════════════════════════════════════════════════════════
// SUBSCRIPTION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/marketplace/subscriptions`.
 *
 * @openapi operationId: listSubscriptions
 */
export interface FridayListSubscriptionsQuery extends FridayMarketplacePaginationQuery {
  /** Filter by listing ID. */
  readonly listingId?: UUID;
  /** Filter by subscription status. */
  readonly status?: FridaySubscriptionStatusDto;
  /** Sort field. */
  readonly sortBy?: "createdAt" | "currentPeriodEnd";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/subscriptions`.
 *
 * @openapi operationId: listSubscriptions
 */
export interface FridayListSubscriptionsResponse extends FridayMarketplacePage<FridaySubscriptionDto> {}

/**
 * Response body for `GET /api/marketplace/subscriptions/:subscriptionId`.
 *
 * @openapi operationId: getSubscription
 */
export interface FridayGetSubscriptionResponse {
  readonly subscription: FridaySubscriptionDto;
  readonly listing: FridayListingSummaryDto;
  readonly entitlement: FridayEntitlementDto | null;
}

/**
 * Request body for `POST /api/marketplace/subscriptions/:subscriptionId/cancel`.
 *
 * Cancels a subscription (at period end by default).
 *
 * @openapi operationId: cancelSubscription
 */
export interface FridayCancelSubscriptionRequest {
  /** Cancel immediately (true) or at period end (false, default). */
  readonly immediately?: boolean;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/subscriptions/:subscriptionId/cancel`.
 *
 * @openapi operationId: cancelSubscription
 */
export interface FridayCancelSubscriptionResponse {
  readonly subscription: FridaySubscriptionDto;
}

/**
 * Request body for `POST /api/marketplace/subscriptions/:subscriptionId/pause`.
 *
 * Pauses a subscription.
 *
 * @openapi operationId: pauseSubscription
 */
export interface FridayPauseSubscriptionRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/subscriptions/:subscriptionId/pause`.
 *
 * @openapi operationId: pauseSubscription
 */
export interface FridayPauseSubscriptionResponse {
  readonly subscription: FridaySubscriptionDto;
}

/**
 * Request body for `POST /api/marketplace/subscriptions/:subscriptionId/resume`.
 *
 * Resumes a paused subscription.
 *
 * @openapi operationId: resumeSubscription
 */
export interface FridayResumeSubscriptionRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/subscriptions/:subscriptionId/resume`.
 *
 * @openapi operationId: resumeSubscription
 */
export interface FridayResumeSubscriptionResponse {
  readonly subscription: FridaySubscriptionDto;
}

// ═══════════════════════════════════════════════════════════════════════
// ENTITLEMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/marketplace/entitlements/check`.
 *
 * Checks whether a tenant/principal is entitled to use a listing's package.
 * This is the primary runtime entitlement check endpoint.
 *
 * @openapi operationId: checkEntitlement
 */
export interface FridayCheckEntitlementQuery {
  /** Listing ID to check entitlement for. */
  readonly listingId?: UUID;
  /** Package name to check entitlement for (alternative to listingId). */
  readonly packageName?: string;
}

/**
 * Response body for `GET /api/marketplace/entitlements/check`.
 *
 * @openapi operationId: checkEntitlement
 */
export interface FridayCheckEntitlementResponse {
  readonly result: FridayEntitlementCheckDto;
}

/**
 * Query parameters for `GET /api/marketplace/entitlements`.
 *
 * @openapi operationId: listEntitlements
 */
export interface FridayListEntitlementsQuery extends FridayMarketplacePaginationQuery {
  /** Filter by listing ID. */
  readonly listingId?: UUID;
  /** Filter by package name. */
  readonly packageName?: string;
  /** Filter by entitlement status. */
  readonly status?: FridayEntitlementStatusDto;
  /** Sort field. */
  readonly sortBy?: "grantedAt" | "expiresAt";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/entitlements`.
 *
 * @openapi operationId: listEntitlements
 */
export interface FridayListEntitlementsResponse extends FridayMarketplacePage<FridayEntitlementDto> {}

/**
 * Request body for `POST /api/marketplace/entitlements/grant`.
 *
 * Admin-grants an entitlement (bypasses purchase flow).
 *
 * @openapi operationId: grantEntitlement
 */
export interface FridayGrantEntitlementRequest {
  readonly tenantId: string;
  readonly principalId: string;
  readonly listingId: UUID;
  /** Admin-grant only; system-created entitlements use the full sourceType via internal flows. */
  readonly sourceType: "grant";
  /** Optional provenance reference ID (e.g., support ticket or campaign ID). */
  readonly sourceId?: string;
  /** Optional notes explaining why the entitlement was granted. */
  readonly notes?: string;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/entitlements/grant`.
 *
 * @openapi operationId: grantEntitlement
 */
export interface FridayGrantEntitlementResponse {
  readonly entitlement: FridayEntitlementDto;
}

/**
 * Request body for `POST /api/marketplace/entitlements/:entitlementId/revoke`.
 *
 * Revokes an entitlement.
 *
 * @openapi operationId: revokeEntitlement
 */
export interface FridayRevokeEntitlementRequest {
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/entitlements/:entitlementId/revoke`.
 *
 * @openapi operationId: revokeEntitlement
 */
export interface FridayRevokeEntitlementResponse {
  readonly entitlement: FridayEntitlementDto;
}

// ═══════════════════════════════════════════════════════════════════════
// PAYOUT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Response body for `GET /api/marketplace/publishers/:publisherId/earnings`.
 *
 * Returns an earnings summary for the publisher.
 *
 * @openapi operationId: getEarningsSummary
 */
export interface FridayGetEarningsSummaryResponse {
  readonly summary: FridayEarningsSummaryDto;
}

/**
 * Query parameters for `GET /api/marketplace/publishers/:publisherId/payout-entries`.
 *
 * @openapi operationId: listPayoutEntries
 */
export interface FridayListPayoutEntriesQuery extends FridayMarketplacePaginationQuery {
  /** Filter by payout entry status. */
  readonly status?: FridayPayoutEntryStatusDto;
  /** Filter by listing ID. */
  readonly listingId?: UUID;
  /** Entries after this timestamp (inclusive). */
  readonly after?: ISODateTime;
  /** Entries before this timestamp (exclusive). */
  readonly before?: ISODateTime;
  /** Sort field. */
  readonly sortBy?: "createdAt" | "netAmount";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/publishers/:publisherId/payout-entries`.
 *
 * @openapi operationId: listPayoutEntries
 */
export interface FridayListPayoutEntriesResponse extends FridayMarketplacePage<FridayPayoutEntryDto> {}

/**
 * Query parameters for `GET /api/marketplace/publishers/:publisherId/payout-batches`.
 *
 * @openapi operationId: listPayoutBatches
 */
export interface FridayListPayoutBatchesQuery extends FridayMarketplacePaginationQuery {
  /** Filter by batch status. */
  readonly status?: FridayPayoutBatchStatusDto;
  /** Sort field. */
  readonly sortBy?: "initiatedAt" | "totalAmount";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/publishers/:publisherId/payout-batches`.
 *
 * @openapi operationId: listPayoutBatches
 */
export interface FridayListPayoutBatchesResponse extends FridayMarketplacePage<FridayPayoutBatchDto> {}

/**
 * Response body for `GET /api/marketplace/payout-batches/:batchId`.
 *
 * @openapi operationId: getPayoutBatch
 */
export interface FridayGetPayoutBatchResponse {
  readonly batch: FridayPayoutBatchDto;
}

/**
 * Query parameters for `GET /api/marketplace/payout-batches/:batchId/entries`.
 *
 * Paginated list of entries within a payout batch.
 *
 * @openapi operationId: listPayoutBatchEntries
 */
export interface FridayListPayoutBatchEntriesQuery extends FridayMarketplacePaginationQuery {
  /** Sort field. */
  readonly sortBy?: "createdAt" | "netAmount";
  /** Sort direction. */
  readonly sortDir?: "asc" | "desc";
}

/**
 * Response body for `GET /api/marketplace/payout-batches/:batchId/entries`.
 *
 * @openapi operationId: listPayoutBatchEntries
 */
export interface FridayListPayoutBatchEntriesResponse extends FridayMarketplacePage<FridayPayoutEntryDto> {}

/**
 * Request body for `POST /api/marketplace/publishers/:publisherId/payout-batches`.
 *
 * Initiates a payout batch for a publisher (admin only).
 *
 * @openapi operationId: initiatePayoutBatch
 */
export interface FridayInitiatePayoutBatchRequest {
  readonly periodStart: ISODateTime;
  readonly periodEnd: ISODateTime;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/publishers/:publisherId/payout-batches`.
 *
 * @openapi operationId: initiatePayoutBatch
 */
export interface FridayInitiatePayoutBatchResponse {
  readonly batch: FridayPayoutBatchDto;
}

// ═══════════════════════════════════════════════════════════════════════
// BILLING EVENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/marketplace/billing-events`.
 *
 * @openapi operationId: listBillingEvents
 */
export interface FridayListBillingEventsQuery extends FridayMarketplacePaginationQuery {
  /** Filter by event type. */
  readonly eventType?: FridayBillingEventTypeDto;
  /** Filter by processed status. */
  readonly processed?: boolean;
  /** Events after this timestamp (inclusive). */
  readonly after?: ISODateTime;
  /** Events before this timestamp (exclusive). */
  readonly before?: ISODateTime;
}

/**
 * Response body for `GET /api/marketplace/billing-events`.
 *
 * @openapi operationId: listBillingEvents
 */
export interface FridayListBillingEventsResponse extends FridayMarketplacePage<FridayBillingEventDto> {}

/**
 * Request body for `POST /api/marketplace/webhooks/:provider`.
 *
 * Receives a webhook from an external billing provider.
 *
 * @openapi operationId: receiveBillingWebhook
 */
export interface FridayReceiveBillingWebhookRequest {
  readonly payload: JsonObject;
  readonly signature: string;
}

/**
 * Response body for `POST /api/marketplace/webhooks/:provider`.
 *
 * @openapi operationId: receiveBillingWebhook
 */
export interface FridayReceiveBillingWebhookResponse {
  readonly received: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// PAYMENT METHOD ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Query parameters for `GET /api/marketplace/payment-methods`.
 *
 * @openapi operationId: listPaymentMethods
 */
export interface FridayListPaymentMethodsQuery extends FridayMarketplacePaginationQuery {}

/**
 * Response body for `GET /api/marketplace/payment-methods`.
 *
 * @openapi operationId: listPaymentMethods
 */
export interface FridayListPaymentMethodsResponse extends FridayMarketplacePage<FridayPaymentMethodDto> {}

/**
 * Request body for `POST /api/marketplace/payment-methods`.
 *
 * Registers a new payment method.
 *
 * @openapi operationId: addPaymentMethod
 */
export interface FridayAddPaymentMethodRequest {
  readonly type: FridayPaymentMethodTypeDto;
  readonly provider: string;
  readonly externalMethodId: string;
  readonly displayLabel: string;
  readonly isDefault?: boolean;
  readonly expiresAt?: ISODateTime;
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/payment-methods`.
 *
 * @openapi operationId: addPaymentMethod
 */
export interface FridayAddPaymentMethodResponse {
  readonly paymentMethod: FridayPaymentMethodDto;
}

/**
 * Response body for `DELETE /api/marketplace/payment-methods/:methodId`.
 *
 * Confirms deletion of a payment method.
 *
 * @openapi operationId: deletePaymentMethod
 */
export interface FridayDeletePaymentMethodResponse {
  readonly deleted: boolean;
}

/**
 * @deprecated Use `FridayDeletePaymentMethodResponse` — aligns with HTTP DELETE verb.
 */
export type FridayRemovePaymentMethodResponse = FridayDeletePaymentMethodResponse;

/**
 * Request body for `POST /api/marketplace/payment-methods/:methodId/default`.
 *
 * Sets a payment method as the default.
 *
 * @openapi operationId: setDefaultPaymentMethod
 */
export interface FridaySetDefaultPaymentMethodRequest {
  readonly idempotencyKey: string;
}

/**
 * Response body for `POST /api/marketplace/payment-methods/:methodId/default`.
 *
 * @openapi operationId: setDefaultPaymentMethod
 */
export interface FridaySetDefaultPaymentMethodResponse {
  readonly paymentMethod: FridayPaymentMethodDto;
}
