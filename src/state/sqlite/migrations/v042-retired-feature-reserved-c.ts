import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V042_RETIRED_FEATURE_RESERVED_C_SQL = `
-- V042: Retired feature reserved slot C.
SELECT 1;
`;

const V042_CHECKSUM = computeFridayMigrationChecksum(V042_RETIRED_FEATURE_RESERVED_C_SQL);

export const V042_RETIRED_FEATURE_RESERVED_C_MIGRATION: FridaySqliteMigration = {
  version: 42,
  name: "v042-retired-feature-reserved-c",
  sql: V042_RETIRED_FEATURE_RESERVED_C_SQL,
  checksum: V042_CHECKSUM,
  acceptedChecksums: ["4c383c21d26ff9eaa15f29363baaf2b32a4812c8b5ac4236ea574c467528725b"], // pragma: allowlist secret
};
