import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFridayMemoryGuardQuotaRepository } from "#memory";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";
import type { FridaySqliteLayer } from "#state";

describe("FridayMemoryGuardQuotaRepository", () => {
  let db: FridaySqliteLayer;
  const repo = createFridayMemoryGuardQuotaRepository();
  const NOW = "2026-02-18T10:00:00.000Z";
  const PAST = "2026-02-17T10:00:00.000Z";
  const FUTURE = "2026-02-19T10:00:00.000Z";
  let counter = 0;

  function insertItem(namespace: string, options?: { content?: string; expiresAt?: string | null }): string {
    const id = `item-${++counter}`;
    const content = options?.content ?? "test content";
    const expiresAt = options?.expiresAt ?? null;
    db.withWriteTransaction((writer) => {
      writer.prepare(`
        INSERT INTO memory_items (id, namespace, key, value_json, tags_json, content_text, source, tags_text, metadata_json, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, '{}', '[]', ?, 'system', '', '{}', ?, ?, ?)
      `).run(id, namespace, id, content, expiresAt, NOW, NOW);
    });
    return id;
  }

  beforeEach(() => {
    db = createTestDb();
    counter = 0;
  });

  afterEach(() => {
    db.close();
  });

  // ─── getNamespaceUsage ───

  it("returns zeros for empty namespace", () => {
    const usage = db.withReadConnection((readDb) =>
      repo.getNamespaceUsage(readDb, "empty-ns", NOW),
    );
    expect(usage.namespace).toBe("empty-ns");
    expect(usage.itemCount).toBe(0);
    expect(usage.totalBytes).toBe(0);
    expect(usage.expiredItemCount).toBe(0);
    expect(usage.expiredBytes).toBe(0);
  });

  it("counts items and bytes correctly", () => {
    insertItem("test-ns", { content: "hello" }); // 5 bytes
    insertItem("test-ns", { content: "world!" }); // 6 bytes

    const usage = db.withReadConnection((readDb) =>
      repo.getNamespaceUsage(readDb, "test-ns", NOW),
    );
    expect(usage.itemCount).toBe(2);
    expect(usage.totalBytes).toBe(11);
  });

  it("identifies expired items correctly", () => {
    insertItem("test-ns", { content: "active", expiresAt: FUTURE });
    insertItem("test-ns", { content: "expired", expiresAt: PAST });

    const usage = db.withReadConnection((readDb) =>
      repo.getNamespaceUsage(readDb, "test-ns", NOW),
    );
    expect(usage.itemCount).toBe(2);
    expect(usage.expiredItemCount).toBe(1);
    expect(usage.expiredBytes).toBe(7); // "expired" = 7 bytes
  });

  it("does not count items from other namespaces", () => {
    insertItem("ns-a", { content: "a" });
    insertItem("ns-b", { content: "b" });

    const usage = db.withReadConnection((readDb) =>
      repo.getNamespaceUsage(readDb, "ns-a", NOW),
    );
    expect(usage.itemCount).toBe(1);
  });

  // ─── listNamespacesByPrefix ───

  it("lists namespaces matching prefix", () => {
    insertItem("tenant.hub1.notes");
    insertItem("tenant.hub1.tasks");
    insertItem("tenant.hub2.notes");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "tenant.hub1", 100),
    );
    expect(namespaces).toEqual(["tenant.hub1.notes", "tenant.hub1.tasks"]);
  });

  it("respects limit parameter", () => {
    insertItem("ns.a");
    insertItem("ns.b");
    insertItem("ns.c");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "ns", 2),
    );
    expect(namespaces).toHaveLength(2);
  });

  it("returns empty array for non-matching prefix", () => {
    insertItem("other.ns");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "nonexistent", 100),
    );
    expect(namespaces).toHaveLength(0);
  });

  it("does not match sibling namespaces with similar prefix (prefix safety)", () => {
    // CX R2: "tenant.hub1.user1" must NOT match "tenant.hub1.user10.something"
    insertItem("tenant.hub1.user1.notes");
    insertItem("tenant.hub1.user10.notes");
    insertItem("tenant.hub1.user100.notes");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "tenant.hub1.user1", 100),
    );
    expect(namespaces).toEqual(["tenant.hub1.user1.notes"]);
    expect(namespaces).not.toContain("tenant.hub1.user10.notes");
    expect(namespaces).not.toContain("tenant.hub1.user100.notes");
  });

  it("includes exact prefix match in results", () => {
    insertItem("tenant.hub1.user1");
    insertItem("tenant.hub1.user1.notes");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "tenant.hub1.user1", 100),
    );
    expect(namespaces).toEqual(["tenant.hub1.user1", "tenant.hub1.user1.notes"]);
  });

  it("returns only exact match when no descendants exist", () => {
    insertItem("tenant.hub1.user1");

    const namespaces = db.withReadConnection((readDb) =>
      repo.listNamespacesByPrefix(readDb, "tenant.hub1.user1", 100),
    );
    expect(namespaces).toEqual(["tenant.hub1.user1"]);
  });

  // ─── pruneExpiredOldest ───

  it("deletes oldest expired items up to limit", () => {
    insertItem("test-ns", { content: "old-expired", expiresAt: "2026-02-15T00:00:00.000Z" });
    insertItem("test-ns", { content: "newer-expired", expiresAt: "2026-02-16T00:00:00.000Z" });
    insertItem("test-ns", { content: "active", expiresAt: FUTURE });

    const result = db.withWriteTransaction((writer) =>
      repo.pruneExpiredOldest(writer, {
        namespace: "test-ns",
        nowIso: NOW,
        limit: 1,
      }),
    );

    expect(result.deletedCount).toBe(1);
    expect(result.deletedIds).toHaveLength(1);
    expect(result.deletedBytes).toBe(11); // "old-expired" = 11 bytes
  });

  it("returns empty result when no expired items exist", () => {
    insertItem("test-ns", { content: "active", expiresAt: FUTURE });

    const result = db.withWriteTransaction((writer) =>
      repo.pruneExpiredOldest(writer, {
        namespace: "test-ns",
        nowIso: NOW,
        limit: 10,
      }),
    );

    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toHaveLength(0);
    expect(result.deletedBytes).toBe(0);
  });

  it("only prunes from specified namespace", () => {
    insertItem("ns-a", { content: "expired-a", expiresAt: PAST });
    insertItem("ns-b", { content: "expired-b", expiresAt: PAST });

    const result = db.withWriteTransaction((writer) =>
      repo.pruneExpiredOldest(writer, {
        namespace: "ns-a",
        nowIso: NOW,
        limit: 100,
      }),
    );

    expect(result.deletedCount).toBe(1);

    // ns-b item should still exist
    const remaining = db.withReadConnection((readDb) =>
      repo.getNamespaceUsage(readDb, "ns-b", NOW),
    );
    expect(remaining.itemCount).toBe(1);
  });
});
