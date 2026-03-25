/**
 * Marketplace Commerce API routes.
 *
 * Wires the marketplace engine (publisher, listing, pricing, purchase,
 * entitlement, payout, search) into production HTTP endpoints.
 *
 * @module api/http/routes/friday-marketplace-commerce-routes
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayHttpContext } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import type { FridayLearningEventAppendInput } from "#ledger";
import {
  FRIDAY_BILLING_EVENT_TYPES,
  FRIDAY_MARKETPLACE_ASSET_TYPES,
  FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES,
  FRIDAY_PAYOUT_BATCH_STATUSES,
  FRIDAY_PAYOUT_ENTRY_STATUSES,
} from "../../../marketplace/model/friday-marketplace.types.js";

import type {
  FridayBillingEvent,
  FridayEntitlement,
  FridayInstallation,
  FridayListing,
  FridayListingVersion,
  FridayMarketplaceAssetType,
  FridayMarketplaceDistributionMode,
  FridayMarketplacePermissionManifest,
  FridayMoneyAmount,
  FridayPayoutBatch,
  FridayPayoutEntry,
  FridayPricingPlanRecord,
  FridayPublisher,
  FridayPublisherVerification,
  FridayPurchase,
  FridayRefund,
  FridaySubscription,
  ISODateTime,
  UUID,
} from "../../../marketplace/model/friday-marketplace.types.js";

import {
  archiveListing,
  completePurchase,
  computeEarningsSummary,
  createListing,
  createPayoutBatch,
  createPricingPlan,
  createPublisher,
  deactivatePricingPlan,
  dispatchInstall,
  initiateCheckout,
  initiateRefund,
  reinstateListing,
  reinstatePublisher,
  reviewListing,
  reviewVerification,
  searchListings,
  submitForReview,
  submitVerification,
  suspendListing,
  suspendPublisher,
  updatePublisher,
} from "../../../marketplace/engine/index.js";

import type {
  ListingDeps,
  ListingSearchEntry,
  ListingSearchFilters,
  MarketplaceAuditEventSink,
  PayoutDeps,
  PricingDeps,
  PublisherDeps,
  PurchaseDeps,
} from "../../../marketplace/engine/index.js";

// ─── Dependencies ───

export interface FridayMarketplaceCommerceRoutesDeps {
  /** Generate a unique ID for new entities. */
  generateId: () => UUID;
  /** Current ISO timestamp. */
  now: () => ISODateTime;
  /** Audit event sink. */
  auditSink?: MarketplaceAuditEventSink;
  /** Optional learning event sink for incentive-alignment signals. */
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  /** Default user to attribute runtime-generated learning events to. */
  learningUserId?: string;

  // ─── Data Access (read) ───
  getPublisher: (id: UUID) => Promise<FridayPublisher | null>;
  getPublisherByPrincipal: (tenantId: string, principalId: string) => Promise<FridayPublisher | null>;
  getPublisherVerification: (publisherId: UUID) => Promise<FridayPublisherVerification | null>;
  listPublishers: (tenantId?: string) => Promise<FridayPublisher[]>;

  getListing: (id: UUID) => Promise<FridayListing | null>;
  getListingBySlug: (slug: string) => Promise<FridayListing | null>;
  listListings: (filters?: { publisherId?: UUID; status?: string }) => Promise<FridayListing[]>;
  getListingVersion: (id: UUID) => Promise<FridayListingVersion | null>;
  listListingVersions: (listingId: UUID) => Promise<FridayListingVersion[]>;

  getPricingPlan: (id: UUID) => Promise<FridayPricingPlanRecord | null>;
  listPricingPlans: (listingId: UUID) => Promise<FridayPricingPlanRecord[]>;

  getPurchase: (id: UUID) => Promise<FridayPurchase | null>;
  listPurchases: (filters?: { buyerTenantId?: string; listingId?: UUID }) => Promise<FridayPurchase[]>;

  getEntitlement: (id: UUID) => Promise<FridayEntitlement | null>;
  listEntitlements: (filters?: { tenantId?: string; listingId?: UUID }) => Promise<FridayEntitlement[]>;
  listInstallations: (filters?: {
    tenantId?: string;
    listingId?: UUID;
    packageName?: string;
    packageVersion?: string;
    status?: string;
  }) => Promise<FridayInstallation[]>;

  listSubscriptions: (filters?: { buyerTenantId?: string }) => Promise<FridaySubscription[]>;
  getSubscription: (id: UUID) => Promise<FridaySubscription | null>;

  listRefunds: (purchaseId: UUID) => Promise<FridayRefund[]>;
  listPayoutEntries: (filters?: {
    publisherId?: UUID;
    status?: string;
    listingId?: UUID;
    payoutBatchId?: UUID;
    after?: ISODateTime;
    before?: ISODateTime;
  }) => Promise<readonly FridayPayoutEntry[]>;
  listPayoutBatches: (filters?: {
    publisherId?: UUID;
    status?: string;
  }) => Promise<readonly FridayPayoutBatch[]>;
  getPayoutBatch: (id: UUID) => Promise<FridayPayoutBatch | null>;
  listPayoutBatchEntries: (batchId: UUID) => Promise<readonly FridayPayoutEntry[]>;
  listBillingEvents: (filters?: {
    eventType?: string;
    processed?: boolean;
    after?: ISODateTime;
    before?: ISODateTime;
    limit?: number;
  }) => Promise<readonly FridayBillingEvent[]>;

  /** Search index — flattened listing entries for search. */
  getSearchIndex: () => Promise<ListingSearchEntry[]>;

  // ─── Data Access (write) ───
  savePublisher: (publisher: FridayPublisher) => Promise<void>;
  saveListing: (listing: FridayListing) => Promise<void>;
  saveListingVersion: (version: FridayListingVersion) => Promise<void>;
  savePricingPlan: (plan: FridayPricingPlanRecord) => Promise<void>;
  savePurchase: (purchase: FridayPurchase) => Promise<void>;
  saveEntitlement: (entitlement: FridayEntitlement) => Promise<void>;
  saveInstallation: (installation: FridayInstallation) => Promise<void>;
  /** Optional install prepare hook; may return rollback metadata for failure handling. */
  beforePersistInstallation?: (input: {
    listingId: UUID;
    versionId: UUID;
    tenantId: string;
    principalId: string;
    installationId: UUID;
    assetType: FridayMarketplaceAssetType;
    packageName: string;
    packageVersion: string;
  }) => Promise<
    void | {
      rollback?: (input: { reasonCode: string; message?: string }) => Promise<void> | void;
      metadata?: Record<string, unknown>;
    }
  > | void | {
    rollback?: (input: { reasonCode: string; message?: string }) => Promise<void> | void;
    metadata?: Record<string, unknown>;
  };
  saveSubscription: (subscription: FridaySubscription) => Promise<void>;
  saveRefund: (refund: FridayRefund) => Promise<void>;
  savePayoutEntry: (entry: FridayPayoutEntry) => Promise<void>;
  savePayoutEntries: (entries: readonly FridayPayoutEntry[]) => Promise<void>;
  savePayoutBatch: (batch: FridayPayoutBatch) => Promise<void>;
}

// ─── Type Aliases ───

type Ctx = FridayHttpContext<unknown, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<unknown, Record<string, string>, unknown, unknown>;

type InstallDeliveryStatus = "installed" | "idempotent";
type InstallDeliveryReasonCode =
  | "MARKETPLACE_INSTALL_COMMITTED"
  | "MARKETPLACE_INSTALL_ALREADY_INSTALLED";

// ─── Factory ───

export function createFridayMarketplaceCommerceRoutes(
  deps: FridayMarketplaceCommerceRoutesDeps,
): Route[] {
  const pubDeps: PublisherDeps = {
    generateId: deps.generateId,
    now: deps.now,
    emitAuditEvent: deps.auditSink,
  };

  const listingDeps: ListingDeps = {
    generateId: deps.generateId,
    now: deps.now,
    emitAuditEvent: deps.auditSink,
  };

  const pricingDeps: PricingDeps = {
    generateId: deps.generateId,
    now: deps.now,
    emitAuditEvent: deps.auditSink,
  };

  const purchaseDeps: PurchaseDeps = {
    generateId: deps.generateId,
    now: deps.now,
    emitAuditEvent: deps.auditSink,
  };

  const payoutDeps: PayoutDeps = {
    generateId: deps.generateId,
    now: deps.now,
    emitAuditEvent: deps.auditSink,
  };

  return [
    // ════════════════════════════════════════════════════════════════
    // PUBLISHERS
    // ════════════════════════════════════════════════════════════════

    // ─── Create Publisher ───
    {
      operationId: "marketplace.publishers.create",
      method: "POST",
      path: "/v1/marketplace/publishers",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "displayName");
        requireString(body, "contactEmail");

        const tenantId = requirePrincipalId(ctx);
        const principalId = requirePrincipalId(ctx);
        const existingPublishers = await deps.listPublishers(tenantId);

        const result = createPublisher(
          {
            tenantId,
            principalId,
            displayName: body.displayName as string,
            bio: body.bio as string | undefined,
            avatarUrl: body.avatarUrl as string | undefined,
            websiteUrl: body.websiteUrl as string | undefined,
            contactEmail: body.contactEmail as string,
          },
          existingPublishers,
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 409 });
        }

        await deps.savePublisher(result.value);
        return { publisher: result.value };
      },
    },

    // ─── Get Publisher ───
    {
      operationId: "marketplace.publishers.get",
      method: "GET",
      path: "/v1/marketplace/publishers/:id",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }
        return { publisher };
      },
    },

    // ─── Update Publisher ───
    {
      operationId: "marketplace.publishers.update",
      method: "PATCH",
      path: "/v1/marketplace/publishers/:id",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }

        const result = updatePublisher(
          publisher,
          {
            displayName: body.displayName as string | undefined,
            bio: body.bio as string | undefined,
            avatarUrl: body.avatarUrl as string | undefined,
            websiteUrl: body.websiteUrl as string | undefined,
            contactEmail: body.contactEmail as string | undefined,
          },
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePublisher(result.value);
        return { publisher: result.value };
      },
    },

    // ─── Submit Publisher Verification ───
    {
      operationId: "marketplace.publishers.verification.submit",
      method: "POST",
      path: "/v1/marketplace/publishers/:id/verification",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "legalName");
        requireString(body, "taxId");
        requireString(body, "country");
        requireString(body, "payoutMethod");

        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }

        const result = submitVerification(
          publisher,
          {
            legalName: body.legalName as string,
            taxId: body.taxId as string,
            country: body.country as string,
            payoutMethod: body.payoutMethod as string,
          },
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePublisher(result.value.publisher);
        return { publisher: result.value.publisher, verification: result.value.verification };
      },
    },

    // ─── Review Publisher Verification ───
    {
      operationId: "marketplace.publishers.verification.review",
      method: "POST",
      path: "/v1/marketplace/publishers/:id/verification/review",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        requireOneOf(body, "decision", ["verified", "rejected"]);

        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }

        const verification = await deps.getPublisherVerification(id);
        if (!verification) {
          throw new FridayDomainError("VALIDATION_ERROR", `No verification record found for publisher "${id}"`, { httpStatus: 404 });
        }

        const result = reviewVerification(
          publisher,
          verification,
          {
            decision: body.decision as "verified" | "rejected",
            notes: body.notes as string | undefined,
          },
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePublisher(result.value.publisher);
        return { publisher: result.value.publisher, verification: result.value.verification };
      },
    },

    // ─── Suspend Publisher ───
    {
      operationId: "marketplace.publishers.suspend",
      method: "POST",
      path: "/v1/marketplace/publishers/:id/suspend",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }

        const result = suspendPublisher(
          publisher,
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePublisher(result.value);
        return { publisher: result.value };
      },
    },

    // ─── Reinstate Publisher ───
    {
      operationId: "marketplace.publishers.reinstate",
      method: "POST",
      path: "/v1/marketplace/publishers/:id/reinstate",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const publisher = await deps.getPublisher(id);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${id}" not found`, { httpStatus: 404 });
        }

        const result = reinstatePublisher(
          publisher,
          pubDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePublisher(result.value);
        return { publisher: result.value };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // LISTINGS
    // ════════════════════════════════════════════════════════════════

    // ─── Create Listing ───
    {
      operationId: "marketplace.listings.create",
      method: "POST",
      path: "/v1/marketplace/listings",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "publisherId");
        requireString(body, "slug");
        requireAssetType(body, "assetType");
        requireString(body, "title");
        requireString(body, "description");
        requireString(body, "packageName");
        requireString(body, "packageVersion");
        const pricingPlan = requireMvpPricingPlan(body.pricingPlan, "pricingPlan");

        const existingListings = await deps.listListings({ publisherId: body.publisherId as string });
        const existingSlugs = existingListings.map((l) => l.slug);

        const result = createListing(
          {
            publisherId: body.publisherId as UUID,
            slug: body.slug as string,
            title: body.title as string,
            description: body.description as string,
            longDescription: body.longDescription as string | undefined,
            screenshotUrls: body.screenshotUrls as string[] | undefined,
            packageName: body.packageName as string,
            packageVersion: body.packageVersion as string,
            assetType: body.assetType as FridayMarketplaceAssetType,
            distributionMode:
              body.distributionMode as FridayMarketplaceDistributionMode | undefined,
            permissionManifest:
              body.permissionManifest as FridayMarketplacePermissionManifest | undefined,
            pricingPlan: pricingPlan as never,
            tags: body.tags as string[] | undefined,
            tenantId: ctx.principal?.principalId,
          },
          existingSlugs,
          listingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value.listing);
        await deps.saveListingVersion(result.value.version);
        return { listing: result.value.listing, version: result.value.version };
      },
    },

    // ─── Get Listing ───
    {
      operationId: "marketplace.listings.get",
      method: "GET",
      path: "/v1/marketplace/listings/:id",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }
        return { listing };
      },
    },

    // ─── List Listings ───
    {
      operationId: "marketplace.listings.list",
      method: "GET",
      path: "/v1/marketplace/listings",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        const listings = await deps.listListings({
          publisherId: query.publisherId,
          status: query.status,
        });
        return { items: listings, total: listings.length };
      },
    },

    // ─── Submit Listing for Review ───
    {
      operationId: "marketplace.listings.review.submit",
      method: "POST",
      path: "/v1/marketplace/listings/:id/submit-for-review",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "versionId");

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }
        const version = await deps.getListingVersion(body.versionId as string);
        if (!version) {
          throw new FridayDomainError("LISTING_VERSION_NOT_FOUND", `Version "${body.versionId as string}" not found`, { httpStatus: 404 });
        }

        const result = submitForReview(listing, version, listingDeps);
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value.listing);
        await deps.saveListingVersion(result.value.version);
        return { listing: result.value.listing, version: result.value.version };
      },
    },

    // ─── Review Listing ───
    {
      operationId: "marketplace.listings.review",
      method: "POST",
      path: "/v1/marketplace/listings/:id/review",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "versionId");
        requireOneOf(body, "decision", ["approved", "rejected"]);

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }
        const version = await deps.getListingVersion(body.versionId as string);
        if (!version) {
          throw new FridayDomainError("LISTING_VERSION_NOT_FOUND", `Version "${body.versionId as string}" not found`, { httpStatus: 404 });
        }

        const result = reviewListing(
          listing,
          version,
          {
            reviewerId: requirePrincipalId(ctx),
            decision: body.decision as "approved" | "rejected",
            notes: body.notes as string | undefined,
          },
          listingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value.listing);
        await deps.saveListingVersion(result.value.version);
        if (
          body.decision === "approved" &&
          deps.learningEventWriter &&
          deps.learningUserId
        ) {
          deps.learningEventWriter([
            {
              eventId: deps.generateId(),
              ts: deps.now(),
              userId: deps.learningUserId,
              kind: "asset_published",
              payload: {
                assetId: `listing:${result.value.listing.id}`,
                assetKind: result.value.version.assetType,
                listingId: result.value.listing.id,
                versionId: result.value.version.id,
                publisherId: result.value.listing.publisherId,
                reviewerId: requirePrincipalId(ctx),
                promotionState: "public",
              },
            },
          ]);
        }
        return { listing: result.value.listing, version: result.value.version };
      },
    },

    // ─── Suspend Listing ───
    {
      operationId: "marketplace.listings.suspend",
      method: "POST",
      path: "/v1/marketplace/listings/:id/suspend",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }

        const result = suspendListing(
          listing,
          listingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value);
        return { listing: result.value };
      },
    },

    // ─── Reinstate Listing ───
    {
      operationId: "marketplace.listings.reinstate",
      method: "POST",
      path: "/v1/marketplace/listings/:id/reinstate",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }

        const result = reinstateListing(
          listing,
          listingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value);
        return { listing: result.value };
      },
    },

    // ─── Archive Listing ───
    {
      operationId: "marketplace.listings.archive",
      method: "POST",
      path: "/v1/marketplace/listings/:id/archive",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }

        const result = archiveListing(
          listing,
          listingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveListing(result.value);
        return { listing: result.value };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // PRICING
    // ════════════════════════════════════════════════════════════════

    // ─── Create Pricing Plan ───
    {
      operationId: "marketplace.pricing.create",
      method: "POST",
      path: "/v1/marketplace/listings/:listingId/pricing-plans",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { listingId } = ctx.params as { listingId: string };
        const body = ctx.body as Record<string, unknown>;

        const listing = await deps.getListing(listingId);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${listingId}" not found`, { httpStatus: 404 });
        }
        const candidatePlan = asRecord(body.plan) ?? body;
        const plan = requireMvpPricingPlan(candidatePlan, "plan");

        const result = createPricingPlan(
          listingId,
          plan as never,
          pricingDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePricingPlan(result.value);
        return { pricingPlan: result.value };
      },
    },

    // ─── List Pricing Plans ───
    {
      operationId: "marketplace.pricing.list",
      method: "GET",
      path: "/v1/marketplace/listings/:listingId/pricing-plans",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { listingId } = ctx.params as { listingId: string };
        const plans = await deps.listPricingPlans(listingId);
        return { items: plans, total: plans.length };
      },
    },

    // ─── Deactivate Pricing Plan ───
    {
      operationId: "marketplace.pricing.deactivate",
      method: "POST",
      path: "/v1/marketplace/pricing-plans/:id/deactivate",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const plan = await deps.getPricingPlan(id);
        if (!plan) {
          throw new FridayDomainError("PRICING_PLAN_NOT_FOUND", `Pricing plan "${id}" not found`, { httpStatus: 404 });
        }

        const result = deactivatePricingPlan(plan, pricingDeps);
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePricingPlan(result.value);
        return { pricingPlan: result.value };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // PURCHASES & CHECKOUT
    // ════════════════════════════════════════════════════════════════

    // ─── Initiate Checkout ───
    {
      operationId: "marketplace.checkout.initiate",
      method: "POST",
      path: "/v1/marketplace/checkout",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      rateLimitPolicyId: "marketplace.checkout",
      async handler(ctx: Ctx) {
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "listingId");
        requireString(body, "versionId");
        requireString(body, "pricingPlanId");

        const listing = await deps.getListing(body.listingId as string);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing not found`, { httpStatus: 404 });
        }
        const version = await deps.getListingVersion(body.versionId as string);
        if (!version) {
          throw new FridayDomainError("LISTING_VERSION_NOT_FOUND", `Version not found`, { httpStatus: 404 });
        }
        const pricingPlan = await deps.getPricingPlan(body.pricingPlanId as string);
        if (!pricingPlan) {
          throw new FridayDomainError("PRICING_PLAN_NOT_FOUND", `Pricing plan not found`, { httpStatus: 404 });
        }

        const buyerTenantId = requirePrincipalId(ctx);
        const buyerPrincipalId = requirePrincipalId(ctx);

        const result = initiateCheckout(
          {
            buyerTenantId,
            buyerPrincipalId,
            listing,
            version,
            pricingPlanRecord: pricingPlan,
            idempotencyKey: body.idempotencyKey as string | undefined,
          },
          purchaseDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.savePurchase(result.value.purchase);
        if (result.value.entitlement) {
          await deps.saveEntitlement(result.value.entitlement);
        }
        if (result.value.subscription) {
          await deps.saveSubscription(result.value.subscription);
        }

        return {
          purchase: result.value.purchase,
          entitlement: result.value.entitlement ?? null,
          subscription: result.value.subscription ?? null,
        };
      },
    },

    // ─── Get Purchase ───
    {
      operationId: "marketplace.purchases.get",
      method: "GET",
      path: "/v1/marketplace/purchases/:id",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const purchase = await deps.getPurchase(id);
        if (!purchase) {
          throw new FridayDomainError("PURCHASE_NOT_FOUND", `Purchase "${id}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, purchase.buyerTenantId);
        return { purchase };
      },
    },

    // ─── Complete Purchase (payment callback) ───
    {
      operationId: "marketplace.purchases.complete",
      method: "POST",
      path: "/v1/marketplace/purchases/:id/complete",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const externalPaymentId = typeof body.externalPaymentId === "string"
          ? body.externalPaymentId.trim()
          : undefined;
        if (body.externalPaymentId !== undefined && !externalPaymentId) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "\"externalPaymentId\" must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }

        const purchase = await deps.getPurchase(id);
        if (!purchase) {
          throw new FridayDomainError("PURCHASE_NOT_FOUND", `Purchase "${id}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, purchase.buyerTenantId);

        const listing = await deps.getListing(purchase.listingId);
        if (!listing) {
          throw new FridayDomainError(
            "PURCHASE_LINKAGE_MISMATCH",
            `Listing "${purchase.listingId}" not found for purchase "${purchase.id}"`,
            { httpStatus: 409 },
          );
        }
        const version = await deps.getListingVersion(purchase.listingVersionId);
        if (!version) {
          throw new FridayDomainError(
            "PURCHASE_LINKAGE_MISMATCH",
            `Version "${purchase.listingVersionId}" not found for purchase "${purchase.id}"`,
            { httpStatus: 409 },
          );
        }

        const result = completePurchase(
          purchase,
          listing,
          version,
          { externalPaymentId },
          purchaseDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(
            result.error.code,
            result.error.message,
            { httpStatus: result.error.code === "PURCHASE_ALREADY_COMPLETED" ? 409 : 400 },
          );
        }

        await deps.savePurchase(result.value.purchase);
        await deps.saveEntitlement(result.value.entitlement);
        return {
          purchase: result.value.purchase,
          entitlement: result.value.entitlement,
        };
      },
    },

    // ─── List Purchases ───
    {
      operationId: "marketplace.purchases.list",
      method: "GET",
      path: "/v1/marketplace/purchases",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        const buyerTenantId = resolveTenantListFilter(query.buyerTenantId, ctx);
        const purchases = await deps.listPurchases({
          buyerTenantId,
          listingId: query.listingId,
        });
        return { items: purchases, total: purchases.length };
      },
    },

    // ─── Refund Purchase ───
    {
      operationId: "marketplace.purchases.refund",
      method: "POST",
      path: "/v1/marketplace/purchases/:id/refund",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = ctx.body as Record<string, unknown>;
        requireString(body, "reason");

        const purchase = await deps.getPurchase(id);
        if (!purchase) {
          throw new FridayDomainError("PURCHASE_NOT_FOUND", `Purchase "${id}" not found`, { httpStatus: 404 });
        }
        const refunds = await deps.listRefunds(id);

        const result = initiateRefund(
          purchase,
          refunds,
          {
            amount: body.amount as FridayMoneyAmount | undefined,
            reason: body.reason as string,
            initiatedBy: requirePrincipalId(ctx),
          },
          purchaseDeps,
        );
        if (!result.ok) {
          throw new FridayDomainError(result.error.code, result.error.message, { httpStatus: 400 });
        }

        await deps.saveRefund(result.value.refund);
        await deps.savePurchase(result.value.purchase);
        return { refund: result.value.refund, purchase: result.value.purchase };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // ENTITLEMENTS
    // ════════════════════════════════════════════════════════════════

    // ─── Check Entitlement ───
    {
      operationId: "marketplace.entitlements.check",
      method: "GET",
      path: "/v1/marketplace/entitlements/check",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        if (!query.listingId) {
          throw new FridayDomainError("VALIDATION_ERROR", "listingId query parameter is required", { httpStatus: 400 });
        }
        const tenantId = resolveTenantCheckFilter(query.tenantId, ctx);
        const entitlements = await deps.listEntitlements({
          tenantId,
          listingId: query.listingId,
        });

        const active = entitlements.find(
          (e) => e.status === "active" || e.status === "grace",
        );

        return {
          entitled: active != null,
          entitlement: active ?? null,
        };
      },
    },

    // ─── List Entitlements ───
    {
      operationId: "marketplace.entitlements.list",
      method: "GET",
      path: "/v1/marketplace/entitlements",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        const tenantId = resolveTenantListFilter(query.tenantId, ctx);
        const entitlements = await deps.listEntitlements({
          tenantId,
          listingId: query.listingId,
        });
        return { items: entitlements, total: entitlements.length };
      },
    },

    // ─── Install Listing Asset ───
    {
      operationId: "marketplace.listings.install",
      method: "POST",
      path: "/v1/marketplace/listings/:id/install",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const requestedVersionId = body.versionId;
        if (requestedVersionId !== undefined && (typeof requestedVersionId !== "string" || requestedVersionId.trim() === "")) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "\"versionId\" must be a non-empty string when provided",
            { httpStatus: 400 },
          );
        }

        const listing = await deps.getListing(id);
        if (!listing) {
          throw new FridayDomainError("LISTING_NOT_FOUND", `Listing "${id}" not found`, { httpStatus: 404 });
        }

        const versionId = (typeof requestedVersionId === "string" ? requestedVersionId.trim() : listing.currentVersionId) ?? "";
        if (!versionId) {
          throw new FridayDomainError(
            "LISTING_VERSION_NOT_FOUND",
            `Listing "${id}" does not have a resolvable install version`,
            { httpStatus: 409 },
          );
        }

        const version = await deps.getListingVersion(versionId);
        if (!version) {
          throw new FridayDomainError("LISTING_VERSION_NOT_FOUND", `Version "${versionId}" not found`, { httpStatus: 404 });
        }

        const tenantId = requirePrincipalId(ctx);
        const principalId = requirePrincipalId(ctx);
        const entitlements = await deps.listEntitlements({
          tenantId,
          listingId: id,
        });
        const activeEntitlement = entitlements.find((entitlement) =>
          entitlement.status === "active" || entitlement.status === "grace"
        );
        if (!activeEntitlement) {
          deps.auditSink?.({
            entityType: "listing",
            entityId: id,
            action: "listing.installation.denied",
            fromState: null,
            toState: "denied",
            timestamp: deps.now(),
            actor: principalId,
            metadata: {
              reason: "entitlement_required",
            },
          });
          throw new FridayDomainError(
            "MARKETPLACE_ENTITLEMENT_REQUIRED",
            "Listing entitlement required before installation",
            { httpStatus: 403, details: { listingId: id } },
          );
        }

        const existingInstallation = (await deps.listInstallations({
          tenantId,
          listingId: id,
          packageName: version.packageName,
          packageVersion: version.packageVersion,
        }))[0] ?? null;

        const install = dispatchInstall(
          {
            tenantId,
            principalId,
            listing,
            version,
            existingInstallation,
          },
          {
            generateId: deps.generateId,
            now: deps.now,
            agentAssetEnabled: process.env.FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED !== "false",
          },
        );

        if (!install.ok) {
          deps.auditSink?.({
            entityType: "listing",
            entityId: id,
            action: "listing.installation.denied",
            fromState: null,
            toState: "denied",
            timestamp: deps.now(),
            actor: principalId,
            metadata: {
              reason: install.error.code,
            },
          });
          const httpStatus = install.error.code === "INSTALL_LISTING_NOT_INSTALLABLE" ? 409 : 400;
          throw new FridayDomainError(install.error.code, install.error.message, { httpStatus });
        }

        let delivery: {
          status: InstallDeliveryStatus;
          reasonCode: InstallDeliveryReasonCode;
          rollback: {
            attempted: boolean;
            succeeded: boolean;
          };
        };

        if (!install.value.idempotent) {
          let prepareResult: void | {
            rollback?: (input: { reasonCode: string; message?: string }) => Promise<void> | void;
            metadata?: Record<string, unknown>;
          };
          try {
            prepareResult = await deps.beforePersistInstallation?.({
              listingId: id,
              versionId: version.id,
              tenantId,
              principalId,
              installationId: install.value.installation.id,
              assetType: version.assetType,
              packageName: version.packageName,
              packageVersion: version.packageVersion,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reasonCode = "MARKETPLACE_INSTALL_PREPARE_FAILED";
            deps.auditSink?.({
              entityType: "listing",
              entityId: id,
              action: "listing.installation.failed",
              fromState: null,
              toState: "failed",
              timestamp: deps.now(),
              actor: principalId,
              metadata: {
                reasonCode,
                reason: message,
              },
            });
            throw new FridayDomainError(
              "MARKETPLACE_INSTALLATION_FAILED",
              "Installation failed during prepare phase",
              { httpStatus: 500, details: { listingId: id, reasonCode } },
            );
          }

          try {
            await deps.saveInstallation(install.value.installation);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reasonCode = "MARKETPLACE_INSTALL_PERSIST_FAILED";
            let rollbackAttempted = false;
            let rollbackSucceeded = false;
            let rollbackError: string | undefined;

            if (prepareResult && typeof prepareResult === "object" && typeof prepareResult.rollback === "function") {
              rollbackAttempted = true;
              try {
                await prepareResult.rollback({
                  reasonCode,
                  message,
                });
                rollbackSucceeded = true;
              } catch (rollbackFailure) {
                rollbackSucceeded = false;
                rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
              }
            }

            deps.auditSink?.({
              entityType: "listing",
              entityId: id,
              action: "listing.installation.failed",
              fromState: null,
              toState: "failed",
              timestamp: deps.now(),
              actor: principalId,
              metadata: {
                reasonCode,
                reason: message,
                rollbackAttempted,
                rollbackSucceeded,
                ...(rollbackError ? { rollbackError } : {}),
                ...(prepareResult && typeof prepareResult === "object" && prepareResult.metadata
                  ? { prepareMetadataPresent: true }
                  : {}),
              },
            });
            throw new FridayDomainError(
              "MARKETPLACE_INSTALLATION_FAILED",
              "Installation failed before commit",
              {
                httpStatus: 500,
                details: {
                  listingId: id,
                  reasonCode,
                  rollbackAttempted,
                  rollbackSucceeded,
                  ...(rollbackError ? { rollbackError } : {}),
                },
              },
            );
          }

          delivery = {
            status: "installed",
            reasonCode: "MARKETPLACE_INSTALL_COMMITTED",
            rollback: {
              attempted: false,
              succeeded: false,
            },
          };
          deps.auditSink?.({
            entityType: "listing",
            entityId: id,
            action: "listing.installation.completed",
            fromState: null,
            toState: "installed",
            timestamp: deps.now(),
            actor: principalId,
            metadata: {
              installationId: install.value.installation.id,
              reasonCode: delivery.reasonCode,
            },
          });
        } else {
          delivery = {
            status: "idempotent",
            reasonCode: "MARKETPLACE_INSTALL_ALREADY_INSTALLED",
            rollback: {
              attempted: false,
              succeeded: false,
            },
          };
          deps.auditSink?.({
            entityType: "listing",
            entityId: id,
            action: "listing.installation.idempotent",
            fromState: "installed",
            toState: "installed",
            timestamp: deps.now(),
            actor: principalId,
            metadata: {
              installationId: install.value.installation.id,
              reasonCode: delivery.reasonCode,
            },
          });
        }

        return {
          installation: install.value.installation,
          idempotent: install.value.idempotent,
          delivery: {
            status: delivery.status,
            reasonCode: delivery.reasonCode,
            rollback: delivery.rollback,
            assetType: install.value.installation.assetType,
            packageName: install.value.installation.packageName,
            packageVersion: install.value.installation.packageVersion,
          },
        };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // SUBSCRIPTIONS
    // ════════════════════════════════════════════════════════════════

    // ─── List Subscriptions ───
    {
      operationId: "marketplace.subscriptions.list",
      method: "GET",
      path: "/v1/marketplace/subscriptions",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        const buyerTenantId = resolveTenantListFilter(query.buyerTenantId, ctx);
        const subscriptions = await deps.listSubscriptions({
          buyerTenantId,
        });
        return { items: subscriptions, total: subscriptions.length };
      },
    },

    // ─── Get Subscription ───
    {
      operationId: "marketplace.subscriptions.get",
      method: "GET",
      path: "/v1/marketplace/subscriptions/:id",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { id } = ctx.params as { id: string };
        const subscription = await deps.getSubscription(id);
        if (!subscription) {
          throw new FridayDomainError("SUBSCRIPTION_NOT_FOUND", `Subscription "${id}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, subscription.buyerTenantId);
        return { subscription };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // SEARCH & DISCOVERY
    // ════════════════════════════════════════════════════════════════

    // ─── Search Listings ───
    {
      operationId: "marketplace.search",
      method: "GET",
      path: "/v1/marketplace/search",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const query = ctx.query;
        const entries = await deps.getSearchIndex();

        const filters: ListingSearchFilters = {
          query: query.q,
          status: query.status as never,
          publisherId: query.publisherId,
          tag: query.tag,
          pricingType: query.pricingType as never,
        };

        const offset = Math.max(0, Number(query.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
        const sortField = (query.sortBy ?? "createdAt") as "createdAt" | "updatedAt" | "title" | "purchaseCount";
        const sortDir = (query.sortDir ?? "desc") as "asc" | "desc";

        const result = searchListings(
          entries,
          filters,
          { field: sortField, direction: sortDir },
          offset,
          limit,
        );

        return {
          items: result.items,
          total: result.total,
          hasMore: result.hasMore,
        };
      },
    },

    // ════════════════════════════════════════════════════════════════
    // PAYOUTS & EARNINGS
    // ════════════════════════════════════════════════════════════════

    // ─── Get Earnings Summary ───
    {
      operationId: "marketplace.earnings.summary",
      method: "GET",
      path: "/v1/marketplace/publishers/:publisherId/earnings",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { publisherId } = ctx.params as { publisherId: string };
        const publisher = await deps.getPublisher(publisherId);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${publisherId}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, publisher.tenantId);
        const entries = await deps.listPayoutEntries({ publisherId });
        const batches = await deps.listPayoutBatches({ publisherId });
        const summary = computeEarningsSummary(publisherId, entries, batches, payoutDeps);
        if (!summary.ok) {
          throw new FridayDomainError(
            summary.error.code,
            summary.error.message,
            { httpStatus: summary.error.code === "PAYOUT_CURRENCY_MISMATCH" ? 409 : 400 },
          );
        }
        return { summary: summary.value };
      },
    },

    // ─── List Payout Entries ───
    {
      operationId: "marketplace.payout.entries.list",
      method: "GET",
      path: "/v1/marketplace/publishers/:publisherId/payout-entries",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { publisherId } = ctx.params as { publisherId: string };
        const publisher = await deps.getPublisher(publisherId);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${publisherId}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, publisher.tenantId);

        const query = ctx.query as Record<string, unknown>;
        const status = readStringQuery(query.status);
        if (status && !(FRIDAY_PAYOUT_ENTRY_STATUSES as readonly string[]).includes(status)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `"status" must be one of: ${FRIDAY_PAYOUT_ENTRY_STATUSES.join(", ")}`,
            { httpStatus: 400 },
          );
        }

        const entries = await deps.listPayoutEntries({
          publisherId,
          status,
          listingId: readStringQuery(query.listingId),
          after: readStringQuery(query.after),
          before: readStringQuery(query.before),
        });
        const sortBy = query.sortBy === "netAmount" ? "netAmount" : "createdAt";
        const sortDir = query.sortDir === "asc" ? "asc" : "desc";
        const sorted = [...entries].sort((a, b) => {
          const left = sortBy === "netAmount" ? a.netAmount.amount : Date.parse(a.createdAt);
          const right = sortBy === "netAmount" ? b.netAmount.amount : Date.parse(b.createdAt);
          return sortDir === "asc" ? left - right : right - left;
        });
        const offset = readOffsetQuery(query.offset);
        const limit = readLimitQuery(query.limit);
        const items = sorted.slice(offset, offset + limit);
        return {
          items,
          total: sorted.length,
          hasMore: offset + limit < sorted.length,
        };
      },
    },

    // ─── List Payout Batches ───
    {
      operationId: "marketplace.payout.batches.list",
      method: "GET",
      path: "/v1/marketplace/publishers/:publisherId/payout-batches",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { publisherId } = ctx.params as { publisherId: string };
        const publisher = await deps.getPublisher(publisherId);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${publisherId}" not found`, { httpStatus: 404 });
        }
        assertMarketplaceTenantAccess(ctx, publisher.tenantId);

        const query = ctx.query as Record<string, unknown>;
        const status = readStringQuery(query.status);
        if (status && !(FRIDAY_PAYOUT_BATCH_STATUSES as readonly string[]).includes(status)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `"status" must be one of: ${FRIDAY_PAYOUT_BATCH_STATUSES.join(", ")}`,
            { httpStatus: 400 },
          );
        }

        const batches = await deps.listPayoutBatches({
          publisherId,
          status,
        });
        const sortBy = query.sortBy === "totalAmount" ? "totalAmount" : "initiatedAt";
        const sortDir = query.sortDir === "asc" ? "asc" : "desc";
        const sorted = [...batches].sort((a, b) => {
          const left = sortBy === "totalAmount" ? a.totalAmount.amount : Date.parse(a.initiatedAt);
          const right = sortBy === "totalAmount" ? b.totalAmount.amount : Date.parse(b.initiatedAt);
          return sortDir === "asc" ? left - right : right - left;
        });
        const offset = readOffsetQuery(query.offset);
        const limit = readLimitQuery(query.limit);
        const items = sorted.slice(offset, offset + limit);
        return {
          items,
          total: sorted.length,
          hasMore: offset + limit < sorted.length,
        };
      },
    },

    // ─── Get Payout Batch ───
    {
      operationId: "marketplace.payout.batches.get",
      method: "GET",
      path: "/v1/marketplace/payout-batches/:batchId",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { batchId } = ctx.params as { batchId: string };
        const batch = await deps.getPayoutBatch(batchId);
        if (!batch) {
          throw new FridayDomainError("PAYOUT_BATCH_NOT_FOUND", `Payout batch "${batchId}" not found`, { httpStatus: 404 });
        }
        const publisher = await deps.getPublisher(batch.publisherId);
        if (publisher) {
          assertMarketplaceTenantAccess(ctx, publisher.tenantId);
        } else if (!isPrivilegedMarketplacePrincipal(ctx)) {
          throw new FridayDomainError("FORBIDDEN", "Tenant access denied", { httpStatus: 403 });
        }
        return { batch };
      },
    },

    // ─── List Payout Batch Entries ───
    {
      operationId: "marketplace.payout.batches.entries.list",
      method: "GET",
      path: "/v1/marketplace/payout-batches/:batchId/entries",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const { batchId } = ctx.params as { batchId: string };
        const batch = await deps.getPayoutBatch(batchId);
        if (!batch) {
          throw new FridayDomainError("PAYOUT_BATCH_NOT_FOUND", `Payout batch "${batchId}" not found`, { httpStatus: 404 });
        }
        const publisher = await deps.getPublisher(batch.publisherId);
        if (publisher) {
          assertMarketplaceTenantAccess(ctx, publisher.tenantId);
        } else if (!isPrivilegedMarketplacePrincipal(ctx)) {
          throw new FridayDomainError("FORBIDDEN", "Tenant access denied", { httpStatus: 403 });
        }

        const query = ctx.query as Record<string, unknown>;
        const sortBy = query.sortBy === "netAmount" ? "netAmount" : "createdAt";
        const sortDir = query.sortDir === "asc" ? "asc" : "desc";
        const entries = await deps.listPayoutBatchEntries(batchId);
        const sorted = [...entries].sort((a, b) => {
          const left = sortBy === "netAmount" ? a.netAmount.amount : Date.parse(a.createdAt);
          const right = sortBy === "netAmount" ? b.netAmount.amount : Date.parse(b.createdAt);
          return sortDir === "asc" ? left - right : right - left;
        });
        const offset = readOffsetQuery(query.offset);
        const limit = readLimitQuery(query.limit);
        const items = sorted.slice(offset, offset + limit);
        return {
          items,
          total: sorted.length,
          hasMore: offset + limit < sorted.length,
        };
      },
    },

    // ─── Initiate Payout Batch ───
    {
      operationId: "marketplace.payout.batches.initiate",
      method: "POST",
      path: "/v1/marketplace/publishers/:publisherId/payout-batches",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      rateLimitPolicyId: "marketplace.write",
      async handler(ctx: Ctx) {
        const { publisherId } = ctx.params as { publisherId: string };
        const publisher = await deps.getPublisher(publisherId);
        if (!publisher) {
          throw new FridayDomainError("PUBLISHER_NOT_FOUND", `Publisher "${publisherId}" not found`, { httpStatus: 404 });
        }
        if (!isPrivilegedMarketplacePrincipal(ctx)) {
          assertMarketplaceTenantAccess(ctx, publisher.tenantId);
        }

        const body = ctx.body as Record<string, unknown>;
        requireString(body, "periodStart");
        requireString(body, "periodEnd");
        requireString(body, "idempotencyKey");

        const periodStart = body.periodStart as ISODateTime;
        const periodEnd = body.periodEnd as ISODateTime;
        if (!Number.isFinite(Date.parse(periodStart)) || !Number.isFinite(Date.parse(periodEnd)) || Date.parse(periodStart) >= Date.parse(periodEnd)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "\"periodStart\" and \"periodEnd\" must be valid ISO timestamps with periodStart < periodEnd",
            { httpStatus: 400 },
          );
        }

        const pendingEntries = await deps.listPayoutEntries({
          publisherId,
          status: "pending",
          after: periodStart,
          before: periodEnd,
        });
        const batchResult = createPayoutBatch(
          publisherId,
          pendingEntries,
          periodStart,
          periodEnd,
          undefined,
          payoutDeps,
        );
        if (!batchResult.ok) {
          throw new FridayDomainError(
            batchResult.error.code,
            batchResult.error.message,
            {
              httpStatus:
                batchResult.error.code === "PAYOUT_NO_PENDING_ENTRIES" ||
                  batchResult.error.code === "PAYOUT_BELOW_THRESHOLD"
                  ? 409
                  : 400,
            },
          );
        }

        await deps.savePayoutBatch(batchResult.value.batch);
        await deps.savePayoutEntries(batchResult.value.entries);
        return { batch: batchResult.value.batch };
      },
    },

    // ─── List Billing Events ───
    {
      operationId: "marketplace.billing.events.list",
      method: "GET",
      path: "/v1/marketplace/billing-events",
      auth: { public: false, anyOfScopes: ["marketplace.admin"] },
      async handler(ctx: Ctx) {
        const query = ctx.query as Record<string, unknown>;
        const eventType = readStringQuery(query.eventType);
        if (eventType && !(FRIDAY_BILLING_EVENT_TYPES as readonly string[]).includes(eventType)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `"eventType" must be one of: ${FRIDAY_BILLING_EVENT_TYPES.join(", ")}`,
            { httpStatus: 400 },
          );
        }

        const events = await deps.listBillingEvents({
          eventType,
          processed: readBooleanQuery(query.processed),
          after: readStringQuery(query.after),
          before: readStringQuery(query.before),
        });
        const sorted = [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const offset = readOffsetQuery(query.offset);
        const limit = readLimitQuery(query.limit);
        const items = sorted.slice(offset, offset + limit);
        return {
          items,
          total: sorted.length,
          hasMore: offset + limit < sorted.length,
        };
      },
    },
  ];
}

// ─── Validation Helpers ───

function requirePrincipalId(ctx: Ctx): string {
  if (!ctx.principal?.principalId) {
    throw new FridayDomainError(
      "AUTH_REQUIRED",
      "Authentication is required for this operation",
      { httpStatus: 401 },
    );
  }
  return ctx.principal.principalId;
}

function requireString(body: Record<string, unknown>, field: string): void {
  if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" is required and must be a non-empty string`,
      { httpStatus: 400 },
    );
  }
}

function requireOneOf(body: Record<string, unknown>, field: string, values: readonly string[]): void {
  requireString(body, field);
  if (!values.includes(body[field] as string)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be one of: ${values.join(", ")}`,
      { httpStatus: 400 },
    );
  }
}

function requireAssetType(body: Record<string, unknown>, field: string): void {
  requireString(body, field);
  const value = body[field] as string;
  if (!(FRIDAY_MARKETPLACE_ASSET_TYPES as readonly string[]).includes(value)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be one of: ${FRIDAY_MARKETPLACE_ASSET_TYPES.join(", ")}`,
      { httpStatus: 400 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireMvpPricingPlan(value: unknown, field: string): Record<string, unknown> {
  const plan = asRecord(value);
  if (!plan) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}" must be an object`,
      { httpStatus: 400 },
    );
  }
  requireString(plan, "type");
  const type = plan.type as string;
  if (!(FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES as readonly string[]).includes(type)) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `"${field}.type" must be one of: ${FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES.join(", ")}`,
      { httpStatus: 400 },
    );
  }
  return plan;
}

function isPrivilegedMarketplacePrincipal(ctx: Ctx): boolean {
  const principal = ctx.principal;
  if (!principal) {
    return false;
  }
  if (principal.scopes.includes("hub.admin") || principal.scopes.includes("marketplace.admin")) {
    return true;
  }
  return principal.role === "owner" || principal.role === "admin";
}

function assertMarketplaceTenantAccess(ctx: Ctx, tenantId: string): void {
  if (isPrivilegedMarketplacePrincipal(ctx)) {
    return;
  }
  const principal = ctx.principal;
  if (!principal?.principalId) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  const principalTenantId = typeof principal.tenantId === "string" && principal.tenantId.trim().length > 0
    ? principal.tenantId.trim()
    : principal.principalId;
  if (principalTenantId !== tenantId) {
    throw new FridayDomainError("FORBIDDEN", "Tenant access denied", { httpStatus: 403 });
  }
}

function resolveTenantCheckFilter(requestedTenantId: string | undefined, ctx: Ctx): string {
  const tenantId = typeof requestedTenantId === "string" && requestedTenantId.trim().length > 0
    ? requestedTenantId.trim()
    : (typeof ctx.principal?.tenantId === "string" && ctx.principal.tenantId.trim().length > 0
      ? ctx.principal.tenantId.trim()
      : ctx.principal?.principalId);
  if (!tenantId) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  assertMarketplaceTenantAccess(ctx, tenantId);
  return tenantId;
}

function resolveTenantListFilter(requestedTenantId: string | undefined, ctx: Ctx): string | undefined {
  const tenantId = typeof requestedTenantId === "string" && requestedTenantId.trim().length > 0
    ? requestedTenantId.trim()
    : undefined;
  if (tenantId) {
    assertMarketplaceTenantAccess(ctx, tenantId);
    return tenantId;
  }
  if (isPrivilegedMarketplacePrincipal(ctx)) {
    return undefined;
  }
  const principal = ctx.principal;
  if (!principal?.principalId) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  return typeof principal.tenantId === "string" && principal.tenantId.trim().length > 0
    ? principal.tenantId.trim()
    : principal.principalId;
}

function readStringQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanQuery(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return undefined;
}

function readOffsetQuery(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function readLimitQuery(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(100, Math.floor(parsed));
}
