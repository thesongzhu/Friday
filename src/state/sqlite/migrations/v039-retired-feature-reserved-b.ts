import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V039_RETIRED_FEATURE_RESERVED_B_SQL = `
-- V039: Retired feature reserved slot B.
SELECT 1;
`;

const V039_CHECKSUM = computeFridayMigrationChecksum(V039_RETIRED_FEATURE_RESERVED_B_SQL);

export const V039_RETIRED_FEATURE_RESERVED_B_MIGRATION: FridaySqliteMigration = {
  version: 39,
  name: "v039-retired-feature-reserved-b",
  sql: V039_RETIRED_FEATURE_RESERVED_B_SQL,
  checksum: V039_CHECKSUM,
  acceptedChecksums: ["c2f255ec4d31c1671dc84ede38cd79a62c07f93033e8ac4958d46acf8884821c"], // pragma: allowlist secret
};
