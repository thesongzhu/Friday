import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS, createFridaySqliteLayer } from "#state";
import {
  createFridayMemoryFileSyncRepository,
  createFridayMemoryFileSyncService,
  memoryNamespaceExportPath,
  sessionKeyExportPath,
} from "#memory";

describe("FridayMemoryFileSyncService", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;

  /** A path that is guaranteed to fail on mkdir/write even as root (a regular file blocks subdir creation). */
  let unwritablePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-sync-test-"));
    const blockingFile = path.join(tmpDir, "blocking-file");
    writeFileSync(blockingFile, "x");
    unwritablePath = path.join(blockingFile, "subdir");
    dbPath = path.join(tmpDir, "test.db");
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

  function insertSessionMessage(id: string, sessionId: string, sessionKey: string, role: string, content: string, sequence: number): void {
    db.withWriteTransaction((conn) => {
      // Ensure session exists
      const exists = conn.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (!exists) {
        conn.prepare(
          `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(sessionId, sessionKey, "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
      }
      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, sessionId, sessionKey, role, JSON.stringify(content), content, sequence, "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    });
  }

  it("syncNow writes memory namespace to file", async () => {
    insertMemoryItem("item-1", "test-ns", "key1", '{"hello":"world"}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    const result = await service.syncNow();
    expect(result.dirtySeen).toBe(1);
    expect(result.filesWritten).toBe(1);

    const filePath = memoryNamespaceExportPath(tmpDir, "test-ns");
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.namespace).toBe("test-ns");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].key).toBe("key1");
  });

  it("syncNow writes session messages to JSONL file", async () => {
    // Insert enough messages to exceed delta threshold, or use force
    insertSessionMessage("msg-1", "sess-1", "test:session:1", "user", "Hello", 1);
    insertSessionMessage("msg-2", "sess-1", "test:session:1", "assistant", "Hi there", 2);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    const result = await service.syncNow({ force: true });
    expect(result.dirtySeen).toBeGreaterThanOrEqual(1);
    expect(result.filesWritten).toBeGreaterThanOrEqual(1);

    const filePath = sessionKeyExportPath(tmpDir, "test:session:1");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.role).toBe("user");
    expect(first.sequence).toBe(1);
  });

  it("does not warn when session content_json is plain text and content_text is null", async () => {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess-plain", "test:session:plain", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "msg-plain",
        "sess-plain",
        "test:session:plain",
        "assistant",
        "Agent said hello from plain text",
        null,
        1,
        "2025-01-01T00:00:00Z",
        "2025-01-01T00:00:00Z",
      );
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    const filePath = sessionKeyExportPath(tmpDir, "test:session:plain");
    const content = await fs.readFile(filePath, "utf8");
    const first = JSON.parse(content.trim().split("\n")[0]!);
    expect(first.content).toBe("Agent said hello from plain text");
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[friday][memory-file-sync] try-parse-json:",
      expect.any(String),
    );
  });

  it("does not warn for bracket-prefixed plain text session content", async () => {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess-bracket", "test:session:bracket", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "msg-bracket",
        "sess-bracket",
        "test:session:bracket",
        "assistant",
        "[topic_block] canonical evidence path remains /tmp/proof.txt",
        null,
        1,
        "2025-01-01T00:00:00Z",
        "2025-01-01T00:00:00Z",
      );
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    const filePath = sessionKeyExportPath(tmpDir, "test:session:bracket");
    const content = await fs.readFile(filePath, "utf8");
    const first = JSON.parse(content.trim().split("\n")[0]!);
    expect(first.content).toBe("[topic_block] canonical evidence path remains /tmp/proof.txt");
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[friday][memory-file-sync] try-parse-json:",
      expect.any(String),
    );
  });

  it("warns only for malformed JSON-looking session content and preserves the raw payload", async () => {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO sessions (id, session_key, channel, chat_kind, status, agent_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("sess-badjson", "test:session:badjson", "cli", "dm", "active", "agent-1", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
      conn.prepare(
        `INSERT INTO session_messages (id, session_id, session_key, role, content_json, content_text, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "msg-badjson",
        "sess-badjson",
        "test:session:badjson",
        "assistant",
        "{\"broken\":",
        null,
        1,
        "2025-01-01T00:00:00Z",
        "2025-01-01T00:00:00Z",
      );
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    const filePath = sessionKeyExportPath(tmpDir, "test:session:badjson");
    const content = await fs.readFile(filePath, "utf8");
    const first = JSON.parse(content.trim().split("\n")[0]!);
    expect(first.content).toBe("{\"broken\":");
    expect(warnSpy).toHaveBeenCalledWith(
      "[friday][memory-file-sync] try-parse-json:",
      expect.any(String),
    );
  });

  it("hash-based skip prevents redundant writes", async () => {
    insertMemoryItem("item-1", "skip-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First sync writes the file
    const r1 = await service.syncNow();
    expect(r1.filesWritten).toBe(1);

    // Re-dirty manually (to simulate another write of same data)
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO memory_file_sync_dirty (entity_type, entity_key, first_dirty_at, last_dirty_at)
         VALUES ('memory_namespace', 'skip-ns', datetime('now'), datetime('now'))`,
      ).run();
    });

    // Second sync should skip (unchanged)
    const r2 = await service.syncNow();
    expect(r2.filesSkippedUnchanged).toBe(1);
    expect(r2.filesWritten).toBe(0);
  });

  it("deletes file when namespace becomes empty", async () => {
    insertMemoryItem("item-del", "empty-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // Write the file
    await service.syncNow();

    const filePath = memoryNamespaceExportPath(tmpDir, "empty-ns");
    const exists1 = await fs.stat(filePath).then(() => true).catch(() => false);
    expect(exists1).toBe(true);

    // Delete the item
    db.withWriteTransaction((conn) => {
      conn.prepare("DELETE FROM memory_items WHERE id = ?").run("item-del");
    });

    // Sync again — should delete file
    const r2 = await service.syncNow();
    expect(r2.filesDeleted).toBe(1);

    const exists2 = await fs.stat(filePath).then(() => true).catch(() => false);
    expect(exists2).toBe(false);
  });

  it("single-flight: concurrent syncNow calls share the same promise", async () => {
    insertMemoryItem("item-sf", "sf-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // Fire two concurrent syncs
    const [r1, r2] = await Promise.all([
      service.syncNow(),
      service.syncNow(),
    ]);

    // Both should resolve to the same result (single-flight)
    expect(r1).toBe(r2);
  });

  it("status returns correct state", async () => {
    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    const s1 = service.status();
    expect(s1.running).toBe(false);
    expect(s1.syncing).toBe(false);

    await service.start();
    const s2 = service.status();
    expect(s2.running).toBe(true);

    await service.stop();
    const s3 = service.status();
    expect(s3.running).toBe(false);
  });

  // ─── F2: Edit/delete detection via checksum validation ───

  it("F2: edit of existing message (same sequence) triggers rewrite, not skip", async () => {
    insertSessionMessage("msg-1", "sess-1", "test:sess:edit", "user", "Hello", 1);
    insertSessionMessage("msg-2", "sess-1", "test:sess:edit", "assistant", "Hi", 2);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First sync (force to bypass delta thresholds)
    const r1 = await service.syncNow({ force: true });
    expect(r1.filesWritten).toBeGreaterThanOrEqual(1);

    // Edit msg-1 in-place (same sequence, different content)
    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE session_messages SET content_json = ?, content_text = ? WHERE id = 'msg-1'",
      ).run(JSON.stringify("Hello EDITED"), "Hello EDITED");
    });

    // Force sync after edit — should rewrite, not skip
    const r2 = await service.syncNow({ force: true });
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);

    // Verify the file contains the edited content
    const filePath = sessionKeyExportPath(tmpDir, "test:sess:edit");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("Hello EDITED");
  });

  it("F2: delete of old message triggers full rewrite", async () => {
    insertSessionMessage("msg-1", "sess-1", "test:sess:del", "user", "Hello", 1);
    insertSessionMessage("msg-2", "sess-1", "test:sess:del", "assistant", "Hi", 2);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    // Delete msg-1
    db.withWriteTransaction((conn) => {
      conn.prepare("DELETE FROM session_messages WHERE id = 'msg-1'").run();
    });

    const r2 = await service.syncNow({ force: true });
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);

    // Verify file only has 1 message
    const filePath = sessionKeyExportPath(tmpDir, "test:sess:del");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).sequence).toBe(2);
  });

  // ─── F3: Dirty row preservation on defer ───

  it("F3: below-threshold delta defers write and preserves dirty row", async () => {
    insertSessionMessage("msg-1", "sess-1", "test:sess:defer", "user", "Hello", 1);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First sync forced — establishes state
    await service.syncNow({ force: true });

    // Add one small message (below threshold)
    insertSessionMessage("msg-2", "sess-1", "test:sess:defer", "assistant", "Hi", 2);

    // Non-forced sync should defer (below threshold)
    const r2 = await service.syncNow();
    expect(r2.filesDeferred).toBeGreaterThanOrEqual(1);

    // Dirty row should still exist
    const dirtyCount = repo.dirtyCount();
    expect(dirtyCount).toBeGreaterThanOrEqual(1);
  });

  it("F3: deferred session rows do not starve newer memory namespace exports", async () => {
    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    for (let i = 0; i < 60; i++) {
      insertSessionMessage(`msg-starve-${i}-1`, `sess-starve-${i}`, `test:sess:starve:${i}`, "user", "Hello", 1);
    }

    await service.syncNow({ force: true });
    await service.syncNow({ force: true });
    expect(repo.dirtyCount()).toBe(0);

    for (let i = 0; i < 60; i++) {
      insertSessionMessage(`msg-starve-${i}-2`, `sess-starve-${i}`, `test:sess:starve:${i}`, "assistant", "Hi", 2);
    }
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `UPDATE memory_file_sync_dirty
           SET first_dirty_at = '2025-01-01 00:00:00',
               last_dirty_at = '2025-01-01 00:00:00'
           WHERE entity_type = 'session_key'`,
        )
        .run();
    });
    insertMemoryItem("item-starve", "starve-ns", "key1", '{"hello":"world"}');

    const r1 = await service.syncNow();
    expect(r1.filesDeferred).toBe(50);

    const r2 = await service.syncNow();
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);

    const filePath = memoryNamespaceExportPath(tmpDir, "starve-ns");
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.namespace).toBe("starve-ns");
  });

  it("F3: force=true bypasses defer and removes dirty row", async () => {
    insertSessionMessage("msg-1", "sess-1", "test:sess:force", "user", "Hello", 1);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First sync forced
    await service.syncNow({ force: true });

    // Add one small message
    insertSessionMessage("msg-2", "sess-1", "test:sess:force", "assistant", "Hi", 2);

    // Force sync should write and remove dirty
    const r2 = await service.syncNow({ force: true });
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);

    // Dirty row should be removed
    const dirtyCount = repo.dirtyCount();
    expect(dirtyCount).toBe(0);
  });

  // ─── F4: Error handling — dirty row persists on error ───

  it("F4: write failure preserves dirty row for retry", async () => {
    insertMemoryItem("item-err", "error-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      // Use an invalid path that will cause write failure
      stateDir: unwritablePath,
    });

    const r = await service.syncNow();
    expect(r.errors.length).toBeGreaterThanOrEqual(1);

    // Dirty row should persist — not removed on error
    const dirtyCount = repo.dirtyCount();
    expect(dirtyCount).toBeGreaterThanOrEqual(1);
  });

  it("F4: retry after transient failure succeeds and removes dirty", async () => {
    insertMemoryItem("item-retry", "retry-ns", "key1", '{"val":1}');

    const repo = createFridayMemoryFileSyncRepository({ db });

    // First: try with bad path
    const badService = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: unwritablePath,
    });
    const r1 = await badService.syncNow();
    expect(r1.errors.length).toBeGreaterThanOrEqual(1);

    // Dirty should persist
    expect(repo.dirtyCount()).toBeGreaterThanOrEqual(1);

    // Second: retry with good path
    const goodService = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });
    const r2 = await goodService.syncNow();
    expect(r2.filesWritten).toBe(1);
    expect(r2.errors).toHaveLength(0);

    // Dirty should be removed now
    expect(repo.dirtyCount()).toBe(0);
  });

  // ─── F5: Crash-safe append — missing file falls back to full rewrite ───

  it("F5: missing transcript file with existing state triggers full rewrite", async () => {
    insertSessionMessage("msg-1", "sess-1", "test:sess:crash", "user", "Hello", 1);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First sync
    await service.syncNow({ force: true });

    const filePath = sessionKeyExportPath(tmpDir, "test:sess:crash");
    // Delete the file to simulate crash/corruption
    await fs.unlink(filePath);

    // Add new message
    insertSessionMessage("msg-2", "sess-1", "test:sess:crash", "assistant", "Hi", 2);

    // Sync should succeed with full rewrite (not partial append of just msg-2)
    const r2 = await service.syncNow({ force: true });
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);

    // File should have BOTH messages (full reconstruction)
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sequence).toBe(1);
    expect(JSON.parse(lines[1]!).sequence).toBe(2);
  });

  // ─── F2 regression: edit+small-insert triggers rewrite (non-force) ───

  it("F2: edit+small-insert triggers rewrite (non-force)", async () => {
    // Seed baseline transcript
    insertSessionMessage("msg-e1", "sess-e", "test:sess:editinsert", "user", "Original message", 1);
    insertSessionMessage("msg-e2", "sess-e", "test:sess:editinsert", "assistant", "Original reply", 2);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // Initial forced sync — establishes state
    const r1 = await service.syncNow({ force: true });
    expect(r1.filesWritten).toBeGreaterThanOrEqual(1);

    // Edit an existing old message (seq 1)
    db.withWriteTransaction((conn) => {
      conn.prepare(
        "UPDATE session_messages SET content_json = ?, content_text = ? WHERE id = 'msg-e1'",
      ).run(JSON.stringify("EDITED original message"), "EDITED original message");
    });

    // Insert one tiny new message (below thresholds)
    insertSessionMessage("msg-e3", "sess-e", "test:sess:editinsert", "user", "tiny", 3);

    // Non-forced sync should detect edit via checksum and trigger rewrite, NOT defer
    const r2 = await service.syncNow();
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);
    expect(r2.filesDeferred).toBe(0);

    // Dirty row should be cleared
    const dirtyCount = repo.dirtyCount();
    expect(dirtyCount).toBe(0);

    // Exported file should contain both edited old content and new line
    const filePath = sessionKeyExportPath(tmpDir, "test:sess:editinsert");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(content).toContain("EDITED original message");
    expect(content).toContain("tiny");
  });

  // ─── F5: Append-fallback with actual append path (non-force) ───

  it("F5: missing transcript file with non-force above-threshold triggers full rewrite", async () => {
    // Seed initial message and sync
    insertSessionMessage("msg-af1", "sess-af", "test:sess:appendfb", "user", "Initial hello", 1);

    const repo = createFridayMemoryFileSyncRepository({ db });
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    await service.syncNow({ force: true });

    const filePath = sessionKeyExportPath(tmpDir, "test:sess:appendfb");
    // Delete the file to simulate crash/corruption
    await fs.unlink(filePath);

    // Add a large message (>100KB) to exceed delta threshold for non-force path
    const bigContent = "X".repeat(150_000);
    insertSessionMessage("msg-af2", "sess-af", "test:sess:appendfb", "assistant", bigContent, 2);

    // Non-forced sync: enters incremental branch, attempts append read, falls back to full rewrite
    const r2 = await service.syncNow();
    expect(r2.filesWritten).toBeGreaterThanOrEqual(1);
    expect(r2.filesDeferred).toBe(0);

    // File should have ALL messages (both seq 1 and 2), not just the delta
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).sequence).toBe(1);
    expect(JSON.parse(lines[1]!).sequence).toBe(2);
    expect(content).toContain("Initial hello");
    expect(content).toContain(bigContent);
  });

  // ─── F5: Write failure preserves dirty and retries cleanly ───

  it("F5: write failure preserves dirty and retries cleanly", async () => {
    insertSessionMessage("msg-rf1", "sess-rf", "test:sess:renamefail", "user", "Hello there", 1);

    const repo = createFridayMemoryFileSyncRepository({ db });

    // Use a good stateDir for the initial sync
    const service = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: tmpDir,
    });

    // First forced sync establishes state
    await service.syncNow({ force: true });

    // Add a large message (above threshold) so non-force takes the append path
    const bigContent = "Y".repeat(150_000);
    insertSessionMessage("msg-rf2", "sess-rf", "test:sess:renamefail", "assistant", bigContent, 2);

    // Create a service pointing to a non-writable path to simulate write failure
    // (atomicWrite will fail because it can't mkdir or create temp file)
    const badService = createFridayMemoryFileSyncService({
      repository: repo,
      stateDir: unwritablePath,
    });

    // Non-forced sync should fail due to write error
    const r2 = await badService.syncNow();
    expect(r2.errors.length).toBeGreaterThanOrEqual(1);

    // Dirty row should be preserved (not removed on error)
    expect(repo.dirtyCount()).toBeGreaterThanOrEqual(1);

    // Retry with good service — should succeed and remove dirty row
    const r3 = await service.syncNow();
    expect(r3.filesWritten).toBeGreaterThanOrEqual(1);
    expect(r3.errors).toHaveLength(0);
    expect(repo.dirtyCount()).toBe(0);
  });

  // ─── F6: Filename collision resistance ───

  it("F6: a:b and a/b produce different filenames", () => {
    const path1 = sessionKeyExportPath(tmpDir, "a:b");
    const path2 = sessionKeyExportPath(tmpDir, "a/b");
    expect(path1).not.toBe(path2);
  });

  it("F6: same key always produces the same filename", () => {
    const path1 = sessionKeyExportPath(tmpDir, "my:session:key");
    const path2 = sessionKeyExportPath(tmpDir, "my:session:key");
    expect(path1).toBe(path2);
  });
});
