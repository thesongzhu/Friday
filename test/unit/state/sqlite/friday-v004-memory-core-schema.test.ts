import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V004 Memory Core Schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function getTableNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getIndexNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getColumnNames(table: string): string[] {
    const rows = db.writer
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getTriggerNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // ─── New columns on memory_items ───

  it("adds content_text column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("content_text");
  });

  it("adds source column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("source");
  });

  it("adds metadata_json column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("metadata_json");
  });

  it("adds ttl_seconds column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("ttl_seconds");
  });

  it("adds expires_at column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("expires_at");
  });

  it("adds tags_text column to memory_items", () => {
    const cols = getColumnNames("memory_items");
    expect(cols).toContain("tags_text");
  });

  // ─── memory_embeddings table ───

  it("creates memory_embeddings table", () => {
    const tables = getTableNames();
    expect(tables).toContain("memory_embeddings");
  });

  it("creates correct columns on memory_embeddings", () => {
    const cols = getColumnNames("memory_embeddings");
    expect(cols).toContain("id");
    expect(cols).toContain("item_id");
    expect(cols).toContain("provider_id");
    expect(cols).toContain("model");
    expect(cols).toContain("dimensions");
    expect(cols).toContain("vector_json");
    expect(cols).toContain("created_at");
    expect(cols).toContain("updated_at");
  });

  // ─── Indexes ───

  it("creates namespace_updated index on memory_items", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_memory_items_namespace_updated");
  });

  it("creates source_updated index on memory_items", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_memory_items_source_updated");
  });

  it("creates expires_at index on memory_items", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_memory_items_expires_at");
  });

  it("creates embedding indexes", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_memory_embeddings_item");
    expect(indexes).toContain("idx_memory_embeddings_model");
    expect(indexes).toContain("idx_memory_embeddings_model_updated");
  });

  // ─── FTS5 virtual table ───

  it("creates memory_items_fts virtual table", () => {
    // FTS5 tables appear in sqlite_master as type='table'
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE name = 'memory_items_fts'")
      .all() as Array<{ name: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  // ─── Triggers ───

  it("creates FTS sync triggers", () => {
    const triggers = getTriggerNames();
    expect(triggers).toContain("trg_memory_items_fts_insert");
    expect(triggers).toContain("trg_memory_items_fts_update");
    expect(triggers).toContain("trg_memory_items_fts_delete");
  });

  // ─── FK cascade delete ───

  it("cascade deletes embeddings when memory item is deleted", () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mi-1", "test", "key1", "{}", "hello world", "system", "[]", "", "{}", now, now);

    db.writer
      .prepare(
        `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("emb-1", "mi-1", "prov-1", "text-embedding-3-small", 3, "[0.1,0.2,0.3]", now, now);

    // Verify embedding exists
    const before = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE item_id = 'mi-1'")
      .get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // Delete the memory item
    db.writer.prepare("DELETE FROM memory_items WHERE id = 'mi-1'").run();

    // Verify embedding was cascade deleted
    const after = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings WHERE item_id = 'mi-1'")
      .get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  // ─── Unique constraint on embeddings ───

  it("enforces unique(item_id, provider_id, model) on memory_embeddings", () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mi-2", "test", "key2", "{}", "content", "system", "[]", "", "{}", now, now);

    db.writer
      .prepare(
        `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("emb-2", "mi-2", "prov-1", "model-a", 3, "[0.1,0.2,0.3]", now, now);

    expect(() =>
      db.writer
        .prepare(
          `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("emb-3", "mi-2", "prov-1", "model-a", 3, "[0.4,0.5,0.6]", now, now),
    ).toThrow();
  });

  // ─── Dimensions check constraint ───

  it("enforces dimensions > 0 check on memory_embeddings", () => {
    const now = "2026-01-01T00:00:00.000Z";
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mi-3", "test", "key3", "{}", "content", "system", "[]", "", "{}", now, now);

    expect(() =>
      db.writer
        .prepare(
          `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("emb-4", "mi-3", "prov-1", "model-a", 0, "[]", now, now),
    ).toThrow();
  });

  // ─── Migration record ───

  it("records v004 migration in schema_migrations", () => {
    const row = db.writer
      .prepare("SELECT * FROM schema_migrations WHERE version = 4")
      .get() as { version: number; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("v004-memory-core");
  });
});
