import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V038_RETIRED_FEATURE_RESERVED_A_SQL = `
-- V038: Retired feature reserved slot A.
SELECT 1;
`;

const V038_CHECKSUM = computeFridayMigrationChecksum(V038_RETIRED_FEATURE_RESERVED_A_SQL);

export const V038_RETIRED_FEATURE_RESERVED_A_MIGRATION: FridaySqliteMigration = {
  version: 38,
  name: "v038-retired-feature-reserved-a",
  sql: V038_RETIRED_FEATURE_RESERVED_A_SQL,
  checksum: V038_CHECKSUM,
  acceptedChecksums: ["17413f03a0015cb3ea468c412c3a3c9f68208d9fc251802975177a66d6bd8486"], // pragma: allowlist secret
};
