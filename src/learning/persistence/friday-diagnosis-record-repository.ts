import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
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
  listByIds(
    db: Database.Database,
    diagnosisIds: string[],
  ): FridayDiagnosisRecordEntity[];
  listLatestByIncidentIds(
    db: Database.Database,
    incidentIds: string[],
  ): FridayDiagnosisRecordEntity[];

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
    diagnosis: safeJsonParse<JsonObject>(row.diagnosis_json) ?? {},
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

    listByIds(db, diagnosisIds) {
      if (diagnosisIds.length === 0) {
        return [];
      }
      const uniqueDiagnosisIds = [...new Set(diagnosisIds)];
      const placeholders = uniqueDiagnosisIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE id IN (${placeholders})`,
        )
        .all(...uniqueDiagnosisIds) as FridayDiagnosisRecordRow[];
      const diagnosesById = new Map(rows.map((row) => [row.id, rowToEntity(row)] as const));
      return uniqueDiagnosisIds
        .map((diagnosisId) => diagnosesById.get(diagnosisId))
        .filter((diagnosis): diagnosis is FridayDiagnosisRecordEntity => diagnosis != null);
    },

    listLatestByIncidentIds(db, incidentIds) {
      if (incidentIds.length === 0) {
        return [];
      }
      const uniqueIncidentIds = [...new Set(incidentIds)];
      const placeholders = uniqueIncidentIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE incident_id IN (${placeholders})
           ORDER BY created_at DESC`,
        )
        .all(...uniqueIncidentIds) as FridayDiagnosisRecordRow[];
      const latestByIncidentId = new Map<string, FridayDiagnosisRecordEntity>();
      for (const row of rows) {
        if (row.incident_id && !latestByIncidentId.has(row.incident_id)) {
          latestByIncidentId.set(row.incident_id, rowToEntity(row));
        }
      }
      return uniqueIncidentIds
        .map((incidentId) => latestByIncidentId.get(incidentId))
        .filter((diagnosis): diagnosis is FridayDiagnosisRecordEntity => diagnosis != null);
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
