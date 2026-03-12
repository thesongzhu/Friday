import type { FridaySqliteLayer } from "#state";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type { FridayPreferenceExtractionService } from "./friday-preference-extraction-service.js";
import type {
  FridayLearningEventAppendInput,
  FridayPreferenceFactEntity,
  JsonValue,
} from "../model/friday-learning.types.js";

export interface FridayLearningFeedbackLoopService {
  applyCorrection(event: FridayLearningEventAppendInput): {
    accepted: boolean;
    updatedFacts: FridayPreferenceFactEntity[];
  };
}

export interface CreateFeedbackLoopServiceDeps {
  db: FridaySqliteLayer;
  factRepo: FridayPreferenceFactRepository;
  extraction: FridayPreferenceExtractionService;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayLearningFeedbackLoopService(
  deps: CreateFeedbackLoopServiceDeps,
): FridayLearningFeedbackLoopService {
  return {
    applyCorrection(event) {
      if (event.kind !== "user_correction") {
        return { accepted: false, updatedFacts: [] };
      }

      const signals = deps.extraction.extract(event);
      const correctionSignals = signals.filter(
        (s) => s.kind === "correction",
      );

      if (correctionSignals.length === 0) {
        return { accepted: false, updatedFacts: [] };
      }

      const updatedFacts = deps.db.withWriteTransaction((db) => {
        const results: FridayPreferenceFactEntity[] = [];

        for (const signal of correctionSignals) {
          // Corrections always get high confidence (1.0) and overwrite value
          const existing = deps.factRepo.getByUserAndKey(
            db,
            event.userId,
            signal.key,
          );

          const entity = deps.factRepo.upsert(db, {
            factId: existing?.factId ?? deps.idGenerator(),
            userId: event.userId,
            key: signal.key,
            value: signal.value,
            confidence: signal.confidence, // 1.0 for corrections
            evidenceCountDelta: 1,
            lastConfirmedAt: event.ts,
            sourceEventId: event.eventId,
            nowIso: event.ts,
          });

          results.push(entity);
        }

        return results;
      });

      return { accepted: true, updatedFacts };
    },
  };
}
