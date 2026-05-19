import Database from "better-sqlite3";
import type { CreateFridaySqliteLayerOptions, FridaySqliteLayer } from "./friday-sqlite.types.js";
import { applyFridayWritePragmas } from "./friday-sqlite-pragmas.js";
import { createFridaySqliteReadPool } from "./friday-sqlite-read-pool.js";
import { runFridayMigrations } from "./friday-migration-runner.js";
import { FRIDAY_SQLITE_MIGRATIONS } from "./migrations/index.js";

export const FRIDAY_SQLITE_STARTUP_BUSY_TIMEOUT_FLOOR_MS = 30_000;

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
  let writerClosed = false;
  const closeWriterAfterFailedStartup = () => {
    if (writerClosed || !writer.open) return;
    writerClosed = true;
    writer.close();
  };
  const startupPragmas = {
    ...pragmas,
    busyTimeoutMs: Math.max(pragmas.busyTimeoutMs, FRIDAY_SQLITE_STARTUP_BUSY_TIMEOUT_FLOOR_MS),
  };
  try {
    applyFridayWritePragmas(writer, startupPragmas);
    // 2. Run migrations on writer
    if (shouldRunMigrations) {
      runFridayMigrations({ db: writer, migrations: FRIDAY_SQLITE_MIGRATIONS });
    }
    if (!writerClosed && startupPragmas.busyTimeoutMs !== pragmas.busyTimeoutMs) {
      writer.pragma(`busy_timeout = ${pragmas.busyTimeoutMs}`);
    }
  } catch (error) {
    closeWriterAfterFailedStartup();
    throw error;
  }

  // 3. Open read pool
  let reads: ReturnType<typeof createFridaySqliteReadPool>;
  try {
    reads = createFridaySqliteReadPool({
      dbPath,
      size: readPoolSize,
      pragmas,
    });
  } catch (error) {
    closeWriterAfterFailedStartup();
    throw error;
  }

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

    optimize(): void {
      writer.pragma("optimize");
    },

    close(): void {
      if (closed) return;
      closed = true;
      reads.close();
      writerClosed = true;
      writer.close();
    },
  };
}
