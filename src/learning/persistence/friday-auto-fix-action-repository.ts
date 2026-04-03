import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixActionRow,
  FridayAutoFixPlan,
} from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixActionRepository {
  insert(
    db: Database.Database,
    action: FridayAutoFixActionEntity,
  ): FridayAutoFixActionEntity;

  getById(
    db: Database.Database,
    actionId: string,
  ): FridayAutoFixActionEntity | null;
  listByIds(
    db: Database.Database,
    actionIds: string[],
  ): FridayAutoFixActionEntity[];
  listByIncidentIds(
    db: Database.Database,
    input: {
      incidentIds: string[];
      status?: FridayAutoFixActionEntity["status"];
      limitPerIncident?: number;
    },
  ): FridayAutoFixActionEntity[];
  listLatestByIncidentIds(
    db: Database.Database,
    input: {
      userId: string;
      incidentIds: string[];
    },
  ): FridayAutoFixActionEntity[];

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: FridayAutoFixActionEntity["status"];
      incidentId?: string;
      limit?: number;
    },
  ): FridayAutoFixActionEntity[];
  listRejectedByUser(
    db: Database.Database,
    input: {
      userId: string;
      limit?: number;
    },
  ): FridayAutoFixActionEntity[];
  summarizeByFingerprint(
    db: Database.Database,
    input: {
      userId: string;
      fingerprint: string;
      limit?: number;
    },
  ): {
    sampleCount: number;
    successCount: number;
    rollbackCount: number;
    rejectedCount: number;
    executedCount: number;
  };
  summarizeRecentHotspots(
    db: Database.Database,
    input: {
      userId: string;
      recentLimit?: number;
      hotspotLimit?: number;
    },
  ): Array<{
    fingerprint: string;
    rolledBackCount: number;
    appliedCount: number;
    rejectedCount: number;
    totalCount: number;
    lastSeenAt: string;
  }>;

  listPlanned(
    db: Database.Database,
    input?: { maxRiskTier?: 0 | 1 | 2; incidentIds?: string[]; limit?: number },
  ): FridayAutoFixActionEntity[];

  markApplied(
    db: Database.Database,
    actionId: string,
    outcome: "success" | "failed",
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  markRolledBack(
    db: Database.Database,
    actionId: string,
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  markRejected(
    db: Database.Database,
    actionId: string,
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  setPlan(
    db: Database.Database,
    actionId: string,
    plan: FridayAutoFixPlan,
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  setRollbackPlan(
    db: Database.Database,
    actionId: string,
    rollbackPlan: FridayAutoFixPlan["rollbackPlan"],
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  countByDay(
    db: Database.Database,
    day: string,
  ): { applied: number; rolledBack: number; total: number };

  countRolling24h(
    db: Database.Database,
    nowIso: string,
  ): { applied: number; rolledBack: number; executed: number };

  countRolling1h(
    db: Database.Database,
    nowIso: string,
  ): { applied: number; rolledBack: number; executed: number };
}

function rowToEntity(row: FridayAutoFixActionRow): FridayAutoFixActionEntity {
  const plan = safeJsonParse<FridayAutoFixPlan>(row.plan_json) ?? ({} as FridayAutoFixPlan);
  return {
    actionId: row.action_id,
    incidentId: row.incident_id,
    userId: row.user_id,
    riskTier: row.risk_tier,
    plan,
    rollbackPlan: safeJsonParse<FridayAutoFixPlan["rollbackPlan"]>(row.rollback_plan_json),
    status: row.status,
    outcome: row.outcome,
    appliedAt: row.applied_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayAutoFixActionRepository(): FridayAutoFixActionRepository {
  return {
    insert(db, action) {
      db.prepare(
        `INSERT INTO auto_fix_actions
         (action_id, incident_id, user_id, risk_tier, plan_json, rollback_plan_json,
          status, outcome, applied_at, rolled_back_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        action.actionId,
        action.incidentId,
        action.userId,
        action.riskTier,
        JSON.stringify(action.plan),
        action.rollbackPlan ? JSON.stringify(action.rollbackPlan) : null,
        action.status,
        action.outcome,
        action.appliedAt ?? null,
        action.rolledBackAt ?? null,
        action.createdAt,
        action.updatedAt,
      );
      return action;
    },

    getById(db, actionId) {
      const row = db
        .prepare("SELECT * FROM auto_fix_actions WHERE action_id = ?")
        .get(actionId) as FridayAutoFixActionRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByIds(db, actionIds) {
      if (actionIds.length === 0) {
        return [];
      }
      const uniqueActionIds = [...new Set(actionIds)];
      const placeholders = uniqueActionIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM auto_fix_actions
           WHERE action_id IN (${placeholders})`,
        )
        .all(...uniqueActionIds) as FridayAutoFixActionRow[];
      const actionsById = new Map(rows.map((row) => [row.action_id, rowToEntity(row)] as const));
      return uniqueActionIds
        .map((actionId) => actionsById.get(actionId))
        .filter((action): action is FridayAutoFixActionEntity => action != null);
    },

    listByIncidentIds(db, input) {
      if (input.incidentIds.length === 0) {
        return [];
      }
      const uniqueIncidentIds = [...new Set(input.incidentIds)];
      const placeholders = uniqueIncidentIds.map(() => "?").join(", ");
      let sql = `SELECT * FROM auto_fix_actions WHERE incident_id IN (${placeholders})`;
      const params: unknown[] = [...uniqueIncidentIds];
      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }
      sql += " ORDER BY created_at DESC";
      const rows = db.prepare(sql).all(...params) as FridayAutoFixActionRow[];
      if (!input.limitPerIncident || input.limitPerIncident <= 0) {
        return rows.map(rowToEntity);
      }
      const countsByIncidentId = new Map<string, number>();
      const selected: FridayAutoFixActionEntity[] = [];
      for (const row of rows) {
        const nextCount = (countsByIncidentId.get(row.incident_id) ?? 0) + 1;
        if (nextCount > input.limitPerIncident) {
          continue;
        }
        countsByIncidentId.set(row.incident_id, nextCount);
        selected.push(rowToEntity(row));
      }
      return selected;
    },

    listLatestByIncidentIds(db, input) {
      if (input.incidentIds.length === 0) {
        return [];
      }
      const uniqueIncidentIds = [...new Set(input.incidentIds)];
      const placeholders = uniqueIncidentIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM auto_fix_actions
           WHERE user_id = ? AND incident_id IN (${placeholders})
           ORDER BY created_at DESC`,
        )
        .all(input.userId, ...uniqueIncidentIds) as FridayAutoFixActionRow[];
      const latestByIncidentId = new Map<string, FridayAutoFixActionEntity>();
      for (const row of rows) {
        if (!latestByIncidentId.has(row.incident_id)) {
          latestByIncidentId.set(row.incident_id, rowToEntity(row));
        }
      }
      return uniqueIncidentIds
        .map((incidentId) => latestByIncidentId.get(incidentId))
        .filter((action): action is FridayAutoFixActionEntity => action != null);
    },

    listByUser(db, input) {
      let sql = "SELECT * FROM auto_fix_actions WHERE user_id = ?";
      const params: unknown[] = [input.userId];

      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }

      if (input.incidentId) {
        sql += " AND incident_id = ?";
        params.push(input.incidentId);
      }

      sql += " ORDER BY created_at DESC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayAutoFixActionRow[];
      return rows.map(rowToEntity);
    },

    listRejectedByUser(db, input) {
      const rows = db
        .prepare(
          `SELECT * FROM auto_fix_actions
           WHERE user_id = ? AND status = 'rejected'
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(input.userId, input.limit ?? 50) as FridayAutoFixActionRow[];
      return rows.map(rowToEntity);
    },

    summarizeByFingerprint(db, input) {
      let sql = `SELECT
                   COUNT(*) as sample_count,
                   COALESCE(SUM(CASE WHEN status = 'applied' AND outcome = 'success' THEN 1 ELSE 0 END), 0) as success_count,
                   COALESCE(SUM(CASE WHEN status = 'rolled_back' THEN 1 ELSE 0 END), 0) as rollback_count,
                   COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) as rejected_count,
                   COALESCE(SUM(CASE WHEN status IN ('applied', 'rolled_back') THEN 1 ELSE 0 END), 0) as executed_count
                 FROM (
                   SELECT status, outcome
                   FROM auto_fix_actions
                   WHERE user_id = ?
                     AND json_extract(plan_json, '$.evidence.fingerprint') = ?
                   ORDER BY created_at DESC`;
      const params: unknown[] = [input.userId, input.fingerprint];

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      sql += ")";

      const row = db.prepare(sql).get(...params) as
        | {
            sample_count: number;
            success_count: number;
            rollback_count: number;
            rejected_count: number;
            executed_count: number;
          }
        | undefined;

      return {
        sampleCount: row?.sample_count ?? 0,
        successCount: row?.success_count ?? 0,
        rollbackCount: row?.rollback_count ?? 0,
        rejectedCount: row?.rejected_count ?? 0,
        executedCount: row?.executed_count ?? 0,
      };
    },

    summarizeRecentHotspots(db, input) {
      const rows = db
        .prepare(
          `SELECT
             json_extract(plan_json, '$.evidence.fingerprint') as fingerprint,
             COALESCE(SUM(CASE WHEN status = 'rolled_back' THEN 1 ELSE 0 END), 0) as rolled_back_count,
             COALESCE(SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END), 0) as applied_count,
             COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) as rejected_count,
             COUNT(*) as total_count,
             MAX(updated_at) as last_seen_at
           FROM (
             SELECT *
             FROM auto_fix_actions
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?
           )
           GROUP BY fingerprint
           HAVING rolled_back_count > 0 OR rejected_count > 0
           ORDER BY (rolled_back_count + rejected_count) DESC, last_seen_at DESC
           LIMIT ?`,
        )
        .all(
          input.userId,
          input.recentLimit ?? 200,
          input.hotspotLimit ?? 20,
        ) as Array<{
          fingerprint: string | null;
          rolled_back_count: number;
          applied_count: number;
          rejected_count: number;
          total_count: number;
          last_seen_at: string;
        }>;

      return rows
        .filter((row): row is typeof row & { fingerprint: string } => typeof row.fingerprint === "string" && row.fingerprint.length > 0)
        .map((row) => ({
          fingerprint: row.fingerprint,
          rolledBackCount: row.rolled_back_count,
          appliedCount: row.applied_count,
          rejectedCount: row.rejected_count,
          totalCount: row.total_count,
          lastSeenAt: row.last_seen_at,
        }));
    },

    listPlanned(db, input) {
      let sql = "SELECT * FROM auto_fix_actions WHERE status = 'planned'";
      const params: unknown[] = [];

      if (input?.maxRiskTier !== undefined) {
        sql += " AND risk_tier <= ?";
        params.push(input.maxRiskTier);
      }

      if (input?.incidentIds && input.incidentIds.length > 0) {
        const placeholders = input.incidentIds.map(() => "?").join(",");
        sql += ` AND incident_id IN (${placeholders})`;
        params.push(...input.incidentIds);
      }

      sql += " ORDER BY created_at ASC";

      if (input?.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayAutoFixActionRow[];
      return rows.map(rowToEntity);
    },

    markApplied(db, actionId, outcome, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'applied', outcome = ?, applied_at = ?, updated_at = ?
           WHERE action_id = ? AND status = 'planned'`,
        )
        .run(outcome, nowIso, nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    markRolledBack(db, actionId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'rolled_back', outcome = 'failed', rolled_back_at = ?, updated_at = ?
           WHERE action_id = ? AND status IN ('planned', 'applied')`,
        )
        .run(nowIso, nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    markRejected(db, actionId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'rejected', updated_at = ?
           WHERE action_id = ? AND status = 'planned'`,
        )
        .run(nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    setPlan(db, actionId, plan, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET plan_json = ?, updated_at = ?
           WHERE action_id = ?`,
        )
        .run(JSON.stringify(plan), nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    setRollbackPlan(db, actionId, rollbackPlan, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET rollback_plan_json = ?, updated_at = ?
           WHERE action_id = ?`,
        )
        .run(
          rollbackPlan ? JSON.stringify(rollbackPlan) : null,
          nowIso,
          actionId,
        ).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    countByDay(db, day) {
      const dayStart = `${day}T00:00:00.000Z`;
      const dayEnd = `${day}T23:59:59.999Z`;

      const applied = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'applied' AND applied_at >= ? AND applied_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      const rolledBack = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'rolled_back' AND rolled_back_at >= ? AND rolled_back_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      const total = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE created_at >= ? AND created_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      return { applied, rolledBack, total };
    },

    countRolling24h(db, nowIso) {
      const cutoff = new Date(new Date(nowIso).getTime() - 24 * 60 * 60 * 1000).toISOString();

      const applied = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'applied' AND applied_at >= ? AND applied_at <= ?`,
          )
          .get(cutoff, nowIso) as { cnt: number }
      ).cnt;

      const rolledBack = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'rolled_back' AND rolled_back_at >= ? AND rolled_back_at <= ?`,
          )
          .get(cutoff, nowIso) as { cnt: number }
      ).cnt;

      return { applied, rolledBack, executed: applied + rolledBack };
    },

    countRolling1h(db, nowIso) {
      const cutoff = new Date(new Date(nowIso).getTime() - 60 * 60 * 1000).toISOString();

      const applied = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'applied' AND applied_at >= ? AND applied_at <= ?`,
          )
          .get(cutoff, nowIso) as { cnt: number }
      ).cnt;

      const rolledBack = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'rolled_back' AND rolled_back_at >= ? AND rolled_back_at <= ?`,
          )
          .get(cutoff, nowIso) as { cnt: number }
      ).cnt;

      return { applied, rolledBack, executed: applied + rolledBack };
    },
  };
}
