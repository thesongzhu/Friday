import type { FridaySqliteLayer } from "#state";
import type {
  FridayBillingEvent,
  FridayBillingEventRow,
  FridayBillingWebhook,
  FridayBillingWebhookRow,
  FridayEntitlement,
  FridayEntitlementRow,
  FridayInstallation,
  FridayInstallationRow,
  FridayListing,
  FridayListingRow,
  FridayListingVersion,
  FridayListingVersionRow,
  FridayMarketplaceRequestPost,
  FridayMarketplaceRequestResponse,
  FridayMarketplaceRequestResponseRow,
  FridayMarketplaceRequestRow,
  FridayPayoutBatch,
  FridayPayoutBatchRow,
  FridayPayoutEntry,
  FridayPayoutEntryRow,
  FridayPricingPlan,
  FridayPricingPlanRecord,
  FridayPricingPlanRow,
  FridayPublisher,
  FridayPublisherRow,
  FridayPublisherVerification,
  FridayPurchase,
  FridayPurchaseRow,
  FridayRefund,
  FridayRefundRow,
  FridaySubscription,
  FridaySubscriptionRow,
  FridaySupportEvent,
  FridaySupportEventRow,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-marketplace.types.js";
import { fridayMoney } from "../model/friday-marketplace.types.js";
import type { ListingSearchEntry } from "../engine/search-discovery.js";

export interface FridayMarketplaceCommercePersistence {
  getPublisher(id: UUID): Promise<FridayPublisher | null>;
  getPublisherByPrincipal(tenantId: string, principalId: string): Promise<FridayPublisher | null>;
  getPublisherVerification(publisherId: UUID): Promise<FridayPublisherVerification | null>;
  listPublishers(tenantId?: string): Promise<FridayPublisher[]>;

  getListing(id: UUID): Promise<FridayListing | null>;
  getListingBySlug(slug: string): Promise<FridayListing | null>;
  listListings(filters?: { publisherId?: UUID; status?: string }): Promise<FridayListing[]>;
  getListingVersion(id: UUID): Promise<FridayListingVersion | null>;
  listListingVersions(listingId: UUID): Promise<FridayListingVersion[]>;

  getPricingPlan(id: UUID): Promise<FridayPricingPlanRecord | null>;
  listPricingPlans(listingId: UUID): Promise<FridayPricingPlanRecord[]>;

  getPurchase(id: UUID): Promise<FridayPurchase | null>;
  getPurchaseByExternalPaymentId(externalPaymentId: string): Promise<FridayPurchase | null>;
  listPurchases(filters?: { buyerTenantId?: string; listingId?: UUID }): Promise<FridayPurchase[]>;

  getEntitlement(id: UUID): Promise<FridayEntitlement | null>;
  listEntitlements(filters?: { tenantId?: string; listingId?: UUID }): Promise<FridayEntitlement[]>;
  getInstallation(id: UUID): Promise<FridayInstallation | null>;
  listInstallations(filters?: {
    tenantId?: string;
    listingId?: UUID;
    packageName?: string;
    packageVersion?: string;
    status?: string;
  }): Promise<FridayInstallation[]>;
  listSupportEvents(filters?: {
    creatorId?: string;
    assetId?: string;
    supporterPrincipalId?: string;
    includeQuarantined?: boolean;
  }): Promise<FridaySupportEvent[]>;
  listRequests(filters?: {
    assetKind?: string;
    status?: string;
    requesterPrincipalId?: string;
    privacy?: string;
    includeQuarantined?: boolean;
  }): Promise<FridayMarketplaceRequestPost[]>;
  getRequest(id: UUID, options?: { includeQuarantined?: boolean }): Promise<FridayMarketplaceRequestPost | null>;
  listRequestResponses(
    requestId: UUID,
    options?: { includeQuarantined?: boolean },
  ): Promise<FridayMarketplaceRequestResponse[]>;
  listAcceptedRequestCountsByCreator(): Promise<
    readonly {
      creatorId: string;
      count: number;
    }[]
  >;

  listSubscriptions(filters?: { buyerTenantId?: string }): Promise<FridaySubscription[]>;
  getSubscription(id: UUID): Promise<FridaySubscription | null>;

  listRefunds(purchaseId: UUID): Promise<FridayRefund[]>;
  getRefundByExternalRefundId(externalRefundId: string): Promise<FridayRefund | null>;

  listPayoutEntries(filters?: {
    publisherId?: UUID;
    status?: string;
    listingId?: UUID;
    payoutBatchId?: UUID;
    after?: ISODateTime;
    before?: ISODateTime;
  }): Promise<FridayPayoutEntry[]>;
  listPayoutBatches(filters?: {
    publisherId?: UUID;
    status?: string;
  }): Promise<FridayPayoutBatch[]>;
  getPayoutBatch(id: UUID): Promise<FridayPayoutBatch | null>;
  listPayoutBatchEntries(batchId: UUID): Promise<FridayPayoutEntry[]>;

  listBillingEvents(filters?: {
    eventType?: string;
    processed?: boolean;
    after?: ISODateTime;
    before?: ISODateTime;
    limit?: number;
  }): Promise<FridayBillingEvent[]>;
  getUnprocessedBillingEvents(limit: number): Promise<FridayBillingEvent[]>;
  markBillingEventProcessed(eventId: UUID): Promise<void>;
  getBillingWebhookByExternalId(provider: string, externalId: string): Promise<FridayBillingWebhook | null>;

  getSearchIndex(): Promise<ListingSearchEntry[]>;

  savePublisher(publisher: FridayPublisher): Promise<void>;
  saveListing(listing: FridayListing): Promise<void>;
  saveListingVersion(version: FridayListingVersion): Promise<void>;
  savePricingPlan(plan: FridayPricingPlanRecord): Promise<void>;
  savePurchase(purchase: FridayPurchase): Promise<void>;
  saveEntitlement(entitlement: FridayEntitlement): Promise<void>;
  saveInstallation(installation: FridayInstallation): Promise<void>;
  saveSupportEvent(event: FridaySupportEvent): Promise<void>;
  saveRequest(request: FridayMarketplaceRequestPost): Promise<void>;
  saveRequestResponse(response: FridayMarketplaceRequestResponse): Promise<void>;
  saveSubscription(subscription: FridaySubscription): Promise<void>;
  saveRefund(refund: FridayRefund): Promise<void>;
  savePayoutEntry(entry: FridayPayoutEntry): Promise<void>;
  savePayoutEntries(entries: readonly FridayPayoutEntry[]): Promise<void>;
  savePayoutBatch(batch: FridayPayoutBatch): Promise<void>;
  saveBillingEvent(event: FridayBillingEvent): Promise<void>;
  saveBillingWebhook(webhook: FridayBillingWebhook): Promise<void>;
}

interface CreateFridayMarketplaceCommercePersistenceDeps {
  db: FridaySqliteLayer;
}

const MARKETPLACE_ACTOR_SCHEMA_VERSION = 2;

export function createFridayMarketplaceCommercePersistence(
  deps: CreateFridayMarketplaceCommercePersistenceDeps,
): FridayMarketplaceCommercePersistence {
  return {
    async getPublisher(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_publishers WHERE id = ?").get(id) as FridayPublisherRow | undefined;
        return row ? mapPublisherRow(row) : null;
      });
    },

    async getPublisherByPrincipal(tenantId, principalId) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare(
          "SELECT * FROM marketplace_publishers WHERE tenant_id = ? AND principal_id = ? LIMIT 1",
        ).get(tenantId, principalId) as FridayPublisherRow | undefined;
        return row ? mapPublisherRow(row) : null;
      });
    },

    async getPublisherVerification(publisherId) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_publishers WHERE id = ?").get(publisherId) as FridayPublisherRow | undefined;
        if (!row) return null;
        if (!row.legal_name || !row.tax_id_last4 || !row.country || !row.payout_method) {
          return null;
        }
        const status = normalizePublisherVerificationStatus(row.verification_status);
        return {
          publisherId: row.id,
          legalName: row.legal_name,
          taxIdLast4: row.tax_id_last4,
          country: row.country,
          payoutMethod: row.payout_method,
          submittedAt: row.updated_at,
          status,
          reviewerNotes: null,
          reviewedAt: status === "verified" || status === "suspended" ? row.updated_at : null,
        };
      });
    },

    async listPublishers(tenantId) {
      return deps.db.withReadConnection((conn) => {
        const rows = tenantId
          ? conn.prepare("SELECT * FROM marketplace_publishers WHERE tenant_id = ? ORDER BY created_at DESC").all(tenantId)
          : conn.prepare("SELECT * FROM marketplace_publishers ORDER BY created_at DESC").all();
        return (rows as FridayPublisherRow[]).map(mapPublisherRow);
      });
    },

    async getListing(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_listings WHERE id = ?").get(id) as FridayListingRow | undefined;
        return row ? mapListingRow(row) : null;
      });
    },

    async getListingBySlug(slug) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_listings WHERE slug = ?").get(slug) as FridayListingRow | undefined;
        return row ? mapListingRow(row) : null;
      });
    },

    async listListings(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.publisherId) {
          conditions.push("publisher_id = ?");
          values.push(filters.publisherId);
        }
        if (filters?.status) {
          conditions.push("status = ?");
          values.push(filters.status);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_listings ${where} ORDER BY created_at DESC`).all(...values);
        return (rows as FridayListingRow[]).map(mapListingRow);
      });
    },

    async getListingVersion(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_listing_versions WHERE id = ?").get(id) as FridayListingVersionRow | undefined;
        return row ? mapListingVersionRow(row) : null;
      });
    },

    async listListingVersions(listingId) {
      return deps.db.withReadConnection((conn) => {
        const rows = conn.prepare(
          "SELECT * FROM marketplace_listing_versions WHERE listing_id = ? ORDER BY version_number DESC",
        ).all(listingId);
        return (rows as FridayListingVersionRow[]).map(mapListingVersionRow);
      });
    },

    async getPricingPlan(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_pricing_plans WHERE id = ?").get(id) as FridayPricingPlanRow | undefined;
        return row ? mapPricingPlanRow(row) : null;
      });
    },

    async listPricingPlans(listingId) {
      return deps.db.withReadConnection((conn) => {
        const rows = conn.prepare(
          "SELECT * FROM marketplace_pricing_plans WHERE listing_id = ? ORDER BY created_at DESC",
        ).all(listingId);
        return (rows as FridayPricingPlanRow[]).map(mapPricingPlanRow);
      });
    },

    async getPurchase(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_purchases WHERE id = ?").get(id) as FridayPurchaseRow | undefined;
        return row ? mapPurchaseRow(row) : null;
      });
    },

    async getPurchaseByExternalPaymentId(externalPaymentId) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare(
          "SELECT * FROM marketplace_purchases WHERE external_payment_id = ? LIMIT 1",
        ).get(externalPaymentId) as FridayPurchaseRow | undefined;
        return row ? mapPurchaseRow(row) : null;
      });
    },

    async listPurchases(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.buyerTenantId) {
          conditions.push("buyer_tenant_id = ?");
          values.push(filters.buyerTenantId);
        }
        if (filters?.listingId) {
          conditions.push("listing_id = ?");
          values.push(filters.listingId);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_purchases ${where} ORDER BY created_at DESC`).all(...values);
        return (rows as FridayPurchaseRow[]).map(mapPurchaseRow);
      });
    },

    async getEntitlement(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_entitlements WHERE id = ?").get(id) as FridayEntitlementRow | undefined;
        return row ? mapEntitlementRow(row) : null;
      });
    },

    async listEntitlements(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.tenantId) {
          conditions.push("tenant_id = ?");
          values.push(filters.tenantId);
        }
        if (filters?.listingId) {
          conditions.push("listing_id = ?");
          values.push(filters.listingId);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_entitlements ${where} ORDER BY created_at DESC`).all(...values);
        return (rows as FridayEntitlementRow[]).map(mapEntitlementRow);
      });
    },

    async getInstallation(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_installations WHERE id = ?").get(id) as FridayInstallationRow | undefined;
        return row ? mapInstallationRow(row) : null;
      });
    },

    async listInstallations(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.tenantId) {
          conditions.push("tenant_id = ?");
          values.push(filters.tenantId);
        }
        if (filters?.listingId) {
          conditions.push("listing_id = ?");
          values.push(filters.listingId);
        }
        if (filters?.packageName) {
          conditions.push("package_name = ?");
          values.push(filters.packageName);
        }
        if (filters?.packageVersion) {
          conditions.push("package_version = ?");
          values.push(filters.packageVersion);
        }
        if (filters?.status) {
          conditions.push("status = ?");
          values.push(filters.status);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_installations ${where} ORDER BY updated_at DESC`).all(...values);
        return (rows as FridayInstallationRow[]).map(mapInstallationRow);
      });
    },

    async listSupportEvents(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];
        if (filters?.includeQuarantined !== true) {
          conditions.push("COALESCE(actor_quarantined, 0) = 0");
        }
        if (filters?.creatorId) {
          conditions.push("creator_id = ?");
          values.push(filters.creatorId);
        }
        if (filters?.assetId) {
          conditions.push("asset_id = ?");
          values.push(filters.assetId);
        }
        if (filters?.supporterPrincipalId) {
          conditions.push("supporter_principal_id = ?");
          values.push(filters.supporterPrincipalId);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn
          .prepare(`SELECT * FROM marketplace_support_events ${where} ORDER BY created_at DESC`)
          .all(...values);
        return (rows as FridaySupportEventRow[]).map(mapSupportEventRow);
      });
    },

    async listRequests(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];
        if (filters?.includeQuarantined !== true) {
          conditions.push("COALESCE(actor_quarantined, 0) = 0");
        }
        if (filters?.assetKind) {
          conditions.push("asset_kind = ?");
          values.push(filters.assetKind);
        }
        if (filters?.status) {
          conditions.push("status = ?");
          values.push(filters.status);
        }
        if (filters?.requesterPrincipalId) {
          conditions.push("requester_principal_id = ?");
          values.push(filters.requesterPrincipalId);
        }
        if (filters?.privacy) {
          conditions.push("privacy = ?");
          values.push(filters.privacy);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn
          .prepare(`SELECT * FROM marketplace_requests ${where} ORDER BY updated_at DESC, created_at DESC`)
          .all(...values);
        return (rows as FridayMarketplaceRequestRow[]).map(mapRequestRow);
      });
    },

    async getRequest(id, options) {
      return deps.db.withReadConnection((conn) => {
        const statement = options?.includeQuarantined === true
          ? "SELECT * FROM marketplace_requests WHERE id = ?"
          : "SELECT * FROM marketplace_requests WHERE id = ? AND COALESCE(actor_quarantined, 0) = 0";
        const row = conn.prepare(statement).get(id) as FridayMarketplaceRequestRow | undefined;
        return row ? mapRequestRow(row) : null;
      });
    },

    async listRequestResponses(requestId, options) {
      return deps.db.withReadConnection((conn) => {
        const statement = options?.includeQuarantined === true
          ? "SELECT * FROM marketplace_request_responses WHERE request_id = ? ORDER BY created_at ASC"
          : "SELECT * FROM marketplace_request_responses WHERE request_id = ? AND COALESCE(actor_quarantined, 0) = 0 ORDER BY created_at ASC";
        const rows = conn.prepare(statement).all(requestId);
        return (rows as FridayMarketplaceRequestResponseRow[]).map(mapRequestResponseRow);
      });
    },

    async listAcceptedRequestCountsByCreator() {
      return deps.db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT responder_creator_id AS creator_id, COUNT(*) AS accepted_count
               FROM marketplace_request_responses
              WHERE COALESCE(actor_quarantined, 0) = 0
                AND id IN (
                SELECT accepted_response_id
                  FROM marketplace_requests
                 WHERE accepted_response_id IS NOT NULL
                   AND COALESCE(actor_quarantined, 0) = 0
              )
                AND responder_creator_id IS NOT NULL
              GROUP BY responder_creator_id`,
          )
          .all() as Array<{ creator_id: string; accepted_count: number }>;
        return rows.map((row) => ({
          creatorId: row.creator_id,
          count: Number(row.accepted_count),
        }));
      });
    },

    async listSubscriptions(filters) {
      return deps.db.withReadConnection((conn) => {
        const rows = filters?.buyerTenantId
          ? conn.prepare(
            "SELECT * FROM marketplace_subscriptions WHERE buyer_tenant_id = ? ORDER BY created_at DESC",
          ).all(filters.buyerTenantId)
          : conn.prepare("SELECT * FROM marketplace_subscriptions ORDER BY created_at DESC").all();
        return (rows as FridaySubscriptionRow[]).map(mapSubscriptionRow);
      });
    },

    async getSubscription(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_subscriptions WHERE id = ?").get(id) as FridaySubscriptionRow | undefined;
        return row ? mapSubscriptionRow(row) : null;
      });
    },

    async listRefunds(purchaseId) {
      return deps.db.withReadConnection((conn) => {
        const rows = conn.prepare(
          "SELECT * FROM marketplace_refunds WHERE purchase_id = ? ORDER BY created_at DESC",
        ).all(purchaseId);
        return (rows as FridayRefundRow[]).map(mapRefundRow);
      });
    },

    async getRefundByExternalRefundId(externalRefundId) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare(
          "SELECT * FROM marketplace_refunds WHERE external_refund_id = ? LIMIT 1",
        ).get(externalRefundId) as FridayRefundRow | undefined;
        return row ? mapRefundRow(row) : null;
      });
    },

    async listPayoutEntries(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.publisherId) {
          conditions.push("publisher_id = ?");
          values.push(filters.publisherId);
        }
        if (filters?.status) {
          conditions.push("status = ?");
          values.push(filters.status);
        }
        if (filters?.listingId) {
          conditions.push("listing_id = ?");
          values.push(filters.listingId);
        }
        if (filters?.payoutBatchId) {
          conditions.push("payout_batch_id = ?");
          values.push(filters.payoutBatchId);
        }
        if (filters?.after) {
          conditions.push("created_at >= ?");
          values.push(filters.after);
        }
        if (filters?.before) {
          conditions.push("created_at < ?");
          values.push(filters.before);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_payout_entries ${where} ORDER BY created_at DESC`).all(...values);
        return (rows as FridayPayoutEntryRow[]).map(mapPayoutEntryRow);
      });
    },

    async listPayoutBatches(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.publisherId) {
          conditions.push("publisher_id = ?");
          values.push(filters.publisherId);
        }
        if (filters?.status) {
          conditions.push("status = ?");
          values.push(filters.status);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = conn.prepare(`SELECT * FROM marketplace_payout_batches ${where} ORDER BY initiated_at DESC`).all(...values);
        return (rows as FridayPayoutBatchRow[]).map(mapPayoutBatchRow);
      });
    },

    async getPayoutBatch(id) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare("SELECT * FROM marketplace_payout_batches WHERE id = ?").get(id) as FridayPayoutBatchRow | undefined;
        return row ? mapPayoutBatchRow(row) : null;
      });
    },

    async listPayoutBatchEntries(batchId) {
      return deps.db.withReadConnection((conn) => {
        const rows = conn.prepare(
          "SELECT * FROM marketplace_payout_entries WHERE payout_batch_id = ? ORDER BY created_at DESC",
        ).all(batchId);
        return (rows as FridayPayoutEntryRow[]).map(mapPayoutEntryRow);
      });
    },

    async listBillingEvents(filters) {
      return deps.db.withReadConnection((conn) => {
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (filters?.eventType) {
          conditions.push("event_type = ?");
          values.push(filters.eventType);
        }
        if (typeof filters?.processed === "boolean") {
          conditions.push("processed = ?");
          values.push(filters.processed ? 1 : 0);
        }
        if (filters?.after) {
          conditions.push("created_at >= ?");
          values.push(filters.after);
        }
        if (filters?.before) {
          conditions.push("created_at < ?");
          values.push(filters.before);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit) && filters.limit > 0
          ? ` LIMIT ${Math.floor(filters.limit)}`
          : "";
        const rows = conn.prepare(
          `SELECT * FROM marketplace_billing_events ${where} ORDER BY created_at DESC${limit}`,
        ).all(...values);
        return (rows as FridayBillingEventRow[]).map(mapBillingEventRow);
      });
    },

    async getUnprocessedBillingEvents(limit) {
      return deps.db.withReadConnection((conn) => {
        const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
        const rows = conn.prepare(
          "SELECT * FROM marketplace_billing_events WHERE processed = 0 ORDER BY created_at ASC LIMIT ?",
        ).all(safeLimit);
        return (rows as FridayBillingEventRow[]).map(mapBillingEventRow);
      });
    },

    async markBillingEventProcessed(eventId) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare("UPDATE marketplace_billing_events SET processed = 1 WHERE id = ?").run(eventId);
      });
    },

    async getBillingWebhookByExternalId(provider, externalId) {
      return deps.db.withReadConnection((conn) => {
        const row = conn.prepare(
          "SELECT * FROM marketplace_billing_webhooks WHERE provider = ? AND external_id = ? LIMIT 1",
        ).get(provider, externalId) as FridayBillingWebhookRow | undefined;
        return row ? mapBillingWebhookRow(row) : null;
      });
    },

    async getSearchIndex() {
      return deps.db.withReadConnection((conn) => {
        const rows = conn.prepare(`
          SELECT
            l.id AS listing_id,
            l.publisher_id AS listing_publisher_id,
            l.slug AS listing_slug,
            l.status AS listing_status,
            l.current_version_id AS listing_current_version_id,
            l.pending_version_id AS listing_pending_version_id,
            l.tenant_id AS listing_tenant_id,
            l.tags_json AS listing_tags_json,
            l.created_at AS listing_created_at,
            l.updated_at AS listing_updated_at,

            v.id AS version_id,
            v.listing_id AS version_listing_id,
            v.version_number AS version_number,
            v.status AS version_status,
            v.title AS version_title,
            v.description AS version_description,
            v.long_description AS version_long_description,
            v.screenshot_urls_json AS version_screenshot_urls_json,
            v.package_name AS version_package_name,
            v.package_version AS version_package_version,
            v.asset_type AS version_asset_type,
            v.distribution_mode AS version_distribution_mode,
            v.permission_manifest_json AS version_permission_manifest_json,
            v.pricing_plan_json AS version_pricing_plan_json,
            v.release_notes AS version_release_notes,
            v.created_at AS version_created_at,

            COALESCE(p.purchase_count, 0) AS purchase_count
          FROM marketplace_listings l
          JOIN marketplace_listing_versions v ON v.id = l.current_version_id
          LEFT JOIN (
            SELECT listing_id, COUNT(*) AS purchase_count
            FROM marketplace_purchases
            WHERE status = 'completed'
            GROUP BY listing_id
          ) p ON p.listing_id = l.id
        `).all() as Array<Record<string, unknown>>;

        return rows.map((row) => ({
          listing: {
            id: row.listing_id as string,
            publisherId: row.listing_publisher_id as string,
            slug: row.listing_slug as string,
            status: normalizeListingStatus(row.listing_status as string),
            currentVersionId: nullableString(row.listing_current_version_id),
            pendingVersionId: nullableString(row.listing_pending_version_id),
            tenantId: nullableString(row.listing_tenant_id),
            tags: parseStringArray(row.listing_tags_json),
            createdAt: row.listing_created_at as string,
            updatedAt: row.listing_updated_at as string,
          },
          version: {
            id: row.version_id as string,
            listingId: row.version_listing_id as string,
            versionNumber: Number(row.version_number),
            status: normalizeListingVersionStatus(row.version_status as string),
            title: row.version_title as string,
            description: row.version_description as string,
            longDescription: nullableString(row.version_long_description),
            screenshotUrls: parseStringArray(row.version_screenshot_urls_json),
            packageName: row.version_package_name as string,
            packageVersion: row.version_package_version as string,
            assetType: normalizeAssetType(row.version_asset_type as string),
            distributionMode: normalizeDistributionMode(
              row.version_distribution_mode as string,
            ),
            permissionManifest: parsePermissionManifestJson(
              row.version_permission_manifest_json as string,
            ),
            pricingPlan: parsePricingPlanJson(row.version_pricing_plan_json),
            releaseNotes: nullableString(row.version_release_notes),
            createdAt: row.version_created_at as string,
          },
          purchaseCount: Number(row.purchase_count),
        } satisfies ListingSearchEntry));
      });
    },

    async savePublisher(publisher) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_publishers (
             id, tenant_id, principal_id, display_name, bio, avatar_url, website_url,
             contact_email, verification_status, legal_name, tax_id_last4, country,
             payout_method, platform_fee_bps, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             tenant_id = excluded.tenant_id,
             principal_id = excluded.principal_id,
             display_name = excluded.display_name,
             bio = excluded.bio,
             avatar_url = excluded.avatar_url,
             website_url = excluded.website_url,
             contact_email = excluded.contact_email,
             verification_status = excluded.verification_status,
             legal_name = excluded.legal_name,
             tax_id_last4 = excluded.tax_id_last4,
             country = excluded.country,
             payout_method = excluded.payout_method,
             platform_fee_bps = excluded.platform_fee_bps,
             updated_at = excluded.updated_at`,
        ).run(
          publisher.id,
          publisher.tenantId,
          publisher.principalId,
          publisher.displayName,
          publisher.bio,
          publisher.avatarUrl,
          publisher.websiteUrl,
          publisher.contactEmail,
          publisher.verificationStatus,
          publisher.legalName,
          publisher.taxIdLast4,
          publisher.country,
          publisher.payoutMethod,
          publisher.platformFeeBps,
          publisher.createdAt,
          publisher.updatedAt,
        );
      });
    },

    async saveListing(listing) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_listings (
             id, publisher_id, slug, status, current_version_id, pending_version_id,
             tenant_id, tags_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             publisher_id = excluded.publisher_id,
             slug = excluded.slug,
             status = excluded.status,
             current_version_id = excluded.current_version_id,
             pending_version_id = excluded.pending_version_id,
             tenant_id = excluded.tenant_id,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        ).run(
          listing.id,
          listing.publisherId,
          listing.slug,
          listing.status,
          listing.currentVersionId,
          listing.pendingVersionId,
          listing.tenantId,
          JSON.stringify(listing.tags),
          listing.createdAt,
          listing.updatedAt,
        );
      });
    },

    async saveListingVersion(version) {
      const normalizedDistributionMode = normalizeDistributionModeForAsset(
        version.distributionMode,
        version.assetType,
      );
      const normalizedPermissionManifest = normalizePermissionManifestInput(
        version.permissionManifest,
      );
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_listing_versions (
             id, listing_id, version_number, status, title, description,
             long_description, screenshot_urls_json, package_name, package_version,
             asset_type, distribution_mode, permission_manifest_json,
             pricing_plan_json, release_notes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             listing_id = excluded.listing_id,
             version_number = excluded.version_number,
             status = excluded.status,
             title = excluded.title,
             description = excluded.description,
             long_description = excluded.long_description,
             screenshot_urls_json = excluded.screenshot_urls_json,
             package_name = excluded.package_name,
             package_version = excluded.package_version,
             asset_type = excluded.asset_type,
             distribution_mode = excluded.distribution_mode,
             permission_manifest_json = excluded.permission_manifest_json,
             pricing_plan_json = excluded.pricing_plan_json,
             release_notes = excluded.release_notes,
             created_at = excluded.created_at`,
        ).run(
          version.id,
          version.listingId,
          version.versionNumber,
          version.status,
          version.title,
          version.description,
          version.longDescription,
          JSON.stringify(version.screenshotUrls),
          version.packageName,
          version.packageVersion,
          version.assetType,
          normalizedDistributionMode,
          JSON.stringify(normalizedPermissionManifest),
          JSON.stringify(version.pricingPlan),
          version.releaseNotes,
          version.createdAt,
        );
      });
    },

    async savePricingPlan(plan) {
      const row = pricingPlanToRow(plan.plan);
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_pricing_plans (
             id, listing_id, type, currency, price_amount_cents, interval_months,
             trial_days, unit_label, tiers_json, is_active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             listing_id = excluded.listing_id,
             type = excluded.type,
             currency = excluded.currency,
             price_amount_cents = excluded.price_amount_cents,
             interval_months = excluded.interval_months,
             trial_days = excluded.trial_days,
             unit_label = excluded.unit_label,
             tiers_json = excluded.tiers_json,
             is_active = excluded.is_active,
             updated_at = excluded.updated_at`,
        ).run(
          plan.id,
          plan.listingId,
          row.type,
          row.currency,
          row.price_amount_cents,
          row.interval_months,
          row.trial_days,
          row.unit_label,
          row.tiers_json,
          plan.isActive ? 1 : 0,
          plan.createdAt,
          plan.updatedAt,
        );
      });
    },

    async savePurchase(purchase) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_purchases (
             id, buyer_tenant_id, buyer_principal_id, listing_id, listing_version_id,
             pricing_plan_id, status, amount_cents, currency, external_payment_id,
             idempotency_key, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             buyer_tenant_id = excluded.buyer_tenant_id,
             buyer_principal_id = excluded.buyer_principal_id,
             listing_id = excluded.listing_id,
             listing_version_id = excluded.listing_version_id,
             pricing_plan_id = excluded.pricing_plan_id,
             status = excluded.status,
             amount_cents = excluded.amount_cents,
             currency = excluded.currency,
             external_payment_id = excluded.external_payment_id,
             idempotency_key = excluded.idempotency_key,
             completed_at = excluded.completed_at,
             updated_at = excluded.updated_at`,
        ).run(
          purchase.id,
          purchase.buyerTenantId,
          purchase.buyerPrincipalId,
          purchase.listingId,
          purchase.listingVersionId,
          purchase.pricingPlanId,
          purchase.status,
          purchase.amount.amount,
          purchase.amount.currency,
          purchase.externalPaymentId,
          purchase.idempotencyKey,
          purchase.completedAt,
          purchase.createdAt,
          purchase.updatedAt,
        );
      });
    },

    async saveEntitlement(entitlement) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_entitlements (
             id, tenant_id, principal_id, listing_id, package_name, source_type,
             source_id, status, granted_at, expires_at, grace_period_ends_at,
             grandfathered, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             tenant_id = excluded.tenant_id,
             principal_id = excluded.principal_id,
             listing_id = excluded.listing_id,
             package_name = excluded.package_name,
             source_type = excluded.source_type,
             source_id = excluded.source_id,
             status = excluded.status,
             granted_at = excluded.granted_at,
             expires_at = excluded.expires_at,
             grace_period_ends_at = excluded.grace_period_ends_at,
             grandfathered = excluded.grandfathered,
             updated_at = excluded.updated_at`,
        ).run(
          entitlement.id,
          entitlement.tenantId,
          entitlement.principalId,
          entitlement.listingId,
          entitlement.packageName,
          entitlement.sourceType,
          entitlement.sourceId,
          entitlement.status,
          entitlement.grantedAt,
          entitlement.expiresAt,
          entitlement.gracePeriodEndsAt,
          entitlement.grandfathered ? 1 : 0,
          entitlement.createdAt,
          entitlement.updatedAt,
        );
      });
    },

    async saveInstallation(installation) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_installations (
             id, tenant_id, principal_id, listing_id, asset_type, package_name,
             package_version, status, last_error, installed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, listing_id, package_version) DO UPDATE SET
             principal_id = excluded.principal_id,
             asset_type = excluded.asset_type,
             package_name = excluded.package_name,
             package_version = excluded.package_version,
             status = excluded.status,
             last_error = excluded.last_error,
             installed_at = excluded.installed_at,
             updated_at = excluded.updated_at`,
        ).run(
          installation.id,
          installation.tenantId,
          installation.principalId,
          installation.listingId,
          installation.assetType,
          installation.packageName,
          installation.packageVersion,
          installation.status,
          installation.lastError,
          installation.installedAt,
          installation.createdAt,
          installation.updatedAt,
        );
      });
    },

    async saveSupportEvent(event) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_support_events (
             id, creator_id, asset_id, asset_type,
             supporter_tenant_id, supporter_principal_id,
             amount_cents, currency, message, created_at,
             actor_schema_version, actor_quarantined, actor_quarantine_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             creator_id = excluded.creator_id,
             asset_id = excluded.asset_id,
             asset_type = excluded.asset_type,
             supporter_tenant_id = excluded.supporter_tenant_id,
             supporter_principal_id = excluded.supporter_principal_id,
             amount_cents = excluded.amount_cents,
             currency = excluded.currency,
             message = excluded.message,
             created_at = excluded.created_at,
             actor_schema_version = excluded.actor_schema_version,
             actor_quarantined = excluded.actor_quarantined,
             actor_quarantine_reason = excluded.actor_quarantine_reason`,
        ).run(
          event.id,
          event.creatorId,
          event.assetId,
          event.assetType,
          event.supporterTenantId,
          event.supporterPrincipalId,
          event.amount.amount,
          event.amount.currency,
          event.message,
          event.createdAt,
          MARKETPLACE_ACTOR_SCHEMA_VERSION,
          0,
          null,
        );
      });
    },

    async saveRequest(request) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_requests (
             id, asset_kind, requester_tenant_id, requester_principal_id, title,
             goal, desired_outcome, constraints_json, budget_support_intent,
             privacy, publishability, risk_notes, status, accepted_response_id,
             created_at, updated_at, closed_at,
             actor_schema_version, actor_quarantined, actor_quarantine_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             asset_kind = excluded.asset_kind,
             requester_tenant_id = excluded.requester_tenant_id,
             requester_principal_id = excluded.requester_principal_id,
             title = excluded.title,
             goal = excluded.goal,
             desired_outcome = excluded.desired_outcome,
             constraints_json = excluded.constraints_json,
             budget_support_intent = excluded.budget_support_intent,
             privacy = excluded.privacy,
             publishability = excluded.publishability,
             risk_notes = excluded.risk_notes,
             status = excluded.status,
             accepted_response_id = excluded.accepted_response_id,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             closed_at = excluded.closed_at,
             actor_schema_version = excluded.actor_schema_version,
             actor_quarantined = excluded.actor_quarantined,
             actor_quarantine_reason = excluded.actor_quarantine_reason`,
        ).run(
          request.id,
          request.assetKind,
          request.requesterTenantId,
          request.requesterPrincipalId,
          request.title,
          request.goal,
          request.desiredOutcome,
          JSON.stringify(request.constraints),
          request.budgetSupportIntent,
          request.privacy,
          request.publishability,
          request.riskNotes,
          request.status,
          request.acceptedResponseId,
          request.createdAt,
          request.updatedAt,
          request.closedAt,
          MARKETPLACE_ACTOR_SCHEMA_VERSION,
          0,
          null,
        );
      });
    },

    async saveRequestResponse(response) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_request_responses (
             id, request_id, responder_tenant_id, responder_principal_id,
             responder_creator_id, message, proposal, deliverable_asset_id, created_at,
             actor_schema_version, actor_quarantined, actor_quarantine_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             request_id = excluded.request_id,
             responder_tenant_id = excluded.responder_tenant_id,
             responder_principal_id = excluded.responder_principal_id,
             responder_creator_id = excluded.responder_creator_id,
             message = excluded.message,
             proposal = excluded.proposal,
             deliverable_asset_id = excluded.deliverable_asset_id,
             created_at = excluded.created_at,
             actor_schema_version = excluded.actor_schema_version,
             actor_quarantined = excluded.actor_quarantined,
             actor_quarantine_reason = excluded.actor_quarantine_reason`,
        ).run(
          response.id,
          response.requestId,
          response.responderTenantId,
          response.responderPrincipalId,
          response.responderCreatorId,
          response.message,
          response.proposal,
          response.deliverableAssetId,
          response.createdAt,
          MARKETPLACE_ACTOR_SCHEMA_VERSION,
          0,
          null,
        );
      });
    },

    async saveSubscription(subscription) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_subscriptions (
             id, purchase_id, buyer_tenant_id, buyer_principal_id, listing_id,
             pricing_plan_id, status, current_period_start, current_period_end,
             cancel_at_period_end, cancelled_at, external_subscription_id,
             trial_ends_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             purchase_id = excluded.purchase_id,
             buyer_tenant_id = excluded.buyer_tenant_id,
             buyer_principal_id = excluded.buyer_principal_id,
             listing_id = excluded.listing_id,
             pricing_plan_id = excluded.pricing_plan_id,
             status = excluded.status,
             current_period_start = excluded.current_period_start,
             current_period_end = excluded.current_period_end,
             cancel_at_period_end = excluded.cancel_at_period_end,
             cancelled_at = excluded.cancelled_at,
             external_subscription_id = excluded.external_subscription_id,
             trial_ends_at = excluded.trial_ends_at,
             updated_at = excluded.updated_at`,
        ).run(
          subscription.id,
          subscription.purchaseId,
          subscription.buyerTenantId,
          subscription.buyerPrincipalId,
          subscription.listingId,
          subscription.pricingPlanId,
          subscription.status,
          subscription.currentPeriodStart,
          subscription.currentPeriodEnd,
          subscription.cancelAtPeriodEnd ? 1 : 0,
          subscription.cancelledAt,
          subscription.externalSubscriptionId,
          subscription.trialEndsAt,
          subscription.createdAt,
          subscription.updatedAt,
        );
      });
    },

    async saveRefund(refund) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_refunds (
             id, purchase_id, amount_cents, currency, reason, status,
             external_refund_id, initiated_by, created_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             purchase_id = excluded.purchase_id,
             amount_cents = excluded.amount_cents,
             currency = excluded.currency,
             reason = excluded.reason,
             status = excluded.status,
             external_refund_id = excluded.external_refund_id,
             initiated_by = excluded.initiated_by,
             completed_at = excluded.completed_at`,
        ).run(
          refund.id,
          refund.purchaseId,
          refund.amount.amount,
          refund.amount.currency,
          refund.reason,
          refund.status,
          refund.externalRefundId,
          refund.initiatedBy,
          refund.createdAt,
          refund.completedAt,
        );
      });
    },

    async savePayoutEntry(entry) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_payout_entries (
             id, publisher_id, purchase_id, listing_id, gross_amount_cents, platform_fee_cents,
             net_amount_cents, tax_withholding_cents, currency, payout_batch_id, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             publisher_id = excluded.publisher_id,
             purchase_id = excluded.purchase_id,
             listing_id = excluded.listing_id,
             gross_amount_cents = excluded.gross_amount_cents,
             platform_fee_cents = excluded.platform_fee_cents,
             net_amount_cents = excluded.net_amount_cents,
             tax_withholding_cents = excluded.tax_withholding_cents,
             currency = excluded.currency,
             payout_batch_id = excluded.payout_batch_id,
             status = excluded.status,
             updated_at = excluded.updated_at`,
        ).run(
          entry.id,
          entry.publisherId,
          entry.purchaseId,
          entry.listingId,
          entry.grossAmount.amount,
          entry.platformFee.amount,
          entry.netAmount.amount,
          entry.taxWithholding.amount,
          entry.grossAmount.currency,
          entry.payoutBatchId,
          entry.status,
          entry.createdAt,
          entry.updatedAt,
        );
      });
    },

    async savePayoutEntries(entries) {
      if (entries.length === 0) {
        return;
      }
      deps.db.withWriteTransaction((conn) => {
        const stmt = conn.prepare(
          `INSERT INTO marketplace_payout_entries (
             id, publisher_id, purchase_id, listing_id, gross_amount_cents, platform_fee_cents,
             net_amount_cents, tax_withholding_cents, currency, payout_batch_id, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             publisher_id = excluded.publisher_id,
             purchase_id = excluded.purchase_id,
             listing_id = excluded.listing_id,
             gross_amount_cents = excluded.gross_amount_cents,
             platform_fee_cents = excluded.platform_fee_cents,
             net_amount_cents = excluded.net_amount_cents,
             tax_withholding_cents = excluded.tax_withholding_cents,
             currency = excluded.currency,
             payout_batch_id = excluded.payout_batch_id,
             status = excluded.status,
             updated_at = excluded.updated_at`,
        );

        for (const entry of entries) {
          stmt.run(
            entry.id,
            entry.publisherId,
            entry.purchaseId,
            entry.listingId,
            entry.grossAmount.amount,
            entry.platformFee.amount,
            entry.netAmount.amount,
            entry.taxWithholding.amount,
            entry.grossAmount.currency,
            entry.payoutBatchId,
            entry.status,
            entry.createdAt,
            entry.updatedAt,
          );
        }
      });
    },

    async savePayoutBatch(batch) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_payout_batches (
             id, publisher_id, status, total_amount_cents, currency, entry_count,
             period_start, period_end, external_payout_id, initiated_at, completed_at, failed_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             publisher_id = excluded.publisher_id,
             status = excluded.status,
             total_amount_cents = excluded.total_amount_cents,
             currency = excluded.currency,
             entry_count = excluded.entry_count,
             period_start = excluded.period_start,
             period_end = excluded.period_end,
             external_payout_id = excluded.external_payout_id,
             initiated_at = excluded.initiated_at,
             completed_at = excluded.completed_at,
             failed_reason = excluded.failed_reason`,
        ).run(
          batch.id,
          batch.publisherId,
          batch.status,
          batch.totalAmount.amount,
          batch.totalAmount.currency,
          batch.entryCount,
          batch.periodStart,
          batch.periodEnd,
          batch.externalPayoutId,
          batch.initiatedAt,
          batch.completedAt,
          batch.failedReason,
        );
      });
    },

    async saveBillingEvent(event) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_billing_events (
             id, event_type, source, reference_type, reference_id, payload_json, processed, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             event_type = excluded.event_type,
             source = excluded.source,
             reference_type = excluded.reference_type,
             reference_id = excluded.reference_id,
             payload_json = excluded.payload_json,
             processed = excluded.processed,
             created_at = excluded.created_at`,
        ).run(
          event.id,
          event.eventType,
          event.source,
          event.referenceType,
          event.referenceId,
          JSON.stringify(event.payload),
          event.processed ? 1 : 0,
          event.createdAt,
        );
      });
    },

    async saveBillingWebhook(webhook) {
      deps.db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO marketplace_billing_webhooks (
             id, provider, external_id, event_type, payload_json, signature,
             status, attempts, last_error, received_at, processed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, external_id) DO UPDATE SET
             event_type = excluded.event_type,
             payload_json = excluded.payload_json,
             signature = excluded.signature,
             status = excluded.status,
             attempts = excluded.attempts,
             last_error = excluded.last_error,
             received_at = excluded.received_at,
             processed_at = excluded.processed_at`,
        ).run(
          webhook.id,
          webhook.provider,
          webhook.externalId,
          webhook.eventType,
          JSON.stringify(webhook.payload),
          webhook.signature,
          webhook.status,
          webhook.attempts,
          webhook.lastError,
          webhook.receivedAt,
          webhook.processedAt,
        );
      });
    },
  };
}

function mapPublisherRow(row: FridayPublisherRow): FridayPublisher {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    websiteUrl: row.website_url,
    contactEmail: row.contact_email,
    verificationStatus: normalizePublisherVerificationStatus(row.verification_status),
    legalName: row.legal_name,
    taxIdLast4: row.tax_id_last4,
    country: row.country,
    payoutMethod: row.payout_method,
    platformFeeBps: row.platform_fee_bps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapListingRow(row: FridayListingRow): FridayListing {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    slug: row.slug,
    status: normalizeListingStatus(row.status),
    currentVersionId: row.current_version_id,
    pendingVersionId: row.pending_version_id,
    tenantId: row.tenant_id,
    tags: parseStringArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapListingVersionRow(row: FridayListingVersionRow): FridayListingVersion {
  return {
    id: row.id,
    listingId: row.listing_id,
    versionNumber: row.version_number,
    status: normalizeListingVersionStatus(row.status),
    title: row.title,
    description: row.description,
    longDescription: row.long_description,
    screenshotUrls: parseStringArray(row.screenshot_urls_json),
    packageName: row.package_name,
    packageVersion: row.package_version,
    assetType: normalizeAssetType(row.asset_type),
    distributionMode: normalizeDistributionMode(row.distribution_mode),
    permissionManifest: parsePermissionManifestJson(
      row.permission_manifest_json,
    ),
    pricingPlan: parsePricingPlanJson(row.pricing_plan_json),
    releaseNotes: row.release_notes,
    createdAt: row.created_at,
  };
}

function mapPricingPlanRow(row: FridayPricingPlanRow): FridayPricingPlanRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    plan: rowToPricingPlan(row),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPurchaseRow(row: FridayPurchaseRow): FridayPurchase {
  return {
    id: row.id,
    buyerTenantId: row.buyer_tenant_id,
    buyerPrincipalId: row.buyer_principal_id,
    listingId: row.listing_id,
    listingVersionId: row.listing_version_id,
    pricingPlanId: row.pricing_plan_id,
    status: normalizePurchaseStatus(row.status),
    amount: fridayMoney(row.amount_cents, row.currency),
    externalPaymentId: row.external_payment_id,
    idempotencyKey: row.idempotency_key,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntitlementRow(row: FridayEntitlementRow): FridayEntitlement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    listingId: row.listing_id,
    packageName: row.package_name,
    sourceType: normalizeEntitlementSourceType(row.source_type),
    sourceId: row.source_id,
    status: normalizeEntitlementStatus(row.status),
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    gracePeriodEndsAt: row.grace_period_ends_at,
    grandfathered: row.grandfathered === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInstallationRow(row: FridayInstallationRow): FridayInstallation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    listingId: row.listing_id,
    assetType: normalizeAssetType(row.asset_type),
    packageName: row.package_name,
    packageVersion: row.package_version,
    status: normalizeInstallationStatus(row.status),
    lastError: row.last_error,
    installedAt: row.installed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportEventRow(row: FridaySupportEventRow): FridaySupportEvent {
  return {
    id: row.id,
    creatorId: row.creator_id,
    assetId: row.asset_id,
    assetType: normalizeAssetType(row.asset_type),
    supporterTenantId: row.supporter_tenant_id,
    supporterPrincipalId: row.supporter_principal_id,
    amount: fridayMoney(row.amount_cents, row.currency),
    message: row.message,
    createdAt: row.created_at,
  };
}

function mapRequestRow(row: FridayMarketplaceRequestRow): FridayMarketplaceRequestPost {
  return {
    id: row.id,
    assetKind: normalizeRequestAssetKind(row.asset_kind),
    requesterTenantId: row.requester_tenant_id,
    requesterPrincipalId: row.requester_principal_id,
    title: row.title,
    goal: row.goal,
    desiredOutcome: row.desired_outcome,
    constraints: parseStringArray(row.constraints_json),
    budgetSupportIntent: row.budget_support_intent,
    privacy: normalizeRequestPrivacy(row.privacy),
    publishability: normalizeRequestPublishability(row.publishability),
    riskNotes: row.risk_notes,
    status: normalizeRequestStatus(row.status),
    acceptedResponseId: row.accepted_response_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function mapRequestResponseRow(
  row: FridayMarketplaceRequestResponseRow,
): FridayMarketplaceRequestResponse {
  return {
    id: row.id,
    requestId: row.request_id,
    responderTenantId: row.responder_tenant_id,
    responderPrincipalId: row.responder_principal_id,
    responderCreatorId: row.responder_creator_id,
    message: row.message,
    proposal: row.proposal,
    deliverableAssetId: row.deliverable_asset_id,
    createdAt: row.created_at,
  };
}

function mapSubscriptionRow(row: FridaySubscriptionRow): FridaySubscription {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    buyerTenantId: row.buyer_tenant_id,
    buyerPrincipalId: row.buyer_principal_id,
    listingId: row.listing_id,
    pricingPlanId: row.pricing_plan_id,
    status: normalizeSubscriptionStatus(row.status),
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    cancelledAt: row.cancelled_at,
    externalSubscriptionId: row.external_subscription_id,
    trialEndsAt: row.trial_ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRefundRow(row: FridayRefundRow): FridayRefund {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    amount: fridayMoney(row.amount_cents, row.currency),
    reason: row.reason,
    status: normalizeRefundStatus(row.status),
    externalRefundId: row.external_refund_id,
    initiatedBy: row.initiated_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapPayoutEntryRow(row: FridayPayoutEntryRow): FridayPayoutEntry {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    purchaseId: row.purchase_id,
    listingId: row.listing_id,
    grossAmount: fridayMoney(row.gross_amount_cents, row.currency),
    platformFee: fridayMoney(row.platform_fee_cents, row.currency),
    netAmount: fridayMoney(row.net_amount_cents, row.currency),
    taxWithholding: fridayMoney(row.tax_withholding_cents, row.currency),
    payoutBatchId: row.payout_batch_id,
    status: normalizePayoutEntryStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPayoutBatchRow(row: FridayPayoutBatchRow): FridayPayoutBatch {
  return {
    id: row.id,
    publisherId: row.publisher_id,
    status: normalizePayoutBatchStatus(row.status),
    totalAmount: fridayMoney(row.total_amount_cents, row.currency),
    entryCount: row.entry_count,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    externalPayoutId: row.external_payout_id,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at,
    failedReason: row.failed_reason,
  };
}

function mapBillingEventRow(row: FridayBillingEventRow): FridayBillingEvent {
  return {
    id: row.id,
    eventType: normalizeBillingEventType(row.event_type),
    source: normalizeBillingEventSource(row.source),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    payload: parseJsonObject(row.payload_json),
    processed: row.processed === 1,
    createdAt: row.created_at,
  };
}

function mapBillingWebhookRow(row: FridayBillingWebhookRow): FridayBillingWebhook {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    eventType: row.event_type,
    payload: parseJsonObject(row.payload_json),
    signature: row.signature,
    status: normalizeBillingWebhookStatus(row.status),
    attempts: row.attempts,
    lastError: row.last_error,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

function rowToPricingPlan(row: FridayPricingPlanRow): FridayPricingPlan {
  switch (row.type) {
    case "free":
      return { type: "free" };
    case "one_time":
      return {
        type: "one_time",
        price: fridayMoney(row.price_amount_cents ?? 0, row.currency ?? "USD"),
      };
    case "subscription":
      return {
        type: "subscription",
        intervalMonths: row.interval_months === 12 ? 12 : 1,
        price: fridayMoney(row.price_amount_cents ?? 0, row.currency ?? "USD"),
        trialDays: row.trial_days ?? 0,
      };
    case "usage_based": {
      const tiers = row.tiers_json ? parseJson(row.tiers_json, []) : [];
      return {
        type: "usage_based",
        unitLabel: row.unit_label ?? "unit",
        tiers: Array.isArray(tiers)
          ? tiers.map((tier) => ({
            upToUnits: typeof (tier as { upToUnits?: unknown }).upToUnits === "number" || (tier as { upToUnits?: unknown }).upToUnits === null
              ? (tier as { upToUnits: number | null }).upToUnits
              : null,
            pricePerUnitCents: Number((tier as { pricePerUnitCents?: unknown }).pricePerUnitCents ?? 0),
          }))
          : [],
        currency: (row.currency ?? "USD") as never,
      };
    }
    default:
      return { type: "free" };
  }
}

function pricingPlanToRow(plan: FridayPricingPlan): {
  type: string;
  currency: string | null;
  price_amount_cents: number | null;
  interval_months: number | null;
  trial_days: number | null;
  unit_label: string | null;
  tiers_json: string | null;
} {
  switch (plan.type) {
    case "free":
      return {
        type: "free",
        currency: null,
        price_amount_cents: null,
        interval_months: null,
        trial_days: null,
        unit_label: null,
        tiers_json: null,
      };
    case "one_time":
      return {
        type: "one_time",
        currency: plan.price.currency,
        price_amount_cents: plan.price.amount,
        interval_months: null,
        trial_days: null,
        unit_label: null,
        tiers_json: null,
      };
    case "subscription":
      return {
        type: "subscription",
        currency: plan.price.currency,
        price_amount_cents: plan.price.amount,
        interval_months: plan.intervalMonths,
        trial_days: plan.trialDays,
        unit_label: null,
        tiers_json: null,
      };
    case "usage_based":
      return {
        type: "usage_based",
        currency: plan.currency,
        price_amount_cents: null,
        interval_months: null,
        trial_days: null,
        unit_label: plan.unitLabel,
        tiers_json: JSON.stringify(plan.tiers),
      };
    default:
      return {
        type: "free",
        currency: null,
        price_amount_cents: null,
        interval_months: null,
        trial_days: null,
        unit_label: null,
        tiers_json: null,
      };
  }
}

function normalizeListingStatus(value: string): FridayListing["status"] {
  switch (value) {
    case "draft":
    case "review":
    case "published":
    case "suspended":
    case "archived":
      return value;
    default:
      return "draft";
  }
}

function normalizeListingVersionStatus(value: string): FridayListingVersion["status"] {
  switch (value) {
    case "draft":
    case "in_review":
    case "approved":
    case "rejected":
      return value;
    default:
      return "draft";
  }
}

function normalizeAssetType(value: string): FridayListingVersion["assetType"] {
  switch (value) {
    case "skill":
    case "workflow":
    case "agent":
      return value;
    default:
      return "agent";
  }
}

function normalizeRequestAssetKind(value: string): FridayMarketplaceRequestPost["assetKind"] {
  switch (value) {
    case "skill":
    case "workflow":
    case "agent":
      return value;
    default:
      return "skill";
  }
}

function normalizeRequestPrivacy(value: string): FridayMarketplaceRequestPost["privacy"] {
  switch (value) {
    case "public":
    case "private":
      return value;
    default:
      return "public";
  }
}

function normalizeRequestPublishability(
  value: string,
): FridayMarketplaceRequestPost["publishability"] {
  switch (value) {
    case "private_only":
    case "allow_publication":
      return value;
    default:
      return "private_only";
  }
}

function normalizeRequestStatus(value: string): FridayMarketplaceRequestPost["status"] {
  switch (value) {
    case "open":
    case "in_discussion":
    case "submitted":
    case "accepted":
    case "closed":
      return value;
    default:
      return "open";
  }
}

function normalizeDistributionMode(
  value: string,
): FridayListingVersion["distributionMode"] {
  switch (value) {
    case "declarative_public":
    case "legacy_executable":
      return value;
    default:
      return "legacy_executable";
  }
}

function normalizeDistributionModeForAsset(
  value: string | undefined,
  assetType: FridayListingVersion["assetType"],
): FridayListingVersion["distributionMode"] {
  if (value === "declarative_public" || value === "legacy_executable") {
    return value;
  }
  return assetType === "skill" ? "legacy_executable" : "declarative_public";
}

function normalizePermissionManifestInput(
  value: FridayListingVersion["permissionManifest"] | undefined,
): FridayListingVersion["permissionManifest"] {
  if (!value) {
    return {
      permissions: [],
      requiresExplicitApproval: false,
    };
  }
  return {
    permissions: [...value.permissions],
    requiresExplicitApproval: value.requiresExplicitApproval === true,
  };
}

function parsePermissionManifestJson(
  value: string | null | undefined,
): FridayListingVersion["permissionManifest"] {
  if (!value) {
    return {
      permissions: [],
      requiresExplicitApproval: false,
    };
  }
  try {
    const parsed = JSON.parse(value) as {
      permissions?: unknown;
      requiresExplicitApproval?: unknown;
    };
    return {
      permissions: Array.isArray(parsed.permissions)
        ? parsed.permissions.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      requiresExplicitApproval:
        parsed.requiresExplicitApproval === true,
    };
  } catch {
    return {
      permissions: [],
      requiresExplicitApproval: false,
    };
  }
}

function normalizePublisherVerificationStatus(value: string): FridayPublisher["verificationStatus"] {
  switch (value) {
    case "unverified":
    case "pending":
    case "verified":
    case "suspended":
      return value;
    default:
      return "unverified";
  }
}

function normalizePurchaseStatus(value: string): FridayPurchase["status"] {
  switch (value) {
    case "pending":
    case "completed":
    case "failed":
    case "refunded":
    case "disputed":
      return value;
    default:
      return "pending";
  }
}

function normalizeEntitlementStatus(value: string): FridayEntitlement["status"] {
  switch (value) {
    case "active":
    case "grace":
    case "suspended":
    case "revoked":
    case "expired":
      return value;
    default:
      return "revoked";
  }
}

function normalizeInstallationStatus(value: string): FridayInstallation["status"] {
  switch (value) {
    case "installing":
    case "installed":
    case "failed":
      return value;
    default:
      return "failed";
  }
}

function normalizeEntitlementSourceType(value: string): FridayEntitlement["sourceType"] {
  switch (value) {
    case "purchase":
    case "subscription":
    case "grant":
    case "trial":
      return value;
    default:
      return "grant";
  }
}

function normalizeSubscriptionStatus(value: string): FridaySubscription["status"] {
  switch (value) {
    case "active":
    case "past_due":
    case "paused":
    case "cancelled":
    case "expired":
      return value;
    default:
      return "cancelled";
  }
}

function normalizeRefundStatus(value: string): FridayRefund["status"] {
  switch (value) {
    case "pending":
    case "completed":
    case "failed":
      return value;
    default:
      return "failed";
  }
}

function normalizePayoutEntryStatus(value: string): FridayPayoutEntry["status"] {
  switch (value) {
    case "pending":
    case "processing":
    case "completed":
    case "failed":
    case "clawed_back":
      return value;
    default:
      return "pending";
  }
}

function normalizePayoutBatchStatus(value: string): FridayPayoutBatch["status"] {
  switch (value) {
    case "pending":
    case "processing":
    case "completed":
    case "failed":
      return value;
    default:
      return "pending";
  }
}

function normalizeBillingEventType(value: string): FridayBillingEvent["eventType"] {
  switch (value) {
    case "checkout.completed":
    case "checkout.abandoned":
    case "payment.succeeded":
    case "payment.failed":
    case "subscription.created":
    case "subscription.renewed":
    case "subscription.cancelled":
    case "subscription.paused":
    case "subscription.resumed":
    case "refund.initiated":
    case "refund.completed":
    case "chargeback.opened":
    case "chargeback.won":
    case "chargeback.lost":
    case "payout.initiated":
    case "payout.completed":
    case "payout.failed":
      return value;
    default:
      return "payment.succeeded";
  }
}

function normalizeBillingEventSource(value: string): FridayBillingEvent["source"] {
  switch (value) {
    case "internal":
    case "webhook":
      return value;
    default:
      return "internal";
  }
}

function normalizeBillingWebhookStatus(value: string): FridayBillingWebhook["status"] {
  switch (value) {
    case "received":
    case "processing":
    case "processed":
    case "failed":
      return value;
    default:
      return "received";
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJson(value, []) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function parsePricingPlanJson(value: unknown): FridayPricingPlan {
  const parsed = typeof value === "string" ? parseJson(value, { type: "free" }) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { type: "free" };
  }

  const plan = parsed as { type?: unknown };
  switch (plan.type) {
    case "free":
      return { type: "free" };
    case "one_time": {
      const raw = parsed as { price?: { amount?: unknown; currency?: unknown } };
      return {
        type: "one_time",
        price: fridayMoney(
          Number(raw.price?.amount ?? 0),
          typeof raw.price?.currency === "string" ? raw.price.currency : "USD",
        ),
      };
    }
    case "subscription": {
      const raw = parsed as {
        intervalMonths?: unknown;
        trialDays?: unknown;
        price?: { amount?: unknown; currency?: unknown };
      };
      return {
        type: "subscription",
        intervalMonths: raw.intervalMonths === 12 ? 12 : 1,
        trialDays: Number(raw.trialDays ?? 0),
        price: fridayMoney(
          Number(raw.price?.amount ?? 0),
          typeof raw.price?.currency === "string" ? raw.price.currency : "USD",
        ),
      };
    }
    case "usage_based": {
      const raw = parsed as {
        unitLabel?: unknown;
        currency?: unknown;
        tiers?: Array<{ upToUnits?: unknown; pricePerUnitCents?: unknown }>;
      };
      return {
        type: "usage_based",
        unitLabel: typeof raw.unitLabel === "string" ? raw.unitLabel : "unit",
        currency: (typeof raw.currency === "string" ? raw.currency : "USD") as never,
        tiers: Array.isArray(raw.tiers)
          ? raw.tiers.map((tier) => ({
            upToUnits: typeof tier.upToUnits === "number" || tier.upToUnits === null ? tier.upToUnits : null,
            pricePerUnitCents: Number(tier.pricePerUnitCents ?? 0),
          }))
          : [],
      };
    }
    default:
      return { type: "free" };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonObject(value: string): JsonObject {
  const parsed = parseJson<unknown>(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {} as JsonObject;
  }
  return parsed as JsonObject;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
