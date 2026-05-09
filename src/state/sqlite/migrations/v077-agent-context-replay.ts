import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V077_AGENT_CONTEXT_REPLAY_SQL = `
-- V077: Persist agent context replay summaries outside durable memory.
--
-- Context compaction summaries are replay evidence, not user-confirmed
-- memory.  Store them in a dedicated table so future runs can recover
-- continuity without polluting memory or preference stores.

CREATE TABLE IF NOT EXISTS friday_agent_context_replay_entries (
  entry_id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  source TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  compacted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_context_replay_session_compacted
  ON friday_agent_context_replay_entries(session_key, compacted_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_context_replay_run
  ON friday_agent_context_replay_entries(run_id);

CREATE INDEX IF NOT EXISTS idx_agent_context_replay_kind
  ON friday_agent_context_replay_entries(kind, trust_level);
`;

const V077_CHECKSUM = computeFridayMigrationChecksum(V077_AGENT_CONTEXT_REPLAY_SQL);

export const V077_AGENT_CONTEXT_REPLAY_MIGRATION: FridaySqliteMigration = {
  version: 77,
  name: "v077-agent-context-replay",
  sql: V077_AGENT_CONTEXT_REPLAY_SQL,
  checksum: V077_CHECKSUM,
};
