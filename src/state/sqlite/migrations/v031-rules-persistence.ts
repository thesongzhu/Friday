import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V031_RULES_PERSISTENCE_SQL = `
-- V031: Rules engine persistence — tables for rules, rule_versions, policy_bundles, evaluation_audit

CREATE TABLE IF NOT EXISTS rule_policy_bundles (
  id              TEXT    PRIMARY KEY NOT NULL,
  name            TEXT    NOT NULL,
  description     TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  tags_json       TEXT    NOT NULL DEFAULT '[]',
  source          TEXT    NOT NULL DEFAULT 'manual',
  etag            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  deleted_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_rule_policy_bundles_name
  ON rule_policy_bundles (name);
CREATE INDEX IF NOT EXISTS idx_rule_policy_bundles_enabled
  ON rule_policy_bundles (enabled) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS rules (
  id                TEXT    PRIMARY KEY NOT NULL,
  policy_bundle_id  TEXT    NOT NULL REFERENCES rule_policy_bundles(id),
  name              TEXT    NOT NULL,
  description       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  resource          TEXT    NOT NULL,
  action            TEXT    NOT NULL,
  conditions_json   TEXT    NOT NULL DEFAULT '[]',
  decision          TEXT    NOT NULL DEFAULT 'allow',
  message           TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  etag              TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  deleted_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_rules_policy_bundle_id
  ON rules (policy_bundle_id);
CREATE INDEX IF NOT EXISTS idx_rules_resource_action
  ON rules (resource, action) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rules_enabled
  ON rules (enabled) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS rule_versions (
  id            TEXT    PRIMARY KEY NOT NULL,
  rule_id       TEXT    NOT NULL REFERENCES rules(id),
  version       INTEGER NOT NULL,
  snapshot_json TEXT    NOT NULL,
  changed_by    TEXT,
  change_note   TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_versions_rule_id
  ON rule_versions (rule_id, version DESC);

CREATE TABLE IF NOT EXISTS rule_evaluation_log (
  id                     TEXT    PRIMARY KEY NOT NULL,
  rule_id                TEXT,
  policy_bundle_id       TEXT,
  decision               TEXT    NOT NULL,
  resource               TEXT    NOT NULL,
  action                 TEXT    NOT NULL,
  context_redacted_json  TEXT    NOT NULL DEFAULT '{}',
  redaction_applied      INTEGER NOT NULL DEFAULT 0,
  redacted_fields_json   TEXT    NOT NULL DEFAULT '[]',
  matched_rules_json     TEXT    NOT NULL DEFAULT '[]',
  duration_ms            REAL    NOT NULL DEFAULT 0,
  run_id                 TEXT,
  workflow_id            TEXT,
  principal_id           TEXT,
  created_at             TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_evaluation_log_rule_id
  ON rule_evaluation_log (rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_evaluation_log_bundle_id
  ON rule_evaluation_log (policy_bundle_id);
CREATE INDEX IF NOT EXISTS idx_rule_evaluation_log_created_at
  ON rule_evaluation_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_evaluation_log_run_id
  ON rule_evaluation_log (run_id) WHERE run_id IS NOT NULL;
`;

const V031_CHECKSUM = computeFridayMigrationChecksum(V031_RULES_PERSISTENCE_SQL);
const V031_LEGACY_ACCEPTED_CHECKSUMS = [
  // Historical checksum found in existing user databases before SQL text stabilization.
  "0e88f23db5b602a0aed6d774baf4fc2cdf1d451141e665ab8dee0ee622e2403d",
] as const;

export const V031_RULES_PERSISTENCE_MIGRATION: FridaySqliteMigration = {
  version: 31,
  name: "v031-rules-persistence",
  sql: V031_RULES_PERSISTENCE_SQL,
  checksum: V031_CHECKSUM,
  acceptedChecksums: V031_LEGACY_ACCEPTED_CHECKSUMS,
};
