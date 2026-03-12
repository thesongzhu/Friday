import { computeFridayMigrationChecksum } from "./friday-migration.types.js";

import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V005_SESSION_FOUNDATION_SQL = `
-- V005: Session foundation (canonical keys, lifecycle, memory bridge metadata)

ALTER TABLE sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN chat_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN user_id TEXT;
ALTER TABLE sessions ADD COLUMN memory_namespace TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_key TEXT;
ALTER TABLE sessions ADD COLUMN root_session_key TEXT;
ALTER TABLE sessions ADD COLUMN forked_from_message_id TEXT;
ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
ALTER TABLE sessions ADD COLUMN idle_at TEXT;
ALTER TABLE sessions ADD COLUMN archived_at TEXT;
ALTER TABLE sessions ADD COLUMN pruned_at TEXT;
ALTER TABLE sessions ADD COLUMN status_changed_at TEXT;
ALTER TABLE sessions ADD COLUMN context_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1;

UPDATE sessions
SET account_id = COALESCE(NULLIF(account_id, ''), 'default'),
    chat_id = CASE
      WHEN chat_id IS NULL OR chat_id = '' OR chat_id = 'unknown'
        THEN COALESCE(json_extract(metadata_json, '$.chatId'), session_key, 'unknown')
      ELSE chat_id
    END,
    root_session_key = COALESCE(root_session_key, session_key),
    last_activity_at = COALESCE(last_activity_at, updated_at, created_at),
    status_changed_at = COALESCE(status_changed_at, updated_at, created_at);

ALTER TABLE session_messages ADD COLUMN session_key TEXT;
ALTER TABLE session_messages ADD COLUMN content_text TEXT;
ALTER TABLE session_messages ADD COLUMN tool_calls_json TEXT;
ALTER TABLE session_messages ADD COLUMN token_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_messages ADD COLUMN occurred_at TEXT;
ALTER TABLE session_messages ADD COLUMN parent_message_id TEXT;
ALTER TABLE session_messages ADD COLUMN memory_extract_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (memory_extract_status IN ('pending', 'extracted', 'skipped', 'failed'));
ALTER TABLE session_messages ADD COLUMN memory_extracted_at TEXT;

UPDATE session_messages
SET session_key = COALESCE(
      session_key,
      (SELECT s.session_key FROM sessions s WHERE s.id = session_messages.session_id)
    ),
    content_text = COALESCE(content_text, content_json),
    occurred_at = COALESCE(occurred_at, created_at),
    token_count = COALESCE(
      CASE WHEN token_count > 0 THEN token_count ELSE NULL END,
      CAST(json_extract(token_usage_json, '$.total') AS INTEGER),
      CAST(json_extract(token_usage_json, '$.totalTokens') AS INTEGER),
      0
    );

CREATE INDEX IF NOT EXISTS idx_sessions_channel_account_chat
  ON sessions(channel, account_id, chat_kind, chat_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_status_activity
  ON sessions(user_id, status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_status_changed
  ON sessions(status, status_changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_archived_pruned
  ON sessions(archived_at, pruned_at);

CREATE INDEX IF NOT EXISTS idx_sessions_memory_namespace
  ON sessions(memory_namespace);

CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_key
  ON sessions(parent_session_key);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_key_occurred
  ON session_messages(session_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_key_sequence
  ON session_messages(session_key, sequence DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_key_idempotency
  ON session_messages(session_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_messages_extract_status
  ON session_messages(memory_extract_status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_messages_parent_message
  ON session_messages(parent_message_id);

CREATE TRIGGER IF NOT EXISTS trg_sessions_delete_messages
BEFORE DELETE ON sessions
BEGIN
  DELETE FROM session_messages WHERE session_id = OLD.id;
END;
`;

const V005_CHECKSUM = computeFridayMigrationChecksum(V005_SESSION_FOUNDATION_SQL);

export const V005_SESSION_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 5,
  name: "v005-session-foundation",
  sql: V005_SESSION_FOUNDATION_SQL,
  checksum: V005_CHECKSUM,
};
