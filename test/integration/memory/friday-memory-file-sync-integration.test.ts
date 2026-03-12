import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridaySqliteLayer } from "#state";
import {
  createFridayMemoryFileSyncRepository,
  createFridayMemoryFileSyncService,
  memoryNamespaceExportPath,
  sessionKeyExportPath,
} from "#memory";

describe("Memory File Sync Integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-sync-integ-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = createFridaySqliteLayer({ dbPath, readPoolSize: 1, pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" } });
  });

  afterEach(async () => {
    try { db.close(); } catch { /* ok */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("memory store → file emitted with correct content", async () => {
    // Insert memory items via DB (like memory service would)
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("i1", "user.facts", "name", '{"value":"Alice"}', "Alice", "manual", '["name"]', '{}', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
      conn.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("i2", "user.facts", "fav-color", '{"value":"blue"}', "blue", "auto", '["pref"]', '{}', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    });

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    const result = await service.syncNow({ force: true });
    expect(result.filesWritten).toBe(1);

    const filePath = memoryNamespaceExportPath(tmpDir, "user.facts");
    const content = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(content.namespace).toBe("user.facts");
    expect(content.items).toHaveLength(2);
    expect(content.items[0].key).toBe("fav-color"); // ordered by key ASC
    expect(content.items[1].key).toBe("name");
  });

  it("session messages → transcript emitted", async () => {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", "chat:main", "discord", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("m1", "s1", "chat:main", "user", '"What is 2+2?"', "What is 2+2?", 1, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("m2", "s1", "chat:main", "assistant", '"4"', "4", 2, "2025-01-01T00:00:01Z", "2025-01-01T00:00:01Z");
    });

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    const result = await service.syncNow({ force: true });
    expect(result.filesWritten).toBeGreaterThanOrEqual(1);

    const filePath = sessionKeyExportPath(tmpDir, "chat:main");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].role).toBe("user");
    expect(lines[1].role).toBe("assistant");
    expect(lines[1].content).toBe("4");
  });

  it("delete/prune → file removed", async () => {
    // Insert and sync
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("del-1", "prune-ns", "k1", '{}', '[]', "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    });

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    const filePath = memoryNamespaceExportPath(tmpDir, "prune-ns");
    expect(await fs.stat(filePath).then(() => true).catch(() => false)).toBe(true);

    // Delete item
    db.withWriteTransaction((conn) => {
      conn.prepare("DELETE FROM memory_items WHERE id = ?").run("del-1");
    });

    // Sync again
    const result = await service.syncNow({ force: true });
    expect(result.filesDeleted).toBe(1);
    expect(await fs.stat(filePath).then(() => true).catch(() => false)).toBe(false);
  });
});
