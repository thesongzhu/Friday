import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V042_MARKETPLACE_PAYOUT_BILLING_MVP_SQL = `
-- V042: Marketplace payout + billing persistence (entries, batches, events, webhooks).

CREATE TABLE IF NOT EXISTS marketplace_payout_batches (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES marketplace_publishers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  external_payout_id TEXT,
  initiated_at TEXT NOT NULL,
  completed_at TEXT,
  failed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_batches_publisher_status
  ON marketplace_payout_batches (publisher_id, status, initiated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_payout_batches_external
  ON marketplace_payout_batches (external_payout_id)
  WHERE external_payout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_payout_entries (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL REFERENCES marketplace_publishers(id) ON DELETE CASCADE,
  purchase_id TEXT NOT NULL REFERENCES marketplace_purchases(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  gross_amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  net_amount_cents INTEGER NOT NULL,
  tax_withholding_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payout_batch_id TEXT REFERENCES marketplace_payout_batches(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_entries_publisher_status
  ON marketplace_payout_entries (publisher_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_entries_batch
  ON marketplace_payout_entries (payout_batch_id, updated_at DESC)
  WHERE payout_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_payout_entries_purchase
  ON marketplace_payout_entries (purchase_id);

CREATE TABLE IF NOT EXISTS marketplace_billing_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  payload_json TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_events_processed
  ON marketplace_billing_events (processed, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_events_type
  ON marketplace_billing_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_billing_webhooks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_billing_webhooks_provider_external
  ON marketplace_billing_webhooks (provider, external_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_billing_webhooks_status
  ON marketplace_billing_webhooks (status, received_at DESC);
`;

const V042_CHECKSUM = computeFridayMigrationChecksum(V042_MARKETPLACE_PAYOUT_BILLING_MVP_SQL);

export const V042_MARKETPLACE_PAYOUT_BILLING_MVP_MIGRATION: FridaySqliteMigration = {
  version: 42,
  name: "v042-marketplace-payout-billing-mvp",
  sql: V042_MARKETPLACE_PAYOUT_BILLING_MVP_SQL,
  checksum: V042_CHECKSUM,
};
