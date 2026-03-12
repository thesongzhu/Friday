import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V038_MARKETPLACE_COMMERCE_MVP_SQL = `
-- V038: Marketplace commerce MVP persistence (publisher/listing/pricing/purchase/entitlement).

CREATE TABLE IF NOT EXISTS marketplace_publishers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  website_url TEXT,
  contact_email TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  legal_name TEXT,
  tax_id_last4 TEXT,
  country TEXT,
  payout_method TEXT,
  platform_fee_bps INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_publishers_tenant_principal
  ON marketplace_publishers (tenant_id, principal_id);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES marketplace_publishers(id),
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  current_version_id TEXT,
  pending_version_id TEXT,
  tenant_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_publisher
  ON marketplace_listings (publisher_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_tenant
  ON marketplace_listings (tenant_id, status);

CREATE TABLE IF NOT EXISTS marketplace_listing_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  screenshot_urls_json TEXT NOT NULL DEFAULT '[]',
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  pricing_plan_json TEXT NOT NULL,
  release_notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_versions_listing
  ON marketplace_listing_versions (listing_id, status, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_versions_package
  ON marketplace_listing_versions (package_name, package_version);

CREATE TABLE IF NOT EXISTS marketplace_listing_reviews (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES marketplace_listing_versions(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_reviews_listing
  ON marketplace_listing_reviews (listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_pricing_plans (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  currency TEXT,
  price_amount_cents INTEGER,
  interval_months INTEGER,
  trial_days INTEGER,
  unit_label TEXT,
  tiers_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_pricing_plans_listing
  ON marketplace_pricing_plans (listing_id, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_purchases (
  id TEXT PRIMARY KEY,
  buyer_tenant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  listing_version_id TEXT NOT NULL REFERENCES marketplace_listing_versions(id),
  pricing_plan_id TEXT NOT NULL REFERENCES marketplace_pricing_plans(id),
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  external_payment_id TEXT,
  idempotency_key TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_purchases_idempotency
  ON marketplace_purchases (buyer_principal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_listing
  ON marketplace_purchases (listing_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_buyer
  ON marketplace_purchases (buyer_tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_subscriptions (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES marketplace_purchases(id),
  buyer_tenant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  pricing_plan_id TEXT NOT NULL REFERENCES marketplace_pricing_plans(id),
  status TEXT NOT NULL,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  external_subscription_id TEXT,
  trial_ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_subscriptions_buyer
  ON marketplace_subscriptions (buyer_tenant_id, status, current_period_end);

CREATE TABLE IF NOT EXISTS marketplace_entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id),
  package_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  grace_period_ends_at TEXT,
  grandfathered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_entitlements_tenant_listing
  ON marketplace_entitlements (tenant_id, listing_id, status);

CREATE INDEX IF NOT EXISTS idx_marketplace_entitlements_tenant_package
  ON marketplace_entitlements (tenant_id, package_name, status);

CREATE TABLE IF NOT EXISTS marketplace_refunds (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES marketplace_purchases(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  external_refund_id TEXT,
  initiated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketplace_refunds_purchase
  ON marketplace_refunds (purchase_id, created_at DESC);
`;

const V038_CHECKSUM = computeFridayMigrationChecksum(V038_MARKETPLACE_COMMERCE_MVP_SQL);

export const V038_MARKETPLACE_COMMERCE_MVP_MIGRATION: FridaySqliteMigration = {
  version: 38,
  name: "v038-marketplace-commerce-mvp",
  sql: V038_MARKETPLACE_COMMERCE_MVP_SQL,
  checksum: V038_CHECKSUM,
};
