import Database from "better-sqlite3";
import { FridayDomainError } from "#errors";
import type { FridaySqlitePragmaConfig, FridaySqliteReadPool } from "./friday-sqlite.types.js";
import { applyFridayReadPragmas } from "./friday-sqlite-pragmas.js";

export interface CreateFridaySqliteReadPoolOptions {
  dbPath: string;
  size: number;
  pragmas: FridaySqlitePragmaConfig;
}

/** Creates and manages a fixed-size read-only better-sqlite3 pool. */
export function createFridaySqliteReadPool(
  options: CreateFridaySqliteReadPoolOptions,
): FridaySqliteReadPool {
  const { dbPath, size, pragmas } = options;

  if (size < 1) {
    throw new FridayDomainError("STATE_VALIDATION_ERROR", `Read pool size must be >= 1, got ${size}`, { httpStatus: 500 });
  }

  const connections: Database.Database[] = [];

  for (let i = 0; i < size; i++) {
    let conn: Database.Database | undefined;
    try {
      conn = new Database(dbPath, { readonly: true });
      applyFridayReadPragmas(conn, pragmas);
      connections.push(conn);
    } catch (error) {
      if (conn?.open) {
        conn.close();
      }
      for (const openConn of connections) {
        openConn.close();
      }
      connections.length = 0;
      throw error;
    }
  }

  let index = 0;
  let closed = false;

  return {
    size,

    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      if (closed || connections.length === 0) {
        throw new FridayDomainError("NOT_INITIALIZED", "SQLite read pool is closed", { httpStatus: 503 });
      }
      const conn = connections[index % connections.length];
      index = (index + 1) % connections.length;
      // P2-11: Error handling and slow-query diagnostics.
      const start = performance.now();
      try {
        const result = fn(conn);
        const elapsed = performance.now() - start;
        if (elapsed > 5000) {
          console.warn(`[friday][sqlite-read-pool] slow query: ${elapsed.toFixed(0)}ms`);
        }
        return result;
      } catch (err) {
        const elapsed = performance.now() - start;
        console.warn(`[friday][sqlite-read-pool] query error after ${elapsed.toFixed(0)}ms:`, err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const conn of connections) {
        conn.close();
      }
      connections.length = 0;
    },
  };
}
