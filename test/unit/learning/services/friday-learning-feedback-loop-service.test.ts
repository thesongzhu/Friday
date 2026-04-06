import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayLearningFeedbackLoopService,
  createFridayPreferenceExtractionService,
  createFridayPreferenceFactRepository,
} from "#learning";
import type {
  FridayLearningFeedbackLoopService,
  FridayPreferenceFactRepository,
} from "#learning";
import type { FridayLearningEventAppendInput } from "#ledger";

describe("FridayLearningFeedbackLoopService", () => {
  let db: FridaySqliteLayer;
  let factRepo: FridayPreferenceFactRepository;
  let service: FridayLearningFeedbackLoopService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    factRepo = createFridayPreferenceFactRepository();
    idGen = createTestIdGenerator();
    const extraction = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
    service = createFridayLearningFeedbackLoopService({
      db,
      factRepo,
      extraction,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
      ...overrides,
    };
  }

  it("rejects non-correction events", () => {
    const result = service.applyCorrection(
      makeEvent({ kind: "user_message" }),
    );
    expect(result.accepted).toBe(false);
    expect(result.updatedFacts).toHaveLength(0);
  });

  it("accepts user_correction events and creates preference facts", () => {
    const result = service.applyCorrection(makeEvent());
    expect(result.accepted).toBe(true);
    expect(result.updatedFacts.length).toBeGreaterThanOrEqual(1);
  });

  it("stores correction with high confidence", () => {
    const result = service.applyCorrection(makeEvent());
    expect(result.accepted).toBe(true);

    const fact = result.updatedFacts[0];
    expect(fact).toBeDefined();
    expect(fact!.confidence).toBe(1.0);
    expect(fact!.value).toBe("Python");
  });

  it("updates existing fact when same key is corrected again", () => {
    // First correction
    service.applyCorrection(makeEvent());

    // Second correction for same field
    const result = service.applyCorrection(
      makeEvent({
        eventId: "evt-002",
        payload: { correctedField: "language", newValue: "TypeScript" },
      }),
    );

    expect(result.accepted).toBe(true);
    const fact = result.updatedFacts[0];
    expect(fact!.value).toBe("TypeScript");
  });

  it("returns empty when correction has no extractable signals", () => {
    // A correction event with empty/invalid payload
    const result = service.applyCorrection(
      makeEvent({ payload: {} }),
    );
    expect(result.accepted).toBe(false);
    expect(result.updatedFacts).toHaveLength(0);
  });
});
