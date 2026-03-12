import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V007 session forks schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("adds is_inherited column to session_messages", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(session_messages)").all(),
    ) as Array<{ name: string }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("is_inherited");
  });

  it("adds inherited_from_session_key column to session_messages", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(session_messages)").all(),
    ) as Array<{ name: string }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("inherited_from_session_key");
  });

  it("adds inherited_from_message_id column to session_messages", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(session_messages)").all(),
    ) as Array<{ name: string }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("inherited_from_message_id");
  });

  it("is_inherited defaults to 0", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(session_messages)").all(),
    ) as Array<{ name: string; dflt_value: string | null }>;

    const isInheritedCol = cols.find((c) => c.name === "is_inherited");
    expect(isInheritedCol).toBeDefined();
    expect(isInheritedCol!.dflt_value).toBe("0");
  });

  it("creates idx_session_messages_session_inherited_sequence index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_messages'",
      ).all(),
    ) as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_session_messages_session_inherited_sequence");
  });

  it("creates idx_sessions_parent_status_activity index", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'",
      ).all(),
    ) as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_sessions_parent_status_activity");
  });

  it("migration row version=7 exists", () => {
    const row = db.withReadConnection((d) =>
      d.prepare("SELECT version, name FROM schema_migrations WHERE version = 7").get(),
    ) as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.version).toBe(7);
    expect(row!.name).toBe("v007-session-forks");
  });
});
