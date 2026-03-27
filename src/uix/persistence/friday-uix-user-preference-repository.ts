import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";

import type {
  FridayUserPreference,
  FridayUserPreferenceCategory,
  FridayUserPreferenceRow,
  JsonValue,
} from "../model/friday-uix.types.js";

export interface FridayUixUserPreferenceRepository {
  listByPrincipal(
    db: Database.Database,
    input: {
      principalId: string;
      category?: FridayUserPreferenceCategory;
    },
  ): FridayUserPreference[];
  getById(db: Database.Database, input: {
    principalId: string;
    preferenceId: string;
  }): FridayUserPreference | null;
  upsert(db: Database.Database, input: {
    id: string;
    principalId: string;
    category: FridayUserPreferenceCategory;
    key: string;
    value: JsonValue;
    source: "explicit" | "implicit";
    confidence: number;
    nowIso: string;
  }): FridayUserPreference;
  deleteById(db: Database.Database, input: {
    principalId: string;
    preferenceId: string;
  }): boolean;
}

function mapRow(row: FridayUserPreferenceRow): FridayUserPreference {
  return {
    id: row.id,
    principalId: row.principal_id,
    category: row.category as FridayUserPreferenceCategory,
    key: row.key,
    value: safeJsonParse<JsonValue>(row.value_json) as JsonValue,
    source: row.source as "explicit" | "implicit",
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayUixUserPreferenceRepository(): FridayUixUserPreferenceRepository {
  return {
    listByPrincipal(db, input) {
      const rows = input.category
        ? db.prepare(
          `SELECT * FROM uix_user_preferences
           WHERE principal_id = ? AND category = ?
           ORDER BY category ASC, key ASC`,
        ).all(input.principalId, input.category) as FridayUserPreferenceRow[]
        : db.prepare(
          `SELECT * FROM uix_user_preferences
           WHERE principal_id = ?
           ORDER BY category ASC, key ASC`,
        ).all(input.principalId) as FridayUserPreferenceRow[];
      return rows.map(mapRow);
    },

    getById(db, input) {
      const row = db.prepare(
        `SELECT * FROM uix_user_preferences
         WHERE principal_id = ? AND id = ?`,
      ).get(input.principalId, input.preferenceId) as FridayUserPreferenceRow | undefined;
      return row ? mapRow(row) : null;
    },

    upsert(db, input) {
      const existing = db.prepare(
        `SELECT id, created_at
         FROM uix_user_preferences
         WHERE principal_id = ? AND category = ? AND key = ?`,
      ).get(input.principalId, input.category, input.key) as {
        id: string;
        created_at: string;
      } | undefined;

      const id = existing?.id ?? input.id;
      const createdAt = existing?.created_at ?? input.nowIso;
      db.prepare(
        `INSERT INTO uix_user_preferences (
           id,
           principal_id,
           category,
           key,
           value_json,
           source,
           confidence,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal_id, category, key) DO UPDATE SET
           value_json = excluded.value_json,
           source = excluded.source,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      ).run(
        id,
        input.principalId,
        input.category,
        input.key,
        JSON.stringify(input.value),
        input.source,
        input.confidence,
        createdAt,
        input.nowIso,
      );

      const row = db.prepare(
        `SELECT * FROM uix_user_preferences WHERE id = ?`,
      ).get(id) as FridayUserPreferenceRow;
      return mapRow(row);
    },

    deleteById(db, input) {
      const result = db.prepare(
        `DELETE FROM uix_user_preferences
         WHERE principal_id = ? AND id = ?`,
      ).run(input.principalId, input.preferenceId);
      return result.changes > 0;
    },
  };
}
