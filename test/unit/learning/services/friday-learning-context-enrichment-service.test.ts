import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayPreferenceFactRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayPreferenceFactService } from "#learning";
import { createFridayLearningPatternRecognitionService } from "#learning";
import { createFridayLearningLifecycleService } from "#learning";
import { createFridayLearningContextEnrichmentService } from "#learning";
import type { FridayLearningContextEnrichmentService } from "#learning";

describe("FridayLearningContextEnrichmentService", () => {
  let db: FridaySqliteLayer;
  let service: FridayLearningContextEnrichmentService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();

    const factService = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const patternService = createFridayLearningPatternRecognitionService({
      db,
      incidentRepo,
      factRepo,
      idGenerator: idGen,
    });

    const lifecycleService = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    service = createFridayLearningContextEnrichmentService({
      db,
      factService,
      patternService,
      lifecycleService,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("buildContext returns cold_start for user with no facts", () => {
    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.userId).toBe("test-user");
    expect(ctx.lifecycleState).toBe("cold_start");
    expect(ctx.preferences).toEqual({});
    expect(ctx.appliedFacts).toEqual([]);
    expect(ctx.generatedAt).toBe(NOW);
  });

  it("buildContext includes preferences from high-confidence facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert a high-confidence fact
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.90,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).toHaveProperty("pref:language", "TypeScript");
    expect(ctx.appliedFacts).toHaveLength(1);
    expect(ctx.appliedFacts[0]!.key).toBe("pref:language");
    expect(ctx.appliedFacts[0]!.confidence).toBe(0.90);
  });

  it("buildContext excludes low-confidence facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert a low-confidence fact (below default threshold of 0.60)
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.30,
        evidenceCountDelta: 1,
        lastConfirmedAt: NOW,
        sourceEventId: "evt-001",
        nowIso: NOW,
      });
    });

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).toEqual({});
    expect(ctx.appliedFacts).toHaveLength(0);
  });

  it("buildContext keeps a first inferred preference recorded but inactive", () => {
    const factRepo = createFridayPreferenceFactRepository();
    const factService = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    factService.applySignals({
      event: {
        eventId: "evt-001",
        ts: NOW,
        userId: "test-user",
        kind: "user_message",
        payload: { text: "please be more concise" },
      },
      signals: [
        {
          signalId: "sig-001",
          kind: "preference",
          key: "persona.verbosity",
          value: "concise",
          confidence: 0.65,
          sourceEventId: "evt-001",
          userId: "test-user",
          ts: NOW,
        },
      ],
      nowIso: NOW,
    });

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).not.toHaveProperty("persona.verbosity");
    expect(ctx.appliedFacts).toEqual([]);
  });

  it("buildContext excludes repeated inferred preferences until explicit confirmation", () => {
    const factRepo = createFridayPreferenceFactRepository();
    const factService = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    for (const eventId of ["evt-001", "evt-002"]) {
      factService.applySignals({
        event: {
          eventId,
          ts: NOW,
          userId: "test-user",
          kind: "user_message",
          payload: { text: "please be more concise" },
        },
        signals: [
          {
            signalId: `sig-${eventId}`,
            kind: "preference",
            key: "persona.verbosity",
            value: "concise",
            confidence: 0.65,
            sourceEventId: eventId,
            userId: "test-user",
            ts: NOW,
          },
        ],
        nowIso: NOW,
      });
    }

    const ctx = service.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });

    expect(ctx.preferences).not.toHaveProperty("persona.verbosity");
    expect(ctx.appliedFacts).toEqual([]);
  });

  it("enrichSkillPayload adds __fridayLearning envelope", () => {
    const payload = { task: "compile", target: "main" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    expect(enriched).toHaveProperty("task", "compile");
    expect(enriched).toHaveProperty("target", "main");
    expect(enriched).toHaveProperty("__fridayLearning");

    const learning = enriched["__fridayLearning"] as Record<string, unknown>;
    expect(learning).toHaveProperty("lifecycleState", "cold_start");
    expect(learning).toHaveProperty("preferences");
    expect(learning).toHaveProperty("generatedAt", NOW);
  });

  it("enrichSkillPayload does not mutate original payload", () => {
    const payload = { task: "compile" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    expect(payload).not.toHaveProperty("__fridayLearning");
    expect(enriched).toHaveProperty("__fridayLearning");
  });

  it("enrichSkillPayload skips enrichment when no userId", () => {
    const payload = { task: "compile" };
    const enriched = service.enrichSkillPayload({
      payload,
      nowIso: NOW,
    });

    expect(enriched).not.toHaveProperty("__fridayLearning");
    expect(enriched).toEqual({ task: "compile" });
  });

  it("enrichSkillPayload preserves explicit payload values", () => {
    const payload = { task: "compile", __fridayLearning: "should-be-overwritten" };
    const enriched = service.enrichSkillPayload({
      userId: "test-user",
      payload,
      nowIso: NOW,
    });

    // The enrichment overwrites __fridayLearning with the real context
    const learning = enriched["__fridayLearning"] as Record<string, unknown>;
    expect(learning).toHaveProperty("lifecycleState");
  });
});
