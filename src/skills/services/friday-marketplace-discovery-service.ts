import type { FridaySqliteLayer } from "#state";
import type { FridayMarketplaceCacheRepository } from "../persistence/friday-marketplace-cache-repository.js";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridayMarketplaceCacheEntity,
  FridaySkillCatalogItem,
  FridaySkillCatalogQuery,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceDiscoveryService {
  search(query: FridaySkillCatalogQuery): FridaySkillCatalogResult;
}

export interface FridaySkillCatalogResult {
  items: FridaySkillCatalogItem[];
  nextCursor?: string;
  total: number;
}

// ─── Dependencies ───

export interface CreateMarketplaceDiscoveryServiceDeps {
  db: FridaySqliteLayer;
  cacheRepo: FridayMarketplaceCacheRepository;
}

// ─── Factory ───

export function createFridayMarketplaceDiscoveryService(
  deps: CreateMarketplaceDiscoveryServiceDeps,
): FridayMarketplaceDiscoveryService {
  function cacheEntityToCatalogItem(entity: FridayMarketplaceCacheEntity): FridaySkillCatalogItem {
    // SAFETY: manifestJson is stored as JSON in DB, always a SkillManifestV2 when read from cache entity
    const manifest = entity.manifestJson as unknown as SkillManifestV2;
    return {
      sourceId: entity.sourceId,
      skillId: entity.skillId,
      skillName: manifest?.name ?? entity.skillId,
      publisher: manifest?.author?.name,
      version: entity.version,
      category: manifest?.category,
      releasedAt: entity.indexedAt,
      signatureValid: entity.signatureValid,
      trustScore: entity.trustScore,
      starter: (manifest?.tags ?? []).includes("starter"),
      manifest,
    };
  }

  return {
    search(query) {
      const limit = query.limit ?? 50;
      const entities = deps.db.withReadConnection((conn) =>
        deps.cacheRepo.listCatalog(conn, { ...query, limit: limit + 1 }),
      );

      const hasMore = entities.length > limit;
      const items = (hasMore ? entities.slice(0, limit) : entities).map(cacheEntityToCatalogItem);

      const offset = query.cursor ? parseInt(query.cursor, 10) : 0;
      const nextCursor = hasMore ? String(offset + limit) : undefined;

      return {
        items,
        nextCursor,
        total: items.length,
      };
    },
  };
}
