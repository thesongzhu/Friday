import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V032_PLAYBOOK_PERSISTENCE_SQL = `
-- V032: Playbook persistence — candidates, playbooks, versions, scores, selections

CREATE TABLE IF NOT EXISTS playbook_candidates (
  id                     TEXT    PRIMARY KEY NOT NULL,
  fingerprint            TEXT    NOT NULL,
  workflow_type          TEXT    NOT NULL,
  tags_json              TEXT    NOT NULL DEFAULT '[]',
  pattern_json           TEXT    NOT NULL,
  status                 TEXT    NOT NULL,
  evidence_count         INTEGER NOT NULL DEFAULT 0,
  success_count          INTEGER NOT NULL DEFAULT 0,
  failure_count          INTEGER NOT NULL DEFAULT 0,
  total_duration_ms      REAL    NOT NULL DEFAULT 0,
  total_cost_json        TEXT    NOT NULL DEFAULT '{}',
  source_run_ids_json    TEXT    NOT NULL DEFAULT '[]',
  promoted_playbook_id   TEXT,
  first_observed_at      TEXT    NOT NULL,
  last_observed_at       TEXT    NOT NULL,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playbook_candidates_fingerprint
  ON playbook_candidates (fingerprint);
CREATE INDEX IF NOT EXISTS idx_playbook_candidates_workflow_status
  ON playbook_candidates (workflow_type, status);
CREATE INDEX IF NOT EXISTS idx_playbook_candidates_updated_at
  ON playbook_candidates (updated_at DESC);

CREATE TABLE IF NOT EXISTS playbooks (
  id                     TEXT    PRIMARY KEY NOT NULL,
  name                   TEXT    NOT NULL,
  description            TEXT,
  workflow_type          TEXT    NOT NULL,
  tags_json              TEXT    NOT NULL DEFAULT '[]',
  status                 TEXT    NOT NULL,
  active_version_number  INTEGER NOT NULL DEFAULT 1,
  source_candidate_id    TEXT    NOT NULL REFERENCES playbook_candidates(id),
  composite_score        REAL    NOT NULL DEFAULT 0,
  total_uses             INTEGER NOT NULL DEFAULT 0,
  total_successes        INTEGER NOT NULL DEFAULT 0,
  last_used_at           TEXT,
  last_successful_at     TEXT,
  etag                   TEXT    NOT NULL,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  archived_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_playbooks_workflow_status
  ON playbooks (workflow_type, status);
CREATE INDEX IF NOT EXISTS idx_playbooks_composite_score
  ON playbooks (composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_playbooks_updated_at
  ON playbooks (updated_at DESC);

CREATE TABLE IF NOT EXISTS playbook_versions (
  id                     TEXT    PRIMARY KEY NOT NULL,
  playbook_id            TEXT    NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL,
  fingerprint            TEXT    NOT NULL,
  pattern_json           TEXT    NOT NULL,
  candidate_id           TEXT    NOT NULL REFERENCES playbook_candidates(id),
  change_note            TEXT,
  created_at             TEXT    NOT NULL,
  UNIQUE (playbook_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_playbook_versions_playbook
  ON playbook_versions (playbook_id, version_number DESC);

CREATE TABLE IF NOT EXISTS playbook_scores (
  id                     TEXT    PRIMARY KEY NOT NULL,
  playbook_id            TEXT    NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL,
  composite_score        REAL    NOT NULL,
  success_rate           REAL    NOT NULL,
  speed_score            REAL    NOT NULL,
  cost_efficiency_score  REAL    NOT NULL,
  satisfaction_score     REAL    NOT NULL,
  sample_size            INTEGER NOT NULL DEFAULT 0,
  calculated_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playbook_scores_playbook_calculated
  ON playbook_scores (playbook_id, calculated_at DESC);

CREATE TABLE IF NOT EXISTS playbook_selections (
  id                     TEXT    PRIMARY KEY NOT NULL,
  run_id                 TEXT    NOT NULL,
  workflow_id            TEXT    NOT NULL,
  playbook_id            TEXT    REFERENCES playbooks(id),
  version_number         INTEGER,
  match_score            REAL,
  similarity             REAL,
  reason                 TEXT    NOT NULL,
  context_json           TEXT    NOT NULL DEFAULT '{}',
  selected_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playbook_selections_workflow_selected
  ON playbook_selections (workflow_id, selected_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbook_selections_playbook_selected
  ON playbook_selections (playbook_id, selected_at DESC) WHERE playbook_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_decisions (
  id                     TEXT    PRIMARY KEY NOT NULL,
  candidate_id           TEXT    NOT NULL REFERENCES playbook_candidates(id) ON DELETE CASCADE,
  decision               TEXT    NOT NULL,
  reason                 TEXT    NOT NULL,
  rule_results_json      TEXT    NOT NULL DEFAULT '[]',
  rules_result_json      TEXT,
  score_snapshot_json    TEXT    NOT NULL DEFAULT '{}',
  decided_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promotion_decisions_candidate
  ON promotion_decisions (candidate_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS playbook_lifecycle_events (
  id                     TEXT    PRIMARY KEY NOT NULL,
  playbook_id            TEXT    NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  type                   TEXT    NOT NULL,
  reason                 TEXT    NOT NULL,
  from_version_number    INTEGER,
  to_version_number      INTEGER,
  occurred_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playbook_lifecycle_events_playbook
  ON playbook_lifecycle_events (playbook_id, occurred_at DESC);
`;

const V032_CHECKSUM = computeFridayMigrationChecksum(V032_PLAYBOOK_PERSISTENCE_SQL);
const V032_LEGACY_ACCEPTED_CHECKSUMS = [
  // Historical checksum observed in previously released local state databases.
  "f84814033692526f292897f8d0886a2eb6846688d8849e250a7fcbfa2aee0b57",
] as const;

export const V032_PLAYBOOK_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 32,
  name: "v032-playbook-persistence",
  sql: V032_PLAYBOOK_PERSISTENCE_SQL,
  checksum: V032_CHECKSUM,
  acceptedChecksums: V032_LEGACY_ACCEPTED_CHECKSUMS,
};
