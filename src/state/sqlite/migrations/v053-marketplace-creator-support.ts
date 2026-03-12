import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V053_MARKETPLACE_CREATOR_SUPPORT_SQL = `
-- V053: creator support events for zero-commission marketplace rewards.

CREATE TABLE IF NOT EXISTS marketplace_support_events (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  supporter_tenant_id TEXT NOT NULL,
  supporter_principal_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_support_events_creator
  ON marketplace_support_events (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_support_events_asset
  ON marketplace_support_events (asset_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_support_events_supporter
  ON marketplace_support_events (supporter_principal_id, created_at DESC);
`;

const V053_CHECKSUM = computeFridayMigrationChecksum(
  V053_MARKETPLACE_CREATOR_SUPPORT_SQL,
);

export const V053_MARKETPLACE_CREATOR_SUPPORT_MIGRATION: FridaySqliteMigration =
  {
    version: 53,
    name: "v053-marketplace-creator-support",
    sql: V053_MARKETPLACE_CREATOR_SUPPORT_SQL,
    checksum: V053_CHECKSUM,
  };
