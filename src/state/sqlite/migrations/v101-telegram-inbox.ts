import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V101_TELEGRAM_INBOX_SQL = `
-- V101: Durable Telegram inbox + poll cursor (CHAN-TELEGRAM-INBOX-001).
--
-- The Telegram polling/webhook service previously kept its long-poll offset in a
-- volatile in-memory 'let offset = 0' and advanced it BEFORE the inbound update was
-- durably persisted, delivering the handler fire-and-forget. A crash between offset
-- advance and handler completion LOST the update (Telegram had already been told to
-- forget it), and a duplicate update_id (poll retry or webhook resend) re-dispatched
-- the run TWICE. There was no durable inbox, no exactly-once dedupe, and no offset
-- persistence, so a restart reset the cursor to 0.
--
-- This durable inbox survives restarts. The composite PRIMARY KEY (channel_id,
-- update_id) is the exactly-once dedupe identity: a duplicate insert is a no-op, so a
-- resent/retried update is committed (and dispatched) EXACTLY ONCE. Both tables are
-- additive and created IF NOT EXISTS; no existing table or column is changed.

CREATE TABLE IF NOT EXISTS telegram_inbox (
  channel_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  update_json TEXT NOT NULL,
  -- 'pending' = durably committed, handler not yet confirmed dispatched.
  -- 'processed' = handler dispatched to completion; the terminal exactly-once state.
  -- 'delivery_unknown' = a row left 'pending' when the process crashed: its dispatch
  -- outcome is unknown. It is re-driven through the SAME dedupe path on recovery (never
  -- a blind re-insert), so the inbox identity still guarantees a single durable row.
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'delivery_unknown')),
  received_at_ms INTEGER NOT NULL,
  processed_at_ms INTEGER,
  -- The composite identity that makes an insert idempotent: a duplicate (poll retry or
  -- webhook resend) collides here and is deduped instead of re-dispatched.
  PRIMARY KEY (channel_id, update_id)
);

-- Recovery scan: resume un-processed rows (pending / delivery_unknown) for a channel in
-- update_id order without a full-table scan.
CREATE INDEX IF NOT EXISTS idx_telegram_inbox_recovery
  ON telegram_inbox (channel_id, status, update_id);

CREATE TABLE IF NOT EXISTS telegram_poll_cursor (
  channel_id TEXT NOT NULL PRIMARY KEY,
  -- The next getUpdates offset to request. Persisted so a restart resumes instead of
  -- resetting to 0; only advanced AFTER the update is durably committed to the inbox.
  next_offset INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;

const V101_CHECKSUM = computeFridayMigrationChecksum(V101_TELEGRAM_INBOX_SQL);

export const V101_TELEGRAM_INBOX_MIGRATION: FridaySqliteMigration = {
  version: 101,
  name: "v101-telegram-inbox",
  sql: V101_TELEGRAM_INBOX_SQL,
  checksum: V101_CHECKSUM,
};
