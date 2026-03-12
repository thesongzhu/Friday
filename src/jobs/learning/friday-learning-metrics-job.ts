import type { FridayLearningMetricsService } from "#learning";
import type { FridayLearningMetricsJobResult } from "./friday-learning-metrics.types.js";

export interface FridayLearningMetricsJob {
  run(dayOverride?: string): FridayLearningMetricsJobResult;
}

export interface CreateLearningMetricsJobDeps {
  metricsService: FridayLearningMetricsService;
  nowIso: () => string;
}

export function createFridayLearningMetricsJob(
  deps: CreateLearningMetricsJobDeps,
): FridayLearningMetricsJob {
  return {
    run(dayOverride?) {
      const day =
        dayOverride ?? deps.nowIso().slice(0, 10);
      const metric = deps.metricsService.aggregateDay(day);
      return { day, metric };
    },
  };
}
