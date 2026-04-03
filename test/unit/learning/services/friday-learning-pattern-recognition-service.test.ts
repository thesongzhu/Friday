import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayPreferenceFactRepository } from "#learning";
import { createFridayLearningPatternRecognitionService } from "#learning";
import type { FridayLearningPatternRecognitionService } from "#learning";
import type { FridayErrorIncidentEntity } from "#learning";
import { createFridayLearningEventLedger } from "#ledger";

describe("FridayLearningPatternRecognitionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayLearningPatternRecognitionService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const factRepo = createFridayPreferenceFactRepository();
    service = createFridayLearningPatternRecognitionService({
      db,
      incidentRepo,
      factRepo,
      idGenerator: idGen,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("detects recurring incident signatures (>= 3 occurrences)", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert 3 incidents with same signature
    for (let i = 0; i < 3; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-1${i + 2}T10:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: "sig-recurring",
          context: { error: "timeout" },
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const recurring = patterns.filter(
      (p) => p.kind === "recurring_incident_signature",
    );
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.key).toBe("sig-recurring");
    expect(recurring[0]!.occurrences).toBe(3);
    expect(recurring[0]!.strength).toBeGreaterThan(0);
    expect(recurring[0]!.strength).toBeLessThanOrEqual(1);
  });

  it("does not detect incident pattern with < 3 occurrences", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert only 2 incidents
    for (let i = 0; i < 2; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-1${i + 2}T10:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: "sig-rare",
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const recurring = patterns.filter(
      (p) => p.kind === "recurring_incident_signature",
    );
    expect(recurring).toHaveLength(0);
  });

  it("detects recurring correction keys (>= 2 in 14 days)", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Insert 2 correction events for same field
    ledger.appendEvent({
      eventId: "evt-corr-1",
      ts: "2025-06-10T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
    });
    ledger.appendEvent({
      eventId: "evt-corr-2",
      ts: "2025-06-12T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 14,
    });

    const correctionPatterns = patterns.filter(
      (p) => p.kind === "recurring_correction_key",
    );
    expect(correctionPatterns).toHaveLength(1);
    expect(correctionPatterns[0]!.key).toBe("language");
  });

  it("detects correction patterns from legacy field/value payloads", () => {
    const ledger = createFridayLearningEventLedger({ db });

    ledger.appendEvent({
      eventId: "evt-legacy-1",
      ts: "2025-06-10T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { field: "theme", value: "dark" },
    });
    ledger.appendEvent({
      eventId: "evt-legacy-2",
      ts: "2025-06-12T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { field: "theme", value: "light" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    expect(patterns.some((pattern) => pattern.kind === "recurring_correction_key" && pattern.key === "theme")).toBe(true);
    expect(patterns.some((pattern) => pattern.kind === "drifting_preference_key" && pattern.key === "theme")).toBe(true);
  });

  it("detects stable preference keys (evidence >= 4, confidence >= 0.75)", () => {
    const factRepo = createFridayPreferenceFactRepository();

    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-stable",
        userId: "test-user",
        key: "pref:theme",
        value: "dark",
        confidence: 0.90,
        evidenceCountDelta: 5,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const stable = patterns.filter(
      (p) => p.kind === "stable_preference_key",
    );
    expect(stable).toHaveLength(1);
    expect(stable[0]!.key).toBe("pref:theme");
  });

  it("detects drifting preference keys (>= 2 distinct values in 30 days)", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Same field corrected to different values
    ledger.appendEvent({
      eventId: "evt-drift-1",
      ts: "2025-06-01T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "vim" },
    });
    ledger.appendEvent({
      eventId: "evt-drift-2",
      ts: "2025-06-10T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "vscode" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const drifting = patterns.filter(
      (p) => p.kind === "drifting_preference_key",
    );
    expect(drifting).toHaveLength(1);
    expect(drifting[0]!.key).toBe("editor");
    expect(drifting[0]!.occurrences).toBe(2);
  });

  it("contradiction detection matches normalized correctedField to fact key", () => {
    const ledger = createFridayLearningEventLedger({ db });
    const factRepo = createFridayPreferenceFactRepository();

    // Create a stable fact with key "pref:favorite_color"
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-color",
        userId: "test-user",
        key: "pref:favorite_color",
        value: "blue",
        confidence: 0.90,
        evidenceCountDelta: 5,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-color-1",
        nowIso: NOW,
      });
    });

    // Insert a correction with raw "Favorite Color" (unnormalized) in the last 30 days
    ledger.appendEvent({
      eventId: "evt-corr-color",
      ts: "2025-06-14T10:00:00.000Z",
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "Favorite Color", newValue: "red" },
    });

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    // The fact should NOT be "stable" because there's a contradiction
    const stable = patterns.filter(
      (p) => p.kind === "stable_preference_key" && p.key === "pref:favorite_color",
    );
    expect(stable).toHaveLength(0);
  });

  it("returns empty patterns for user with no data", () => {
    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    expect(patterns).toHaveLength(0);
  });

  it("pattern strength is bounded 0..1", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert many incidents to test strength clamping
    for (let i = 0; i < 20; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-15T0${String(i % 10)}:00:00.000Z`,
          category: "tool",
          severity: "high",
          signature: "sig-many",
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    for (const p of patterns) {
      expect(p.strength).toBeGreaterThanOrEqual(0);
      expect(p.strength).toBeLessThanOrEqual(1);
    }
  });

  it("counts recurring incident signatures beyond the old 500-row cap", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    for (let i = 0; i < 520; i++) {
      db.withWriteTransaction((writer) => {
        incidentRepo.insert(writer, {
          incidentId: `inc-many-${i}`,
          userId: "test-user",
          ts: `2025-06-${String((i % 14) + 1).padStart(2, "0")}T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
          category: "tool",
          severity: "high",
          signature: "sig-over-500",
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      });
    }

    const patterns = service.detectUserPatterns({
      userId: "test-user",
      nowIso: NOW,
      lookbackDays: 30,
    });

    const recurring = patterns.find(
      (pattern) =>
        pattern.kind === "recurring_incident_signature" &&
        pattern.key === "sig-over-500",
    );
    expect(recurring).toBeDefined();
    expect(recurring!.occurrences).toBe(520);
  });
});
