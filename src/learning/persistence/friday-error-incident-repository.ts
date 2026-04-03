import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
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
  listByIds(
    db: Database.Database,
    incidentIds: string[],
  ): FridayErrorIncidentEntity[];

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
  countBySignature(
    db: Database.Database,
    input: {
      userId: string;
      fromTs?: string;
      toTs?: string;
      minCount?: number;
      limit?: number;
    },
  ): Array<{
    signature: string;
    count: number;
  }>;

  findRecentBySignature(
    db: Database.Database,
    userId: string,
    signature: string,
    limit?: number,
  ): FridayErrorIncidentEntity[];
  countRecentBySignatures(
    db: Database.Database,
    input: {
      userId: string;
      signatures: string[];
      limitPerSignature?: number;
    },
  ): Array<{
    signature: string;
    count: number;
  }>;

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
    context: safeJsonParse<JsonObject>(row.context_json) ?? {},
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

    listByIds(db, incidentIds) {
      if (incidentIds.length === 0) {
        return [];
      }
      const uniqueIncidentIds = [...new Set(incidentIds)];
      const placeholders = uniqueIncidentIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM error_incidents
           WHERE incident_id IN (${placeholders})`,
        )
        .all(...uniqueIncidentIds) as FridayErrorIncidentRow[];
      const incidentsById = new Map(rows.map((row) => [row.incident_id, rowToEntity(row)] as const));
      return uniqueIncidentIds
        .map((incidentId) => incidentsById.get(incidentId))
        .filter((incident): incident is FridayErrorIncidentEntity => incident != null);
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

    countBySignature(db, input) {
      let sql = `SELECT signature, COUNT(*) as count
                 FROM error_incidents
                 WHERE user_id = ?`;
      const params: unknown[] = [input.userId];

      if (input.fromTs) {
        sql += " AND ts >= ?";
        params.push(input.fromTs);
      }
      if (input.toTs) {
        sql += " AND ts <= ?";
        params.push(input.toTs);
      }

      sql += " GROUP BY signature";

      if (input.minCount && input.minCount > 1) {
        sql += " HAVING COUNT(*) >= ?";
        params.push(input.minCount);
      }

      sql += " ORDER BY count DESC, signature ASC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      return db.prepare(sql).all(...params) as Array<{
        signature: string;
        count: number;
      }>;
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

    countRecentBySignatures(db, input) {
      if (input.signatures.length === 0) {
        return [];
      }
      const uniqueSignatures = [...new Set(input.signatures)];
      const placeholders = uniqueSignatures.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT signature, COUNT(*) as count
           FROM error_incidents
           WHERE user_id = ? AND signature IN (${placeholders})
           GROUP BY signature`,
        )
        .all(input.userId, ...uniqueSignatures) as Array<{ signature: string; count: number }>;
      const countBySignature = new Map(rows.map((row) => [row.signature, row.count] as const));
      const cap = input.limitPerSignature ?? Number.POSITIVE_INFINITY;
      return uniqueSignatures.map((signature) => ({
        signature,
        count: Math.min(countBySignature.get(signature) ?? 0, cap),
      }));
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
