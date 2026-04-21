import type Database from "better-sqlite3";
import {
  defaultFridayProviderUpgradeFields,
  type FridayProviderCanaryStats,
  type FridayProviderUpgradeFields,
  type FridayProviderUpgradePatch,
  mergeFridayProviderUpgradeFields,
} from "../model/friday-provider-upgrade.types.js";
import { safeJsonParse } from "#utilities";

import type {
  FridayProviderConfigJson,
  FridayProviderProfile,
  FridayProviderProfileRow,
} from "../model/friday-provider.types.js";
import { normalizeFridayProviderSupportedModels } from "../model/friday-provider.types.js";
import { getFridayProviderPreset } from "../model/friday-provider-catalog.js";

// ─── Repository interface ───

export interface FridayProviderProfileRepository {
  list(db: Database.Database): FridayProviderProfile[];
  getById(db: Database.Database, id: string): FridayProviderProfile | null;
  insert(db: Database.Database, profile: FridayProviderProfile): void;
  update(db: Database.Database, profile: FridayProviderProfile): void;
  setUpgradeMetadata(db: Database.Database, id: string, patch: FridayProviderUpgradePatch, nowIso: string): FridayProviderProfile | null;
  deleteById(db: Database.Database, id: string): boolean;
}

// ─── Row ↔ Entity mapping ───

function rowToProfile(row: FridayProviderProfileRow): FridayProviderProfile {
  const preset = getFridayProviderPreset(row.kind as FridayProviderProfile["kind"], row.endpoint_url ?? "");
  const config: FridayProviderConfigJson = safeJsonParse<FridayProviderConfigJson>(row.config_json)
    ?? {
        api: preset.api,
        authMode: preset.authMode,
        backendKind: preset.backendKind,
        deploymentKind: preset.deploymentKind,
        regionTag: preset.regionTag,
        keySource: { kind: "none" },
        supportedModels: [],
      };
  const normalizedConfig: FridayProviderConfigJson = {
    ...config,
    api: config.api ?? preset.api,
    authMode: config.authMode ?? preset.authMode,
    backendKind: config.backendKind ?? preset.backendKind,
    deploymentKind: config.deploymentKind ?? preset.deploymentKind,
    regionTag: config.regionTag ?? preset.regionTag,
    keySource: config.keySource ?? { kind: "none" },
    supportedModels: normalizeFridayProviderSupportedModels(config.supportedModels),
  };
  const canaryStats = safeJsonParse<FridayProviderCanaryStats>(row.canary_stats_json);
  const upgradeDefaults = defaultFridayProviderUpgradeFields();

  return {
    id: row.id,
    kind: row.kind as FridayProviderProfile["kind"],
    name: row.display_name,
    baseUrl: row.endpoint_url ?? "",
    enabled: row.enabled === 1,
    defaultModel: row.default_model ?? undefined,
    config: normalizedConfig,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    lastVerifiedRuntimeVersion: row.last_verified_runtime_version ?? undefined,
    lastVerifiedProviderModel: row.last_verified_provider_model ?? undefined,
    compatibilityStatus: (row.compatibility_status as FridayProviderUpgradeFields["compatibilityStatus"] | undefined)
      ?? upgradeDefaults.compatibilityStatus,
    promotionChannel: (row.promotion_channel as FridayProviderUpgradeFields["promotionChannel"] | undefined)
      ?? upgradeDefaults.promotionChannel,
    shadowVersionId: row.shadow_version_id ?? undefined,
    canaryStats: canaryStats && Object.keys(canaryStats).length > 0 ? canaryStats : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayProviderProfileRepository(): FridayProviderProfileRepository {
  return {
    list(db) {
      const rows = db
        .prepare("SELECT * FROM provider_profiles ORDER BY created_at ASC")
        .all() as FridayProviderProfileRow[];
      return rows.map(rowToProfile);
    },

    getById(db, id) {
      const row = db
        .prepare("SELECT * FROM provider_profiles WHERE id = ?")
        .get(id) as FridayProviderProfileRow | undefined;
      return row ? rowToProfile(row) : null;
    },

    insert(db, profile) {
      const upgrade = mergeFridayProviderUpgradeFields(profile, {});
      db.prepare(
        `INSERT INTO provider_profiles
         (id, kind, display_name, endpoint_url, enabled, default_model, config_json,
          last_verified_at, last_verified_runtime_version, last_verified_provider_model,
          compatibility_status, promotion_channel, shadow_version_id, canary_stats_json,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        profile.id,
        profile.kind,
        profile.name,
        profile.baseUrl || null,
        profile.enabled ? 1 : 0,
        profile.defaultModel ?? null,
        JSON.stringify(profile.config),
        upgrade.lastVerifiedAt ?? null,
        upgrade.lastVerifiedRuntimeVersion ?? null,
        upgrade.lastVerifiedProviderModel ?? null,
        upgrade.compatibilityStatus,
        upgrade.promotionChannel,
        upgrade.shadowVersionId ?? null,
        JSON.stringify(upgrade.canaryStats ?? {}),
        profile.createdAt,
        profile.updatedAt,
      );
    },

    update(db, profile) {
      const upgrade = mergeFridayProviderUpgradeFields(profile, {});
      db.prepare(
        `UPDATE provider_profiles
         SET kind = ?, display_name = ?, endpoint_url = ?, enabled = ?,
             default_model = ?, config_json = ?, last_verified_at = ?,
             last_verified_runtime_version = ?, last_verified_provider_model = ?,
             compatibility_status = ?, promotion_channel = ?, shadow_version_id = ?,
             canary_stats_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        profile.kind,
        profile.name,
        profile.baseUrl || null,
        profile.enabled ? 1 : 0,
        profile.defaultModel ?? null,
        JSON.stringify(profile.config),
        upgrade.lastVerifiedAt ?? null,
        upgrade.lastVerifiedRuntimeVersion ?? null,
        upgrade.lastVerifiedProviderModel ?? null,
        upgrade.compatibilityStatus,
        upgrade.promotionChannel,
        upgrade.shadowVersionId ?? null,
        JSON.stringify(upgrade.canaryStats ?? {}),
        profile.updatedAt,
        profile.id,
      );
    },

    setUpgradeMetadata(db, id, patch, nowIso) {
      const existing = this.getById(db, id);
      if (!existing) {
        return null;
      }
      const merged = mergeFridayProviderUpgradeFields(existing, patch);
      db.prepare(
        `UPDATE provider_profiles
         SET last_verified_at = ?,
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
        id,
      );
      return this.getById(db, id);
    },

    deleteById(db, id) {
      const result = db
        .prepare("DELETE FROM provider_profiles WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },
  };
}
