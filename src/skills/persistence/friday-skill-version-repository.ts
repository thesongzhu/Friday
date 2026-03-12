import type Database from "better-sqlite3";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type {
  FridayMarketplaceSignatureAlgorithm,
  FridaySkillSignature,
  FridaySkillVersionEntity,
  FridaySkillVersionRow,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillVersionRepository {
  upsertVersion(
    db: Database.Database,
    input: {
      id: UUID;
      skillId: string;
      version: string;
      checksum: string;
      packageUrl?: string;
      signature?: FridaySkillSignature;
      manifest: SkillManifestV2;
      releasedAt: string;
      nowIso: string;
    },
  ): FridaySkillVersionEntity;

  getVersion(
    db: Database.Database,
    skillId: string,
    version: string,
  ): FridaySkillVersionEntity | null;

  listVersions(
    db: Database.Database,
    skillId: string,
    limit?: number,
  ): FridaySkillVersionEntity[];

  listVersionsForResolution(
    db: Database.Database,
    skillId: string,
    includeYanked?: boolean,
  ): FridaySkillVersionEntity[];

  markYanked(
    db: Database.Database,
    skillId: string,
    version: string,
    nowIso: string,
  ): void;

  clearYanked(
    db: Database.Database,
    skillId: string,
    version: string,
    nowIso: string,
  ): void;

  setSignatureFields(
    db: Database.Database,
    skillId: string,
    version: string,
    signature: FridaySkillSignature,
    nowIso: string,
  ): void;
}

// ─── Row Mapper ───

function mapRow(row: FridaySkillVersionRow): FridaySkillVersionEntity {
  const signature: FridaySkillSignature | undefined =
    row.signature_key_id && row.signature_algorithm && row.signature_value
      ? {
          keyId: row.signature_key_id,
          algorithm: row.signature_algorithm as FridayMarketplaceSignatureAlgorithm,
          value: row.signature_value,
        }
      : undefined;

  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    checksum: row.checksum,
    packageUrl: row.package_url ?? undefined,
    signature,
    manifest: JSON.parse(row.manifest_json) as SkillManifestV2,
    releasedAt: row.released_at,
    yankedAt: row.yanked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridaySkillVersionRepository(): FridaySkillVersionRepository {
  return {
    upsertVersion(db, input) {
      db.prepare(
        `INSERT INTO skill_versions (id, skill_id, version, checksum, package_url, signature_key_id, signature_algorithm, signature_value, manifest_json, released_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, version) DO UPDATE SET
           checksum = excluded.checksum,
           package_url = excluded.package_url,
           signature_key_id = excluded.signature_key_id,
           signature_algorithm = excluded.signature_algorithm,
           signature_value = excluded.signature_value,
           manifest_json = excluded.manifest_json,
           released_at = excluded.released_at,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.skillId,
        input.version,
        input.checksum,
        input.packageUrl ?? null,
        input.signature?.keyId ?? null,
        input.signature?.algorithm ?? null,
        input.signature?.value ?? null,
        JSON.stringify(input.manifest),
        input.releasedAt,
        input.nowIso,
        input.nowIso,
      );

      return mapRow(
        db
          .prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?")
          .get(input.skillId, input.version) as FridaySkillVersionRow,
      );
    },

    getVersion(db, skillId, version) {
      const row = db
        .prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?")
        .get(skillId, version) as FridaySkillVersionRow | undefined;
      return row ? mapRow(row) : null;
    },

    listVersions(db, skillId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY released_at DESC LIMIT ?",
        )
        .all(skillId, limit ?? 50) as FridaySkillVersionRow[];
      return rows.map(mapRow);
    },

    listVersionsForResolution(db, skillId, includeYanked) {
      const sql = includeYanked
        ? "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY released_at DESC"
        : "SELECT * FROM skill_versions WHERE skill_id = ? AND yanked_at IS NULL ORDER BY released_at DESC";
      const rows = db.prepare(sql).all(skillId) as FridaySkillVersionRow[];
      return rows.map(mapRow);
    },

    markYanked(db, skillId, version, nowIso) {
      db.prepare(
        "UPDATE skill_versions SET yanked_at = ?, updated_at = ? WHERE skill_id = ? AND version = ?",
      ).run(nowIso, nowIso, skillId, version);
    },

    clearYanked(db, skillId, version, nowIso) {
      db.prepare(
        "UPDATE skill_versions SET yanked_at = NULL, updated_at = ? WHERE skill_id = ? AND version = ?",
      ).run(nowIso, skillId, version);
    },

    setSignatureFields(db, skillId, version, signature, nowIso) {
      db.prepare(
        `UPDATE skill_versions SET
         signature_key_id = ?,
         signature_algorithm = ?,
         signature_value = ?,
         updated_at = ?
         WHERE skill_id = ? AND version = ?`,
      ).run(
        signature.keyId,
        signature.algorithm,
        signature.value,
        nowIso,
        skillId,
        version,
      );
    },
  };
}
