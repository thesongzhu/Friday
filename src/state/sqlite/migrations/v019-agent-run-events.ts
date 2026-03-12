import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V019_AGENT_RUN_EVENTS_SQL = `
-- V019: Durable per-run agent event log
CREATE TABLE IF NOT EXISTS friday_agent_run_events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES friday_agent_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  event_name   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_agent_run_events_run_seq
  ON friday_agent_run_events (run_id, seq);

CREATE INDEX IF NOT EXISTS idx_friday_agent_run_events_run_emitted
  ON friday_agent_run_events (run_id, emitted_at);
`;

const V019_CHECKSUM = computeFridayMigrationChecksum(V019_AGENT_RUN_EVENTS_SQL);

export const V019_AGENT_RUN_EVENTS_MIGRATION: FridaySqliteMigration = {
  version: 19,
  name: "v019-agent-run-events",
  sql: V019_AGENT_RUN_EVENTS_SQL,
  checksum: V019_CHECKSUM,
};
