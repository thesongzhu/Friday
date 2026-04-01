import type Database from "better-sqlite3";
import type { FridaySqlitePragmaConfig } from "./friday-sqlite.types.js";

function isBusyPragmaError(error: unknown): boolean {
  return !!(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}

/** Applies write-connection pragmas: WAL, foreign_keys, busy_timeout, synchronous. */
export function applyFridayWritePragmas(
  db: Database.Database,
  pragmas: FridaySqlitePragmaConfig,
): void {
  db.pragma(`busy_timeout = ${pragmas.busyTimeoutMs}`);
  try {
    db.pragma(`journal_mode = WAL`);
  } catch (error) {
    if (!isBusyPragmaError(error)) {
      throw error;
    }
  }
  db.pragma(`foreign_keys = ON`);
  db.pragma(`synchronous = ${pragmas.synchronous}`);
}

/** Applies read-connection pragmas: foreign_keys, busy_timeout, query_only. */
export function applyFridayReadPragmas(
  db: Database.Database,
  pragmas: FridaySqlitePragmaConfig,
): void {
  db.pragma(`foreign_keys = ON`);
  db.pragma(`busy_timeout = ${pragmas.busyTimeoutMs}`);
  db.pragma(`query_only = ON`);
}
