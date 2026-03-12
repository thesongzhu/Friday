import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V037_FK_AND_PLAYBOOK_INDEX_SQL = `
-- V037: Rebuild tables with real REFERENCES FK constraints + missing indexes.
--
-- friday_subagent_runs was created in v013 (15 columns) then ALTERed in
-- v028 (+4 columns). A rebuild normalizes all 19 columns into the
-- canonical CREATE TABLE and adds REFERENCES for parent_run_id.
-- child_run_id is a deferred FK (starts as '' and is populated after
-- the child agent run is created) so it cannot use REFERENCES.
--
-- workflow_builder_drafts is rebuilt to add REFERENCES workflows(id).
-- workflow_conflicts is rebuilt to add REFERENCES workflows(id) and
-- REFERENCES workflow_builder_drafts(draft_id).
--
-- Note: PRAGMA foreign_keys = ON is set in v001, so these constraints
-- are enforced at the database level.

-- ── 1. friday_subagent_runs: rebuild with REFERENCES on parent_run_id ──

CREATE TABLE friday_subagent_runs_new (
  id                      TEXT PRIMARY KEY,
  parent_run_id           TEXT NOT NULL REFERENCES friday_agent_runs(id),
  parent_session_key      TEXT NOT NULL,
  child_run_id            TEXT NOT NULL DEFAULT '',  -- deferred FK: populated after child run created
  child_session_key       TEXT NOT NULL,
  task                    TEXT NOT NULL,
  label                   TEXT,
  model                   TEXT,
  depth                   INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  outcome                 TEXT,
  created_at              TEXT NOT NULL,
  started_at              TEXT,
  completed_at            TEXT,
  duration_ms             INTEGER,
  requester_session_key   TEXT,
  root_run_id             TEXT,
  cleanup_requested       INTEGER NOT NULL DEFAULT 0,
  archival_deadline        TEXT
);

INSERT INTO friday_subagent_runs_new
  SELECT * FROM friday_subagent_runs;

DROP TABLE friday_subagent_runs;
ALTER TABLE friday_subagent_runs_new RENAME TO friday_subagent_runs;

CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
  ON friday_subagent_runs (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_child
  ON friday_subagent_runs (child_run_id);
CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_status
  ON friday_subagent_runs (status);
CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_created
  ON friday_subagent_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_requester_session
  ON friday_subagent_runs (requester_session_key);
CREATE INDEX IF NOT EXISTS idx_friday_subagent_runs_root_run
  ON friday_subagent_runs (root_run_id);

-- ── 2. workflow_builder_drafts: rebuild with REFERENCES workflows(id) ──

CREATE TABLE workflow_builder_drafts_new (
  draft_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL DEFAULT '{}',
  visual_json TEXT NOT NULL DEFAULT '{}',
  owner_user_id TEXT,
  base_workflow_version_id TEXT,
  lock_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autosave_enabled INTEGER NOT NULL DEFAULT 0,
  autosave_interval_ms INTEGER NOT NULL DEFAULT 30000
);

INSERT INTO workflow_builder_drafts_new
  SELECT * FROM workflow_builder_drafts;

DROP TABLE workflow_builder_drafts;
ALTER TABLE workflow_builder_drafts_new RENAME TO workflow_builder_drafts;

CREATE INDEX IF NOT EXISTS idx_builder_drafts_workflow
  ON workflow_builder_drafts (workflow_id);

-- ── 3. workflow_conflicts: rebuild with REFERENCES workflows(id) + drafts ──

CREATE TABLE workflow_conflicts_new (
  conflict_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  draft_id TEXT NOT NULL REFERENCES workflow_builder_drafts(draft_id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  base_workflow_version_id TEXT,
  head_workflow_version_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user_id TEXT,
  summary TEXT NOT NULL,
  patches_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO workflow_conflicts_new
  SELECT * FROM workflow_conflicts;

DROP TABLE workflow_conflicts;
ALTER TABLE workflow_conflicts_new RENAME TO workflow_conflicts;

CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_workflow
  ON workflow_conflicts (workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_draft
  ON workflow_conflicts (draft_id);

-- ── 4. Remaining indexes ──

CREATE INDEX IF NOT EXISTS idx_playbook_selections_run_id
  ON playbook_selections (run_id);
`;

const V037_CHECKSUM = computeFridayMigrationChecksum(V037_FK_AND_PLAYBOOK_INDEX_SQL);

export const V037_FK_AND_PLAYBOOK_INDEX_MIGRATION: FridaySqliteMigration = {
  version: 37,
  name: "v037-fk-and-playbook-index",
  sql: V037_FK_AND_PLAYBOOK_INDEX_SQL,
  checksum: V037_CHECKSUM,
};
