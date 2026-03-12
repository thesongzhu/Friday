import type Database from "better-sqlite3";
import type {
  FridayMarketplaceSourceCreateInput,
  FridayMarketplaceSourceEntity,
  FridayMarketplaceSourcePatchInput,
  FridayMarketplaceSourceRow,
  FridayMarketplaceTrustPolicy,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridayMarketplaceSourceRepository {
  insertSource(
    db: Database.Database,
    id: UUID,
    input: FridayMarketplaceSourceCreateInput,
    nowIso: string,
  ): FridayMarketplaceSourceEntity;

  getSourceById(
    db: Database.Database,
    id: UUID,
  ): FridayMarketplaceSourceEntity | null;

  listSources(
    db: Database.Database,
    enabledOnly?: boolean,
  ): FridayMarketplaceSourceEntity[];

  updateSource(
    db: Database.Database,
    id: UUID,
    patch: FridayMarketplaceSourcePatchInput,
    nowIso: string,
  ): FridayMarketplaceSourceEntity;

  setEnabled(
    db: Database.Database,
    id: UUID,
    enabled: boolean,
    nowIso: string,
  ): void;

  deleteSource(db: Database.Database, id: UUID): void;
}

// ─── Row Mapper ───

function mapRow(row: FridayMarketplaceSourceRow): FridayMarketplaceSourceEntity {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    trustPolicy: row.trust_policy as FridayMarketplaceTrustPolicy,
    pinnedKeyIds: JSON.parse(row.pinned_key_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayMarketplaceSourceRepository(): FridayMarketplaceSourceRepository {
  return {
    insertSource(db, id, input, nowIso) {
      db.prepare(
        `INSERT INTO marketplace_sources (id, name, base_url, enabled, trust_policy, pinned_key_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        id,
        input.name,
        input.baseUrl,
        input.trustPolicy,
        JSON.stringify(input.pinnedKeyIds),
        nowIso,
        nowIso,
      );

      return mapRow(
        db.prepare("SELECT * FROM marketplace_sources WHERE id = ?").get(id) as FridayMarketplaceSourceRow,
      );
    },

    getSourceById(db, id) {
      const row = db
        .prepare("SELECT * FROM marketplace_sources WHERE id = ?")
        .get(id) as FridayMarketplaceSourceRow | undefined;
      return row ? mapRow(row) : null;
    },

    listSources(db, enabledOnly) {
      const sql = enabledOnly
        ? "SELECT * FROM marketplace_sources WHERE enabled = 1 ORDER BY name"
        : "SELECT * FROM marketplace_sources ORDER BY name";
      const rows = db.prepare(sql).all() as FridayMarketplaceSourceRow[];
      return rows.map(mapRow);
    },

    updateSource(db, id, patch, nowIso) {
      db.prepare(
        `UPDATE marketplace_sources SET
         name = COALESCE(?, name),
         base_url = COALESCE(?, base_url),
         enabled = COALESCE(?, enabled),
         trust_policy = COALESCE(?, trust_policy),
         pinned_key_ids_json = COALESCE(?, pinned_key_ids_json),
         updated_at = ?
         WHERE id = ?`,
      ).run(
        patch.name ?? null,
        patch.baseUrl ?? null,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : null,
        patch.trustPolicy ?? null,
        patch.pinnedKeyIds ? JSON.stringify(patch.pinnedKeyIds) : null,
        nowIso,
        id,
      );

      return mapRow(
        db.prepare("SELECT * FROM marketplace_sources WHERE id = ?").get(id) as FridayMarketplaceSourceRow,
      );
    },

    setEnabled(db, id, enabled, nowIso) {
      db.prepare(
        "UPDATE marketplace_sources SET enabled = ?, updated_at = ? WHERE id = ?",
      ).run(enabled ? 1 : 0, nowIso, id);
    },

    deleteSource(db, id) {
      db.prepare("DELETE FROM marketplace_cache WHERE source_id = ?").run(id);
      db.prepare("DELETE FROM marketplace_sources WHERE id = ?").run(id);
    },
  };
}
