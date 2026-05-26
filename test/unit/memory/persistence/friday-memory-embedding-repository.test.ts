import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayMemoryEmbeddingRepository } from "#memory";
import type { FridayMemoryEmbeddingRepository } from "#memory";
import type { FridayMemoryEmbedding } from "#memory";
import { FridayDomainError } from "#errors";

describe("FridayMemoryEmbeddingRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayMemoryEmbeddingRepository;
  const NOW = "2026-02-17T10:00:00.000Z";

  function insertMemoryItem(
    id: string,
    namespace = "test",
    key?: string,
    expiresAt?: string,
    tags: string[] = [],
    memoryType?: string,
  ) {
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, content_text, source, tags_json, tags_text, metadata_json, expires_at, created_at, updated_at, memory_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        namespace,
        key ?? id,
        "{}",
        "test content",
        "system",
        JSON.stringify(tags),
        tags.join(" "),
        "{}",
        expiresAt ?? null,
        NOW,
        NOW,
        memoryType ?? null,
      );
  }

  function makeEmbedding(overrides: Partial<FridayMemoryEmbedding> = {}): FridayMemoryEmbedding {
    return {
      id: "emb-1",
      itemId: "mi-1",
      providerId: "prov-1",
      model: "text-embedding-3-small",
      dimensions: 3,
      vector: [0.1, 0.2, 0.3],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayMemoryEmbeddingRepository();
  });

  afterEach(() => {
    db.close();
  });

  // ─── Upsert / Get ───

  it("upserts and retrieves an embedding by item ID", () => {
    insertMemoryItem("mi-1");
    const embedding = makeEmbedding();
    db.writer.transaction(() => repo.upsert(db.writer, embedding))();

    const found = repo.getByItemId(db.writer, "mi-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("emb-1");
    expect(found!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(found!.dimensions).toBe(3);
    expect(found!.model).toBe("text-embedding-3-small");
  });

  it("returns null for non-existent item", () => {
    const found = repo.getByItemId(db.writer, "nonexistent");
    expect(found).toBeNull();
  });

  it("upserts overwrites existing embedding for same item+provider+model", () => {
    insertMemoryItem("mi-1");
    const emb1 = makeEmbedding({ vector: [0.1, 0.2, 0.3] });
    db.writer.transaction(() => repo.upsert(db.writer, emb1))();

    const emb2 = makeEmbedding({ id: "emb-2", vector: [0.9, 0.8, 0.7] });
    db.writer.transaction(() => repo.upsert(db.writer, emb2))();

    const found = repo.getByItemId(db.writer, "mi-1");
    expect(found).not.toBeNull();
    expect(found!.vector).toEqual([0.9, 0.8, 0.7]);
  });

  it("filters by model when specified", () => {
    insertMemoryItem("mi-1");
    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "emb-1", model: "model-a", providerId: "p1" }));
      repo.upsert(db.writer, makeEmbedding({ id: "emb-2", model: "model-b", providerId: "p2" }));
    })();

    const found = repo.getByItemId(db.writer, "mi-1", "model-b");
    expect(found).not.toBeNull();
    expect(found!.model).toBe("model-b");
  });

  // ─── Delete ───

  it("deletes embeddings by item ID", () => {
    insertMemoryItem("mi-1");
    db.writer.transaction(() => repo.upsert(db.writer, makeEmbedding()))();

    const count = db.writer.transaction(() => repo.deleteByItemId(db.writer, "mi-1"))();
    expect(count).toBe(1);
    expect(repo.getByItemId(db.writer, "mi-1")).toBeNull();
  });

  // ─── Cosine similarity query ───

  it("ranks items by cosine similarity", () => {
    insertMemoryItem("mi-1");
    insertMemoryItem("mi-2", "test", "mi-2");
    insertMemoryItem("mi-3", "test", "mi-3");

    db.writer.transaction(() => {
      // mi-1: similar to query [1, 0, 0]
      repo.upsert(db.writer, makeEmbedding({
        id: "e1", itemId: "mi-1", vector: [0.9, 0.1, 0.0],
      }));
      // mi-2: opposite direction
      repo.upsert(db.writer, makeEmbedding({
        id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [0.0, 0.0, 1.0],
      }));
      // mi-3: somewhat similar
      repo.upsert(db.writer, makeEmbedding({
        id: "e3", itemId: "mi-3", providerId: "prov-1", vector: [0.7, 0.7, 0.0],
      }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      limit: 10,
      candidateLimit: 100,
    });

    expect(results.length).toBe(3);
    // mi-1 should be most similar
    expect(results[0].itemId).toBe("mi-1");
    expect(results[0].score).toBeGreaterThan(results[1].score);
    // mi-3 should be second
    expect(results[1].itemId).toBe("mi-3");
  });

  it("respects minScore filter", () => {
    insertMemoryItem("mi-1");
    insertMemoryItem("mi-2", "test", "mi-2");

    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({
        id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0],
      }));
      repo.upsert(db.writer, makeEmbedding({
        id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [0.0, 0.0, 1.0],
      }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      limit: 10,
      candidateLimit: 100,
      minScore: 0.5,
    });

    // Only mi-1 (similarity ~1.0) should pass; mi-2 (similarity ~0.0) should not
    expect(results).toHaveLength(1);
    expect(results[0].itemId).toBe("mi-1");
  });

  it("filters by namespace", () => {
    insertMemoryItem("mi-1", "ns-a");
    insertMemoryItem("mi-2", "ns-b", "mi-2");

    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0] }));
      repo.upsert(db.writer, makeEmbedding({ id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [1.0, 0.0, 0.0] }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      namespace: "ns-a",
      limit: 10,
      candidateLimit: 100,
    });

    expect(results).toHaveLength(1);
    expect(results[0].itemId).toBe("mi-1");
  });

  it("filters by memoryType", () => {
    insertMemoryItem("mi-1", "test", "mi-1", undefined, [], "fact");
    insertMemoryItem("mi-2", "test", "mi-2", undefined, [], "preference");

    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0] }));
      repo.upsert(db.writer, makeEmbedding({ id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [1.0, 0.0, 0.0] }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      memoryType: "preference",
      limit: 10,
      candidateLimit: 100,
    });

    expect(results.map((result) => result.itemId)).toEqual(["mi-2"]);
  });

  it("respects candidate limit", () => {
    // Insert 5 items
    for (let i = 0; i < 5; i++) {
      const id = `mi-${i}`;
      insertMemoryItem(id, "test", id);
      db.writer.transaction(() => {
        repo.upsert(db.writer, makeEmbedding({
          id: `e-${i}`, itemId: id, providerId: "prov-1",
          vector: [Math.random(), Math.random(), Math.random()],
        }));
      })();
    }

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      limit: 2,
      candidateLimit: 3,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("excludes expired items by default", () => {
    const past = "2026-01-01T00:00:00.000Z";
    insertMemoryItem("mi-1", "test", "mi-1", past);
    insertMemoryItem("mi-2", "test", "mi-2");

    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0] }));
      repo.upsert(db.writer, makeEmbedding({ id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [1.0, 0.0, 0.0] }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      limit: 10,
      candidateLimit: 100,
    });

    expect(results).toHaveLength(1);
    expect(results[0].itemId).toBe("mi-2");
  });

  it("filters semantic candidates by exact tag match", () => {
    insertMemoryItem("mi-1", "test", "mi-1", undefined, ["data"]);
    insertMemoryItem("mi-2", "test", "mi-2", undefined, ["database"]);

    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0] }));
      repo.upsert(db.writer, makeEmbedding({ id: "e2", itemId: "mi-2", providerId: "prov-1", vector: [1.0, 0.0, 0.0] }));
    })();

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      tagsAny: ["data"],
      limit: 10,
      candidateLimit: 100,
    });

    expect(results.map((result) => result.itemId)).toEqual(["mi-1"]);
  });

  // ─── Vector validation ───

  it("rejects empty vector on upsert", () => {
    insertMemoryItem("mi-1");
    expect(() => {
      db.writer.transaction(() => {
        repo.upsert(db.writer, makeEmbedding({ vector: [], dimensions: 0 }));
      })();
    }).toThrow(FridayDomainError);
  });

  it("rejects vector with NaN values on upsert", () => {
    insertMemoryItem("mi-1");
    expect(() => {
      db.writer.transaction(() => {
        repo.upsert(db.writer, makeEmbedding({ vector: [0.1, NaN, 0.3] }));
      })();
    }).toThrow(FridayDomainError);
  });

  it("rejects vector with Infinity values on upsert", () => {
    insertMemoryItem("mi-1");
    expect(() => {
      db.writer.transaction(() => {
        repo.upsert(db.writer, makeEmbedding({ vector: [0.1, Infinity, 0.3] }));
      })();
    }).toThrow(FridayDomainError);
  });

  it("rejects vector with mismatched dimensions on upsert", () => {
    insertMemoryItem("mi-1");
    expect(() => {
      db.writer.transaction(() => {
        repo.upsert(db.writer, makeEmbedding({ vector: [0.1, 0.2], dimensions: 3 }));
      })();
    }).toThrow(FridayDomainError);
  });

  it("skips malformed vectors in querySimilar results", () => {
    insertMemoryItem("mi-1");
    insertMemoryItem("mi-2", "test", "mi-2");

    // Insert a valid embedding
    db.writer.transaction(() => {
      repo.upsert(db.writer, makeEmbedding({ id: "e1", itemId: "mi-1", vector: [1.0, 0.0, 0.0] }));
    })();

    // Manually insert a malformed vector directly into the DB
    db.writer.prepare(
      `INSERT INTO memory_embeddings (id, item_id, provider_id, model, dimensions, vector_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("e-bad", "mi-2", "prov-1", "text-embedding-3-small", 3, "[null, NaN, 0.1]", NOW, NOW);

    const results = repo.querySimilar(db.writer, {
      queryVector: [1.0, 0.0, 0.0],
      model: "text-embedding-3-small",
      nowIso: NOW,
      limit: 10,
      candidateLimit: 100,
    });

    // Only mi-1 should appear (mi-2's vector is malformed and skipped)
    expect(results).toHaveLength(1);
    expect(results[0].itemId).toBe("mi-1");
  });
});
