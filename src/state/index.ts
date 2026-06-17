import * as fs from "node:fs";

import { loadFridayConfig } from "#config";
import type { LoadedFridayConfig, LoadFridayConfigOptions } from "#config";

import type { FridaySqliteLayer } from "./sqlite/friday-sqlite.types.js";
import { createFridayMigrationTelemetryWriter } from "./telemetry/friday-migration-telemetry.js";
import type { FridayMigrationTelemetryWriter } from "./telemetry/friday-migration-telemetry.js";
import { resolveStateDir } from "./paths/friday-state-dir-resolver.js";
import { createFridaySqliteLayer } from "./sqlite/friday-sqlite-layer.js";
import { verifyFridayRustHubSchemaHandshake } from "./sqlite/friday-rust-hub-schema-handshake.js";

// SQLite types
export type {
  FridaySqlitePragmaConfig,
  CreateFridaySqliteLayerOptions,
  FridaySqliteReadPool,
  FridaySqliteLayer,
} from "./sqlite/friday-sqlite.types.js";
export { createFridaySqliteLayer } from "./sqlite/friday-sqlite-layer.js";

// Path utilities
export {
  resolveStateDir,
  resolveFridayDbPath,
} from "./paths/friday-state-dir-resolver.js";
export type { ResolveStateDirOptions } from "./paths/friday-state-dir-resolver.js";

// Telemetry
export { createFridayMigrationTelemetryWriter } from "./telemetry/friday-migration-telemetry.js";
export type {
  FridayMigrationTelemetryWriter,
  FridayMigrationTelemetryEvent,
  FridayMigrationTelemetrySummary,
} from "./telemetry/friday-migration-telemetry.js";

// Migration runner
export { runFridayMigrations } from "./sqlite/friday-migration-runner.js";
export {
  FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION,
  FRIDAY_HUB_AGENT_RUN_DB_PATH_ENV,
  verifyFridayRustHubSchemaHandshake,
} from "./sqlite/friday-rust-hub-schema-handshake.js";

// Migration types
export type { FridaySqliteMigration } from "./sqlite/migrations/friday-migration.types.js";
export { computeFridayMigrationChecksum } from "./sqlite/migrations/friday-migration.types.js";

// Migration definitions
export { FRIDAY_SQLITE_MIGRATIONS } from "./sqlite/migrations/index.js";
export { V001_INITIAL_MIGRATION } from "./sqlite/migrations/v001-initial.js";

// SQLite pragmas
export { applyFridayWritePragmas, applyFridayReadPragmas } from "./sqlite/friday-sqlite-pragmas.js";

export interface InitializeFridayStateOptions extends LoadFridayConfigOptions {}

export interface FridayStateRuntime {
  stateDir: string;
  config: LoadedFridayConfig;
  sqlite: FridaySqliteLayer;
  telemetry: FridayMigrationTelemetryWriter;
  /** Closes sqlite connections and flushes telemetry summary. */
  close(): void;
}

/** Initializes Phase 0 state baseline runtime end-to-end. */
export function initializeFridayState(
  options?: InitializeFridayStateOptions,
): FridayStateRuntime {
  // 1. Load config
  const loadedConfig = loadFridayConfig(options);
  const config = loadedConfig.config;

  // 2. Resolve state dir
  const stateDir = config.stateDir ?? resolveStateDir({ env: options?.env });
  fs.mkdirSync(stateDir, { recursive: true });

  // 3. Create telemetry writer
  const telemetry = createFridayMigrationTelemetryWriter({
    stateDir,
    fileName: config.telemetry.fileName,
    summaryFileName: config.telemetry.summaryFileName,
  });

  // 4. Fail closed if a configured/present Rust hub DB is not this build's schema peer.
  const rustHubSchemaHandshake = verifyFridayRustHubSchemaHandshake({
    stateDir,
    env: options?.env,
  });

  // 5. Create sqlite layer (includes migrations)
  const dbPath = `${stateDir}/friday.db`;
  const sqlite = createFridaySqliteLayer({
    dbPath,
    readPoolSize: config.database.readPoolSize,
    pragmas: {
      busyTimeoutMs: config.database.busyTimeoutMs,
      synchronous: config.database.synchronous,
    },
  });

  // 6. Record migration telemetry
  telemetry.record({
    type: "sqlite-migration",
    status: "ok",
    message: `Phase 0 state initialized; rust hub schema handshake=${rustHubSchemaHandshake.status}`,
  });

  return {
    stateDir,
    config: loadedConfig,
    sqlite,
    telemetry,

    close(): void {
      telemetry.finalize({
        finishedAt: new Date().toISOString(),
        appliedMigrations: [],
        mirrorWrites: { ok: 0, mismatch: 0, error: 0 },
        consistencyChecks: { ok: 0, mismatch: 0, error: 0 },
      });
      sqlite.close();
    },
  };
}
