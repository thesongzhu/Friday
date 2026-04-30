import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V052_RETIRED_FEATURE_RESERVED_D_SQL = `
-- V052: Retired feature reserved slot D.
SELECT 1;
`;

const V052_CHECKSUM = computeFridayMigrationChecksum(V052_RETIRED_FEATURE_RESERVED_D_SQL);

export const V052_RETIRED_FEATURE_RESERVED_D_MIGRATION: FridaySqliteMigration = {
  version: 52,
  name: "v052-retired-feature-reserved-d",
  sql: V052_RETIRED_FEATURE_RESERVED_D_SQL,
  checksum: V052_CHECKSUM,
  acceptedChecksums: ["44e4fa8e5de293f832617d60ad08025bd56f8e11ae6b11fdf674e0513b68c37f"], // pragma: allowlist secret
};
