import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V102_PROVIDER_CALL_RECEIPT_SQL = `
-- ============================================================
-- V102: Provider call receipt + per-call request-id idempotency
-- (BYOK-PROVIDER-COST-RECEIPT-001)
-- ============================================================
--
-- llm_usage_records (V003) recorded provider spend keyed only by a locally
-- minted UUID 'id'. recordUsage generated a fresh 'id' on every call, so the
-- SAME provider response recorded twice (a fire-and-forget retry, a replay, or
-- two code paths recording one call) produced TWO rows and DOUBLE-COUNTED the
-- charge. There was also no capture of the provider's own request-id and no
-- durable, verifiable receipt bound to that call.
--
-- This migration is additive. Four nullable columns carry the new truth:
--   request_id  the provider response's own request identifier (x-request-id
--               header or response body id). NULL for legacy/local calls that
--               never surfaced one — those keep their prior (non-idempotent)
--               behavior and are untouched.
--   run_id      agent run linkage (nullable).
--   turn_id     agent turn linkage (nullable).
--   receipt     a deterministic receipt hash bound to (request_id, provider,
--               model, tokens, cost, occurred_at). Recomputable for tamper
--               detection; NULL when there is no request_id to bind to.
--
-- The PARTIAL UNIQUE INDEX on request_id (WHERE request_id IS NOT NULL) is the
-- exactly-once identity: an INSERT ... ON CONFLICT(request_id) DO NOTHING makes
-- a duplicate request-id a no-op (one row, one charge). NULL request_ids are
-- outside the index and stay distinct, so no legacy row is affected.

ALTER TABLE llm_usage_records ADD COLUMN request_id TEXT;
ALTER TABLE llm_usage_records ADD COLUMN run_id TEXT;
ALTER TABLE llm_usage_records ADD COLUMN turn_id TEXT;
ALTER TABLE llm_usage_records ADD COLUMN receipt TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_request_id
  ON llm_usage_records(request_id)
  WHERE request_id IS NOT NULL;
`;

const V102_CHECKSUM = computeFridayMigrationChecksum(V102_PROVIDER_CALL_RECEIPT_SQL);

export const V102_PROVIDER_CALL_RECEIPT_MIGRATION: FridaySqliteMigration = {
  version: 102,
  name: "v102-provider-call-receipt",
  sql: V102_PROVIDER_CALL_RECEIPT_SQL,
  checksum: V102_CHECKSUM,
};
