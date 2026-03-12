import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V005 Session Foundation Schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function getColumnNames(table: string): string[] {
    const rows = db.writer
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getIndexNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getTriggerNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // ─── New columns on sessions ───

  it("adds account_id column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("account_id");
  });

  it("adds chat_id column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("chat_id");
  });

  it("adds user_id column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("user_id");
  });

  it("adds memory_namespace column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("memory_namespace");
  });

  it("adds parent_session_key column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("parent_session_key");
  });

  it("adds root_session_key column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("root_session_key");
  });

  it("adds forked_from_message_id column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("forked_from_message_id");
  });

  it("adds last_activity_at column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("last_activity_at");
  });

  it("adds idle_at column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("idle_at");
  });

  it("adds archived_at column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("archived_at");
  });

  it("adds pruned_at column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("pruned_at");
  });

  it("adds status_changed_at column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("status_changed_at");
  });

  it("adds context token columns to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("context_input_tokens");
    expect(cols).toContain("context_output_tokens");
    expect(cols).toContain("context_total_tokens");
  });

  it("adds message_count column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("message_count");
  });

  it("adds metadata_version column to sessions", () => {
    const cols = getColumnNames("sessions");
    expect(cols).toContain("metadata_version");
  });

  // ─── New columns on session_messages ───

  it("adds session_key column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("session_key");
  });

  it("adds content_text column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("content_text");
  });

  it("adds tool_calls_json column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("tool_calls_json");
  });

  it("adds token_count column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("token_count");
  });

  it("adds occurred_at column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("occurred_at");
  });

  it("adds parent_message_id column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("parent_message_id");
  });

  it("adds memory_extract_status column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("memory_extract_status");
  });

  it("adds memory_extracted_at column to session_messages", () => {
    const cols = getColumnNames("session_messages");
    expect(cols).toContain("memory_extracted_at");
  });

  // ─── Indexes ───

  it("creates session indexes", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_sessions_channel_account_chat");
    expect(indexes).toContain("idx_sessions_user_status_activity");
    expect(indexes).toContain("idx_sessions_status_changed");
    expect(indexes).toContain("idx_sessions_archived_pruned");
    expect(indexes).toContain("idx_sessions_memory_namespace");
    expect(indexes).toContain("idx_sessions_parent_session_key");
  });

  it("creates session_messages indexes", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_session_messages_session_key_occurred");
    expect(indexes).toContain("idx_session_messages_session_key_sequence");
    expect(indexes).toContain("idx_session_messages_session_key_idempotency");
    expect(indexes).toContain("idx_session_messages_extract_status");
    expect(indexes).toContain("idx_session_messages_parent_message");
  });

  // ─── Triggers ───

  it("creates cascade delete trigger on sessions", () => {
    const triggers = getTriggerNames();
    expect(triggers).toContain("trg_sessions_delete_messages");
  });

  it("cascade deletes session_messages when session is deleted", () => {
    const now = "2026-01-01T00:00:00.000Z";

    // Insert a session
    db.writer
      .prepare(
        `INSERT INTO sessions (id, session_key, agent_id, channel, chat_kind, status,
         account_id, chat_id, owner_lease_epoch, metadata_json, created_at, updated_at,
         context_input_tokens, context_output_tokens, context_total_tokens, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      )
      .run("sess-1", "discord:default:user1", "friday", "discord", "dm", "active",
        "default", "user1", 0, "{}", now, now);

    // Insert messages
    db.writer
      .prepare(
        `INSERT INTO session_messages (id, session_id, session_key, sequence, role,
         content_json, content_text, token_count, memory_extract_status,
         occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("msg-1", "sess-1", "discord:default:user1", 1, "user",
        '"hello"', "hello", 5, "pending", now, now, now);

    db.writer
      .prepare(
        `INSERT INTO session_messages (id, session_id, session_key, sequence, role,
         content_json, content_text, token_count, memory_extract_status,
         occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("msg-2", "sess-1", "discord:default:user1", 2, "assistant",
        '"world"', "world", 3, "pending", now, now, now);

    // Verify messages exist
    const before = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = 'sess-1'")
      .get() as { cnt: number };
    expect(before.cnt).toBe(2);

    // Delete the session
    db.writer.prepare("DELETE FROM sessions WHERE id = 'sess-1'").run();

    // Verify messages were cascade deleted
    const after = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = 'sess-1'")
      .get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  // ─── Migration record ───

  it("records v005 migration in schema_migrations", () => {
    const row = db.writer
      .prepare("SELECT * FROM schema_migrations WHERE version = 5")
      .get() as { version: number; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("v005-session-foundation");
  });

  // ─── memory_extract_status check constraint ───

  it("enforces check constraint on memory_extract_status", () => {
    const now = "2026-01-01T00:00:00.000Z";

    db.writer
      .prepare(
        `INSERT INTO sessions (id, session_key, agent_id, channel, chat_kind, status,
         account_id, chat_id, owner_lease_epoch, metadata_json, created_at, updated_at,
         context_input_tokens, context_output_tokens, context_total_tokens, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      )
      .run("sess-chk", "discord:default:chk", "friday", "discord", "dm", "active",
        "default", "chk", 0, "{}", now, now);

    expect(() =>
      db.writer
        .prepare(
          `INSERT INTO session_messages (id, session_id, session_key, sequence, role,
           content_json, content_text, token_count, memory_extract_status,
           occurred_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("msg-bad", "sess-chk", "discord:default:chk", 1, "user",
          '"test"', "test", 0, "invalid_status", now, now, now),
    ).toThrow();
  });
});
