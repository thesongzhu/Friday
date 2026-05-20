import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION } from "../../../../src/state/sqlite/migrations/v088-auto-fix-rollback-receipt.js";

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE auto_fix_actions (
      action_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("v088 auto-fix rollback receipt migration", () => {
  it("adds nullable/defaulted rollback attempt receipt columns", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.sql);
      const columns = db
        .prepare("PRAGMA table_info(auto_fix_actions)")
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

      expect(columns.find((col) => col.name === "rollback_attempted")).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      });
      expect(columns.find((col) => col.name === "rollback_attempted_at")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(columns.find((col) => col.name === "rollback_succeeded")).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      });
      expect(columns.find((col) => col.name === "rollback_error_message")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
    } finally {
      db.close();
    }
  });

  it("preserves legacy rows as no rollback attempt recorded", () => {
    const db = makeMemoryDb();
    try {
      db.prepare(
        `INSERT INTO auto_fix_actions (action_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("action-legacy", "applied", "2026-05-20T00:00:00.000Z", "2026-05-20T00:00:00.000Z");

      db.exec(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.sql);

      const row = db
        .prepare(
          `SELECT rollback_attempted, rollback_attempted_at, rollback_succeeded, rollback_error_message
           FROM auto_fix_actions WHERE action_id = ?`,
        )
        .get("action-legacy") as Record<string, unknown>;
      expect(row.rollback_attempted).toBe(0);
      expect(row.rollback_attempted_at).toBeNull();
      expect(row.rollback_succeeded).toBe(0);
      expect(row.rollback_error_message).toBeNull();
    } finally {
      db.close();
    }
  });

  it("v088 migration metadata is well-formed", () => {
    expect(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.version).toBe(88);
    expect(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.name).toBe("v088-auto-fix-rollback-receipt");
    expect(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(V088_AUTO_FIX_ROLLBACK_RECEIPT_MIGRATION.sql).toMatch(/rollback_attempted/);
  });
});
