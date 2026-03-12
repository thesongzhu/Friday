import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createTestDb, NOW, EARLIER, MUCH_EARLIER } from "./marketplace.helper.js";

describe("FridayMarketplaceCacheRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    // Insert a source for FK
    db.withWriteTransaction((conn) => {
      createFridayMarketplaceSourceRepository().insertSource(conn, "src-1", {
        name: "Test Source",
        baseUrl: "https://test.dev",
        trustPolicy: "warn",
        pinnedKeyIds: [],
      }, NOW);
      createFridayMarketplaceSourceRepository().insertSource(conn, "src-2", {
        name: "Disabled Source",
        baseUrl: "https://disabled.dev",
        trustPolicy: "strict",
        pinnedKeyIds: [],
      }, NOW);
      // Disable src-2
      createFridayMarketplaceSourceRepository().setEnabled(conn, "src-2", false, NOW);
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayMarketplaceCacheRepository();
  }

  it("upserts and retrieves a cache entry", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, {
        id: "c-1",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: JSON.stringify({ name: "Skill One" }),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 85,
        nowIso: NOW,
      });
    });

    const entry = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "skill-1", "1.0.0"),
    );
    expect(entry).not.toBeNull();
    expect(entry!.skillId).toBe("skill-1");
    expect(entry!.signatureValid).toBe(true);
    expect(entry!.trustScore).toBe(85);
  });

  it("upsert updates on conflict", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, {
        id: "c-1",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: "{}",
        signatureValid: false,
        indexedAt: EARLIER,
        trustScore: 50,
        nowIso: EARLIER,
      });
      repo.upsertCacheEntry(conn, {
        id: "c-2",
        sourceId: "src-1",
        skillId: "skill-1",
        version: "1.0.0",
        manifestJson: JSON.stringify({ updated: true }),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 90,
        nowIso: NOW,
      });
    });

    const entry = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "skill-1", "1.0.0"),
    );
    expect(entry!.signatureValid).toBe(true);
    expect(entry!.trustScore).toBe(90);
  });

  it("batch upserts multiple entries", () => {
    const repo = createRepo();
    const count = db.withWriteTransaction((conn) =>
      repo.upsertCacheBatch(conn, [
        { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW },
        { id: "c-2", sourceId: "src-1", skillId: "s2", version: "2.0.0", manifestJson: "{}", signatureValid: false, indexedAt: NOW, trustScore: 40, nowIso: NOW },
      ]),
    );
    expect(count).toBe(2);
  });

  it("lists catalog with filters", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "weather-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Weather", category: "utility" }), signatureValid: true, indexedAt: NOW, trustScore: 90, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "email-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Email", category: "communication" }), signatureValid: true, indexedAt: NOW, trustScore: 70, nowIso: NOW });
    });

    // Search by q
    const results = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { q: "weather" }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("weather-skill");

    // Search by category
    const commResults = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { category: "communication" }),
    );
    expect(commResults).toHaveLength(1);
    expect(commResults[0].skillId).toBe("email-skill");
  });

  it("listCatalog excludes disabled sources", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-2", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    // Without sourceId filter, only enabled sources shown
    const results = db.withReadConnection((conn) =>
      repo.listCatalog(conn, {}),
    );
    expect(results).toHaveLength(1);
    expect(results[0].skillId).toBe("s1");

    // With explicit sourceId, shows even disabled
    const explicit = db.withReadConnection((conn) =>
      repo.listCatalog(conn, { sourceId: "src-2" }),
    );
    expect(explicit).toHaveLength(1);
  });

  it("detects stale source IDs", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: MUCH_EARLIER, trustScore: 80, nowIso: NOW });
    });

    const stale = db.withReadConnection((conn) =>
      repo.listStaleSourceIds(conn, EARLIER),
    );
    expect(stale).toContain("src-1");
  });

  it("prunes old entries", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: MUCH_EARLIER, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    const pruned = db.withWriteTransaction((conn) =>
      repo.pruneOlderThan(conn, EARLIER),
    );
    expect(pruned).toBe(1);

    // The fresh entry should remain
    const remaining = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "s2", "1.0.0"),
    );
    expect(remaining).not.toBeNull();
  });

  it("deletes by source ID", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "s1", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
      repo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "s2", version: "1.0.0", manifestJson: "{}", signatureValid: true, indexedAt: NOW, trustScore: 80, nowIso: NOW });
    });

    const deleted = db.withWriteTransaction((conn) =>
      repo.deleteBySourceId(conn, "src-1"),
    );
    expect(deleted).toBe(2);
  });

  it("returns null for non-existent cache entry", () => {
    const repo = createRepo();
    const result = db.withReadConnection((conn) =>
      repo.getCachedVersion(conn, "src-1", "no-skill", "1.0.0"),
    );
    expect(result).toBeNull();
  });
});
