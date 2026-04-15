> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 0 Implementation Plan: SQLite/State Baseline

## 1) `src/` Project Structure

```text
src/
  config/
    friday-config.types.ts
    friday-config.schema.ts
    friday-config-path.ts
    friday-config-backup-rotation.ts
    friday-config-io.ts
  state/
    index.ts
    paths/
      resolve-state-dir.ts
    sqlite/
      friday-sqlite.types.ts
      friday-sqlite-pragmas.ts
      friday-sqlite-read-pool.ts
      friday-migration-runner.ts
      friday-sqlite-layer.ts
      migrations/
        friday-migration.types.ts
        v001-initial.ts
        index.ts
    mirror/
      friday-compatibility-mirror.types.ts
      friday-consistency-checks.ts
      friday-compatibility-mirror.ts
    telemetry/
      friday-migration-telemetry.ts
```

### File purpose map

- `src/config/friday-config.types.ts`: Canonical Phase 0 config types (`FridayConfig`, load/write options).
- `src/config/friday-config.schema.ts`: Zod schema + parsing helpers.
- `src/config/friday-config-path.ts`: Resolve config file path from state dir.
- `src/config/friday-config-backup-rotation.ts`: Backup rotation logic (`.bak`, `.bak.1`, ...).
- `src/config/friday-config-io.ts`: JSON5 load/validate/default/write (atomic write).
- `src/state/index.ts`: Phase 0 bootstrap wiring (config + sqlite + telemetry + mirror setup).
- `src/state/paths/resolve-state-dir.ts`: `resolveStateDir()` + `resolveFridayDbPath()`.
- `src/state/sqlite/friday-sqlite.types.ts`: Shared sqlite interfaces and option types.
- `src/state/sqlite/friday-sqlite-pragmas.ts`: WAL/sync/foreign_keys/busy_timeout pragmas.
- `src/state/sqlite/friday-sqlite-read-pool.ts`: Read-only connection pool (round-robin).
- `src/state/sqlite/friday-migration-runner.ts`: Migration apply/checksum validation runner.
- `src/state/sqlite/friday-sqlite-layer.ts`: Writer + read pool lifecycle and close/checkpoint APIs.
- `src/state/sqlite/migrations/friday-migration.types.ts`: Migration type/checksum helper.
- `src/state/sqlite/migrations/v001-initial.ts`: V001 migration SQL constant + metadata.
- `src/state/sqlite/migrations/index.ts`: Ordered migration list export.
- `src/state/mirror/friday-compatibility-mirror.types.ts`: Mirror operation/result contracts.
- `src/state/mirror/friday-consistency-checks.ts`: Cross-store consistency checks + hash compare.
- `src/state/mirror/friday-compatibility-mirror.ts`: Executes sqlite + legacy mirror writes + telemetry.
- `src/state/telemetry/friday-migration-telemetry.ts`: Migration/mirror/consistency JSONL telemetry writer.

---

## 2) File Interfaces and Function Signatures (with JSDoc)

### `src/config/friday-config.types.ts`
```ts
export type FridayMirrorMode = "best-effort" | "strict";
export type FridaySqliteSynchronousMode = "NORMAL" | "FULL";

export interface FridayConfig {
  stateDir?: string;
  database: {
    readPoolSize: number;
    busyTimeoutMs: number;
    synchronous: FridaySqliteSynchronousMode;
  };
  mirror: {
    enabled: boolean;
    mode: FridayMirrorMode;
    consistencyCheckOnStartup: boolean;
  };
  telemetry: {
    enabled: boolean;
    fileName: string;
    summaryFileName: string;
  };
  backups: {
    configBackupCount: number;
  };
}

export interface LoadedFridayConfig {
  config: FridayConfig;
  configPath: string;
  exists: boolean;
  rawText?: string;
}

export interface LoadFridayConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface WriteFridayConfigOptions {
  configPath?: string;
  backupCount?: number;
  fileMode?: number;
}
```

### `src/config/friday-config.schema.ts`
```ts
import { z } from "zod";
import type { FridayConfig } from "./friday-config.types.js";

export const FridayConfigSchema: z.ZodType<FridayConfig>;

/** Validates unknown input and returns a fully defaulted FridayConfig. */
export function parseFridayConfig(input: unknown): FridayConfig;

/** Returns a stable default config used when config file does not exist. */
export function buildDefaultFridayConfig(): FridayConfig;
```

### `src/config/friday-config-path.ts`
```ts
import type { ResolveStateDirOptions } from "../state/paths/resolve-state-dir.js";

export interface ResolveFridayConfigPathOptions extends ResolveStateDirOptions {
  stateDir?: string;
  fileName?: string;
}

/** Resolves the Phase 0 config path. Default: `${resolveStateDir()}/config.json5`. */
export function resolveFridayConfigPath(options?: ResolveFridayConfigPathOptions): string;
```

### `src/config/friday-config-backup-rotation.ts`
```ts
/** Rotates config backups in descending order: `.bak.(n-1)` -> `.bak.n`, `.bak` -> `.bak.1`. */
export async function rotateFridayConfigBackups(
  configPath: string,
  maxBackups: number,
): Promise<void>;
```

### `src/config/friday-config-io.ts`
```ts
import type {
  FridayConfig,
  LoadedFridayConfig,
  LoadFridayConfigOptions,
  WriteFridayConfigOptions,
} from "./friday-config.types.js";

export type ParseFridayJson5Result =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parses raw JSON5 config text without validation. */
export function parseFridayJson5(raw: string): ParseFridayJson5Result;

/** Loads config from disk, applies Zod validation/defaults, returns typed result. */
export function loadFridayConfig(options?: LoadFridayConfigOptions): LoadedFridayConfig;

/** Validates and writes config atomically, rotating backups before replacement. */
export async function writeFridayConfig(
  config: FridayConfig,
  options?: WriteFridayConfigOptions,
): Promise<void>;
```

### `src/state/paths/resolve-state-dir.ts`
```ts
export interface ResolveStateDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (path: string) => boolean;
}

/**
 * Resolves Friday state directory.
 * Precedence:
 * 1) FRIDAY_STATE_DIR
 * 2) existing ~/.friday/state
 * 3) existing platform-convention path
 * 4) ~/.friday/state
 */
export function resolveStateDir(options?: ResolveStateDirOptions): string;

/** Resolves `${resolveStateDir()}/friday.db`. */
export function resolveFridayDbPath(options?: ResolveStateDirOptions): string;
```

### `src/state/sqlite/friday-sqlite.types.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySqliteSynchronousMode } from "../../config/friday-config.types.js";

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
  /** Closes writer and all readers. */
  close(): void;
}
```

### `src/state/sqlite/friday-sqlite-pragmas.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySqlitePragmaConfig } from "./friday-sqlite.types.js";

/** Applies write-connection pragmas: WAL, foreign_keys, busy_timeout, synchronous. */
export function applyFridayWritePragmas(
  db: Database.Database,
  pragmas: FridaySqlitePragmaConfig,
): void;

/** Applies read-connection pragmas: foreign_keys, busy_timeout, query_only. */
export function applyFridayReadPragmas(
  db: Database.Database,
  pragmas: FridaySqlitePragmaConfig,
): void;
```

### `src/state/sqlite/friday-sqlite-read-pool.ts`
```ts
import type { FridaySqlitePragmaConfig, FridaySqliteReadPool } from "./friday-sqlite.types.js";

export interface CreateFridaySqliteReadPoolOptions {
  dbPath: string;
  size: number;
  pragmas: FridaySqlitePragmaConfig;
}

/** Creates and manages a fixed-size read-only better-sqlite3 pool. */
export function createFridaySqliteReadPool(
  options: CreateFridaySqliteReadPoolOptions,
): FridaySqliteReadPool;
```

### `src/state/sqlite/migrations/friday-migration.types.ts`
```ts
export interface FridaySqliteMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
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
export function computeFridayMigrationChecksum(sql: string): string;
```

### `src/state/sqlite/migrations/v001-initial.ts`
```ts
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V001_INITIAL_SQL: string;

/** V001 baseline schema migration (authoritative §10.2 DDL). */
export const V001_INITIAL_MIGRATION: FridaySqliteMigration;
```

### `src/state/sqlite/migrations/index.ts`
```ts
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/** Ordered migration list, always ascending by version. */
export const FRIDAY_SQLITE_MIGRATIONS: readonly FridaySqliteMigration[];
```

### `src/state/sqlite/friday-migration-runner.ts`
```ts
import type Database from "better-sqlite3";
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
export function runFridayMigrations(options: RunFridayMigrationsOptions): RunFridayMigrationsResult;
```

### `src/state/sqlite/friday-sqlite-layer.ts`
```ts
import type { CreateFridaySqliteLayerOptions, FridaySqliteLayer } from "./friday-sqlite.types.js";

/**
 * Creates Phase 0 sqlite runtime:
 * writer connection -> pragmas -> migrations -> read pool.
 */
export function createFridaySqliteLayer(options: CreateFridaySqliteLayerOptions): FridaySqliteLayer;
```

### `src/state/telemetry/friday-migration-telemetry.ts`
```ts
export type FridayMigrationEventType =
  | "sqlite-migration"
  | "compatibility-mirror-write"
  | "consistency-check";

export type FridayMigrationStatus = "ok" | "skipped" | "mismatch" | "error";

export interface FridayMigrationTelemetryEvent {
  runId: string;
  at: string;
  type: FridayMigrationEventType;
  status: FridayMigrationStatus;
  entityType?: string;
  entityKey?: string;
  sourceCount?: number;
  targetCount?: number;
  sourceChecksum?: string;
  targetChecksum?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface FridayMigrationTelemetrySummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  appliedMigrations: number[];
  mirrorWrites: { ok: number; mismatch: number; error: number };
  consistencyChecks: { ok: number; mismatch: number; error: number };
}

export interface CreateFridayMigrationTelemetryOptions {
  stateDir: string;
  fileName: string;
  summaryFileName: string;
  now?: () => Date;
}

export interface FridayMigrationTelemetryWriter {
  runId: string;
  startedAt: string;
  /** Appends one JSONL event record. */
  record(event: Omit<FridayMigrationTelemetryEvent, "runId" | "at">): void;
  /** Writes summary JSON for the run. */
  finalize(summary: Omit<FridayMigrationTelemetrySummary, "runId" | "startedAt">): void;
}

/** Creates telemetry writer backed by `${stateDir}/telemetry/*.jsonl` and summary JSON. */
export function createFridayMigrationTelemetryWriter(
  options: CreateFridayMigrationTelemetryOptions,
): FridayMigrationTelemetryWriter;
```

### `src/state/mirror/friday-compatibility-mirror.types.ts`
```ts
import type { FridayMirrorMode } from "../../config/friday-config.types.js";

export interface FridayMirrorOperation<TPayload = unknown> {
  operation: string;
  entityType: string;
  entityKey: string;
  payload: TPayload;
  writeSqlite: () => void;
  writeLegacy: () => void;
  readSqliteSnapshot?: () => unknown;
  readLegacySnapshot?: () => unknown;
}

export interface FridayMirrorWriteResult {
  status: "ok" | "mismatch" | "legacy-write-failed";
  sourceChecksum?: string;
  targetChecksum?: string;
  errorMessage?: string;
}

export interface ExecuteFridayMirrorWriteOptions {
  mode: FridayMirrorMode;
}
```

### `src/state/mirror/friday-consistency-checks.ts`
```ts
export interface FridayConsistencyCheckDefinition {
  name: string;
  entityType: string;
  /** Returns source records keyed by stable entity key. */
  loadSource: () => Map<string, unknown>;
  /** Returns target records keyed by stable entity key. */
  loadTarget: () => Map<string, unknown>;
}

export interface FridayConsistencyMismatch {
  entityKey: string;
  sourceChecksum: string;
  targetChecksum: string;
}

export interface FridayConsistencyCheckResult {
  name: string;
  entityType: string;
  sourceCount: number;
  targetCount: number;
  mismatchCount: number;
  mismatches: FridayConsistencyMismatch[];
  status: "ok" | "mismatch";
}

export interface FridayConsistencyReport {
  at: string;
  results: FridayConsistencyCheckResult[];
}

/** Produces stable sha256 hash for canonicalized JSON values. */
export function hashFridayCanonicalJson(value: unknown): string;

/** Runs configured consistency checks and returns per-check mismatch data. */
export function runFridayConsistencyChecks(
  checks: readonly FridayConsistencyCheckDefinition[],
): FridayConsistencyReport;
```

### `src/state/mirror/friday-compatibility-mirror.ts`
```ts
import type {
  ExecuteFridayMirrorWriteOptions,
  FridayMirrorOperation,
  FridayMirrorWriteResult,
} from "./friday-compatibility-mirror.types.js";
import type { FridayMigrationTelemetryWriter } from "../telemetry/friday-migration-telemetry.js";

/**
 * Executes a mirrored write against sqlite + legacy store.
 * In strict mode, legacy failures/mismatches throw.
 * In best-effort mode, they are telemetry events.
 */
export function executeFridayCompatibilityMirrorWrite<TPayload>(
  operation: FridayMirrorOperation<TPayload>,
  telemetry: FridayMigrationTelemetryWriter,
  options: ExecuteFridayMirrorWriteOptions,
): FridayMirrorWriteResult;
```

### `src/state/index.ts`
```ts
import type { LoadFridayConfigOptions, LoadedFridayConfig } from "../config/friday-config.types.js";
import type { FridaySqliteLayer } from "./sqlite/friday-sqlite.types.js";
import type { FridayMigrationTelemetryWriter } from "./telemetry/friday-migration-telemetry.js";

export interface InitializeFridayStateOptions extends LoadFridayConfigOptions {}

export interface FridayStateRuntime {
  config: LoadedFridayConfig;
  sqlite: FridaySqliteLayer;
  telemetry: FridayMigrationTelemetryWriter;
  /** Closes sqlite connections and flushes telemetry summary. */
  close(): void;
}

/** Initializes Phase 0 state baseline runtime end-to-end. */
export function initializeFridayState(options?: InitializeFridayStateOptions): FridayStateRuntime;
```

---

## 3) SQLite Module Design (Phase 0 behavior)

- Engine: `better-sqlite3`.
- DB path: `${resolveStateDir()}/friday.db`.
- Write model: one writer connection.
- Read model: fixed-size read-only pool.
- Pragmas on writer:
- `journal_mode = WAL`
- `synchronous = NORMAL` (default; configurable to `FULL`)
- `foreign_keys = ON`
- `busy_timeout = 5000` (configurable)
- Pragmas on readers:
- `foreign_keys = ON`
- `busy_timeout = 5000`
- `query_only = ON`
- Migration flow:
- Open writer.
- Apply writer pragmas.
- Ensure `schema_migrations` exists.
- Apply ordered migrations (transaction per migration).
- Validate checksum for already-applied versions.
- Open read pool after migrations.
- Expose `checkpoint("FULL")` for backup-safe sync points.

---

## 4) State Directory Resolution (`resolveStateDir()`)

Resolution logic per §2.4 (with compatibility safety):

1. If `FRIDAY_STATE_DIR` is set and non-empty, use it (supports `~` expansion).
2. Else if `~/.friday/state` exists, use it.
3. Else if a platform-convention state path exists, use it.
4. Else fallback to `~/.friday/state`.

Platform-convention candidates:
- macOS: `~/Library/Application Support/Friday/state`
- Linux: `${XDG_STATE_HOME}/friday` or `~/.local/state/friday`
- Windows: `%LOCALAPPDATA%\Friday\state`

This keeps §2.4’s default while honoring platform conventions when already present.

---

## 5) Migration Telemetry + Consistency Checks

Telemetry file outputs:
- JSONL stream: `${stateDir}/telemetry/migration-telemetry.jsonl`
- Run summary JSON: `${stateDir}/telemetry/migration-summary.json`

Telemetry event types:
- `sqlite-migration`
- `compatibility-mirror-write`
- `consistency-check`

Compatibility mirror behavior:
- Every mirrored write executes `sqlite` then `legacy`.
- Optional snapshot hash comparison (`sourceChecksum` vs `targetChecksum`).
- `best-effort` mode logs mismatch/failure and continues.
- `strict` mode throws on mismatch/failure.

Consistency checks (startup + on-demand):
- Check 1: config snapshot parity (legacy config file vs sqlite `hub_settings`/`config_revisions` projection).
- Check 2: session index parity (legacy sessions index vs sqlite `sessions`).
- Check 3: message parity (legacy transcript-derived set vs sqlite `session_messages` key/hash).

---

## 6) V001 Migration DDL (`src/state/sqlite/migrations/v001-initial.ts`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hub_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  is_local_only INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS config_revisions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  patch_json TEXT NOT NULL,
  full_snapshot_json TEXT NOT NULL,
  changed_keys_json TEXT NOT NULL DEFAULT '[]',
  changed_by_user_id TEXT REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_revisions_revision
  ON config_revisions(revision DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  refresh_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  device_label TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  principal_type TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS satellites (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  pairing_status TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  public_key TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  local_ip TEXT,
  external_ip TEXT,
  transport TEXT NOT NULL DEFAULT 'ws',
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  node_version TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_satellites_pairing_status ON satellites(pairing_status);
CREATE INDEX IF NOT EXISTS idx_satellites_last_seen ON satellites(last_seen_at);

CREATE TABLE IF NOT EXISTS satellite_capabilities (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  key TEXT NOT NULL,
  available INTEGER NOT NULL,
  metadata_json TEXT,
  limits_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(satellite_id, key)
);

CREATE TABLE IF NOT EXISTS satellite_pairing_requests (
  id TEXT PRIMARY KEY,
  satellite_id TEXT REFERENCES satellites(id),
  code TEXT NOT NULL,
  nonce TEXT NOT NULL,
  requested_by_ip TEXT,
  requested_by_user_agent TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_user_id TEXT REFERENCES users(id),
  satellite_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pairing_status_expires
  ON satellite_pairing_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS satellite_heartbeats (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL,
  memory_percent REAL,
  load_avg_1m REAL,
  queue_depth INTEGER,
  active_runs INTEGER,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_sat_ts
  ON satellite_heartbeats(satellite_id, ts DESC);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  satellite_id TEXT NOT NULL REFERENCES satellites(id),
  queue_key TEXT NOT NULL,
  message_type TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  deliver_after TEXT,
  expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  leased_until TEXT,
  acked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_sat_status
  ON outbox_messages(satellite_id, status, deliver_after);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_sat_idempotency
  ON outbox_messages(satellite_id, idempotency_key);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  owner_satellite_id TEXT REFERENCES satellites(id),
  owner_lease_expires_at TEXT,
  owner_lease_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  summary TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_owner_lease
  ON sessions(owner_satellite_id, owner_lease_expires_at);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source_satellite_id TEXT REFERENCES satellites(id),
  idempotency_key TEXT,
  token_usage_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_idempotency
  ON session_messages(session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_messages_session_created
  ON session_messages(session_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
USING fts5(session_id, content_text, content='session_messages', content_rowid='rowid', tokenize='unicode61');

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_insert
AFTER INSERT ON session_messages
BEGIN
  INSERT INTO session_messages_fts(rowid, session_id, content_text)
  VALUES (NEW.rowid, NEW.session_id, NEW.content_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_update
AFTER UPDATE OF content_json ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, session_id, content_text)
  VALUES ('delete', OLD.rowid, OLD.session_id, OLD.content_json);
  INSERT INTO session_messages_fts(rowid, session_id, content_text)
  VALUES (NEW.rowid, NEW.session_id, NEW.content_json);
END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_fts_delete
AFTER DELETE ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, session_id, content_text)
  VALUES ('delete', OLD.rowid, OLD.session_id, OLD.content_json);
END;

-- Recovery reindex procedure (run manually if FTS index becomes inconsistent):
-- INSERT INTO session_messages_fts(session_messages_fts) VALUES('rebuild');

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  owner_user_id TEXT REFERENCES users(id),
  latest_version_number INTEGER NOT NULL DEFAULT 1,
  published_version_number INTEGER,
  is_archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version_number INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  is_published INTEGER NOT NULL DEFAULT 0,
  change_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
  ON workflow_versions(workflow_id, version_number DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_payload_json TEXT,
  started_by_user_id TEXT REFERENCES users(id),
  started_by_satellite_id TEXT REFERENCES satellites(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  correlation_id TEXT,
  context_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  failure_details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_started
  ON workflow_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_nodes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  satellite_id TEXT REFERENCES satellites(id),
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, node_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run_status
  ON workflow_run_nodes(run_id, status);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'managed',
  publisher TEXT,
  latest_version TEXT,
  installed_version TEXT,
  status TEXT NOT NULL,
  current_manifest_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  package_url TEXT,
  signature_key_id TEXT,
  signature_algorithm TEXT,
  signature_value TEXT,
  manifest_json TEXT NOT NULL,
  released_at TEXT NOT NULL,
  yanked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_installations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  satellite_id TEXT REFERENCES satellites(id),
  status TEXT NOT NULL,
  permissions_granted_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_installs_sat_status
  ON skill_installations(satellite_id, status);

CREATE TABLE IF NOT EXISTS marketplace_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trust_policy TEXT NOT NULL,
  pinned_key_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketplace_cache (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES marketplace_sources(id),
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  trust_score REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, skill_id, version)
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_model TEXT,
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  key_id TEXT NOT NULL,
  expires_at TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, ref_key)
);

-- ============================================================
-- Unified learning + diagnosis + approval schema
-- (Authoritative DDL — merged from both design documents)
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  embedding_vector_ref TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_memory_namespace_key
  ON memory_items(namespace, key);

CREATE TABLE IF NOT EXISTS learning_events (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'user_message',
    'assistant_message',
    'tool_result',
    'user_correction',
    'error_incident',
    'workflow_outcome'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_events_user_ts
  ON learning_events(user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_kind
  ON learning_events(kind);

CREATE INDEX IF NOT EXISTS idx_learning_events_run
  ON learning_events(run_id);

CREATE TABLE IF NOT EXISTS preference_facts (
  fact_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  evidence_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_preference_facts_user
  ON preference_facts(user_id);

CREATE TABLE IF NOT EXISTS error_incidents (
  incident_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_id TEXT,
  ts TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('tool', 'model', 'routing', 'config', 'workflow')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  signature TEXT NOT NULL,
  context_json TEXT NOT NULL,
  auto_fix_eligible INTEGER NOT NULL DEFAULT 0 CHECK (auto_fix_eligible IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_incidents_signature
  ON error_incidents(signature);

CREATE INDEX IF NOT EXISTS idx_error_incidents_user
  ON error_incidents(user_id);

CREATE INDEX IF NOT EXISTS idx_error_incidents_run
  ON error_incidents(run_id);

CREATE TABLE IF NOT EXISTS diagnosis_records (
  id TEXT PRIMARY KEY,
  incident_id TEXT REFERENCES error_incidents(incident_id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_id TEXT,
  error_fingerprint TEXT NOT NULL,
  confidence REAL NOT NULL,
  diagnosis_json TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_fingerprint
  ON diagnosis_records(error_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnosis_incident
  ON diagnosis_records(incident_id);

CREATE TABLE IF NOT EXISTS learned_lessons (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  cause TEXT NOT NULL,
  fix TEXT NOT NULL,
  mitigation_json TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  source_incident_id TEXT REFERENCES error_incidents(incident_id) ON DELETE SET NULL,
  source_diagnosis_id TEXT REFERENCES diagnosis_records(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_last_seen
  ON learned_lessons(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS auto_fix_actions (
  action_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES error_incidents(incident_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  risk_tier INTEGER NOT NULL CHECK (risk_tier IN (0, 1, 2)),
  plan_json TEXT NOT NULL,
  rollback_plan_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'rolled_back', 'rejected')),
  outcome TEXT CHECK (outcome IN ('success', 'failed') OR outcome IS NULL),
  applied_at TEXT,
  rolled_back_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_incident
  ON auto_fix_actions(incident_id);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_user
  ON auto_fix_actions(user_id);

CREATE INDEX IF NOT EXISTS idx_auto_fix_actions_status
  ON auto_fix_actions(status);

CREATE TABLE IF NOT EXISTS approval_requests (
  request_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES auto_fix_actions(action_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  risk_tier INTEGER NOT NULL CHECK (risk_tier = 2),
  plan_json TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  response_reason TEXT,
  responded_at TEXT,
  responded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_user_status
  ON approval_requests(user_id, status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_action
  ON approval_requests(action_id);

CREATE TABLE IF NOT EXISTS learning_metrics (
  day TEXT PRIMARY KEY,
  success_rate REAL,
  auto_fix_success_rate REAL,
  rollback_rate REAL,
  incidents_total INTEGER NOT NULL DEFAULT 0,
  facts_updated INTEGER NOT NULL DEFAULT 0,
  actions_executed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- End unified learning/approval schema
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  ip TEXT,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id, ts DESC);
```

---

## 7) Unit Test Plan (Vitest)

### Config tests

- `test/unit/config/friday-config-io.test.ts`
- Loads defaults when config file is absent.
- Parses JSON5 comments/trailing commas.
- Rejects invalid config with Zod path details.
- Writes atomically and preserves valid JSON5 output.

- `test/unit/config/friday-config-backup-rotation.test.ts`
- Rotates backups correctly at `N` depth.
- No-op when `maxBackups <= 1`.
- Handles missing backup files gracefully.

- `test/unit/config/friday-config-path.test.ts`
- Uses explicit `configPath` when provided.
- Defaults to `${stateDir}/config.json5`.

### State path tests

- `test/unit/state/paths/resolve-state-dir.test.ts`
- `FRIDAY_STATE_DIR` override wins.
- Existing `~/.friday/state` wins over platform path.
- Existing platform path chosen when legacy default absent.
- Fallback path is `~/.friday/state`.
- `~` expansion works.

### SQLite tests

- `test/unit/state/sqlite/friday-sqlite-pragmas.test.ts`
- Writer pragmas set (`WAL`, `foreign_keys`, `busy_timeout`, `synchronous`).
- Reader sets `query_only`.

- `test/unit/state/sqlite/friday-migration-runner.test.ts`
- Applies V001 once and records in `schema_migrations`.
- Second run is no-op.
- Checksum mismatch for applied version throws.
- Failed migration rolls back that migration transaction.

- `test/unit/state/sqlite/v001-schema.test.ts`
- Verifies existence of all V001 tables.
- Verifies critical indexes and FTS triggers exist.

- `test/unit/state/sqlite/friday-sqlite-layer.test.ts`
- Creates writer + read pool.
- `withWriteTransaction` commits and rolls back correctly.
- `close()` closes all connections.

### Mirror + telemetry tests

- `test/unit/state/mirror/friday-compatibility-mirror.test.ts`
- Best-effort mode logs legacy failure without throw.
- Strict mode throws on legacy failure.
- Snapshot mismatch marks result `mismatch`.

- `test/unit/state/mirror/friday-consistency-checks.test.ts`
- Detects count mismatch.
- Detects hash mismatch for same key.
- Reports clean check as `ok`.

- `test/unit/state/telemetry/friday-migration-telemetry.test.ts`
- Writes JSONL event records.
- Writes summary JSON on finalize.
- Includes runId/timestamps/status counters.

### Bootstrap wiring tests

- `test/unit/state/state-index.test.ts`
- Initializes full Phase 0 runtime from temp state dir.
- Runs migrations during init.
- Wires telemetry and close lifecycle.

---

## 8) Dependencies (`pnpm`)

### Runtime

- `better-sqlite3`
- `zod`
- `json5`

### Dev

- `typescript`
- `vitest`
- `@types/node`

### Install commands

```bash
pnpm add better-sqlite3 zod json5
pnpm add -D typescript vitest @types/node
```


