import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayLearningLifecycleService } from "#learning";
import { createFridayPreferenceFactRepository } from "#learning";
import type { FridayLearningLifecycleService } from "#learning";
import type { FridayPreferenceFactRepository } from "#learning";

describe("FridayLearningLifecycleService", () => {
  let db: FridaySqliteLayer;
  let factRepo: FridayPreferenceFactRepository;
  let service: FridayLearningLifecycleService;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    factRepo = createFridayPreferenceFactRepository();
  });

  afterEach(() => {
    db.close();
  });

  function insertFact(key: string, confidence: number) {
    factRepo.upsert(db.writer, {
      factId: `fact-${key}`,
      userId: "test-user",
      key,
      value: "some-value",
      confidence,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });
  }

  it("returns cold_start when user has no facts", () => {
    service = createFridayLearningLifecycleService({
      db,
      factRepo,
      warmupFactCount: 3,
      steadyStateFactCount: 10,
      steadyStateThreshold: 0.8,
    });

    expect(service.getState("test-user")).toBe("cold_start");
  });

  it("returns warmup when user has some facts but not enough high-confidence", () => {
    service = createFridayLearningLifecycleService({
      db,
      factRepo,
      warmupFactCount: 2,
      steadyStateFactCount: 5,
      steadyStateThreshold: 0.8,
    });

    // Insert 3 facts with low confidence
    insertFact("pref:lang", 0.5);
    insertFact("pref:tone", 0.6);
    insertFact("pref:style", 0.4);

    expect(service.getState("test-user")).toBe("warmup");
  });

  it("returns steady_state when user has enough high-confidence facts", () => {
    service = createFridayLearningLifecycleService({
      db,
      factRepo,
      warmupFactCount: 2,
      steadyStateFactCount: 3,
      steadyStateThreshold: 0.8,
    });

    insertFact("pref:lang", 0.9);
    insertFact("pref:tone", 0.85);
    insertFact("pref:style", 0.95);

    expect(service.getState("test-user")).toBe("steady_state");
  });

  it("uses custom thresholds", () => {
    service = createFridayLearningLifecycleService({
      db,
      factRepo,
      warmupFactCount: 1,
      steadyStateFactCount: 2,
      steadyStateThreshold: 0.5,
    });

    insertFact("pref:lang", 0.6);
    insertFact("pref:tone", 0.7);

    expect(service.getState("test-user")).toBe("steady_state");
  });

  it("returns cold_start for unknown user", () => {
    service = createFridayLearningLifecycleService({
      db,
      factRepo,
      warmupFactCount: 1,
      steadyStateFactCount: 2,
      steadyStateThreshold: 0.8,
    });

    expect(service.getState("unknown-user")).toBe("cold_start");
  });
});
