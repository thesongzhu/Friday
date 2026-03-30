import type Database from "better-sqlite3";
import type { FridaySqliteSynchronousMode } from "#config";

export interface FridaySqlitePragmaConfig {
  busyTimeoutMs: number;
  synchronous: FridaySqliteSynchronousMode;
}

export interface CreateFridaySqliteLayerOptions {
  dbPath: string;
  readPoolSize: number;
  pragmas: FridaySqlitePragmaConfig;
  runMigrations?: boolean;
}

export interface FridaySqliteReadPool {
  size: number;
  /** Executes callback against one read-only connection (round-robin). */
  withReadConnection<T>(fn: (db: Database.Database) => T): T;
  /** Closes all read-only connections. */
  close(): void;
}

export interface FridaySqliteLayer {
  dbPath: string;
  writer: Database.Database;
  reads: FridaySqliteReadPool;
  /** Runs a write transaction on the single writer connection. */
  withWriteTransaction<T>(fn: (db: Database.Database) => T): T;
  /** Runs a read callback on the read pool. */
  withReadConnection<T>(fn: (db: Database.Database) => T): T;
  /** Runs WAL checkpoint for backup/maintenance flows. */
  checkpoint(mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): void;
  /** Runs PRAGMA optimize to update query planner statistics. */
  optimize(): void;
  /** Closes writer and all readers. */
  close(): void;
}
