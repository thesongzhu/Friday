import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayMarketplaceCacheRepository,
  createFridayMarketplaceSourceRepository,
  createFridayMarketplaceSourceService,
} from "#skills";
import { createTestDb, EARLIER, NOW } from "./marketplace.helper.js";

describe("FridayMarketplaceSourceService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("builds source views with trust and cache health summaries", () => {
    const sourceRepo = createFridayMarketplaceSourceRepository();
    const cacheRepo = createFridayMarketplaceCacheRepository();

    db.withWriteTransaction((conn) => {
      sourceRepo.insertSource(conn, "src-1", {
        name: "Main",
        baseUrl: "https://marketplace.example.com",
        trustPolicy: "strict",
        pinnedKeyIds: ["key-1"],
      }, NOW);

      cacheRepo.upsertCacheEntry(conn, {
        id: "cache-1",
        sourceId: "src-1",
        skillId: "skill.alpha",
        version: "1.0.0",
        manifestJson: JSON.stringify({ id: "skill.alpha", name: "Alpha" }),
        signatureValid: true,
        indexedAt: NOW,
        trustScore: 95,
        nowIso: NOW,
      });
      cacheRepo.upsertCacheEntry(conn, {
        id: "cache-2",
        sourceId: "src-1",
        skillId: "skill.beta",
        version: "1.0.0",
        manifestJson: JSON.stringify({ id: "skill.beta", name: "Beta" }),
        signatureValid: false,
        indexedAt: EARLIER,
        trustScore: 55,
        nowIso: NOW,
      });
    });

    const service = createFridayMarketplaceSourceService({
      db,
      sourceRepo,
      cacheRepo,
      idGenerator: () => "generated-source-id",
      nowIso: () => NOW,
    });

    const view = service.getSourceView("src-1");
    expect(view).toMatchObject({
      id: "src-1",
      trustSummary: {
        policy: "strict",
        pinnedKeyCount: 1,
        pinned: true,
      },
      catalogSummary: {
        cachedSkillCount: 2,
        cachedVersionCount: 2,
        verifiedVersionCount: 1,
        unsignedVersionCount: 1,
        stale: false,
      },
      healthSummary: {
        status: "warning",
      },
    });
    expect(view?.healthSummary.reasons).toContain("1 cached version(s) are unsigned.");
    expect(service.listSourceViews()).toHaveLength(1);
  });
});
