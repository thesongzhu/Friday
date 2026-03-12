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
    const conn = new Database(dbPath, { readonly: true });
    applyFridayReadPragmas(conn, pragmas);
    connections.push(conn);
  }

  let index = 0;

  return {
    size,

    withReadConnection<T>(fn: (db: Database.Database) => T): T {
      const conn = connections[index % connections.length];
      index = (index + 1) % connections.length;
      return fn(conn);
    },

    close(): void {
      for (const conn of connections) {
        conn.close();
      }
      connections.length = 0;
    },
  };
}
