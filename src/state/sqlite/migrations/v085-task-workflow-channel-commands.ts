import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V085_TASK_WORKFLOW_CHANNEL_COMMANDS_SQL = `
-- V085: Phase 13.5D typed channel command records for task workflows.
--
-- task_workflow_channel_commands records the typed, hashed-only view of
-- configured-channel commands that fan in / fan out task workflow
-- activity. The table is intentionally privacy-preserving:
--
--   * No raw channel message text, body, or platform payload is ever
--     stored here. Only hashed channel / message / sender identifiers are
--     persisted.
--   * The confirmation token is a Friday-issued opaque token used to
--     gate the canonical dispatch step; it never embeds raw user content.
--   * The intent_kind enumerates the small set of canonical task workflow
--     actions a channel command may dispatch to (progress query, closeout
--     request, supervisor mode preview, confirm-token). Dispatch always
--     routes back through the task workflow service APIs; raw channel
--     payloads never reach the task workflow service.
--
-- Existing channels / sessions tables are NOT modified. Channel evidence
-- is referenced through the existing channel_event evidence ref source on
-- task_workflow_evidence_refs.

CREATE TABLE IF NOT EXISTS task_workflow_channel_commands (
  id                    TEXT PRIMARY KEY NOT NULL,
  workflow_id           TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  channel_kind          TEXT NOT NULL,
  channel_chat_hash     TEXT NOT NULL,
  channel_message_hash  TEXT NOT NULL,
  sender_hash           TEXT NOT NULL,
  intent_kind           TEXT NOT NULL CHECK (intent_kind IN (
    'progress_query','closeout_request','supervisor_mode_preview','confirm_token'
  )),
  confirmation_token    TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
    'issued','confirmed','dispatched','declined','expired'
  )),
  dispatched_action     TEXT,
  declined_reason       TEXT,
  issued_at             TEXT NOT NULL,
  confirmed_at          TEXT,
  dispatched_at         TEXT,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_channel_commands_workflow
  ON task_workflow_channel_commands (workflow_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workflow_channel_commands_token
  ON task_workflow_channel_commands (confirmation_token);
CREATE INDEX IF NOT EXISTS idx_task_workflow_channel_commands_status
  ON task_workflow_channel_commands (workflow_id, status, created_at DESC);
`;

const V085_CHECKSUM = computeFridayMigrationChecksum(
  V085_TASK_WORKFLOW_CHANNEL_COMMANDS_SQL,
);

export const V085_TASK_WORKFLOW_CHANNEL_COMMANDS_MIGRATION: FridaySqliteMigration = {
  version: 85,
  name: "v085-task-workflow-channel-commands",
  sql: V085_TASK_WORKFLOW_CHANNEL_COMMANDS_SQL,
  checksum: V085_CHECKSUM,
};
