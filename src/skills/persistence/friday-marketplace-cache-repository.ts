import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayMarketplaceCacheEntity,
  FridayMarketplaceCacheRow,
  FridaySkillCatalogQuery,
  JsonValue,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceCacheRepository {
  upsertCacheEntry(
    db: Database.Database,
    entry: {
      id: UUID;
      sourceId: UUID;
      skillId: string;
      version: string;
      manifestJson: string;
      signatureValid: boolean;
      indexedAt: string;
      trustScore: number;
      nowIso: string;
    },
  ): void;

  upsertCacheBatch(
    db: Database.Database,
    entries: Array<{
      id: UUID;
      sourceId: UUID;
      skillId: string;
      version: string;
      manifestJson: string;
      signatureValid: boolean;
      indexedAt: string;
      trustScore: number;
      nowIso: string;
    }>,
  ): number;

  getCachedVersion(
    db: Database.Database,
    sourceId: UUID,
    skillId: string,
    version: string,
  ): FridayMarketplaceCacheEntity | null;

  listCatalog(
    db: Database.Database,
    query: FridaySkillCatalogQuery,
  ): FridayMarketplaceCacheEntity[];

  listStaleSourceIds(
    db: Database.Database,
    staleCutoff: string,
  ): string[];

  summarizeSource(
    db: Database.Database,
    sourceId: UUID,
    staleCutoff: string,
  ): {
    cachedSkillCount: number;
    cachedVersionCount: number;
    verifiedVersionCount: number;
    unsignedVersionCount: number;
    latestIndexedAt?: string;
    stale: boolean;
  };

  deleteBySourceId(db: Database.Database, sourceId: UUID): number;

  pruneOlderThan(db: Database.Database, cutoff: string): number;
}

// ─── Row Mapper ───

function mapRow(row: FridayMarketplaceCacheRow): FridayMarketplaceCacheEntity {
  return {
    id: row.id,
    sourceId: row.source_id,
    skillId: row.skill_id,
    version: row.version,
    manifestJson: safeJsonParse<JsonValue>(row.manifest_json) as JsonValue,
    signatureValid: row.signature_valid === 1,
    indexedAt: row.indexed_at,
    trustScore: row.trust_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayMarketplaceCacheRepository(): FridayMarketplaceCacheRepository {
  return {
    upsertCacheEntry(db, entry) {
      db.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, skill_id, version) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           signature_valid = excluded.signature_valid,
           indexed_at = excluded.indexed_at,
           trust_score = excluded.trust_score,
           updated_at = excluded.updated_at`,
      ).run(
        entry.id,
        entry.sourceId,
        entry.skillId,
        entry.version,
        entry.manifestJson,
        entry.signatureValid ? 1 : 0,
        entry.indexedAt,
        entry.trustScore,
        entry.nowIso,
        entry.nowIso,
      );
    },

    upsertCacheBatch(db, entries) {
      const stmt = db.prepare(
        `INSERT INTO marketplace_cache (id, source_id, skill_id, version, manifest_json, signature_valid, indexed_at, trust_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, skill_id, version) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           signature_valid = excluded.signature_valid,
           indexed_at = excluded.indexed_at,
           trust_score = excluded.trust_score,
           updated_at = excluded.updated_at`,
      );

      let count = 0;
      for (const entry of entries) {
        stmt.run(
          entry.id,
          entry.sourceId,
          entry.skillId,
          entry.version,
          entry.manifestJson,
          entry.signatureValid ? 1 : 0,
          entry.indexedAt,
          entry.trustScore,
          entry.nowIso,
          entry.nowIso,
        );
        count++;
      }
      return count;
    },

    getCachedVersion(db, sourceId, skillId, version) {
      const row = db
        .prepare(
          "SELECT * FROM marketplace_cache WHERE source_id = ? AND skill_id = ? AND version = ?",
        )
        .get(sourceId, skillId, version) as FridayMarketplaceCacheRow | undefined;
      return row ? mapRow(row) : null;
    },

    listCatalog(db, query) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.sourceId) {
        conditions.push("mc.source_id = ?");
        params.push(query.sourceId);
      }

      // Only show cache entries from enabled sources unless sourceId explicitly given
      if (!query.sourceId) {
        conditions.push("ms.enabled = 1");
      }

      if (query.q) {
        conditions.push("(mc.skill_id LIKE ? OR mc.manifest_json LIKE ?)");
        const pattern = `%${query.q}%`;
        params.push(pattern, pattern);
      }

      if (query.category) {
        conditions.push("mc.manifest_json LIKE ?");
        params.push(`%"category":"${query.category}"%`);
      }

      const limit = query.limit ?? 50;
      const offset = query.cursor ? parseInt(query.cursor, 10) : 0;

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `SELECT mc.* FROM marketplace_cache mc
        JOIN marketplace_sources ms ON ms.id = mc.source_id
        ${whereClause}
        ORDER BY mc.trust_score DESC, mc.indexed_at DESC
        LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as FridayMarketplaceCacheRow[];
      return rows.map(mapRow);
    },

    listStaleSourceIds(db, staleCutoff) {
      const rows = db
        .prepare(
          `SELECT DISTINCT source_id FROM marketplace_cache
           WHERE indexed_at < ?`,
        )
        .all(staleCutoff) as Array<{ source_id: string }>;
      return rows.map((r) => r.source_id);
    },

    summarizeSource(db, sourceId, staleCutoff) {
      const row = db.prepare(
        `SELECT
           COUNT(*) AS cached_version_count,
           COUNT(DISTINCT skill_id) AS cached_skill_count,
           SUM(CASE WHEN signature_valid = 1 THEN 1 ELSE 0 END) AS verified_version_count,
           MAX(indexed_at) AS latest_indexed_at
         FROM marketplace_cache
         WHERE source_id = ?`,
      ).get(sourceId) as {
        cached_version_count: number;
        cached_skill_count: number;
        verified_version_count: number | null;
        latest_indexed_at: string | null;
      };

      const cachedVersionCount = Number(row.cached_version_count ?? 0);
      const verifiedVersionCount = Number(row.verified_version_count ?? 0);
      const latestIndexedAt = row.latest_indexed_at ?? undefined;

      return {
        cachedSkillCount: Number(row.cached_skill_count ?? 0),
        cachedVersionCount,
        verifiedVersionCount,
        unsignedVersionCount: Math.max(0, cachedVersionCount - verifiedVersionCount),
        latestIndexedAt,
        stale: latestIndexedAt ? latestIndexedAt < staleCutoff : false,
      };
    },

    deleteBySourceId(db, sourceId) {
      return db
        .prepare("DELETE FROM marketplace_cache WHERE source_id = ?")
        .run(sourceId).changes;
    },

    pruneOlderThan(db, cutoff) {
      return db
        .prepare("DELETE FROM marketplace_cache WHERE indexed_at < ?")
        .run(cutoff).changes;
    },
  };
}
