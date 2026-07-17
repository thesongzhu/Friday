import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V106: owner-bind the realtime event log (SEC-EVENT-REDACTION-001 / P0#2).
 *
 * `realtime_events` had NO owner/principal column, and the realtime read surfaces
 * (validateSubscriptions / isStreamAuthorized / pull / replay / WS delivery)
 * authorized by topic-prefix + scope ALONE. A second, legitimately-authenticated
 * principal holding the same topic scope (e.g. `execution.read`) could therefore
 * pull ANY stream by knowing/guessing its `stream_id` — a cross-principal data
 * read of another principal's events (raw ids + payloads).
 *
 * This migration adds an OWNER column so each row is bound to the canonical hub
 * owner that persisted it. Combined with the read-side canonical-owner gate, a
 * non-canonical principal is denied even with matching scope + a known stream id.
 *
 * FAIL-CLOSED for legacy rows: the column is nullable and back-fills nothing.
 * Any pre-existing row (and any row written before the owner is resolvable) has
 * `owner_id IS NULL` and is treated as an INACCESSIBLE sentinel — the owner-scoped
 * read queries require `owner_id = ?` (a non-null canonical owner), so a NULL-owner
 * row is never returned to ANY principal. Ownership can only over-restrict, never
 * leak.
 *
 * Additive + idempotent: SQLite `ADD COLUMN` is a metadata-only change that
 * defaults existing rows to NULL; the new index is `IF NOT EXISTS`. Nothing is
 * altered or removed. (SQLite has no `ADD COLUMN IF NOT EXISTS`; the migration
 * runner applies each version exactly once, so a plain `ADD COLUMN` is safe.)
 */
export const V106_REALTIME_EVENTS_OWNER_SQL = `
ALTER TABLE realtime_events ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_realtime_events_owner_stream_seq
  ON realtime_events(owner_id, stream_id, seq);
`;

const V106_CHECKSUM = computeFridayMigrationChecksum(V106_REALTIME_EVENTS_OWNER_SQL);

export const V106_REALTIME_EVENTS_OWNER_MIGRATION: FridaySqliteMigration = {
  version: 106,
  name: "v106-realtime-events-owner",
  sql: V106_REALTIME_EVENTS_OWNER_SQL,
  checksum: V106_CHECKSUM,
};
