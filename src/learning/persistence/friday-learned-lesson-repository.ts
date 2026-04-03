import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayLearnedLessonEntity,
  FridayLearnedLessonRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayLearnedLessonRepository {
  getById(
    db: Database.Database,
    lessonId: string,
  ): FridayLearnedLessonEntity | null;
  upsertByFingerprint(
    db: Database.Database,
    input: {
      id: string;
      fingerprint: string;
      title: string;
      cause: string;
      fix: string;
      mitigation?: JsonObject;
      sourceIncidentId?: string;
      sourceDiagnosisId?: string;
      nowIso: string;
    },
  ): FridayLearnedLessonEntity;

  listRecent(
    db: Database.Database,
    limit?: number,
  ): FridayLearnedLessonEntity[];

  getByFingerprint(
    db: Database.Database,
    fingerprint: string,
  ): FridayLearnedLessonEntity | null;
  listByFingerprints(
    db: Database.Database,
    fingerprints: string[],
  ): FridayLearnedLessonEntity[];
}

function rowToEntity(row: FridayLearnedLessonRow): FridayLearnedLessonEntity {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    cause: row.cause,
    fix: row.fix,
    mitigation: safeJsonParse<JsonObject>(row.mitigation_json),
    occurrences: row.occurrences,
    lastSeenAt: row.last_seen_at,
    sourceIncidentId: row.source_incident_id ?? undefined,
    sourceDiagnosisId: row.source_diagnosis_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayLearnedLessonRepository(): FridayLearnedLessonRepository {
  return {
    getById(db, lessonId) {
      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE id = ?")
        .get(lessonId) as FridayLearnedLessonRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    upsertByFingerprint(db, input) {
      const existing = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow | undefined;

      if (existing) {
        db.prepare(
          `UPDATE learned_lessons
           SET title = ?,
               cause = ?,
               fix = ?,
               mitigation_json = ?,
               occurrences = occurrences + 1,
               last_seen_at = ?,
               source_incident_id = COALESCE(?, source_incident_id),
               source_diagnosis_id = COALESCE(?, source_diagnosis_id),
               updated_at = ?
           WHERE fingerprint = ?`,
        ).run(
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.fingerprint,
        );
      } else {
        db.prepare(
          `INSERT INTO learned_lessons
           (id, fingerprint, title, cause, fix, mitigation_json,
            occurrences, last_seen_at, source_incident_id, source_diagnosis_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.fingerprint,
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.nowIso,
        );
      }

      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow;
      return rowToEntity(row);
    },

    listRecent(db, limit = 20) {
      const rows = db
        .prepare(
          `SELECT * FROM learned_lessons
           ORDER BY last_seen_at DESC
           LIMIT ?`,
        )
        .all(limit) as FridayLearnedLessonRow[];
      return rows.map(rowToEntity);
    },

    getByFingerprint(db, fingerprint) {
      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(fingerprint) as FridayLearnedLessonRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByFingerprints(db, fingerprints) {
      if (fingerprints.length === 0) {
        return [];
      }
      const uniqueFingerprints = [...new Set(fingerprints)];
      const placeholders = uniqueFingerprints.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM learned_lessons
           WHERE fingerprint IN (${placeholders})`,
        )
        .all(...uniqueFingerprints) as FridayLearnedLessonRow[];
      const lessonsByFingerprint = new Map(
        rows.map((row) => [row.fingerprint, rowToEntity(row)] as const),
      );
      return uniqueFingerprints
        .map((fingerprint) => lessonsByFingerprint.get(fingerprint))
        .filter((lesson): lesson is FridayLearnedLessonEntity => lesson != null);
    },
  };
}
