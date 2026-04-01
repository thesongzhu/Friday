import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";

import type {
  FridayAuthProfile,
  FridayAuthProfileRow,
  FridayProviderKeySource,
} from "../model/friday-provider.types.js";

export interface FridayAuthProfileRepository {
  listByProviderProfileId(
    db: Database.Database,
    providerProfileId: string,
  ): FridayAuthProfile[];

  getByProviderProfileIdAndKey(
    db: Database.Database,
    providerProfileId: string,
    profileKey: string,
  ): FridayAuthProfile | null;

  getActiveByProviderProfileId(
    db: Database.Database,
    providerProfileId: string,
  ): FridayAuthProfile | null;

  upsert(
    db: Database.Database,
    profile: FridayAuthProfile,
  ): void;

  deleteByProviderProfileId(
    db: Database.Database,
    providerProfileId: string,
  ): number;
}

function rowToAuthProfile(row: FridayAuthProfileRow): FridayAuthProfile {
  const keySource = safeJsonParse<FridayProviderKeySource>(row.key_source_json) ?? { kind: "none" };
  const metadata = safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? {};

  return {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    providerKind: row.provider_kind as FridayAuthProfile["providerKind"],
    profileKey: row.profile_key,
    label: row.display_label,
    authMode: row.auth_mode as FridayAuthProfile["authMode"],
    keySource,
    oauthProvider: row.oauth_provider as FridayAuthProfile["oauthProvider"] | undefined,
    isActive: row.is_active === 1,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayAuthProfileRepository(): FridayAuthProfileRepository {
  return {
    listByProviderProfileId(db, providerProfileId) {
      const rows = db.prepare(
        `SELECT * FROM auth_profiles
         WHERE provider_profile_id = ?
         ORDER BY is_active DESC, updated_at DESC, profile_key ASC`,
      ).all(providerProfileId) as FridayAuthProfileRow[];
      return rows.map(rowToAuthProfile);
    },

    getByProviderProfileIdAndKey(db, providerProfileId, profileKey) {
      const row = db.prepare(
        `SELECT * FROM auth_profiles
         WHERE provider_profile_id = ? AND profile_key = ?`,
      ).get(providerProfileId, profileKey) as FridayAuthProfileRow | undefined;
      return row ? rowToAuthProfile(row) : null;
    },

    getActiveByProviderProfileId(db, providerProfileId) {
      const row = db.prepare(
        `SELECT * FROM auth_profiles
         WHERE provider_profile_id = ? AND is_active = 1
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(providerProfileId) as FridayAuthProfileRow | undefined;
      return row ? rowToAuthProfile(row) : null;
    },

    upsert(db, profile) {
      db.prepare(
        `INSERT INTO auth_profiles
           (id, provider_profile_id, provider_kind, profile_key, display_label,
            auth_mode, key_source_json, oauth_provider, is_active, metadata_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_profile_id, profile_key)
         DO UPDATE SET
           provider_kind = excluded.provider_kind,
           display_label = excluded.display_label,
           auth_mode = excluded.auth_mode,
           key_source_json = excluded.key_source_json,
           oauth_provider = excluded.oauth_provider,
           is_active = excluded.is_active,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      ).run(
        profile.id,
        profile.providerProfileId,
        profile.providerKind,
        profile.profileKey,
        profile.label,
        profile.authMode,
        JSON.stringify(profile.keySource),
        profile.oauthProvider ?? null,
        profile.isActive ? 1 : 0,
        JSON.stringify(profile.metadata),
        profile.createdAt,
        profile.updatedAt,
      );
    },

    deleteByProviderProfileId(db, providerProfileId) {
      const result = db.prepare(
        "DELETE FROM auth_profiles WHERE provider_profile_id = ?",
      ).run(providerProfileId);
      return result.changes;
    },
  };
}
