import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";
import type {
  FridaySqliteMigration,
  RunFridayMigrationsResult,
} from "./migrations/friday-migration.types.js";

export interface RunFridayMigrationsOptions {
  db: Database.Database;
  migrations: readonly FridaySqliteMigration[];
  now?: () => Date;
}

/**
 * Applies pending migrations in a transaction per version.
 * Validates checksum for already-applied versions.
 */
export function runFridayMigrations(
  options: RunFridayMigrationsOptions,
): RunFridayMigrationsResult {
  const { db, migrations, now = () => new Date() } = options;

  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied: RunFridayMigrationsResult["applied"] = [];
  const skippedVersions: number[] = [];

  const getApplied = db.prepare(
    "SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = ?",
  );
  const insertApplied = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  for (const migration of migrations) {
    const existing = getApplied.get(migration.version) as
      | { version: number; name: string; checksum: string; applied_at: string }
      | undefined;

    if (existing) {
      // Validate checksum
      const acceptedChecksums = new Set([
        migration.checksum,
        ...(migration.acceptedChecksums ?? []),
      ]);
      if (!acceptedChecksums.has(existing.checksum)) {
        throw new FridayDomainError(
          "MIGRATION_CHECKSUM_MISMATCH",
          `Migration checksum mismatch for version ${migration.version} (${migration.name}): ` +
            `expected ${migration.checksum}, found ${existing.checksum}`,
          { httpStatus: 500 },
        );
      }
      skippedVersions.push(migration.version);
      continue;
    }

    // Apply migration in its own transaction
    const appliedAt = now().toISOString();
    const applyMigration = db.transaction(() => {
      if (typeof migration.apply === "function") {
        migration.apply(db);
      } else {
        db.exec(migration.sql);
      }
      insertApplied.run(migration.version, migration.name, migration.checksum, appliedAt);
    });

    applyMigration();

    applied.push({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt,
    });
  }

  return { applied, skippedVersions };
}
