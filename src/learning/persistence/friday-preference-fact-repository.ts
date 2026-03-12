import type Database from "better-sqlite3";
import type {
  FridayPreferenceFactEntity,
  FridayPreferenceFactRow,
  JsonValue,
} from "../model/friday-learning.types.js";

export interface FridayPreferenceFactRepository {
  getByUserAndKey(
    db: Database.Database,
    userId: string,
    key: string,
  ): FridayPreferenceFactEntity | null;

  listByUser(
    db: Database.Database,
    userId: string,
    minConfidence?: number,
    limit?: number,
  ): FridayPreferenceFactEntity[];

  upsert(
    db: Database.Database,
    input: {
      factId: string;
      userId: string;
      key: string;
      value: JsonValue;
      confidence: number;
      evidenceCountDelta: number;
      lastConfirmedAt: string;
      sourceEventId: string;
      nowIso: string;
    },
  ): FridayPreferenceFactEntity;

  deleteByUserAndKey(
    db: Database.Database,
    userId: string,
    key: string,
  ): boolean;

  applyDecay(
    db: Database.Database,
    input: {
      userId?: string;
      nowIso: string;
      halfLifeDays: number;
      minConfidenceFloor: number;
    },
  ): number;
}

function rowToEntity(row: FridayPreferenceFactRow): FridayPreferenceFactEntity {
  return {
    factId: row.fact_id,
    userId: row.user_id,
    key: row.key,
    value: JSON.parse(row.value_json) as JsonValue,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    lastConfirmedAt: row.last_confirmed_at,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayPreferenceFactRepository(): FridayPreferenceFactRepository {
  return {
    getByUserAndKey(db, userId, key) {
      const row = db
        .prepare(
          "SELECT * FROM preference_facts WHERE user_id = ? AND key = ?",
        )
        .get(userId, key) as FridayPreferenceFactRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByUser(db, userId, minConfidence = 0, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM preference_facts
           WHERE user_id = ? AND confidence >= ?
           ORDER BY confidence DESC
           LIMIT ?`,
        )
        .all(userId, minConfidence, limit) as FridayPreferenceFactRow[];
      return rows.map(rowToEntity);
    },

    upsert(db, input) {
      const existing = db
        .prepare(
          "SELECT * FROM preference_facts WHERE user_id = ? AND key = ?",
        )
        .get(input.userId, input.key) as FridayPreferenceFactRow | undefined;

      if (existing) {
        const existingSourceIds = JSON.parse(
          existing.source_event_ids_json,
        ) as string[];
        const mergedSourceIds = existingSourceIds.includes(input.sourceEventId)
          ? existingSourceIds
          : [...existingSourceIds, input.sourceEventId].slice(-50);

        db.prepare(
          `UPDATE preference_facts
           SET value_json = ?,
               confidence = ?,
               evidence_count = evidence_count + ?,
               last_confirmed_at = ?,
               source_event_ids_json = ?,
               updated_at = ?
           WHERE user_id = ? AND key = ?`,
        ).run(
          JSON.stringify(input.value),
          input.confidence,
          input.evidenceCountDelta,
          input.lastConfirmedAt,
          JSON.stringify(mergedSourceIds),
          input.nowIso,
          input.userId,
          input.key,
        );
      } else {
        db.prepare(
          `INSERT INTO preference_facts
           (fact_id, user_id, key, value_json, confidence, evidence_count,
            last_confirmed_at, source_event_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.factId,
          input.userId,
          input.key,
          JSON.stringify(input.value),
          input.confidence,
          input.evidenceCountDelta,
          input.lastConfirmedAt,
          JSON.stringify([input.sourceEventId]),
          input.nowIso,
          input.nowIso,
        );
      }

      return this.getByUserAndKey(db, input.userId, input.key)!;
    },

    deleteByUserAndKey(db, userId, key) {
      const result = db
        .prepare("DELETE FROM preference_facts WHERE user_id = ? AND key = ?")
        .run(userId, key);
      return result.changes > 0;
    },

    applyDecay(db, input) {
      // Exponential decay: newConfidence = confidence * exp(-ln(2) * daysSinceLastConfirmed / halfLifeDays)
      // SQLite doesn't have exp(), so we compute in JS
      const userFilter = input.userId ? " AND user_id = ?" : "";
      const params: unknown[] = input.userId ? [input.userId] : [];

      const rows = db
        .prepare(
          `SELECT * FROM preference_facts WHERE 1=1${userFilter}`,
        )
        .all(...params) as FridayPreferenceFactRow[];

      const nowMs = new Date(input.nowIso).getTime();
      let updated = 0;

      const updateStmt = db.prepare(
        `UPDATE preference_facts SET confidence = ?, updated_at = ?
         WHERE fact_id = ?`,
      );

      for (const row of rows) {
        const lastMs = new Date(row.last_confirmed_at).getTime();
        const daysSince = (nowMs - lastMs) / (1000 * 60 * 60 * 24);
        if (daysSince <= 0) continue;

        const decayed =
          row.confidence *
          Math.exp((-Math.LN2 * daysSince) / input.halfLifeDays);
        const clamped = Math.max(input.minConfidenceFloor, decayed);

        if (Math.abs(clamped - row.confidence) > 0.0001) {
          updateStmt.run(clamped, input.nowIso, row.fact_id);
          updated++;
        }
      }

      return updated;
    },
  };
}
