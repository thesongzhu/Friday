import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("V025 — memory file sync trigger fixes", () => {
  const dbs: Database.Database[] = [];

  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    return db;
  }

  function clearDirty(db: Database.Database): void {
    db.prepare("DELETE FROM memory_file_sync_dirty").run();
  }

  function getDirtyKeys(db: Database.Database): Array<{ entity_type: string; entity_key: string }> {
    return db
      .prepare("SELECT entity_type, entity_key FROM memory_file_sync_dirty ORDER BY entity_key")
      .all() as Array<{ entity_type: string; entity_key: string }>;
  }

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* ok */ }
    }
    dbs.length = 0;
  });

  it("records migration v025 in schema_migrations", () => {
    const db = freshDb();
    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 25")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(25);
    expect(row?.name).toBe("v025-memory-file-sync-trigger-fixes");
  });

  it("v025 does not cause checksum mismatch on re-run (migration chain test)", () => {
    const db = freshDb();
    // Running again should just skip already-applied migrations
    expect(() => {
      runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    }).not.toThrow();
  });

  // ─── F1: session_messages UPDATE triggers ───

  it("UPDATE session_key from 'a' to NULL enqueues dirty row for 'a'", () => {
    const db = freshDb();

    // Setup: session + message
    db.prepare(
      `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-1", "key-a", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO session_messages (id, session_id, session_key, role, content_json, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("msg-1", "sess-1", "key-a", "user", '"hello"', 1, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    clearDirty(db);

    // Act: update session_key from "key-a" to NULL
    db.prepare("UPDATE session_messages SET session_key = NULL WHERE id = 'msg-1'").run();

    // Assert: dirty row for "key-a" must exist (old key)
    const dirty = getDirtyKeys(db);
    expect(dirty.length).toBeGreaterThanOrEqual(1);
    const keys = dirty.map((d) => d.entity_key);
    expect(keys).toContain("key-a");
  });

  it("UPDATE session_key from 'a' to 'b' enqueues dirty rows for both 'a' and 'b'", () => {
    const db = freshDb();

    db.prepare(
      `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-1", "key-a", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-2", "key-b", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO session_messages (id, session_id, session_key, role, content_json, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("msg-1", "sess-1", "key-a", "user", '"hello"', 1, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    clearDirty(db);

    // Act: update session_key from "key-a" to "key-b"
    db.prepare("UPDATE session_messages SET session_key = 'key-b' WHERE id = 'msg-1'").run();

    // Assert: dirty rows for both "key-a" (old) and "key-b" (new) must exist
    const dirty = getDirtyKeys(db);
    const keys = dirty.filter((d) => d.entity_type === "session_key").map((d) => d.entity_key);
    expect(keys).toContain("key-a");
    expect(keys).toContain("key-b");
  });

  it("UPDATE session_key same value (a to a) enqueues only one dirty row", () => {
    const db = freshDb();

    db.prepare(
      `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-1", "key-a", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO session_messages (id, session_id, session_key, role, content_json, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("msg-1", "sess-1", "key-a", "user", '"hello"', 1, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    clearDirty(db);

    // Act: update content but keep same session_key
    db.prepare("UPDATE session_messages SET content_json = '\"updated\"' WHERE id = 'msg-1'").run();

    // Assert: one dirty row for "key-a" (no old key because key didn't change)
    const dirty = getDirtyKeys(db);
    const keys = dirty.filter((d) => d.entity_type === "session_key").map((d) => d.entity_key);
    expect(keys).toEqual(["key-a"]);
  });

  // ─── F1: memory_items UPDATE triggers ───

  it("UPDATE memory_items namespace from 'ns-a' to 'ns-b' dirties both", () => {
    const db = freshDb();

    db.prepare(
      `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("item-1", "ns-a", "key1", '{}', '[]', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    clearDirty(db);

    // Act: change namespace
    db.prepare("UPDATE memory_items SET namespace = 'ns-b' WHERE id = 'item-1'").run();

    // Assert: both old and new namespace in dirty queue
    const dirty = getDirtyKeys(db);
    const keys = dirty.filter((d) => d.entity_type === "memory_namespace").map((d) => d.entity_key);
    expect(keys).toContain("ns-a");
    expect(keys).toContain("ns-b");
  });
});
