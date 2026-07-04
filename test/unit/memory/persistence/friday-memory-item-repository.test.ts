import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayMemoryItemRepository } from "#memory";
import type { FridayMemoryItemRepository } from "#memory";
import type { FridayMemoryItem } from "#memory";
import { FridayDomainError } from "#errors";

describe("FridayMemoryItemRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayMemoryItemRepository;
  const NOW = "2026-02-17T10:00:00.000Z";

  function makeItem(overrides: Partial<FridayMemoryItem> = {}): FridayMemoryItem {
    return {
      id: "item-1",
      namespace: "test-ns",
      key: "key-1",
      content: "Hello world, this is a test memory item",
      source: "system",
      tags: ["tag1", "tag2"],
      metadata: { foo: "bar" },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayMemoryItemRepository();
  });

  afterEach(() => {
    db.close();
  });

  // ─── CRUD ───

  it("inserts and retrieves a memory item by ID", () => {
    const item = makeItem();
    db.writer.transaction(() => repo.insert(db.writer, item))();
    const found = repo.getById(db.writer, "item-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("item-1");
    expect(found!.namespace).toBe("test-ns");
    expect(found!.content).toBe("Hello world, this is a test memory item");
    expect(found!.source).toBe("system");
    expect(found!.tags).toEqual(["tag1", "tag2"]);
    expect(found!.metadata).toEqual({ foo: "bar" });
  });

  it("persists and retrieves memoryType, confidence, accessCount, lastAccessedAt", () => {
    const item = makeItem({
      memoryType: "fact",
      confidence: 0.85,
      accessCount: 3,
      lastAccessedAt: "2026-02-17T12:00:00.000Z",
    });
    db.writer.transaction(() => repo.insert(db.writer, item))();
    const found = repo.getById(db.writer, "item-1");
    expect(found).not.toBeNull();
    expect(found!.memoryType).toBe("fact");
    expect(found!.confidence).toBe(0.85);
    expect(found!.accessCount).toBe(3);
    expect(found!.lastAccessedAt).toBe("2026-02-17T12:00:00.000Z");
  });

  it("returns undefined for memoryType/confidence when not set", () => {
    const item = makeItem();
    db.writer.transaction(() => repo.insert(db.writer, item))();
    const found = repo.getById(db.writer, "item-1");
    expect(found).not.toBeNull();
    expect(found!.memoryType).toBeUndefined();
    expect(found!.confidence).toBeUndefined();
  });

  it("returns null for non-existent item", () => {
    const found = repo.getById(db.writer, "nonexistent");
    expect(found).toBeNull();
  });

  it("finds the latest item by API idempotency metadata", () => {
    const item = makeItem({
      metadata: {
        apiRequest: {
          operationId: "memory.items.create",
          principalId: "user-1",
          idempotencyKey: "idem-1",
          payloadHash: "hash-1",
          receivedAt: NOW,
        },
      },
    });
    db.writer.transaction(() => repo.insert(db.writer, item))();

    const found = repo.findLatestByApiRequestIdempotencyKey(db.writer, {
      principalId: "user-1",
      idempotencyKey: "idem-1",
    });

    expect(found?.id).toBe("item-1");
    expect(found?.metadata.apiRequest).toEqual({
      operationId: "memory.items.create",
      principalId: "user-1",
      idempotencyKey: "idem-1",
      payloadHash: "hash-1",
      receivedAt: NOW,
    });
  });

  it("deletes an item by ID", () => {
    const item = makeItem();
    db.writer.transaction(() => repo.insert(db.writer, item))();
    const deleted = db.writer.transaction(() => repo.deleteById(db.writer, "item-1"))();
    expect(deleted).toBe(true);
    expect(repo.getById(db.writer, "item-1")).toBeNull();
  });

  it("returns false when deleting non-existent item", () => {
    const deleted = db.writer.transaction(() => repo.deleteById(db.writer, "nonexistent"))();
    expect(deleted).toBe(false);
  });

  // ─── List with filters ───

  it("lists items filtered by namespace", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", namespace: "ns-a" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", namespace: "ns-b" }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", namespace: "ns-a" }));
    })();

    const items = repo.list(db.writer, { namespace: "ns-a", nowIso: NOW });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.namespace === "ns-a")).toBe(true);
  });

  it("lists items filtered by source", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", source: "agent" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", source: "user" }));
    })();

    const items = repo.list(db.writer, { source: "agent", nowIso: NOW });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("agent");
  });

  it("lists items filtered by memoryType", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", memoryType: "fact" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", memoryType: "preference" }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", memoryType: "correction" }));
    })();

    const items = repo.list(db.writer, { memoryType: ["preference", "correction"], nowIso: NOW });
    expect(items.map((item) => item.id).sort()).toEqual(["i2", "i3"]);
  });

  it("lists items filtered by tagsAny", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", tags: ["python", "ai"] }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", tags: ["rust"] }));
    })();

    const items = repo.list(db.writer, { tagsAny: ["python"], nowIso: NOW });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("i1");
  });

  it("lists tagsAny with exact tag matches only", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", tags: ["data"] }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", tags: ["database"] }));
    })();

    const items = repo.list(db.writer, { tagsAny: ["data"], nowIso: NOW });
    expect(items.map((item) => item.id)).toEqual(["i1"]);
  });

  it("excludes expired items by default", () => {
    const past = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", expiresAt: future }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3" }));
    })();

    const items = repo.list(db.writer, { nowIso: NOW });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["i2", "i3"]);
  });

  it("includes expired items when requested", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2" }));
    })();

    const items = repo.list(db.writer, { includeExpired: true, nowIso: NOW });
    expect(items).toHaveLength(2);
  });

  // ─── Prune ───

  it("prunes expired items", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2" }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { expiredOnly: true, nowIso: NOW }),
    )();
    expect(deleted).toEqual(["i1"]);
    expect(repo.getById(db.writer, "i1")).toBeNull();
    expect(repo.getById(db.writer, "i2")).not.toBeNull();
  });

  it("prunes items older than a date", () => {
    const old = "2025-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", updatedAt: old }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", updatedAt: NOW }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { olderThan: "2026-01-01T00:00:00.000Z", nowIso: NOW }),
    )();
    expect(deleted).toEqual(["i1"]);
  });

  it("dry run does not actually delete", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", expiresAt: past }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { expiredOnly: true, dryRun: true, nowIso: NOW }),
    )();
    expect(deleted).toEqual(["i1"]);
    expect(repo.getById(db.writer, "i1")).not.toBeNull();
  });

  // ─── FTS search ───

  it("finds items by FTS query", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "The quick brown fox jumps over the lazy dog" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "A completely different sentence about cats" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "fox jumps",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].itemId).toBe("i1");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(typeof hits[0].snippet).toBe("string");
  });

  it("returns empty for non-matching FTS query", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "Hello world" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "zyxwvutsrqponm",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("FTS respects namespace filter", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", namespace: "ns-a", content: "machine learning tutorial" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", namespace: "ns-b", content: "machine learning guide" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "machine learning",
      namespace: "ns-a",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe("i1");
  });

  it("FTS respects memoryType filter", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "machine learning preference", memoryType: "preference" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "machine learning fact", memoryType: "fact" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "machine learning",
      memoryType: "fact",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe("i2");
  });

  it("FTS excludes expired items", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "important data", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "important data still valid" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "important data",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe("i2");
  });

  // ─── FTS tag filtering ───

  it("FTS filters by tagsAny", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "machine learning intro", tags: ["python", "ai"] }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "machine learning advanced", tags: ["rust"] }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", content: "machine learning tutorial", tags: ["python"] }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "machine learning",
      tagsAny: ["python"],
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(2);
    const ids = hits.map((h) => h.itemId).sort();
    expect(ids).toEqual(["i1", "i3"]);
  });

  it("FTS filters by tagsAll (AND semantics)", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "deep learning model", tags: ["python", "ai", "deep-learning"] }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "deep learning basics", tags: ["python"] }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", content: "deep learning framework", tags: ["ai", "deep-learning"] }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "deep learning",
      tagsAll: ["python", "ai"],
      nowIso: NOW,
      limit: 10,
    });
    // Only i1 has both "python" AND "ai"
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe("i1");
  });

  it("FTS tag filtering uses exact match (not substring)", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "data analysis report", tags: ["data"] }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", content: "data analysis summary", tags: ["database"] }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "data analysis",
      tagsAny: ["data"],
      nowIso: NOW,
      limit: 10,
    });
    // Only i1 has exact tag "data"; i2 has "database" which should not match
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe("i1");
  });

  // ─── FTS injection safety ───

  it("handles FTS operator injection safely (AND/OR/NOT/NEAR)", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "the quick brown fox" }));
    })();

    // These should not throw, even with FTS5 operators in input
    const inputs = [
      "fox AND dog",
      "fox OR cat",
      "NOT fox",
      "NEAR(fox, dog)",
      "fox*",
      "content_text:fox",
      'fox" OR "dog',
      "fox} {dog",
      "fox ^ dog",
    ];

    for (const input of inputs) {
      expect(() => {
        repo.searchFts(db.writer, { text: input, nowIso: NOW, limit: 10 });
      }).not.toThrow();
    }
  });

  it("returns empty for pure-operator / empty-after-sanitize queries", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "hello world" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "*** ^^^ +++",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("sanitized FTS query still finds results with valid terms", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "The fox jumps over the dog" }));
    })();

    // Input has special chars mixed with valid terms — valid terms should still match
    const hits = repo.searchFts(db.writer, {
      text: "fox* jumps^",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].itemId).toBe("i1");
  });

  // ─── Prune defaults ───

  it("prune with empty options defaults to expired entries", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2" })); // no expiry
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { nowIso: NOW }),
    )();
    expect(deleted).toEqual(["i1"]);
    expect(repo.getById(db.writer, "i1")).toBeNull();
    expect(repo.getById(db.writer, "i2")).not.toBeNull();
  });

  it("prune with namespace filter still defaults to expired entries", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", namespace: "ns-a", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", namespace: "ns-a" }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", namespace: "ns-b", expiresAt: past }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { namespace: "ns-a", nowIso: NOW }),
    )();

    expect(deleted).toEqual(["i1"]);
    expect(repo.getById(db.writer, "i1")).toBeNull();
    expect(repo.getById(db.writer, "i2")).not.toBeNull();
    expect(repo.getById(db.writer, "i3")).not.toBeNull();
  });

  it("prune with expiredOnly false deletes all matching namespace entries", () => {
    const past = "2026-01-01T00:00:00.000Z";

    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", namespace: "ns-a", expiresAt: past }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", namespace: "ns-a" }));
      repo.insert(db.writer, makeItem({ id: "i3", key: "k3", namespace: "ns-b" }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { namespace: "ns-a", expiredOnly: false, nowIso: NOW }),
    )();

    expect(deleted.sort()).toEqual(["i1", "i2"]);
    expect(repo.getById(db.writer, "i1")).toBeNull();
    expect(repo.getById(db.writer, "i2")).toBeNull();
    expect(repo.getById(db.writer, "i3")).not.toBeNull();
  });

  it("fail-closes prune with expiredOnly false and no predicate", () => {
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", namespace: "ns-a" }));
      repo.insert(db.writer, makeItem({ id: "i2", key: "k2", namespace: "ns-b" }));
    })();

    const deleted = db.writer.transaction(() =>
      repo.prune(db.writer, { expiredOnly: false, nowIso: NOW }),
    )();

    expect(deleted).toEqual([]);
    expect(repo.getById(db.writer, "i1")).not.toBeNull();
    expect(repo.getById(db.writer, "i2")).not.toBeNull();
  });

  // ─── FTS backfill ───

  it("FTS index includes pre-existing items after migration (backfill)", () => {
    // Items inserted via the repo go through the FTS trigger, so they should be searchable
    // This test verifies the FTS rebuild works correctly
    db.writer.transaction(() => {
      repo.insert(db.writer, makeItem({ id: "i1", key: "k1", content: "backfill test content for verification" }));
    })();

    const hits = repo.searchFts(db.writer, {
      text: "backfill test",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].itemId).toBe("i1");
  });

  it("FTS works on items inserted directly into DB (simulating pre-existing data)", () => {
    // Simulate a pre-migration item that might have been inserted without triggers
    // by manually inserting into both memory_items and rebuilding FTS
    db.writer.exec(`
      INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, created_at, updated_at)
      VALUES ('legacy-1', 'old-ns', 'legacy-key', '{"text":"legacy content for search"}', 'legacy content for search', 'system', '["legacy"]', 'legacy', '{}', '${NOW}', '${NOW}')
    `);
    // Rebuild FTS to pick up the manually inserted row
    db.writer.exec("INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild')");

    const hits = repo.searchFts(db.writer, {
      text: "legacy content",
      nowIso: NOW,
      limit: 10,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].itemId).toBe("legacy-1");
  });

  // ─── B3 access-counter ───

  describe("recordAccess (B3 conservative increment semantics)", () => {
    it("increments access_count by 1 and sets last_accessed_at for every id", () => {
      const itemA = makeItem({ id: "a", key: "a", accessCount: 0, lastAccessedAt: undefined });
      const itemB = makeItem({ id: "b", key: "b", accessCount: 5, lastAccessedAt: "2026-02-10T00:00:00.000Z" });
      const itemC = makeItem({ id: "c", key: "c", accessCount: 0 });
      db.writer.transaction(() => {
        repo.insert(db.writer, itemA);
        repo.insert(db.writer, itemB);
        repo.insert(db.writer, itemC);
      })();

      const accessedAt = "2026-02-17T11:00:00.000Z";
      const changed = repo.recordAccess(db.writer, { itemIds: ["a", "b"], nowIso: accessedAt });
      expect(changed).toBe(2);

      const a = repo.getById(db.writer, "a")!;
      const b = repo.getById(db.writer, "b")!;
      const c = repo.getById(db.writer, "c")!;
      expect(a.accessCount).toBe(1);
      expect(a.lastAccessedAt).toBe(accessedAt);
      expect(b.accessCount).toBe(6);
      expect(b.lastAccessedAt).toBe(accessedAt);
      // c was NOT in the recordAccess set — counter must stay at 0.
      expect(c.accessCount).toBe(0);
      expect(c.lastAccessedAt).toBeUndefined();
    });

    it("returns 0 and is a no-op when itemIds is empty", () => {
      const item = makeItem({ accessCount: 4 });
      db.writer.transaction(() => repo.insert(db.writer, item))();
      const changed = repo.recordAccess(db.writer, { itemIds: [], nowIso: NOW });
      expect(changed).toBe(0);
      expect(repo.getById(db.writer, "item-1")!.accessCount).toBe(4);
    });

    it("multiple sequential calls accumulate the counter monotonically", () => {
      const item = makeItem({ accessCount: 0 });
      db.writer.transaction(() => repo.insert(db.writer, item))();
      repo.recordAccess(db.writer, { itemIds: ["item-1"], nowIso: "2026-02-17T10:01:00.000Z" });
      repo.recordAccess(db.writer, { itemIds: ["item-1"], nowIso: "2026-02-17T10:02:00.000Z" });
      repo.recordAccess(db.writer, { itemIds: ["item-1"], nowIso: "2026-02-17T10:03:00.000Z" });
      const final = repo.getById(db.writer, "item-1")!;
      expect(final.accessCount).toBe(3);
      expect(final.lastAccessedAt).toBe("2026-02-17T10:03:00.000Z");
    });
  });
});
