import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V059_RULES_AUDIT_CANONICALIZATION_SQL = `
-- V059: Canonicalize rules audit writes through rule_eval_audit.
-- Backfill any legacy-only rows, then retire the legacy -> audit trigger.

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

DROP TRIGGER IF EXISTS trg_rule_eval_log_to_audit;
`;

const V059_CHECKSUM = computeFridayMigrationChecksum(V059_RULES_AUDIT_CANONICALIZATION_SQL);

export const V059_RULES_AUDIT_CANONICALIZATION_MIGRATION: FridaySqliteMigration = {
  version: 59,
  name: "v059-rules-audit-canonicalization",
  sql: V059_RULES_AUDIT_CANONICALIZATION_SQL,
  checksum: V059_CHECKSUM,
};
