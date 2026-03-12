import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("V023 — memory file sync schema", () => {
  const dbs: Database.Database[] = [];

  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* ok */ }
    }
    dbs.length = 0;
  });

  it("creates memory_file_sync_dirty table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memory_file_sync_dirty'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("creates memory_file_sync_state table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memory_file_sync_state'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("creates dirty triggers on memory_items", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_memory_file_sync_dirty_mem%'")
      .all() as { name: string }[];

    const triggerNames = triggers.map((t) => t.name);
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_mem_insert");
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_mem_update");
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_mem_delete");
  });

  it("creates dirty triggers on session_messages", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_memory_file_sync_dirty_sess%'")
      .all() as { name: string }[];

    const triggerNames = triggers.map((t) => t.name);
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_sess_insert");
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_sess_update");
    expect(triggerNames).toContain("trg_memory_file_sync_dirty_sess_delete");
  });

  it("memory_items INSERT enqueues dirty row", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    db.prepare(
      `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("item-1", "test-ns", "key1", '{"v":1}', '[]', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    const dirty = db
      .prepare("SELECT entity_type, entity_key FROM memory_file_sync_dirty")
      .all() as { entity_type: string; entity_key: string }[];

    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.entity_type).toBe("memory_namespace");
    expect(dirty[0]!.entity_key).toBe("test-ns");
  });

  it("session_messages INSERT enqueues dirty row when session_key is set", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    // Create a session first
    db.prepare(
      `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess-1", "test:session:1", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO session_messages (id, session_id, session_key, role, content_json, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("msg-1", "sess-1", "test:session:1", "user", '"Hello"', 1, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    const dirty = db
      .prepare("SELECT entity_type, entity_key FROM memory_file_sync_dirty WHERE entity_type = 'session_key'")
      .all() as { entity_type: string; entity_key: string }[];

    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.entity_key).toBe("test:session:1");
  });

  it("dirty rows are deduped by (entity_type, entity_key)", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    // Insert two items in same namespace
    db.prepare(
      `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("item-1", "ns1", "key1", '{}', '[]', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    db.prepare(
      `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("item-2", "ns1", "key2", '{}', '[]', "2025-01-01T00:00:01Z", "2025-01-01T00:00:01Z");

    const dirty = db
      .prepare("SELECT * FROM memory_file_sync_dirty WHERE entity_type = 'memory_namespace' AND entity_key = 'ns1'")
      .all();

    expect(dirty).toHaveLength(1);
  });

  it("records migration v023 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 23")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(23);
    expect(row?.name).toBe("v023-memory-file-sync");
  });
});
