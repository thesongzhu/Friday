import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V052_MARKETPLACE_SAFE_ASSETS_SQL = `
-- V052: classify marketplace assets as declarative public or legacy executable.

ALTER TABLE marketplace_listing_versions
ADD COLUMN distribution_mode TEXT NOT NULL DEFAULT 'legacy_executable';

ALTER TABLE marketplace_listing_versions
ADD COLUMN permission_manifest_json TEXT NOT NULL DEFAULT '{"permissions":[],"requiresExplicitApproval":false}';
`;

const V052_CHECKSUM = computeFridayMigrationChecksum(
  V052_MARKETPLACE_SAFE_ASSETS_SQL,
);

export const V052_MARKETPLACE_SAFE_ASSETS_MIGRATION: FridaySqliteMigration = {
  version: 52,
  name: "v052-marketplace-safe-assets",
  sql: V052_MARKETPLACE_SAFE_ASSETS_SQL,
  checksum: V052_CHECKSUM,
};
