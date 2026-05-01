import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V055_RETIRED_FEATURE_RESERVED_G_SQL = `
-- V055: Retired feature reserved slot G.
SELECT 1;
`;

const V055_CHECKSUM = computeFridayMigrationChecksum(V055_RETIRED_FEATURE_RESERVED_G_SQL);

export const V055_RETIRED_FEATURE_RESERVED_G_MIGRATION: FridaySqliteMigration = {
  version: 55,
  name: "v055-retired-feature-reserved-g",
  sql: V055_RETIRED_FEATURE_RESERVED_G_SQL,
  checksum: V055_CHECKSUM,
  acceptedChecksums: ["dd24fa1261800bc6faec23140739749ef765284be622153e8bb2836fb57a8c1d"], // pragma: allowlist secret
};
