import type Database from "better-sqlite3";
import type {
  FridayDiagnosisRecordEntity,
  FridayDiagnosisRecordRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayDiagnosisRecordRepository {
  getById(
    db: Database.Database,
    diagnosisId: string,
  ): FridayDiagnosisRecordEntity | null;

  insert(
    db: Database.Database,
    record: FridayDiagnosisRecordEntity,
  ): FridayDiagnosisRecordEntity;

  listByIncidentId(
    db: Database.Database,
    incidentId: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];

  getLatestByIncidentId(
    db: Database.Database,
    incidentId: string,
  ): FridayDiagnosisRecordEntity | null;

  listByFingerprint(
    db: Database.Database,
    fingerprint: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];

  markResolved(
    db: Database.Database,
    diagnosisId: string,
    nowIso: string,
  ): FridayDiagnosisRecordEntity | null;

  listRecentByFingerprint(
    db: Database.Database,
    fingerprint: string,
    sinceIso: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];
}

function rowToEntity(row: FridayDiagnosisRecordRow): FridayDiagnosisRecordEntity {
  return {
    id: row.id,
    incidentId: row.incident_id ?? undefined,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    errorFingerprint: row.error_fingerprint,
    confidence: row.confidence,
    diagnosis: JSON.parse(row.diagnosis_json) as JsonObject,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayDiagnosisRecordRepository(): FridayDiagnosisRecordRepository {
  return {
    getById(db, diagnosisId) {
      const row = db
        .prepare("SELECT * FROM diagnosis_records WHERE id = ?")
        .get(diagnosisId) as FridayDiagnosisRecordRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    insert(db, record) {
      db.prepare(
        `INSERT INTO diagnosis_records
         (id, incident_id, run_id, node_id, error_fingerprint, confidence,
          diagnosis_json, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.incidentId ?? null,
        record.runId ?? null,
        record.nodeId ?? null,
        record.errorFingerprint,
        record.confidence,
        JSON.stringify(record.diagnosis),
        record.resolvedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },

    listByIncidentId(db, incidentId, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE incident_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(incidentId, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },

    getLatestByIncidentId(db, incidentId) {
      const row = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE incident_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(incidentId) as FridayDiagnosisRecordRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByFingerprint(db, fingerprint, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE error_fingerprint = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(fingerprint, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },

    markResolved(db, diagnosisId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE diagnosis_records
           SET resolved_at = ?, updated_at = ?
           WHERE id = ? AND resolved_at IS NULL`,
        )
        .run(nowIso, nowIso, diagnosisId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM diagnosis_records WHERE id = ?")
        .get(diagnosisId) as FridayDiagnosisRecordRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listRecentByFingerprint(db, fingerprint, sinceIso, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE error_fingerprint = ? AND created_at >= ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(fingerprint, sinceIso, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },
  };
}
