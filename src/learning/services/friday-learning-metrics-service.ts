import type { FridaySqliteLayer } from "#state";
import type { FridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayLearningMetricsEntity } from "../model/friday-learning.types.js";

export interface FridayLearningMetricsService {
  aggregateDay(day: string): FridayLearningMetricsEntity;
  aggregateRange(
    fromDay: string,
    toDay: string,
  ): FridayLearningMetricsEntity[];
}

export interface CreateLearningMetricsServiceDeps {
  db: FridaySqliteLayer;
  metricsRepo: FridayLearningMetricsRepository;
  actionRepo?: FridayAutoFixActionRepository;
  nowIso: () => string;
}

export function createFridayLearningMetricsService(
  deps: CreateLearningMetricsServiceDeps,
): FridayLearningMetricsService {
  function aggregateSingleDay(day: string): FridayLearningMetricsEntity {
    return deps.db.withWriteTransaction((db) => {
      const dayStart = `${day}T00:00:00.000Z`;
      const dayEnd = `${day}T23:59:59.999Z`;

      // Count incidents for the day
      const incidentCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM error_incidents
           WHERE ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Count facts updated for the day
      const factsCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM preference_facts
           WHERE updated_at >= ? AND updated_at <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Compute success rate from workflow outcomes
      const totalOutcomes = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM learning_events
           WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      let successRate: number | undefined;
      if (totalOutcomes.cnt > 0) {
        const successOutcomes = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM learning_events
             WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?
             AND json_extract(payload_json, '$.success') = 1`,
          )
          .get(dayStart, dayEnd) as { cnt: number };
        successRate = successOutcomes.cnt / totalOutcomes.cnt;
      }

      // Compute auto-fix metrics
      let autoFixSuccessRate: number | undefined;
      let rollbackRate: number | undefined;
      let actionsExecuted = 0;

      if (deps.actionRepo) {
        const counts = deps.actionRepo.countByDay(db, day);
        actionsExecuted = counts.applied + counts.rolledBack;

        if (actionsExecuted > 0) {
          autoFixSuccessRate = counts.applied / actionsExecuted;
          rollbackRate = counts.rolledBack / actionsExecuted;
        }
      }

      const nowIso = deps.nowIso();

      const metric: FridayLearningMetricsEntity = {
        day,
        successRate,
        autoFixSuccessRate,
        rollbackRate,
        incidentsTotal: incidentCount.cnt,
        factsUpdated: factsCount.cnt,
        actionsExecuted,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.metricsRepo.upsertDay(db, metric);
    });
  }

  return {
    aggregateDay: aggregateSingleDay,

    aggregateRange(fromDay, toDay) {
      // Generate day strings from fromDay to toDay
      const results: FridayLearningMetricsEntity[] = [];
      const start = new Date(`${fromDay}T00:00:00.000Z`);
      const end = new Date(`${toDay}T00:00:00.000Z`);

      const current = new Date(start);
      while (current <= end) {
        const dayStr = current.toISOString().slice(0, 10);
        results.push(aggregateSingleDay(dayStr));
        current.setDate(current.getDate() + 1);
      }

      return results;
    },
  };
}
