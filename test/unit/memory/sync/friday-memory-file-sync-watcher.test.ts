import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridaySqliteLayer } from "#state";
import {
  createFridayMemoryFileSyncRepository,
  createFridayMemoryFileSyncService,
  FRIDAY_MEMORY_FILE_IMPORT_RETIRED_ERROR,
  memoryNamespaceExportPath,
} from "#memory";

describe("FridayMemoryFileSyncService — Watcher & Reindex", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-watcher-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = createFridaySqliteLayer({ dbPath, readPoolSize: 1, pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" } });
  });

  afterEach(async () => {
    try { db.close(); } catch { /* ok */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function insertMemoryItem(id: string, namespace: string, key: string, value: string): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, namespace, key, value, "[]", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    });
  }

  function getMemoryItems(namespace: string): Array<{ id: string; key: string; value_json: string }> {
    return db.withReadConnection((conn) => {
      return conn.prepare("SELECT id, key, value_json FROM memory_items WHERE namespace = ? ORDER BY key").all(namespace) as Array<{ id: string; key: string; value_json: string }>;
    });
  }

  // ─── Status: watcher fields ───

  it("status reports watcher state when watcher is enabled", async () => {
    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: true,
    });

    const s1 = service.status();
    expect(s1.watcherActive).toBe(false);
    expect(s1.watcherPendingCount).toBe(0);

    await service.start();
    const s2 = service.status();
    expect(s2.watcherActive).toBe(true);
    expect(s2.watcherPendingCount).toBe(0);

    await service.stop();
    const s3 = service.status();
    expect(s3.watcherActive).toBe(false);
  });

  it("status reports watcher inactive when watcher is disabled", async () => {
    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
    });

    await service.start();
    const s = service.status();
    expect(s.watcherActive).toBe(false);

    await service.stop();
  });

  // ─── Reindex: forced reindex from exported file ───

  it("reindexNow fails closed by default for memory namespace file imports", async () => {
    insertMemoryItem("item-default-1", "default-off-ns", "key1", '{"hello":"world"}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
    });

    await service.syncNow();

    const filePath = memoryNamespaceExportPath(tmpDir, "default-off-ns");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    parsed.items[0].value = { hello: "modified" };
    parsed.items.push({
      id: "item-default-2",
      key: "key2",
      value: { should: "not import" },
      contentText: null,
      source: "file-edit",
      tags: [],
      metadata: null,
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    const result = await service.reindexNow("memory_namespace", "default-off-ns");
    expect(result.filesProcessed).toBe(0);
    expect(result.itemsUpserted).toBe(0);
    expect(result.itemsDeleted).toBe(0);
    expect(result.errors).toEqual([{
      entityType: "memory_namespace",
      entityKey: "default-off-ns",
      message: FRIDAY_MEMORY_FILE_IMPORT_RETIRED_ERROR,
    }]);

    const items = getMemoryItems("default-off-ns");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("item-default-1");
    expect(items[0]!.value_json).toBe('{"hello":"world"}');
    expect(() => repo.upsertMemoryItemsFromExport("default-off-ns", [])).toThrow(FRIDAY_MEMORY_FILE_IMPORT_RETIRED_ERROR);
    expect(() => repo.deleteMemoryNamespace("default-off-ns")).toThrow(FRIDAY_MEMORY_FILE_IMPORT_RETIRED_ERROR);
  });

  it("reindexNow imports changed data from file into DB", async () => {
    insertMemoryItem("item-1", "reindex-ns", "key1", '{"hello":"world"}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export to file
    const r1 = await service.syncNow();
    expect(r1.filesWritten).toBe(1);

    // Externally modify the file — add a new item, modify existing
    const filePath = memoryNamespaceExportPath(tmpDir, "reindex-ns");
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);

    // Modify existing item and add new one
    parsed.items[0].value = { hello: "modified" };
    parsed.items.push({
      id: "item-2",
      key: "key2",
      value: { new: "item" },
      contentText: null,
      source: "file-edit",
      tags: [],
      metadata: null,
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });

    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    // Reindex
    const reindexResult = await service.reindexNow("memory_namespace", "reindex-ns");
    expect(reindexResult.filesProcessed).toBe(1);
    expect(reindexResult.itemsUpserted).toBe(2);
    expect(reindexResult.errors).toHaveLength(0);

    // Verify DB was updated
    const items = getMemoryItems("reindex-ns");
    expect(items).toHaveLength(2);
    expect(items.find(i => i.key === "key1")?.value_json).toBe('{"hello":"modified"}');
    expect(items.find(i => i.key === "key2")?.value_json).toBe('{"new":"item"}');
  });

  it("reindexNow rejects external imports that impersonate learned-fact synthetic ids", async () => {
    insertMemoryItem("item-boundary-1", "boundary-ns", "key1", '{"safe":true}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    await service.syncNow();

    const filePath = memoryNamespaceExportPath(tmpDir, "boundary-ns");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    parsed.items.push({
      id: "learned-fact:pref:display_name",
      key: "ordinary-key",
      value: { name: "Captain Friday" },
      contentText: "Captain Friday",
      source: "file-edit",
      tags: [],
      metadata: {},
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
    });
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    const result = await service.reindexNow("memory_namespace", "boundary-ns");
    expect(result.filesProcessed).toBe(0);
    expect(result.itemsUpserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("synthetic learned-fact ids");

    const items = getMemoryItems("boundary-ns");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("item-boundary-1");
    expect(items[0]!.value_json).toBe('{"safe":true}');
  });

  it("reindexNow skips when file hash matches last export", async () => {
    insertMemoryItem("item-skip", "skip-reindex-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export to file
    await service.syncNow();

    // Reindex without changing the file — should skip (loop suppression)
    const result = await service.reindexNow("memory_namespace", "skip-reindex-ns");
    expect(result.filesSkippedUnchanged).toBe(1);
    expect(result.filesProcessed).toBe(0);
  });

  it("reindexNow keeps local items when they are missing from an externally edited file", async () => {
    insertMemoryItem("item-d1", "del-ns", "key1", '{"val":1}');
    insertMemoryItem("item-d2", "del-ns", "key2", '{"val":2}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export
    await service.syncNow();

    // Remove item-d2 from the file
    const filePath = memoryNamespaceExportPath(tmpDir, "del-ns");
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    parsed.items = parsed.items.filter((i: Record<string, unknown>) => i.id !== "item-d2");
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");

    // Reindex
    const result = await service.reindexNow("memory_namespace", "del-ns");
    expect(result.filesProcessed).toBe(1);
    expect(result.itemsDeleted).toBe(0);

    // External file edits are non-destructive by default: omitted local rows stay.
    const items = getMemoryItems("del-ns");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.key)).toEqual(["key1", "key2"]);
  });

  // ─── ReindexAll ───

  it("reindexAll processes all tracked entities", async () => {
    insertMemoryItem("item-a1", "ns-a", "key1", '{"val":"a"}');
    insertMemoryItem("item-b1", "ns-b", "key1", '{"val":"b"}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export both
    await service.syncNow();

    // Modify both files externally
    for (const ns of ["ns-a", "ns-b"]) {
      const filePath = memoryNamespaceExportPath(tmpDir, ns);
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      parsed.items[0].value = { val: `${ns}-modified` };
      await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");
    }

    // Reindex all
    const result = await service.reindexAll();
    expect(result.filesProcessed).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  // ─── Reindex error handling ───

  it("reindexNow returns error for missing file", async () => {
    insertMemoryItem("item-miss", "missing-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export then delete the file
    await service.syncNow();
    const filePath = memoryNamespaceExportPath(tmpDir, "missing-ns");
    await fs.unlink(filePath);

    const result = await service.reindexNow("memory_namespace", "missing-ns");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("File not found");
  });

  it("reindexNow returns error for invalid JSON in file", async () => {
    insertMemoryItem("item-bad", "bad-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db, allowTestOnlyMemoryFileImport: true });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
      allowTestOnlyMemoryFileImport: true,
    });

    // Export then corrupt the file
    await service.syncNow();
    const filePath = memoryNamespaceExportPath(tmpDir, "bad-ns");
    await fs.writeFile(filePath, "not valid json {{{", "utf8");

    const result = await service.reindexNow("memory_namespace", "bad-ns");
    expect(result.errors).toHaveLength(1);
  });

  it("reindexNow for nonexistent entity returns no-op result", async () => {
    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
    });

    // Reindex entity that was never synced — no state row exists
    const result = await service.reindexNow("memory_namespace", "nonexistent");
    expect(result.filesProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // ─── Loop suppression via exported hash ───

  it("loop suppression: syncNow writes set lastExportedHash in state", async () => {
    insertMemoryItem("item-loop", "loop-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
      enableWatcher: false,
    });

    await service.syncNow();

    const state = repo.getState("memory_namespace", "loop-ns");
    expect(state).not.toBeNull();
    expect(state!.lastExportedHash).toBeTruthy();
    expect(typeof state!.lastExportedHash).toBe("string");
    expect(state!.lastExportedMtimeMs).toBeGreaterThan(0);
  });
});
