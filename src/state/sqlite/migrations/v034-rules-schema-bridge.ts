import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V034_RULES_SCHEMA_BRIDGE_SQL = `
-- V034: Rules schema bridge for platformized repositories.
-- Adds backward-compatible columns/tables used by split repositories and
-- keeps legacy/new evaluation audit tables mirrored.

ALTER TABLE rule_policy_bundles ADD COLUMN signature_algorithm TEXT;
ALTER TABLE rule_policy_bundles ADD COLUMN signature_key_id TEXT;
ALTER TABLE rule_policy_bundles ADD COLUMN signature_value TEXT;
ALTER TABLE rule_policy_bundles ADD COLUMN checksum TEXT;

ALTER TABLE rules ADD COLUMN checksum TEXT;

CREATE TABLE IF NOT EXISTS rule_policy_bundle_versions (
  id            TEXT PRIMARY KEY NOT NULL,
  bundle_id     TEXT NOT NULL REFERENCES rule_policy_bundles(id),
  version       INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  changed_by    TEXT,
  change_note   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(bundle_id, version)
);

CREATE INDEX IF NOT EXISTS idx_rule_policy_bundle_versions_bundle
  ON rule_policy_bundle_versions (bundle_id, version DESC);

CREATE TABLE IF NOT EXISTS rule_eval_audit (
  id                     TEXT PRIMARY KEY NOT NULL,
  rule_id                TEXT,
  policy_bundle_id       TEXT,
  decision               TEXT NOT NULL,
  resource               TEXT NOT NULL,
  action                 TEXT NOT NULL,
  context_redacted_json  TEXT NOT NULL,
  redaction_applied      INTEGER NOT NULL DEFAULT 0,
  redacted_fields_json   TEXT NOT NULL DEFAULT '[]',
  matched_rules_json     TEXT NOT NULL DEFAULT '[]',
  duration_ms            REAL NOT NULL DEFAULT 0,
  run_id                 TEXT,
  workflow_id            TEXT,
  principal_id           TEXT,
  context_hash           TEXT,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_eval_audit_created
  ON rule_eval_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_eval_audit_decision
  ON rule_eval_audit (decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_eval_audit_run
  ON rule_eval_audit (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rule_eval_audit_bundle
  ON rule_eval_audit (policy_bundle_id) WHERE policy_bundle_id IS NOT NULL;

INSERT OR IGNORE INTO rule_eval_audit (
  id,
  rule_id,
  policy_bundle_id,
  decision,
  resource,
  action,
  context_redacted_json,
  redaction_applied,
  redacted_fields_json,
  matched_rules_json,
  duration_ms,
  run_id,
  workflow_id,
  principal_id,
  context_hash,
  created_at
)
SELECT
  id,
  rule_id,
  policy_bundle_id,
  decision,
  resource,
  action,
  context_redacted_json,
  redaction_applied,
  redacted_fields_json,
  matched_rules_json,
  duration_ms,
  run_id,
  workflow_id,
  principal_id,
  NULL,
  created_at
FROM rule_evaluation_log;

CREATE TRIGGER IF NOT EXISTS trg_rule_eval_log_to_audit
AFTER INSERT ON rule_evaluation_log
BEGIN
  INSERT OR IGNORE INTO rule_eval_audit (
    id,
    rule_id,
    policy_bundle_id,
    decision,
    resource,
    action,
    context_redacted_json,
    redaction_applied,
    redacted_fields_json,
    matched_rules_json,
    duration_ms,
    run_id,
    workflow_id,
    principal_id,
    context_hash,
    created_at
  )
  VALUES (
    NEW.id,
    NEW.rule_id,
    NEW.policy_bundle_id,
    NEW.decision,
    NEW.resource,
    NEW.action,
    NEW.context_redacted_json,
    NEW.redaction_applied,
    NEW.redacted_fields_json,
    NEW.matched_rules_json,
    NEW.duration_ms,
    NEW.run_id,
    NEW.workflow_id,
    NEW.principal_id,
    NULL,
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_rule_eval_audit_to_log
AFTER INSERT ON rule_eval_audit
BEGIN
  INSERT OR IGNORE INTO rule_evaluation_log (
    id,
    rule_id,
    policy_bundle_id,
    decision,
    resource,
    action,
    context_redacted_json,
    redaction_applied,
    redacted_fields_json,
    matched_rules_json,
    duration_ms,
    run_id,
    workflow_id,
    principal_id,
    created_at
  )
  VALUES (
    NEW.id,
    NEW.rule_id,
    NEW.policy_bundle_id,
    NEW.decision,
    NEW.resource,
    NEW.action,
    NEW.context_redacted_json,
    NEW.redaction_applied,
    NEW.redacted_fields_json,
    NEW.matched_rules_json,
    NEW.duration_ms,
    NEW.run_id,
    NEW.workflow_id,
    NEW.principal_id,
    NEW.created_at
  );
END;
`;

const V034_CHECKSUM = computeFridayMigrationChecksum(V034_RULES_SCHEMA_BRIDGE_SQL);

export const V034_RULES_SCHEMA_BRIDGE_MIGRATION: FridaySqliteMigration = {
  version: 34,
  name: "v034-rules-schema-bridge",
  sql: V034_RULES_SCHEMA_BRIDGE_SQL,
  checksum: V034_CHECKSUM,
};
