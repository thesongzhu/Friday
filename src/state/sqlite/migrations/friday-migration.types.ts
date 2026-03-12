import * as crypto from "node:crypto";

export interface FridaySqliteMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  /**
   * Legacy checksums accepted for already-applied migrations.
   * Use for backward compatibility when historical migration SQL text changed.
   */
  acceptedChecksums?: readonly string[];
}

export interface FridayAppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface RunFridayMigrationsResult {
  applied: FridayAppliedMigration[];
  skippedVersions: number[];
}

/** Computes deterministic migration checksum (sha256 over normalized SQL). */
export function computeFridayMigrationChecksum(sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
