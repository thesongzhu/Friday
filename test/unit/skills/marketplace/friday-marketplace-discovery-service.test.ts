import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayMarketplaceSourceRepository } from "#skills";
import { createFridayMarketplaceCacheRepository } from "#skills";
import { createFridayMarketplaceDiscoveryService } from "#skills";
import { createTestDb, NOW } from "./marketplace.helper.js";

describe("FridayMarketplaceDiscoveryService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", { name: "Main", baseUrl: "https://main.dev", trustPolicy: "warn", pinnedKeyIds: [] }, NOW);

      cacheRepo.upsertCacheEntry(conn, { id: "c-1", sourceId: "src-1", skillId: "weather-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "Weather Lookup", category: "utility", author: { name: "Friday Labs" } }), signatureValid: true, indexedAt: NOW, trustScore: 90, nowIso: NOW });
      cacheRepo.upsertCacheEntry(conn, { id: "c-2", sourceId: "src-1", skillId: "email-skill", version: "2.0.0", manifestJson: JSON.stringify({ name: "Email Manager", category: "communication", author: { name: "ACME" } }), signatureValid: true, indexedAt: NOW, trustScore: 75, nowIso: NOW });
      cacheRepo.upsertCacheEntry(conn, { id: "c-3", sourceId: "src-1", skillId: "file-skill", version: "1.0.0", manifestJson: JSON.stringify({ name: "File Manager", category: "utility", author: { name: "DevTools" } }), signatureValid: false, indexedAt: NOW, trustScore: 50, nowIso: NOW });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    return createFridayMarketplaceDiscoveryService({
      db,
      cacheRepo: createFridayMarketplaceCacheRepository(),
    });
  }

  it("returns all catalog items", () => {
    const service = createService();
    const result = service.search({});
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("searches by query string", () => {
    const service = createService();
    const result = service.search({ q: "weather" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skillId).toBe("weather-skill");
  });

  it("filters by category", () => {
    const service = createService();
    const result = service.search({ category: "communication" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].skillId).toBe("email-skill");
  });

  it("filters by source ID", () => {
    const service = createService();
    const result = service.search({ sourceId: "src-1" });
    expect(result.items).toHaveLength(3);
  });

  it("paginates results", () => {
    const service = createService();
    const page1 = service.search({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    const page2 = service.search({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("orders by trust score descending", () => {
    const service = createService();
    const result = service.search({});
    const scores = result.items.map((i) => i.trustScore);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]);
  });

  it("maps manifest fields to catalog item", () => {
    const service = createService();
    const result = service.search({ q: "weather" });
    const item = result.items[0];
    expect(item.skillName).toBe("Weather Lookup");
    expect(item.publisher).toBe("Friday Labs");
    expect(item.signatureValid).toBe(true);
    expect(item.trustScore).toBe(90);
  });
});
