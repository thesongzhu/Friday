import type Database from "better-sqlite3";
import type {
  FridayErrorIncidentEntity,
  FridayErrorIncidentRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayErrorIncidentRepository {
  getById(
    db: Database.Database,
    incidentId: string,
  ): FridayErrorIncidentEntity | null;

  insert(
    db: Database.Database,
    incident: FridayErrorIncidentEntity,
  ): FridayErrorIncidentEntity;

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: "open" | "mitigated" | "resolved";
      fromTs?: string;
      toTs?: string;
      limit?: number;
    },
  ): FridayErrorIncidentEntity[];

  findRecentBySignature(
    db: Database.Database,
    userId: string,
    signature: string,
    limit?: number,
  ): FridayErrorIncidentEntity[];

  setAutoFixEligibility(
    db: Database.Database,
    incidentId: string,
    eligible: boolean,
    nowIso: string,
  ): FridayErrorIncidentEntity | null;

  updateStatus(
    db: Database.Database,
    incidentId: string,
    status: "open" | "mitigated" | "resolved",
    nowIso: string,
  ): FridayErrorIncidentEntity | null;
}

function rowToEntity(row: FridayErrorIncidentRow): FridayErrorIncidentEntity {
  return {
    incidentId: row.incident_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    ts: row.ts,
    category: row.category,
    severity: row.severity,
    signature: row.signature,
    context: JSON.parse(row.context_json) as JsonObject,
    autoFixEligible: row.auto_fix_eligible === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayErrorIncidentRepository(): FridayErrorIncidentRepository {
  return {
    getById(db, incidentId) {
      const row = db
        .prepare("SELECT * FROM error_incidents WHERE incident_id = ?")
        .get(incidentId) as FridayErrorIncidentRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    insert(db, incident) {
      db.prepare(
        `INSERT INTO error_incidents
         (incident_id, user_id, run_id, node_id, ts, category, severity,
          signature, context_json, auto_fix_eligible, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        incident.incidentId,
        incident.userId,
        incident.runId ?? null,
        incident.nodeId ?? null,
        incident.ts,
        incident.category,
        incident.severity,
        incident.signature,
        JSON.stringify(incident.context),
        incident.autoFixEligible ? 1 : 0,
        incident.status,
        incident.createdAt,
        incident.updatedAt,
      );
      return incident;
    },

    listByUser(db, input) {
      let sql = "SELECT * FROM error_incidents WHERE user_id = ?";
      const params: unknown[] = [input.userId];

      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }
      if (input.fromTs) {
        sql += " AND ts >= ?";
        params.push(input.fromTs);
      }
      if (input.toTs) {
        sql += " AND ts <= ?";
        params.push(input.toTs);
      }

      sql += " ORDER BY ts DESC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },

    findRecentBySignature(db, userId, signature, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM error_incidents
           WHERE user_id = ? AND signature = ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        .all(userId, signature, limit) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },

    setAutoFixEligibility(db, incidentId, eligible, nowIso) {
      const changes = db
        .prepare(
          `UPDATE error_incidents
           SET auto_fix_eligible = ?, updated_at = ?
           WHERE incident_id = ?`,
        )
        .run(eligible ? 1 : 0, nowIso, incidentId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM error_incidents WHERE incident_id = ?")
        .get(incidentId) as FridayErrorIncidentRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    updateStatus(db, incidentId, status, nowIso) {
      const changes = db
        .prepare(
          `UPDATE error_incidents
           SET status = ?, updated_at = ?
           WHERE incident_id = ?`,
        )
        .run(status, nowIso, incidentId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM error_incidents WHERE incident_id = ?")
        .get(incidentId) as FridayErrorIncidentRow | undefined;
      return row ? rowToEntity(row) : null;
    },
  };
}
