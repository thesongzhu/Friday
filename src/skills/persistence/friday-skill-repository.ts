import type Database from "better-sqlite3";
import {
  defaultFridayAutonomyUpgradeFields,
  type FridayAutonomyCanaryStats,
  type FridayAutonomyUpgradeFields,
  type FridayAutonomyUpgradePatch,
  mergeFridayAutonomyUpgradeFields,
} from "../../autonomy/model/friday-autonomy-upgrade.types.js";
import { safeJsonParse } from "#utilities";
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

  setUpgradeMetadata(
    db: Database.Database,
    skillId: string,
    patch: FridayAutonomyUpgradePatch,
    nowIso: string,
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
  const canaryStats = safeJsonParse<FridayAutonomyCanaryStats>(row.canary_stats_json);
  const upgradeDefaults = defaultFridayAutonomyUpgradeFields();
  return {
    id: row.id,
    name: row.name,
    source: row.source as SkillSource,
    origin: row.origin as SkillOrigin,
    publisher: row.publisher ?? undefined,
    latestVersion: row.latest_version ?? undefined,
    installedVersion: row.installed_version ?? undefined,
    status: row.status as SkillLifecycleStatus,
    currentManifest: safeJsonParse<SkillManifestV2>(row.current_manifest_json),
    lastVerifiedAt: row.last_verified_at ?? undefined,
    lastVerifiedRuntimeVersion: row.last_verified_runtime_version ?? undefined,
    lastVerifiedProviderModel: row.last_verified_provider_model ?? undefined,
    compatibilityStatus: (row.compatibility_status as FridayAutonomyUpgradeFields["compatibilityStatus"] | undefined)
      ?? upgradeDefaults.compatibilityStatus,
    promotionChannel: (row.promotion_channel as FridayAutonomyUpgradeFields["promotionChannel"] | undefined)
      ?? upgradeDefaults.promotionChannel,
    shadowVersionId: row.shadow_version_id ?? undefined,
    canaryStats: canaryStats && Object.keys(canaryStats).length > 0 ? canaryStats : undefined,
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

    setUpgradeMetadata(db, skillId, patch, nowIso) {
      const existing = this.getSkillById(db, skillId);
      if (!existing) {
        return null;
      }
      const merged = mergeFridayAutonomyUpgradeFields(existing, patch);
      db.prepare(
        `UPDATE skills SET
         last_verified_at = ?,
         last_verified_runtime_version = ?,
         last_verified_provider_model = ?,
         compatibility_status = ?,
         promotion_channel = ?,
         shadow_version_id = ?,
         canary_stats_json = ?,
         updated_at = ?
         WHERE id = ?`,
      ).run(
        merged.lastVerifiedAt ?? null,
        merged.lastVerifiedRuntimeVersion ?? null,
        merged.lastVerifiedProviderModel ?? null,
        merged.compatibilityStatus,
        merged.promotionChannel,
        merged.shadowVersionId ?? null,
        JSON.stringify(merged.canaryStats ?? {}),
        nowIso,
        skillId,
      );
      return this.getSkillById(db, skillId);
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
