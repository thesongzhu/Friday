import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V053_RETIRED_FEATURE_RESERVED_E_SQL = `
-- V053: Retired feature reserved slot E.
SELECT 1;
`;

const V053_CHECKSUM = computeFridayMigrationChecksum(V053_RETIRED_FEATURE_RESERVED_E_SQL);

export const V053_RETIRED_FEATURE_RESERVED_E_MIGRATION: FridaySqliteMigration = {
  version: 53,
  name: "v053-retired-feature-reserved-e",
  sql: V053_RETIRED_FEATURE_RESERVED_E_SQL,
  checksum: V053_CHECKSUM,
  acceptedChecksums: ["342608fa672b6e8d02a305906329a94b9d25cfa41eb12a46844d640b8dff3f24"], // pragma: allowlist secret
};
