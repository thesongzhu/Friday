import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V100_OPERATION_JOURNAL_SQL = `
-- V100: Durable cross-store idempotency / operation journal (DUR-OPERATION-JOURNAL-001).
--
-- The generic HTTP idempotency guard previously kept reservations + completed
-- responses in an in-memory Map that was lost on process restart, so a retry with
-- the same Idempotency-Key re-executed the handler and DUPLICATED the side-effect.
-- This durable journal survives restarts. It is a SEPARATE table from the
-- append-only audit ledger.

CREATE TABLE IF NOT EXISTS http_operation_journal (
  principal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_flight', 'completed')),
  response_json TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (principal_id, operation_id, idempotency_key)
);

-- Expression index over the joined store key (\`principal:operation:idempotencyKey\`)
-- so get()/release() lookups by the joined key stay index-backed.
CREATE INDEX IF NOT EXISTS idx_http_operation_journal_key
  ON http_operation_journal (principal_id || ':' || operation_id || ':' || idempotency_key);

-- Supports TTL pruning of expired reservations/replays.
CREATE INDEX IF NOT EXISTS idx_http_operation_journal_expires
  ON http_operation_journal (expires_at_ms);

-- Cross-store digest guards: each of these durable idempotent-insert surfaces now
-- records the sha256 payload digest so a key/PK reused with a DIFFERENT payload can
-- be detected and surfaced as a typed 409 conflict instead of silently swallowed.
-- (Nullable + additive: existing rows/inserts that do not set it stay valid.)
ALTER TABLE friday_agent_runs ADD COLUMN payload_digest TEXT;
ALTER TABLE llm_usage_records ADD COLUMN payload_digest TEXT;
ALTER TABLE outbox_messages ADD COLUMN payload_digest TEXT;
`;

const V100_CHECKSUM = computeFridayMigrationChecksum(V100_OPERATION_JOURNAL_SQL);

export const V100_OPERATION_JOURNAL_MIGRATION: FridaySqliteMigration = {
  version: 100,
  name: "v100-operation-journal",
  sql: V100_OPERATION_JOURNAL_SQL,
  checksum: V100_CHECKSUM,
};
