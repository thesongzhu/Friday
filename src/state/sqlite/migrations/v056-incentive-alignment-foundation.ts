import type Database from "better-sqlite3";
import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL = `
-- V056: Incentive-alignment foundation for outcome receipts, reuse scoring,
-- proof-of-use ranking, and learning metrics expansion.

ALTER TABLE friday_agent_automations
  ADD COLUMN estimated_time_saved_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE friday_agent_automations
  ADD COLUMN reuse_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friday_agent_automations
  ADD COLUMN promotion_state TEXT NOT NULL DEFAULT 'private'
    CHECK (promotion_state IN ('private', 'team', 'public_boost_eligible', 'public'));
ALTER TABLE friday_agent_automations
  ADD COLUMN last_outcome_score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_promotion_state
  ON friday_agent_automations (promotion_state);

ALTER TABLE learning_metrics
  ADD COLUMN activation_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN save_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN reuse_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN promotion_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN support_conversion_rate REAL;
ALTER TABLE learning_metrics
  ADD COLUMN request_fulfillment_rate REAL;

CREATE TABLE learning_events_new (
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
    'workflow_outcome',
    'automation_saved',
    'automation_reused',
    'asset_promoted',
    'asset_published',
    'asset_supported',
    'request_fulfilled',
    'outcome_confirmed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO learning_events_new (
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
)
SELECT
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
FROM learning_events;

DROP TABLE learning_events;
ALTER TABLE learning_events_new RENAME TO learning_events;

CREATE INDEX IF NOT EXISTS idx_learning_events_user_ts
  ON learning_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_learning_events_kind
  ON learning_events(kind);
CREATE INDEX IF NOT EXISTS idx_learning_events_run
  ON learning_events(run_id);
`;

const V056_AUTOMATION_COLUMNS = [
  {
    tableName: "friday_agent_automations",
    columnName: "estimated_time_saved_minutes",
    columnSql: "estimated_time_saved_minutes INTEGER NOT NULL DEFAULT 15",
  },
  {
    tableName: "friday_agent_automations",
    columnName: "reuse_count",
    columnSql: "reuse_count INTEGER NOT NULL DEFAULT 0",
  },
  {
    tableName: "friday_agent_automations",
    columnName: "promotion_state",
    columnSql:
      "promotion_state TEXT NOT NULL DEFAULT 'private' CHECK (promotion_state IN ('private', 'team', 'public_boost_eligible', 'public'))",
  },
  {
    tableName: "friday_agent_automations",
    columnName: "last_outcome_score",
    columnSql: "last_outcome_score REAL NOT NULL DEFAULT 0",
  },
] as const;

const V056_LEARNING_METRIC_COLUMNS = [
  {
    tableName: "learning_metrics",
    columnName: "activation_rate",
    columnSql: "activation_rate REAL",
  },
  {
    tableName: "learning_metrics",
    columnName: "save_rate",
    columnSql: "save_rate REAL",
  },
  {
    tableName: "learning_metrics",
    columnName: "reuse_rate",
    columnSql: "reuse_rate REAL",
  },
  {
    tableName: "learning_metrics",
    columnName: "promotion_rate",
    columnSql: "promotion_rate REAL",
  },
  {
    tableName: "learning_metrics",
    columnName: "support_conversion_rate",
    columnSql: "support_conversion_rate REAL",
  },
  {
    tableName: "learning_metrics",
    columnName: "request_fulfillment_rate",
    columnSql: "request_fulfillment_rate REAL",
  },
] as const;

const V056_NEW_LEARNING_EVENT_KINDS = [
  "automation_saved",
  "automation_reused",
  "asset_promoted",
  "asset_published",
  "asset_supported",
  "request_fulfilled",
  "outcome_confirmed",
] as const;

const V056_LEARNING_EVENTS_REBUILD_SQL = `
DROP TABLE IF EXISTS learning_events_new;

CREATE TABLE learning_events_new (
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
    'workflow_outcome',
    'automation_saved',
    'automation_reused',
    'asset_promoted',
    'asset_published',
    'asset_supported',
    'request_fulfilled',
    'outcome_confirmed'
  )),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO learning_events_new (
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
)
SELECT
  event_id,
  ts,
  user_id,
  session_id,
  run_id,
  kind,
  payload_json,
  created_at
FROM learning_events;

DROP TABLE learning_events;
ALTER TABLE learning_events_new RENAME TO learning_events;
`;

/** Validate that an identifier is a safe SQLite table/column name (alphanumeric + underscore). */
function assertSafeIdentifier(name: string, label: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe ${label} identifier: ${JSON.stringify(name)}`);
  }
}

function hasTableColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  assertSafeIdentifier(tableName, "table");
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function addColumnIfMissing(
  db: Database.Database,
  input: { tableName: string; columnName: string; columnSql: string },
): void {
  assertSafeIdentifier(input.tableName, "table");
  if (hasTableColumn(db, input.tableName, input.columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${input.tableName} ADD COLUMN ${input.columnSql};`);
}

function hasLearningEventsExtension(db: Database.Database): boolean {
  const row = db.prepare(
    `SELECT sql
     FROM sqlite_master
     WHERE type = 'table' AND name = 'learning_events'`,
  ).get() as { sql?: string | null } | undefined;
  const sql = row?.sql ?? "";
  return V056_NEW_LEARNING_EVENT_KINDS.every((kind) => sql.includes(`'${kind}'`));
}

function applyV056IncentiveAlignmentFoundation(db: Database.Database): void {
  for (const column of V056_AUTOMATION_COLUMNS) {
    addColumnIfMissing(db, column);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_promotion_state
      ON friday_agent_automations (promotion_state);
  `);

  for (const column of V056_LEARNING_METRIC_COLUMNS) {
    addColumnIfMissing(db, column);
  }

  if (!hasLearningEventsExtension(db)) {
    db.exec(V056_LEARNING_EVENTS_REBUILD_SQL);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_learning_events_user_ts
      ON learning_events(user_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_events_kind
      ON learning_events(kind);
    CREATE INDEX IF NOT EXISTS idx_learning_events_run
      ON learning_events(run_id);
  `);
}

const V056_CHECKSUM = computeFridayMigrationChecksum(V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL);

export const V056_INCENTIVE_ALIGNMENT_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 56,
  name: "v056-incentive-alignment-foundation",
  sql: V056_INCENTIVE_ALIGNMENT_FOUNDATION_SQL,
  checksum: V056_CHECKSUM,
  apply: applyV056IncentiveAlignmentFoundation,
};
