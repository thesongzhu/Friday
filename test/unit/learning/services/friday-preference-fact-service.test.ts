import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayPreferenceFactRepository } from "#learning";
import { createFridayPreferenceFactService } from "#learning";
import type { FridayPreferenceFactService } from "#learning";
import type {
  FridayExtractedSignal,
  FridayLearningEventAppendInput,
} from "#learning";

describe("FridayPreferenceFactService", () => {
  let db: FridaySqliteLayer;
  let service: FridayPreferenceFactService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const factRepo = createFridayPreferenceFactRepository();
    service = createFridayPreferenceFactService({
      db,
      factRepo,
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
      payload: { correctedField: "language", newValue: "TypeScript" },
      ...overrides,
    };
  }

  function makeSignal(
    overrides?: Partial<FridayExtractedSignal>,
  ): FridayExtractedSignal {
    return {
      signalId: "sig-001",
      kind: "correction",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      sourceEventId: "evt-001",
      userId: "test-user",
      ts: NOW,
      ...overrides,
    };
  }

  it("applySignals creates new fact from correction signal", () => {
    const event = makeEvent();
    const signals = [makeSignal()];

    const updated = service.applySignals({
      event,
      signals,
      nowIso: NOW,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]!.key).toBe("pref:language");
    expect(updated[0]!.value).toBe("TypeScript");
    expect(updated[0]!.confidence).toBeGreaterThan(0);
  });

  it("applySignals skips non-preference/correction signals", () => {
    const event = makeEvent();
    const signals = [
      makeSignal({ kind: "error", key: "tool_failure:x:y" }),
      makeSignal({ kind: "positive_feedback", key: "workflow_success:abc" }),
    ];

    const updated = service.applySignals({
      event,
      signals,
      nowIso: NOW,
    });

    expect(updated).toHaveLength(0);
  });

  it("applySignals updates existing fact with higher confidence on same value", () => {
    // First signal
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ confidence: 0.80 })],
      nowIso: NOW,
    });

    // Second signal with same value should boost confidence
    const updated = service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [makeSignal({ confidence: 0.90, sourceEventId: "evt-002" })],
      nowIso: NOW,
    });

    expect(updated).toHaveLength(1);
    // Confidence model: 0.45 * existing + 0.55 * signal + evidenceBoost
    // Should be higher than initial
    expect(updated[0]!.evidenceCount).toBe(2);
  });

  it("applySignals applies conflict penalty when value changes", () => {
    // First signal
    const initial = service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ value: "TypeScript", confidence: 0.80 })],
      nowIso: NOW,
    });
    const initialConf = initial[0]!.confidence;

    // Second signal with different value
    const updated = service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [
        makeSignal({
          value: "Python",
          confidence: 0.80,
          sourceEventId: "evt-002",
        }),
      ],
      nowIso: NOW,
    });

    // Confidence should be lower due to conflict penalty
    expect(updated[0]!.value).toBe("Python");
    expect(updated[0]!.confidence).toBeLessThan(initialConf);
  });

  it("listActiveFacts returns facts above threshold", () => {
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ key: "pref:a", confidence: 0.90 })],
      nowIso: NOW,
    });
    service.applySignals({
      event: makeEvent({ eventId: "evt-002" }),
      signals: [
        makeSignal({
          key: "pref:b",
          confidence: 0.30,
          sourceEventId: "evt-002",
          kind: "preference",
        }),
      ],
      nowIso: NOW,
    });

    const active = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0.60,
      limit: 100,
    });

    expect(active).toHaveLength(1);
    expect(active[0]!.key).toBe("pref:a");
  });

  it("deleteFact removes a fact", () => {
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal()],
      nowIso: NOW,
    });

    const deleted = service.deleteFact({
      userId: "test-user",
      key: "pref:language",
    });
    expect(deleted).toBe(true);

    const remaining = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0,
      limit: 100,
    });
    expect(remaining).toHaveLength(0);
  });

  it("runDecay reduces confidence of stale facts", () => {
    // Insert fact with old lastConfirmedAt
    service.applySignals({
      event: makeEvent(),
      signals: [makeSignal({ confidence: 1.0 })],
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    // Run decay 60 days later (2 half-lives)
    const result = service.runDecay({
      nowIso: "2025-03-02T00:00:00.000Z",
      userId: "test-user",
    });

    expect(result.updated).toBe(1);

    const facts = service.listActiveFacts({
      userId: "test-user",
      minConfidence: 0,
      limit: 100,
    });
    // After 2 half-lives, confidence should be ~0.25
    expect(facts[0]!.confidence).toBeLessThan(0.50);
  });
});
