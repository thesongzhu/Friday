import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { V085_TASK_WORKFLOW_CHANNEL_COMMANDS_MIGRATION } from "../../../../src/state/sqlite/migrations/v085-task-workflow-channel-commands.js";

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Create the minimum prerequisite tables the migration references.
  db.exec(`
    CREATE TABLE task_workflows (
      id TEXT PRIMARY KEY NOT NULL,
      charter TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      parent_spec_hash TEXT,
      task_kind TEXT NOT NULL,
      risk TEXT NOT NULL,
      supervisor_mode TEXT NOT NULL,
      budget INTEGER NOT NULL,
      stage TEXT NOT NULL,
      context_package_json TEXT NOT NULL,
      gate_plan_json TEXT NOT NULL,
      boundary_refs_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("v085 task workflow channel commands migration", () => {
  it("creates the typed channel command table with the expected schema", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V085_TASK_WORKFLOW_CHANNEL_COMMANDS_MIGRATION.sql);
      const columns = db
        .prepare(`PRAGMA table_info(task_workflow_channel_commands)`)
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const columnNames = columns.map((c) => c.name).sort();
      expect(columnNames).toEqual([
        "channel_chat_hash",
        "channel_kind",
        "channel_message_hash",
        "confirmation_token",
        "confirmed_at",
        "created_at",
        "declined_reason",
        "dispatched_action",
        "dispatched_at",
        "expires_at",
        "id",
        "intent_kind",
        "issued_at",
        "sender_hash",
        "status",
        "workflow_id",
      ]);
      // Privacy guarantee: there is NO column that would store raw message
      // text / body / sender display name / channel payload.
      expect(columnNames).not.toContain("message_text");
      expect(columnNames).not.toContain("body");
      expect(columnNames).not.toContain("raw");
      expect(columnNames).not.toContain("sender_name");
    } finally {
      db.close();
    }
  });

  it("enforces the intent_kind enum and the status enum", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V085_TASK_WORKFLOW_CHANNEL_COMMANDS_MIGRATION.sql);
      db.prepare(
        `INSERT INTO task_workflows (id, charter, spec_hash, task_kind, risk, supervisor_mode, budget, stage, context_package_json, gate_plan_json, boundary_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("wf-1", "c", "sh", "general", "medium", "standard", 4, "charter", "{}", "[]", "[]", "2026-05-16T00:00:00Z", "2026-05-16T00:00:00Z");
      expect(() =>
        db
          .prepare(
            `INSERT INTO task_workflow_channel_commands (id, workflow_id, channel_kind, channel_chat_hash, channel_message_hash, sender_hash, intent_kind, confirmation_token, status, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "cmd-1",
            "wf-1",
            "discord",
            "h-chat",
            "h-msg",
            "h-sender",
            "evil_intent",
            "tok-1",
            "issued",
            "2026-05-16T00:00:00Z",
            "2026-05-16T00:10:00Z",
            "2026-05-16T00:00:00Z",
          ),
      ).toThrow(/CHECK/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO task_workflow_channel_commands (id, workflow_id, channel_kind, channel_chat_hash, channel_message_hash, sender_hash, intent_kind, confirmation_token, status, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "cmd-2",
            "wf-1",
            "discord",
            "h-chat",
            "h-msg",
            "h-sender",
            "progress_query",
            "tok-2",
            "evil_status",
            "2026-05-16T00:00:00Z",
            "2026-05-16T00:10:00Z",
            "2026-05-16T00:00:00Z",
          ),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("enforces unique confirmation tokens across rows", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V085_TASK_WORKFLOW_CHANNEL_COMMANDS_MIGRATION.sql);
      db.prepare(
        `INSERT INTO task_workflows (id, charter, spec_hash, task_kind, risk, supervisor_mode, budget, stage, context_package_json, gate_plan_json, boundary_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("wf-1", "c", "sh", "general", "medium", "standard", 4, "charter", "{}", "[]", "[]", "2026-05-16T00:00:00Z", "2026-05-16T00:00:00Z");
      db.prepare(
        `INSERT INTO task_workflow_channel_commands (id, workflow_id, channel_kind, channel_chat_hash, channel_message_hash, sender_hash, intent_kind, confirmation_token, status, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "cmd-1",
        "wf-1",
        "discord",
        "h",
        "h",
        "h",
        "progress_query",
        "shared-token",
        "issued",
        "2026-05-16T00:00:00Z",
        "2026-05-16T00:10:00Z",
        "2026-05-16T00:00:00Z",
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO task_workflow_channel_commands (id, workflow_id, channel_kind, channel_chat_hash, channel_message_hash, sender_hash, intent_kind, confirmation_token, status, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "cmd-2",
            "wf-1",
            "discord",
            "h",
            "h",
            "h",
            "progress_query",
            "shared-token",
            "issued",
            "2026-05-16T00:00:00Z",
            "2026-05-16T00:10:00Z",
            "2026-05-16T00:00:00Z",
          ),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
