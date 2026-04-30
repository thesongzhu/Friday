import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V054_RETIRED_FEATURE_RESERVED_F_SQL = `
-- V054: Retired feature reserved slot F.
SELECT 1;
`;

const V054_CHECKSUM = computeFridayMigrationChecksum(V054_RETIRED_FEATURE_RESERVED_F_SQL);

export const V054_RETIRED_FEATURE_RESERVED_F_MIGRATION: FridaySqliteMigration = {
  version: 54,
  name: "v054-retired-feature-reserved-f",
  sql: V054_RETIRED_FEATURE_RESERVED_F_SQL,
  checksum: V054_CHECKSUM,
  acceptedChecksums: ["a18b14e07d95673213af64442a03185afdb4b56e2c9c2ed234b4277dbbb32b77"], // pragma: allowlist secret
};
