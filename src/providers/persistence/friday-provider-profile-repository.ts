import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";

import type {
  FridayProviderConfigJson,
  FridayProviderProfile,
  FridayProviderProfileRow,
} from "../model/friday-provider.types.js";
import { getFridayProviderPreset } from "../model/friday-provider-catalog.js";

// ─── Repository interface ───

export interface FridayProviderProfileRepository {
  list(db: Database.Database): FridayProviderProfile[];
  getById(db: Database.Database, id: string): FridayProviderProfile | null;
  insert(db: Database.Database, profile: FridayProviderProfile): void;
  update(db: Database.Database, profile: FridayProviderProfile): void;
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
  };

  return {
    id: row.id,
    kind: row.kind as FridayProviderProfile["kind"],
    name: row.display_name,
    baseUrl: row.endpoint_url ?? "",
    enabled: row.enabled === 1,
    defaultModel: row.default_model ?? undefined,
    config: normalizedConfig,
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
      db.prepare(
        `INSERT INTO provider_profiles
         (id, kind, display_name, endpoint_url, enabled, default_model, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        profile.id,
        profile.kind,
        profile.name,
        profile.baseUrl || null,
        profile.enabled ? 1 : 0,
        profile.defaultModel ?? null,
        JSON.stringify(profile.config),
        profile.createdAt,
        profile.updatedAt,
      );
    },

    update(db, profile) {
      db.prepare(
        `UPDATE provider_profiles
         SET kind = ?, display_name = ?, endpoint_url = ?, enabled = ?,
             default_model = ?, config_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        profile.kind,
        profile.name,
        profile.baseUrl || null,
        profile.enabled ? 1 : 0,
        profile.defaultModel ?? null,
        JSON.stringify(profile.config),
        profile.updatedAt,
        profile.id,
      );
    },

    deleteById(db, id) {
      const result = db
        .prepare("DELETE FROM provider_profiles WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },
  };
}
