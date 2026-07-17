import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V106: owner-bind the realtime event log (SEC-EVENT-REDACTION-001 / P0#2) AND add
 * a DURABLE per-row identifier-pseudonym provenance column
 * (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P1-3 + P1-4).
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
 *
 * UPGRADE-BOUNDARY BACKFILL (SEC-EVENT-REDACTION-001 replay-gap fix): a hub that
 * upgrades across this migration already has pre-upgrade realtime_events rows. Left
 * NULL they would be invisible to the canonical-owner read path, so a reconnecting
 * canonical owner would SILENTLY lose same-epoch history (no gap detection / resync).
 * Friday is a single-canonical-owner hub, so those legacy rows all belong to the
 * canonical owner — attribute them to it here so pre-upgrade events remain visible
 * and no same-epoch sequence gap is introduced. The literal `admin-001` mirrors
 * `learningDefaultUserId` in friday-hub-bootstrap.ts (the SAME canonical owner the
 * runtime stamps on new rows and the retention path resolves); a migration's SQL is
 * a frozen historical artifact, so the value is inlined rather than interpolated. On
 * a fresh install the table is empty, so the UPDATE affects 0 rows. Any row that
 * genuinely can't be attributed stays NULL and remains fail-closed (never returned).
 *
 * IDENTIFIER-PSEUDONYM PROVENANCE (round-6 P1-3 + P1-4): the one-time legacy rewrite
 * previously trusted the opaque marker SHAPE (`o<ver>_<hex>`) to decide "already
 * rewritten" — but shape is coincidental (a legacy RAW `run:o1_<40hex>` id would be
 * wrongly skipped) and cannot establish provenance. `identifier_epoch` records the
 * pseudonym KEY VERSION under which a row's identifiers are opaque:
 *   - NULL   → legacy / pre-rewrite → its identifiers may be RAW → PENDING conversion.
 *   - N (>0) → this row's identifiers are opaque under key version N (born-current via
 *              the pseudonymizing sink, or already rewritten). A DURABLE STATE fact
 *              set in the SAME transaction as the rewrite, NOT a regex over the value.
 * The runtime sink stamps the current version on every new row; the boot rewrite
 * converts rows WHERE `identifier_epoch IS NULL` in bounded batches and stamps the
 * version as it goes, so the conversion is idempotent, crash-resumable and — once
 * complete — costs a partial-index probe (below) rather than a full-table scan.
 * Existing rows default to NULL (pending), which is correct: pre-upgrade rows carry
 * raw identifiers and must be converted exactly once.
 */
export const V106_REALTIME_EVENTS_OWNER_SQL = `
ALTER TABLE realtime_events ADD COLUMN owner_id TEXT;

UPDATE realtime_events SET owner_id = 'admin-001' WHERE owner_id IS NULL;

ALTER TABLE realtime_events ADD COLUMN identifier_epoch INTEGER;

CREATE INDEX IF NOT EXISTS idx_realtime_events_owner_stream_seq
  ON realtime_events(owner_id, stream_id, seq);

CREATE INDEX IF NOT EXISTS idx_realtime_events_pending_rewrite
  ON realtime_events(identifier_epoch) WHERE identifier_epoch IS NULL;
`;

const V106_CHECKSUM = computeFridayMigrationChecksum(V106_REALTIME_EVENTS_OWNER_SQL);

export const V106_REALTIME_EVENTS_OWNER_MIGRATION: FridaySqliteMigration = {
  version: 106,
  name: "v106-realtime-events-owner",
  sql: V106_REALTIME_EVENTS_OWNER_SQL,
  checksum: V106_CHECKSUM,
};
