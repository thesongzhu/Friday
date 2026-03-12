import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createTestDb, NOW } from "./marketplace.helper.js";

describe("FridayMarketplaceSourceRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayMarketplaceSourceRepository();
  }

  it("inserts and retrieves a source", () => {
    const repo = createRepo();
    const entity = db.withWriteTransaction((conn) =>
      repo.insertSource(conn, "src-1", {
        name: "Official",
        baseUrl: "https://marketplace.friday.dev",
        trustPolicy: "strict",
        pinnedKeyIds: ["key-1", "key-2"],
      }, NOW),
    );

    expect(entity.id).toBe("src-1");
    expect(entity.name).toBe("Official");
    expect(entity.baseUrl).toBe("https://marketplace.friday.dev");
    expect(entity.enabled).toBe(true);
    expect(entity.trustPolicy).toBe("strict");
    expect(entity.pinnedKeyIds).toEqual(["key-1", "key-2"]);
    expect(entity.createdAt).toBe(NOW);

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched).toEqual(entity);
  });

  it("lists all sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Alpha", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.insertSource(conn, "src-2", { name: "Beta", baseUrl: "https://b.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
    });

    const all = db.withReadConnection((conn) => repo.listSources(conn));
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("Alpha");
    expect(all[1].name).toBe("Beta");
  });

  it("lists only enabled sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Enabled", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.insertSource(conn, "src-2", { name: "Disabled", baseUrl: "https://b.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);
      repo.setEnabled(conn, "src-2", false, NOW);
    });

    const enabled = db.withReadConnection((conn) => repo.listSources(conn, true));
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Enabled");
  });

  it("updates a source", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Original", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.updateSource(conn, "src-1", { name: "Updated", trustPolicy: "permissive" }, "2025-06-15T13:00:00.000Z"),
    );
    expect(updated.name).toBe("Updated");
    expect(updated.trustPolicy).toBe("permissive");
    expect(updated.baseUrl).toBe("https://a.dev");
    expect(updated.updatedAt).toBe("2025-06-15T13:00:00.000Z");
  });

  it("enables and disables a source", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      repo.setEnabled(conn, "src-1", false, NOW);
    });

    let fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.enabled).toBe(false);

    db.withWriteTransaction((conn) => repo.setEnabled(conn, "src-1", true, NOW));
    fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.enabled).toBe(true);
  });

  it("deletes source and its cache entries", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: [] }, NOW);
      // Insert a cache entry
      conn.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES ('cache-1', 'src-1', 'skill-1', '1.0.0', '{}', 0, ?, 50, ?, ?)`,
      ).run(NOW, NOW, NOW);
    });

    db.withWriteTransaction((conn) => repo.deleteSource(conn, "src-1"));

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched).toBeNull();

    // Cache entries should also be deleted
    const cacheCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as cnt FROM marketplace_cache WHERE source_id = 'src-1'").get() as { cnt: number }).cnt,
    );
    expect(cacheCount).toBe(0);
  });

  it("round-trips pinned key IDs JSON", () => {
    const repo = createRepo();
    const keys = ["key-abc", "key-def", "key-ghi"];
    db.withWriteTransaction((conn) => {
      repo.insertSource(conn, "src-1", { name: "Test", baseUrl: "https://a.dev", trustPolicy: "strict", pinnedKeyIds: keys }, NOW);
    });

    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "src-1"));
    expect(fetched!.pinnedKeyIds).toEqual(keys);
  });

  it("returns null for non-existent source", () => {
    const repo = createRepo();
    const fetched = db.withReadConnection((conn) => repo.getSourceById(conn, "no-such"));
    expect(fetched).toBeNull();
  });
});
