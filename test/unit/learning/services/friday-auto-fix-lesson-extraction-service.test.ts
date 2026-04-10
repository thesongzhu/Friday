import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAutoFixLessonExtractionService,
  createFridayLearnedLessonRepository,
  createFridayErrorIncidentRepository,
  createFridayDiagnosisRecordRepository,
} from "#learning";
import type {
  FridayAutoFixLessonExtractionService,
  FridayAutoFixActionEntity,
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
} from "#learning";

describe("FridayAutoFixLessonExtractionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixLessonExtractionService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  let incidentRepo: ReturnType<typeof createFridayErrorIncidentRepository>;
  let diagnosisRepo: ReturnType<typeof createFridayDiagnosisRecordRepository>;

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-tool-crash",
    context: {},
    autoFixEligible: true,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseDiagnosis: FridayDiagnosisRecordEntity = {
    id: "diag-001",
    incidentId: "inc-001",
    errorFingerprint: "sig-tool-crash",
    diagnosis: { summary: "Tool crashed due to timeout" },
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseAction: FridayAutoFixActionEntity = {
    actionId: "action-001",
    incidentId: "inc-001",
    diagnosisId: "diag-001",
    userId: "test-user",
    plan: {
      title: "Retry with longer timeout",
      summary: "Increase timeout from 5s to 30s and retry",
      steps: [
        { stepId: "step-1", kind: "retry_node", target: "tool", payload: {}, verify: { method: "error_absent", timeoutMs: 5000 } },
      ],
      evidence: {
        fingerprint: "sig-tool-crash",
        matchedLessonIds: [],
        diagnosisId: "diag-001",
        recurrenceCount: 1,
      },
    },
    riskTier: "low",
    outcome: "success",
    rollbackOutcome: undefined,
    executedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    incidentRepo = createFridayErrorIncidentRepository();
    diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();

    // Seed incident and diagnosis
    incidentRepo.insert(db.writer, baseIncident);
    diagnosisRepo.insert(db.writer, {
      id: baseDiagnosis.id,
      incidentId: baseDiagnosis.incidentId,
      errorFingerprint: baseDiagnosis.errorFingerprint,
      confidence: baseDiagnosis.confidence,
      diagnosis: baseDiagnosis.diagnosis,
      createdAt: baseDiagnosis.createdAt,
      updatedAt: baseDiagnosis.updatedAt,
    });

    service = createFridayAutoFixLessonExtractionService({
      db,
      lessonRepo,
      incidentRepo,
      diagnosisRepo,
      idGenerator: idGen,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("extracts lesson from successful auto-fix action", () => {
    const lesson = service.extractFromSuccess({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: baseAction,
      nowIso: NOW,
    });

    expect(lesson).not.toBeNull();
    expect(lesson!.title).toContain("Auto-fixed");
    expect(lesson!.title).toContain("Retry with longer timeout");
    expect(lesson!.cause).toBe("Tool crashed due to timeout");
    expect(lesson!.fix).toBe("Increase timeout from 5s to 30s and retry");
  });

  it("returns null for non-success outcome", () => {
    const failedAction = {
      ...baseAction,
      outcome: "failure" as const,
    };

    const lesson = service.extractFromSuccess({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: failedAction,
      nowIso: NOW,
    });

    expect(lesson).toBeNull();
  });

  it("includes mitigation metadata in extracted lesson", () => {
    const lesson = service.extractFromSuccess({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: baseAction,
      nowIso: NOW,
    });

    expect(lesson).not.toBeNull();
    const mitigation = lesson!.mitigation as Record<string, unknown>;
    expect(mitigation.autoFixApplied).toBe(true);
    expect(mitigation.planTitle).toBe("Retry with longer timeout");
    expect(mitigation.riskTier).toBe("low");
    expect(mitigation.stepsApplied).toEqual(["retry_node"]);
  });

  it("uses incident signature as fingerprint", () => {
    const lesson = service.extractFromSuccess({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: baseAction,
      nowIso: NOW,
    });

    expect(lesson).not.toBeNull();
    expect(lesson!.fingerprint).toBe("sig-tool-crash");
  });

  it("extracts lesson from failed auto-fix action", () => {
    const failedAction: FridayAutoFixActionEntity = {
      ...baseAction,
      outcome: "failed" as FridayAutoFixActionEntity["outcome"],
    };

    const lesson = service.extractFromFailure({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: failedAction,
      nowIso: NOW,
    });

    expect(lesson).not.toBeNull();
    expect(lesson!.title).toContain("Failed fix");
    const mitigation = lesson!.mitigation as Record<string, unknown>;
    expect(mitigation.autoFixFailed).toBe(true);
    expect(mitigation.failedSteps).toEqual(["retry_node"]);
  });

  it("extractFromFailure returns null for success outcome", () => {
    const lesson = service.extractFromFailure({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      action: baseAction,
      nowIso: NOW,
    });

    expect(lesson).toBeNull();
  });
});
