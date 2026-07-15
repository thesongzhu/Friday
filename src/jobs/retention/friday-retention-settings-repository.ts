import type Database from "better-sqlite3";

/**
 * Owner-scoped persistence for per-content-category retention SETTINGS
 * (RETENTION-R3a). Every query is scoped by `principal_id`; a row's existence
 * means the owner enabled a time-based sweep for that content category with
 * `after_days = N` (N a positive integer, enforced by the table `CHECK`). The
 * ABSENCE of a row is the clean disabled state = PERMANENT ("off") — there is
 * NO sentinel number.
 *
 * Mirrors the owner-scoping shape of `uix_user_preferences`
 * (friday-uix-user-preference-repository.ts): principal-scoped reads/writes,
 * unique `(principal_id, content_category)`, upsert-on-conflict.
 */
export interface FridayRetentionSettingOverride {
  readonly contentCategory: string;
  readonly afterDays: number;
}

interface FridayRetentionSettingRow {
  content_category: string;
  after_days: number;
}

export interface FridayRetentionSettingsRepository {
  /** All enabled (after_days) overrides for one owner. Absent categories = permanent. */
  listByPrincipal(
    db: Database.Database,
    input: { principalId: string },
  ): FridayRetentionSettingOverride[];
  /**
   * Enable a time-based sweep for one content category (upsert). `days` MUST be
   * a positive integer; the table CHECK rejects anything else fail-closed.
   */
  upsertAfterDays(
    db: Database.Database,
    input: {
      id: string;
      principalId: string;
      contentCategory: string;
      days: number;
      nowIso: string;
    },
  ): void;
  /**
   * Remove the override for one content category, returning it to the clean
   * disabled state = PERMANENT ("off"). Idempotent.
   */
  deleteCategory(
    db: Database.Database,
    input: { principalId: string; contentCategory: string },
  ): boolean;
}

export function createFridayRetentionSettingsRepository(): FridayRetentionSettingsRepository {
  return {
    listByPrincipal(db, input) {
      const rows = db
        .prepare(
          `SELECT content_category, after_days
             FROM friday_retention_settings
            WHERE principal_id = ?
            ORDER BY content_category ASC`,
        )
        .all(input.principalId) as FridayRetentionSettingRow[];
      return rows.map((row) => ({
        contentCategory: row.content_category,
        afterDays: row.after_days,
      }));
    },

    upsertAfterDays(db, input) {
      const existing = db
        .prepare(
          `SELECT id, created_at
             FROM friday_retention_settings
            WHERE principal_id = ? AND content_category = ?`,
        )
        .get(input.principalId, input.contentCategory) as
        | { id: string; created_at: string }
        | undefined;

      const id = existing?.id ?? input.id;
      const createdAt = existing?.created_at ?? input.nowIso;
      db.prepare(
        `INSERT INTO friday_retention_settings (
           id,
           principal_id,
           content_category,
           after_days,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal_id, content_category) DO UPDATE SET
           after_days = excluded.after_days,
           updated_at = excluded.updated_at`,
      ).run(
        id,
        input.principalId,
        input.contentCategory,
        input.days,
        createdAt,
        input.nowIso,
      );
    },

    deleteCategory(db, input) {
      const result = db
        .prepare(
          `DELETE FROM friday_retention_settings
            WHERE principal_id = ? AND content_category = ?`,
        )
        .run(input.principalId, input.contentCategory);
      return result.changes > 0;
    },
  };
}
