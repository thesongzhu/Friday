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

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: FridayAutoFixActionEntity["status"];
      incidentId?: string;
      limit?: number;
    },
  ): FridayAutoFixActionEntity[];

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
