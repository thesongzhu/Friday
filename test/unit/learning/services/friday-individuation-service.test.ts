import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayPreferenceFactRepository,
  createFridayPreferenceFactService,
  createFridaySessionSatisfactionRepository,
  createFridayIndividuationService,
} from "#learning";
import type {
  FridayIndividuationService,
  FridayPreferenceFactService,
  FridaySessionSatisfactionRepository,
} from "#learning";

describe("FridayIndividuationService", () => {
  let db: FridaySqliteLayer;
  let service: FridayIndividuationService;
  let factService: FridayPreferenceFactService;
  let satisfactionRepo: FridaySessionSatisfactionRepository;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const factRepo = createFridayPreferenceFactRepository();
    satisfactionRepo = createFridaySessionSatisfactionRepository();

    factService = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    service = createFridayIndividuationService({
      db,
      factRepo,
      satisfactionRepo,
    });
  });

  afterEach(() => {
    db.close();
  });

  function seedFacts(userId: string, count: number, prefix = "pref") {
    for (let i = 0; i < count; i++) {
      factService.applySignals({
        event: {
          eventId: idGen(),
          ts: NOW,
          userId,
          kind: "user_correction",
          payload: { correctedField: `${prefix}.key${i}`, newValue: `val${i}` },
        },
        signals: [
          {
            signalId: idGen(),
            kind: "preference",
            key: `${prefix}.key${i}`,
            value: `val${i}`,
            confidence: 0.7,
            source: "user_correction",
          },
        ],
        nowIso: NOW,
      });
    }
  }

  function seedSessions(userId: string, count: number, avgScore = 0.2) {
    for (let i = 0; i < count; i++) {
      const ts = new Date(
        new Date(NOW).getTime() - (count - i) * 86_400_000,
      ).toISOString();
      db.withWriteTransaction((conn) =>
        satisfactionRepo.upsert(conn, {
          sessionId: `sess-${i}`,
          userId,
          score: avgScore,
          signalCount: 5,
          positiveCount: 3,
          negativeCount: 1,
          neutralCount: 1,
          nowIso: ts,
        }),
      );
    }
  }

  it("starts as stranger with no facts", () => {
    const state = service.computeStage({ userId: "test-user", nowIso: NOW });
    expect(state.stage).toBe("stranger");
    expect(state.factCount).toBe(0);
  });

  it("transitions to acquaintance at 3+ facts", () => {
    seedFacts("test-user", 3);
    const state = service.computeStage({ userId: "test-user", nowIso: NOW });
    expect(state.stage).toBe("acquaintance");
  });

  it("transitions to familiar at 10+ facts with decent satisfaction", () => {
    seedFacts("test-user", 12);
    seedSessions("test-user", 5, 0.1);
    const state = service.computeStage({ userId: "test-user", nowIso: NOW });
    expect(state.stage).toBe("familiar");
  });

  it("transitions to companion at 25+ facts, 30+ sessions, satisfaction > 0.1", () => {
    seedFacts("test-user", 28);
    seedSessions("test-user", 35, 0.3);
    const state = service.computeStage({ userId: "test-user", nowIso: NOW });
    expect(state.stage).toBe("companion");
  });

  it("persists state and tracks previous stage", () => {
    // Start as stranger
    service.computeStage({ userId: "test-user", nowIso: NOW });
    // Advance to acquaintance
    seedFacts("test-user", 5);
    const state = service.computeStage({ userId: "test-user", nowIso: NOW });

    expect(state.stage).toBe("acquaintance");
    expect(state.previousStage).toBe("stranger");
  });

  it("getStage returns null for unknown user", () => {
    const state = service.getStage("nonexistent");
    expect(state).toBeNull();
  });

  it("getStage returns persisted state", () => {
    service.computeStage({ userId: "test-user", nowIso: NOW });
    const state = service.getStage("test-user");

    expect(state).toBeDefined();
    expect(state?.stage).toBe("stranger");
    expect(state?.userId).toBe("test-user");
  });
});
