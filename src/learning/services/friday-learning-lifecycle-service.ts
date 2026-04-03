import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayLearningLifecycleState,
} from "../model/friday-learning.types.js";
import { FRIDAY_LEARNING_DEFAULTS } from "../model/friday-learning.types.js";

export interface FridayLearningLifecycleService {
  getState(userId: string): FridayLearningLifecycleState;
}

export interface CreateLifecycleServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  warmupFactCount?: number;
  steadyStateFactCount?: number;
  steadyStateThreshold?: number;
}

export function createFridayLearningLifecycleService(
  deps: CreateLifecycleServiceDeps,
): FridayLearningLifecycleService {
  const warmupFactCount =
    deps.warmupFactCount ?? FRIDAY_LEARNING_DEFAULTS.warmupFactCount;
  const steadyStateFactCount =
    deps.steadyStateFactCount ?? FRIDAY_LEARNING_DEFAULTS.steadyStateFactCount;
  const steadyStateThreshold =
    deps.steadyStateThreshold ?? FRIDAY_LEARNING_DEFAULTS.steadyStateThreshold;

  return {
    getState(userId) {
      return deps.db.withReadConnection((db) => {
        const highConfidenceFactCount = deps.factRepo.countByUser(
          db,
          userId,
          steadyStateThreshold,
        );

        if (highConfidenceFactCount >= steadyStateFactCount) {
          return "steady_state";
        }

        const totalFactCount = deps.factRepo.countByUser(db, userId, 0);

        if (totalFactCount >= warmupFactCount) {
          return "warmup";
        }

        return "cold_start";
      });
    },
  };
}
