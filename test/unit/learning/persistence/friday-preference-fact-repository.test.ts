import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayPreferenceFactRepository } from "#learning";
import type { FridayPreferenceFactRepository } from "#learning";

describe("FridayPreferenceFactRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayPreferenceFactRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayPreferenceFactRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("upsert inserts a new fact", () => {
    const fact = repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    expect(fact.factId).toBe("fact-001");
    expect(fact.key).toBe("pref:language");
    expect(fact.value).toBe("TypeScript");
    expect(fact.confidence).toBe(0.85);
    expect(fact.evidenceCount).toBe(1);
    expect(fact.sourceEventIds).toEqual(["evt-001"]);
  });

  it("upsert updates an existing fact by user+key", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    const updated = repo.upsert(db.writer, {
      factId: "fact-002", // different id, same user+key
      userId: "test-user",
      key: "pref:language",
      value: "Python",
      confidence: 0.90,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2025-06-16T10:00:00.000Z",
      sourceEventId: "evt-002",
      nowIso: "2025-06-16T10:00:00.000Z",
    });

    expect(updated.factId).toBe("fact-001"); // keeps original factId
    expect(updated.value).toBe("Python");
    expect(updated.confidence).toBe(0.90);
    expect(updated.evidenceCount).toBe(2);
    expect(updated.sourceEventIds).toEqual(["evt-001", "evt-002"]);
  });

  it("upsert does not duplicate source event ids", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.90,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001", // same event id
      nowIso: NOW,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.sourceEventIds).toEqual(["evt-001"]);
  });

  it("getByUserAndKey returns null for non-existent key", () => {
    const result = repo.getByUserAndKey(db.writer, "test-user", "pref:nonexistent");
    expect(result).toBeNull();
  });

  it("listByUser filters by minConfidence", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:a",
      value: "a",
      confidence: 0.30,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-002",
      userId: "test-user",
      key: "pref:b",
      value: "b",
      confidence: 0.80,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-002",
      nowIso: NOW,
    });

    const all = repo.listByUser(db.writer, "test-user", 0);
    expect(all).toHaveLength(2);

    const highOnly = repo.listByUser(db.writer, "test-user", 0.50);
    expect(highOnly).toHaveLength(1);
    expect(highOnly[0]!.key).toBe("pref:b");
  });

  it("listByUser respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.upsert(db.writer, {
        factId: `fact-${i}`,
        userId: "test-user",
        key: `pref:key${i}`,
        value: `val${i}`,
        confidence: 0.80,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: `evt-${i}`,
        nowIso: NOW,
      });
    }

    const limited = repo.listByUser(db.writer, "test-user", 0, 3);
    expect(limited).toHaveLength(3);
  });

  it("listByUserWithThresholds filters by confidence and evidence count", () => {
    repo.upsert(db.writer, {
      factId: "fact-low-evidence",
      userId: "test-user",
      key: "pref:editor",
      value: "vim",
      confidence: 0.95,
      evidenceCountDelta: 2,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-low-evidence",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-low-confidence",
      userId: "test-user",
      key: "pref:theme",
      value: "dark",
      confidence: 0.7,
      evidenceCountDelta: 5,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-low-confidence",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-strong",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.92,
      evidenceCountDelta: 5,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-strong",
      nowIso: NOW,
    });

    const matching = repo.listByUserWithThresholds(db.writer, {
      userId: "test-user",
      minConfidence: 0.75,
      minEvidenceCount: 4,
    });

    expect(matching.map((fact) => fact.key)).toEqual(["pref:language"]);
  });

  it("listByUserAndKeyPrefixes returns only matching prefixed facts", () => {
    repo.upsert(db.writer, {
      factId: "fact-route",
      userId: "test-user",
      key: "route_penalty:triage",
      value: { providerId: "openai" },
      confidence: 0.8,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-route",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-pattern",
      userId: "test-user",
      key: "pattern_demotion:pattern-1",
      value: { factor: 0.2 },
      confidence: 0.7,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-pattern",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-pref",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.95,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-pref",
      nowIso: NOW,
    });

    const matching = repo.listByUserAndKeyPrefixes(db.writer, {
      userId: "test-user",
      keyPrefixes: ["route_penalty:", "pattern_demotion:"],
    });

    expect(matching.map((fact) => fact.key)).toEqual([
      "route_penalty:triage",
      "pattern_demotion:pattern-1",
    ]);
  });

  it("listByUserAndKeys returns only the requested keys in input order", () => {
    repo.upsert(db.writer, {
      factId: "fact-route",
      userId: "test-user",
      key: "route_penalty:triage",
      value: { providerId: "openai" },
      confidence: 0.8,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-route",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-pattern",
      userId: "test-user",
      key: "pattern_demotion:pattern-1",
      value: { factor: 0.2 },
      confidence: 0.7,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-pattern",
      nowIso: NOW,
    });
    repo.upsert(db.writer, {
      factId: "fact-pref",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.95,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-pref",
      nowIso: NOW,
    });

    const matching = repo.listByUserAndKeys(db.writer, {
      userId: "test-user",
      keys: ["pattern_demotion:pattern-1", "route_penalty:triage"],
    });

    expect(matching.map((fact) => fact.key)).toEqual([
      "pattern_demotion:pattern-1",
      "route_penalty:triage",
    ]);
  });

  it("deleteByUserAndKey removes fact and returns true", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.85,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "evt-001",
      nowIso: NOW,
    });

    const deleted = repo.deleteByUserAndKey(db.writer, "test-user", "pref:language");
    expect(deleted).toBe(true);

    const result = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(result).toBeNull();
  });

  it("deleteByUserAndKey returns false for non-existent", () => {
    const deleted = repo.deleteByUserAndKey(db.writer, "test-user", "pref:nonexistent");
    expect(deleted).toBe(false);
  });

  it("applyDecay reduces confidence over time", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2025-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    // 30 days later = one half-life
    const updated = repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-01-31T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    expect(updated).toBe(1);

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    // After one half-life, confidence should be ~0.5
    expect(fact!.confidence).toBeCloseTo(0.5, 1);
  });

  it("applyDecay respects minimum floor", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 0.10,
      evidenceCountDelta: 1,
      lastConfirmedAt: "2024-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2024-01-01T00:00:00.000Z",
    });

    // 365 days later — confidence should decay heavily but not below floor
    repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-01-01T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.confidence).toBeGreaterThanOrEqual(0.05);
  });

  it("applyDecay does not mutate evidence_count", () => {
    repo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "pref:language",
      value: "TypeScript",
      confidence: 1.0,
      evidenceCountDelta: 3,
      lastConfirmedAt: "2025-01-01T00:00:00.000Z",
      sourceEventId: "evt-001",
      nowIso: "2025-01-01T00:00:00.000Z",
    });

    repo.applyDecay(db.writer, {
      userId: "test-user",
      nowIso: "2025-02-01T00:00:00.000Z",
      halfLifeDays: 30,
      minConfidenceFloor: 0.05,
    });

    const fact = repo.getByUserAndKey(db.writer, "test-user", "pref:language");
    expect(fact!.evidenceCount).toBe(3);
  });
});
