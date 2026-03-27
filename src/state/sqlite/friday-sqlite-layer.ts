import Database from "better-sqlite3";
import type { CreateFridaySqliteLayerOptions, FridaySqliteLayer } from "./friday-sqlite.types.js";
import { applyFridayWritePragmas } from "./friday-sqlite-pragmas.js";
import { createFridaySqliteReadPool } from "./friday-sqlite-read-pool.js";
import { runFridayMigrations } from "./friday-migration-runner.js";
import { FRIDAY_SQLITE_MIGRATIONS } from "./migrations/index.js";

/**
 * Creates Phase 0 sqlite runtime:
 * writer connection -> pragmas -> migrations -> read pool.
 */
export function createFridaySqliteLayer(
  options: CreateFridaySqliteLayerOptions,
): FridaySqliteLayer {
  const { dbPath, readPoolSize, pragmas, runMigrations: shouldRunMigrations = true } = options;

  // 1. Open writer connection
  const writer = new Database(dbPath);
  applyFridayWritePragmas(writer, pragmas);

  // 2. Run migrations on writer
  if (shouldRunMigrations) {
    runFridayMigrations({ db: writer, migrations: FRIDAY_SQLITE_MIGRATIONS });
  }

  // 3. Open read pool
  const reads = createFridaySqliteReadPool({
    dbPath,
    size: readPoolSize,
    pragmas,
  });

  // P2-DATA: Track closed state for idempotent close()
  let closed = false;

  return {
    dbPath,
    writer,
    reads,

    withWriteTransaction<T>(fn: (db: Database.Database) => T): T {
      return writer.transaction(() => fn(writer))();
    },

    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      return reads.withReadConnection(fn);
    },

    checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
      writer.pragma(`wal_checkpoint(${mode})`);
    },

    close(): void {
      if (closed) return;
      closed = true;
      reads.close();
      writer.close();
    },
  };
}
