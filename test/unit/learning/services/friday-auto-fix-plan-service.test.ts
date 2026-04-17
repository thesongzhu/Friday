import { describe, it, expect, beforeEach } from "vitest";
import { createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixPlanService } from "#learning";
import type { FridayAutoFixPlanService } from "#learning";
import type { FridayErrorIncidentEntity, FridayDiagnosisRecordEntity, FridayLearnedLessonEntity } from "#learning";

describe("FridayAutoFixPlanService", () => {
  let service: FridayAutoFixPlanService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-abc",
    context: {},
    autoFixEligible: true,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseDiagnosis: FridayDiagnosisRecordEntity = {
    id: "diag-001",
    incidentId: "inc-001",
    errorFingerprint: "sig-abc",
    confidence: 0.8,
    diagnosis: { summary: "Tool timeout" },
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseLesson: FridayLearnedLessonEntity = {
    id: "lesson-001",
    fingerprint: "sig-abc",
    title: "Tool Timeout Fix",
    cause: "Network latency",
    fix: "Increase timeout to 30s",
    occurrences: 3,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    idGen = createTestIdGenerator();
    service = createFridayAutoFixPlanService({ idGenerator: idGen });
  });

  it("builds a plan from matched lessons", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 3,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]!.title).toContain("Tool Timeout Fix");
    expect(plans[0]!.steps).toHaveLength(1);
    expect(plans[0]!.steps[0]!.kind).toBe("retry_node");
    expect(plans[0]!.evidence.fingerprint).toBe("sig-abc");
    expect(plans[0]!.evidence.matchedLessonIds).toEqual(["lesson-001"]);
  });

  it("builds a fallback plan when no lessons match", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [],
      recurrenceCount: 1,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]!.title).toContain("retry");
    expect(plans[0]!.steps).toHaveLength(1);
  });

  it("maps model category to switch_model_fallback", () => {
    const modelIncident = {
      ...baseIncident,
      category: "model" as const,
      context: {
        providerId: "provider-primary",
        actualProviderId: "provider-primary",
        model: "claude-sonnet-4-5",
        actualModel: "claude-sonnet-4-5",
        fallbackProviderIds: ["provider-secondary", "provider-tertiary"],
      },
    };
    const plans = service.buildPlans({
      incident: modelIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("switch_model_fallback");
    expect(plans[0]!.steps[0]!.payload).toMatchObject({
      fallbackProviderIds: ["provider-secondary", "provider-tertiary"],
      fallbackProviderId: "provider-secondary",
      nextProviderId: "provider-secondary",
    });
    expect(plans[0]!.rollbackPlan).toBeDefined();
    expect(plans[0]!.rollbackPlan!.steps[0]!.payload).toMatchObject({
      restoreProviderId: "provider-primary",
      restoreModel: "claude-sonnet-4-5",
      restoreFallbackProviderIds: ["provider-secondary", "provider-tertiary"],
    });
  });

  it("maps config category to apply_config_patch with rollback", () => {
    const configIncident = { ...baseIncident, category: "config" as const };
    const plans = service.buildPlans({
      incident: configIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("apply_config_patch");
    expect(plans[0]!.rollbackPlan).toBeDefined();
    expect(plans[0]!.rollbackPlan!.steps).toHaveLength(1);
  });

  it("maps routing category to trim_payload", () => {
    const routingIncident = { ...baseIncident, category: "routing" as const };
    const plans = service.buildPlans({
      incident: routingIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("trim_payload");
  });

  it("includes evidence metadata in plans", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 5,
    });

    expect(plans[0]!.evidence.diagnosisId).toBe("diag-001");
    expect(plans[0]!.evidence.recurrenceCount).toBe(5);
  });

  it("builds plans for multiple lessons", () => {
    const lesson2: FridayLearnedLessonEntity = {
      ...baseLesson,
      id: "lesson-002",
      title: "Alternative Fix",
      fix: "Switch to backup API",
    };

    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson, lesson2],
      recurrenceCount: 2,
    });

    expect(plans).toHaveLength(2);
    expect(plans[0]!.title).toContain("Tool Timeout Fix");
    expect(plans[1]!.title).toContain("Alternative Fix");
  });
});
