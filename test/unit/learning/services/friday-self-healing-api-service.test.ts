import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
  createFridaySelfLearningRuntime,
} from "#learning";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-04-04T02:00:00.000Z";

describe("FridaySelfHealingApiService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns a learning overview when incidents table is absent", () => {
    const idGenerator = createTestIdGenerator();
    const runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => NOW,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      lessonRepo: createFridayLearnedLessonRepository(),
      actionRepo: createFridayAutoFixActionRepository(),
      approvalRepo: createFridayApprovalRequestRepository(),
      factRepo: createFridayPreferenceFactRepository(),
      diagnosisService: runtime.diagnosis,
      planService: runtime.autoFixPlan,
      riskService: runtime.autoFixRisk,
      executionService: runtime.autoFixExecution,
      rollbackService: runtime.autoFixRollback,
      approvalService: runtime.approvals,
      autoFixDispatcher: runtime.autoFixDispatcher,
      metricsService: runtime.metrics,
      pipeline: runtime.pipeline,
    });

    const overview = service.getLearningOverview({ userId: "user-1", limit: 10 });

    expect(overview.coverage.incidents).toBe(0);
    expect(overview.lessons).toEqual([]);
    expect(overview.patterns).toEqual([]);
  });
});
