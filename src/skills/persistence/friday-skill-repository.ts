import type Database from "better-sqlite3";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { SkillLifecycleStatus } from "../model/friday-skill-lifecycle.types.js";
import type { SkillOrigin, SkillSource } from "../model/friday-skill-source.types.js";
import type {
  FridaySkillEntity,
  FridaySkillRow,
  UUID,
} from "../model/friday-skill-marketplace.types.js";

// ─── Interface ───

export interface FridaySkillRepository {
  upsertSkillFromMarketplace(
    db: Database.Database,
    input: {
      id: string;
      name: string;
      source: SkillSource;
      origin: SkillOrigin;
      publisher?: string;
      latestVersion?: string;
      status: SkillLifecycleStatus;
      currentManifest?: SkillManifestV2;
      nowIso: string;
    },
  ): FridaySkillEntity;

  updateLifecycleStatus(
    db: Database.Database,
    skillId: string,
    status: SkillLifecycleStatus,
    nowIso: string,
  ): void;

  setInstalledVersion(
    db: Database.Database,
    skillId: string,
    version: string,
    manifest: SkillManifestV2,
    nowIso: string,
  ): void;

  clearInstalledVersion(
    db: Database.Database,
    skillId: string,
    nowIso: string,
  ): void;

  getSkillById(
    db: Database.Database,
    skillId: string,
  ): FridaySkillEntity | null;

  listAll(db: Database.Database): FridaySkillEntity[];

  listInstalled(db: Database.Database): FridaySkillEntity[];

  markDeleted(
    db: Database.Database,
    skillId: string,
    deletedBy: string,
    nowIso: string,
  ): void;
}

// ─── Row Mapper ───

function mapRow(row: FridaySkillRow): FridaySkillEntity {
  return {
    id: row.id,
    name: row.name,
    source: row.source as SkillSource,
    origin: row.origin as SkillOrigin,
    publisher: row.publisher ?? undefined,
    latestVersion: row.latest_version ?? undefined,
    installedVersion: row.installed_version ?? undefined,
    status: row.status as SkillLifecycleStatus,
    currentManifest: row.current_manifest_json
      ? (JSON.parse(row.current_manifest_json) as SkillManifestV2)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
  };
}

// ─── Factory ───

export function createFridaySkillRepository(): FridaySkillRepository {
  return {
    upsertSkillFromMarketplace(db, input) {
      db.prepare(
        `INSERT INTO skills (id, name, source, origin, publisher, latest_version, installed_version, status, current_manifest_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           publisher = excluded.publisher,
           latest_version = excluded.latest_version,
           status = CASE WHEN skills.installed_version IS NOT NULL THEN skills.status ELSE excluded.status END,
           current_manifest_json = CASE WHEN skills.current_manifest_json IS NOT NULL THEN skills.current_manifest_json ELSE excluded.current_manifest_json END,
           updated_at = excluded.updated_at`,
      ).run(
        input.id,
        input.name,
        input.source,
        input.origin,
        input.publisher ?? null,
        input.latestVersion ?? null,
        input.status,
        input.currentManifest ? JSON.stringify(input.currentManifest) : null,
        input.nowIso,
        input.nowIso,
      );

      return mapRow(
        db.prepare("SELECT * FROM skills WHERE id = ?").get(input.id) as FridaySkillRow,
      );
    },

    updateLifecycleStatus(db, skillId, status, nowIso) {
      db.prepare(
        "UPDATE skills SET status = ?, updated_at = ? WHERE id = ?",
      ).run(status, nowIso, skillId);
    },

    setInstalledVersion(db, skillId, version, manifest, nowIso) {
      db.prepare(
        `UPDATE skills SET
         installed_version = ?,
         status = 'installed',
         current_manifest_json = ?,
         updated_at = ?
         WHERE id = ?`,
      ).run(version, JSON.stringify(manifest), nowIso, skillId);
    },

    clearInstalledVersion(db, skillId, nowIso) {
      db.prepare(
        `UPDATE skills SET
         installed_version = NULL,
         status = 'not_installed',
         current_manifest_json = NULL,
         updated_at = ?
         WHERE id = ?`,
      ).run(nowIso, skillId);
    },

    getSkillById(db, skillId) {
      const row = db
        .prepare("SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL")
        .get(skillId) as FridaySkillRow | undefined;
      return row ? mapRow(row) : null;
    },

    listAll(db) {
      const rows = db
        .prepare("SELECT * FROM skills WHERE deleted_at IS NULL ORDER BY name")
        .all() as FridaySkillRow[];
      return rows.map(mapRow);
    },

    listInstalled(db) {
      const rows = db
        .prepare(
          "SELECT * FROM skills WHERE installed_version IS NOT NULL AND deleted_at IS NULL ORDER BY name",
        )
        .all() as FridaySkillRow[];
      return rows.map(mapRow);
    },

    markDeleted(db, skillId, deletedBy, nowIso) {
      db.prepare(
        `UPDATE skills SET
         deleted_at = ?,
         deleted_by = ?,
         installed_version = NULL,
         status = 'not_installed',
         current_manifest_json = NULL,
         updated_at = ?
         WHERE id = ?`,
      ).run(nowIso, deletedBy, nowIso, skillId);
    },
  };
}
