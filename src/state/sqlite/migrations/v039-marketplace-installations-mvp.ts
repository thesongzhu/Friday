import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V039_MARKETPLACE_INSTALLATIONS_MVP_SQL = `
-- V039: Marketplace installation tracking for acquire->install closure.

CREATE TABLE IF NOT EXISTS marketplace_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  installed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, listing_id, package_version)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_installations_tenant_listing_status
  ON marketplace_installations (tenant_id, listing_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_installations_tenant_package
  ON marketplace_installations (tenant_id, package_name, package_version);
`;

const V039_CHECKSUM = computeFridayMigrationChecksum(V039_MARKETPLACE_INSTALLATIONS_MVP_SQL);

export const V039_MARKETPLACE_INSTALLATIONS_MVP_MIGRATION: FridaySqliteMigration = {
  version: 39,
  name: "v039-marketplace-installations-mvp",
  sql: V039_MARKETPLACE_INSTALLATIONS_MVP_SQL,
  checksum: V039_CHECKSUM,
};
