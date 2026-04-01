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
 * Applies the full pending migration pass under a single IMMEDIATE transaction.
 * This serializes concurrent runners against the same SQLite file and preserves
 * all-or-nothing semantics for a migration batch.
 */
export function runFridayMigrations(
  options: RunFridayMigrationsOptions,
): RunFridayMigrationsResult {
  const { db, migrations, now = () => new Date() } = options;

  const applied: RunFridayMigrationsResult["applied"] = [];
  const skippedVersions: number[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

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

      const appliedAt = now().toISOString();
      if (typeof migration.apply === "function") {
        migration.apply(db);
      } else {
        db.exec(migration.sql);
      }
      insertApplied.run(migration.version, migration.name, migration.checksum, appliedAt);

      applied.push({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        appliedAt,
      });
    }

    db.exec("COMMIT");
    return { applied, skippedVersions };
  } catch (error) {
    if (db.inTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
