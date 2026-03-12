import type Database from "better-sqlite3";
import type {
  FridayLearningMetricsEntity,
  FridayLearningMetricsRow,
} from "../model/friday-learning.types.js";

export interface FridayLearningMetricsRepository {
  upsertDay(
    db: Database.Database,
    metric: FridayLearningMetricsEntity,
  ): FridayLearningMetricsEntity;

  getDay(
    db: Database.Database,
    day: string,
  ): FridayLearningMetricsEntity | null;

  listDays(
    db: Database.Database,
    fromDay?: string,
    toDay?: string,
    limit?: number,
  ): FridayLearningMetricsEntity[];
}

function rowToEntity(row: FridayLearningMetricsRow): FridayLearningMetricsEntity {
  return {
    day: row.day,
    successRate: row.success_rate ?? undefined,
    autoFixSuccessRate: row.auto_fix_success_rate ?? undefined,
    rollbackRate: row.rollback_rate ?? undefined,
    incidentsTotal: row.incidents_total,
    factsUpdated: row.facts_updated,
    actionsExecuted: row.actions_executed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayLearningMetricsRepository(): FridayLearningMetricsRepository {
  return {
    upsertDay(db, metric) {
      db.prepare(
        `INSERT INTO learning_metrics
         (day, success_rate, auto_fix_success_rate, rollback_rate,
          incidents_total, facts_updated, actions_executed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET
           success_rate = excluded.success_rate,
           auto_fix_success_rate = excluded.auto_fix_success_rate,
           rollback_rate = excluded.rollback_rate,
           incidents_total = excluded.incidents_total,
           facts_updated = excluded.facts_updated,
           actions_executed = excluded.actions_executed,
           updated_at = excluded.updated_at`,
      ).run(
        metric.day,
        metric.successRate ?? null,
        metric.autoFixSuccessRate ?? null,
        metric.rollbackRate ?? null,
        metric.incidentsTotal,
        metric.factsUpdated,
        metric.actionsExecuted,
        metric.createdAt,
        metric.updatedAt,
      );

      return this.getDay(db, metric.day)!;
    },

    getDay(db, day) {
      const row = db
        .prepare("SELECT * FROM learning_metrics WHERE day = ?")
        .get(day) as FridayLearningMetricsRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listDays(db, fromDay, toDay, limit = 30) {
      let sql = "SELECT * FROM learning_metrics WHERE 1=1";
      const params: unknown[] = [];

      if (fromDay) {
        sql += " AND day >= ?";
        params.push(fromDay);
      }
      if (toDay) {
        sql += " AND day <= ?";
        params.push(toDay);
      }

      sql += " ORDER BY day DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as FridayLearningMetricsRow[];
      return rows.map(rowToEntity);
    },
  };
}
