import type { FridayLearningEventAppendInput, FridayLearningEventLedger } from "#ledger";

export interface FridayLearningEventCollectionService {
  collect(event: FridayLearningEventAppendInput): { inserted: boolean };
  collectBatch(
    events: FridayLearningEventAppendInput[],
  ): Array<{ eventId: string; inserted: boolean }>;
}

export interface CreateLearningEventCollectionServiceDeps {
  ledger: FridayLearningEventLedger;
}

export function createFridayLearningEventCollectionService(
  deps: CreateLearningEventCollectionServiceDeps,
): FridayLearningEventCollectionService {
  return {
    collect(event) {
      return deps.ledger.appendEvent(event);
    },
    collectBatch(events) {
      return deps.ledger.appendBatch(events);
    },
  };
}
