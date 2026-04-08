import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V065_AGENT_RUN_CHECKPOINT_MANIFEST_SQL = `
-- V065: Persist per-run rollback checkpoint manifests for agent file mutations.
CREATE TABLE IF NOT EXISTS friday_agent_run_checkpoints (
  run_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  original_path TEXT NOT NULL,
  existed_before INTEGER NOT NULL DEFAULT 0,
  backup_path TEXT,
  snapshot_at TEXT NOT NULL,
  rollback_available INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, canonical_path)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_checkpoints_run_id
  ON friday_agent_run_checkpoints(run_id);

CREATE INDEX IF NOT EXISTS idx_agent_run_checkpoints_available
  ON friday_agent_run_checkpoints(rollback_available, run_id);
`;

const V065_CHECKSUM = computeFridayMigrationChecksum(
  V065_AGENT_RUN_CHECKPOINT_MANIFEST_SQL,
);

export const V065_AGENT_RUN_CHECKPOINT_MANIFEST_MIGRATION: FridaySqliteMigration = {
  version: 65,
  name: "v065-agent-run-checkpoint-manifest",
  sql: V065_AGENT_RUN_CHECKPOINT_MANIFEST_SQL,
  checksum: V065_CHECKSUM,
};
