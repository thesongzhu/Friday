import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySelfLearningRuntime } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridaySelfLearningRuntime } from "#learning";
import type { FridayAutoFixPlan } from "#learning";
import type { FridayLearningEventAppendInput } from "#ledger";

describe("FridaySelfLearningRuntime", () => {
  let db: FridaySqliteLayer;
  let runtime: FridaySelfLearningRuntime;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("composes all services correctly", () => {
    expect(runtime.events).toBeDefined();
    expect(runtime.extraction).toBeDefined();
    expect(runtime.facts).toBeDefined();
    expect(runtime.patterns).toBeDefined();
    expect(runtime.feedback).toBeDefined();
    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.context).toBeDefined();
    expect(runtime.metrics).toBeDefined();
    expect(runtime.pipeline).toBeDefined();
    expect(runtime.diagnosis).toBeDefined();
    expect(runtime.autoFixPlan).toBeDefined();
    expect(runtime.autoFixRisk).toBeDefined();
    expect(runtime.autoFixExecution).toBeDefined();
    expect(runtime.approvals).toBeDefined();
    expect(runtime.autoFixDispatcher).toBeDefined();
  });

  it("events service collects and deduplicates events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const r1 = runtime.events.collect(event);
    expect(r1.inserted).toBe(true);

    const r2 = runtime.events.collect(event);
    expect(r2.inserted).toBe(false);
  });

  it("extraction service produces signals deterministically", () => {
    const signals1 = runtime.extraction.extract({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "theme", newValue: "dark" },
    });

    expect(signals1).toHaveLength(1);
    expect(signals1[0]!.kind).toBe("correction");
    expect(signals1[0]!.key).toBe("pref:theme");
  });

  it("lifecycle starts at cold_start for new users", () => {
    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("cold_start");
  });

  it("lifecycle transitions to warmup after enough facts", () => {
    // Insert 3 facts to trigger warmup (default warmupFactCount = 3)
    for (let i = 0; i < 3; i++) {
      runtime.pipeline.processEvent({
        eventId: `evt-${i}`,
        ts: NOW,
        userId: "test-user",
        kind: "user_correction",
        payload: { correctedField: `field${i}`, newValue: `val${i}` },
      });
    }

    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("warmup");
  });

  it("feedback service accepts corrections and updates facts", () => {
    const correctionEvent: FridayLearningEventAppendInput = {
      eventId: "evt-feedback-1",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "timezone", newValue: "UTC" },
    };

    const result = runtime.feedback.applyCorrection(correctionEvent);
    expect(result.accepted).toBe(true);
    expect(result.updatedFacts).toHaveLength(1);
    expect(result.updatedFacts[0]!.key).toBe("pref:timezone");
    expect(result.updatedFacts[0]!.value).toBe("UTC");
  });

  it("feedback service rejects non-correction events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const result = runtime.feedback.applyCorrection(event);
    expect(result.accepted).toBe(false);
    expect(result.updatedFacts).toHaveLength(0);
  });

  it("context enrichment builds context and enriches payloads", () => {
    // Process a correction to create a fact
    runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
    });

    // Enrich a payload
    const enriched = runtime.context.enrichSkillPayload({
      userId: "test-user",
      payload: { task: "compile" },
      nowIso: NOW,
    });

    expect(enriched).toHaveProperty("task", "compile");
    expect(enriched).toHaveProperty("__fridayLearning");
  });

  it("pipeline end-to-end: correction → fact → context", () => {
    // 1. Process correction
    const result = runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "nvim" },
    });

    expect(result.inserted).toBe(true);
    expect(result.factsUpdated).toHaveLength(1);

    // 2. Verify fact is active
    const facts = runtime.facts.listActiveFacts({
      userId: "test-user",
      minConfidence: 0.0,
      limit: 10,
    });
    expect(facts.some((f) => f.key === "pref:editor")).toBe(true);

    // 3. Verify context includes the preference
    const ctx = runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });
    expect(ctx.preferences).toHaveProperty("pref:editor", "nvim");
  });

  it("pipeline end-to-end: explicit user-message preference is active on first evidence", () => {
    const result = runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "call me Captain" },
    });

    expect(result.factsUpdated).toHaveLength(1);
    expect(result.factsUpdated[0]!.key).toBe("pref:display_name");
    expect(result.factsUpdated[0]!.confidence).toBeGreaterThanOrEqual(0.60);

    const ctx = runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });
    expect(ctx.preferences).toHaveProperty("pref:display_name", "Captain");
  });

  it("pipeline end-to-end: inferred persona preference stays inactive until explicit confirmation", () => {
    const first = runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "Can you be more concise in your answers?" },
    });

    expect(first.factsUpdated).toHaveLength(1);
    expect(first.factsUpdated[0]!.key).toBe("persona.verbosity");
    expect(first.factsUpdated[0]!.confidence).toBeLessThan(0.60);
    expect(runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    }).preferences).not.toHaveProperty("persona.verbosity");

    const second = runtime.pipeline.processEvent({
      eventId: "evt-002",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "please be more concise" },
    });

    expect(second.factsUpdated).toHaveLength(1);
    expect(second.factsUpdated[0]!.confidence).toBeLessThan(0.60);
    expect(runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    }).preferences).not.toHaveProperty("persona.verbosity");
  });

  it("pipeline end-to-end: error → incident → diagnosis (Phase 7: no lesson at ingestion)", () => {
    const result = runtime.pipeline.processEvent({
      eventId: "evt-err-001",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { category: "tool", message: "api_timeout" },
    });

    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.diagnosisCreated).toHaveLength(1);
    // Phase 7: lessons are NOT created during ingestion — they're extracted after successful execution
    expect(result.lessonsUpdated).toHaveLength(0);
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false);
  });

  it("wires injected step executors and verifiers into autoFixExecution", async () => {
    const retryExecutorCalled: string[] = [];
    const retryVerifierCalled: string[] = [];
    runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: async (step) => {
          retryExecutorCalled.push(step.stepId);
          return true;
        },
      },
      stepVerifiers: {
        retry_node: async (step) => {
          retryVerifierCalled.push(step.stepId);
          return true;
        },
      },
    });

    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const actionRepo = createFridayAutoFixActionRepository();

    incidentRepo.insert(db.writer, {
      incidentId: "inc-runtime-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-runtime",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-runtime-001",
      incidentId: "inc-runtime-001",
      errorFingerprint: "sig-runtime",
      confidence: 0.8,
      diagnosis: { summary: "runtime wiring test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const plan: FridayAutoFixPlan = {
      title: "Retry node",
      summary: "Retry the failed node",
      steps: [
        {
          stepId: "step-runtime-001",
          kind: "retry_node",
          target: "tool",
          payload: {},
          verify: { method: "error_absent", timeoutMs: 5000 },
        },
      ],
      evidence: {
        fingerprint: "sig-runtime",
        matchedLessonIds: [],
        diagnosisId: "diag-runtime-001",
        recurrenceCount: 1,
      },
    };

    actionRepo.insert(db.writer, {
      actionId: "action-runtime-001",
      incidentId: "inc-runtime-001",
      userId: "test-user",
      riskTier: 0,
      plan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await runtime.autoFixExecution.execute("action-runtime-001");

    expect(result.success).toBe(true);
    expect(retryExecutorCalled).toEqual(["step-runtime-001"]);
    expect(retryVerifierCalled).toEqual(["step-runtime-001"]);
  });
});
