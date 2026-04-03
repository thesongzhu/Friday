import { afterEach, describe, expect, it } from "vitest";

import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import {
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
} from "#learning";

describe("FridaySelfHealingApiService", () => {
  const allocatedDbs: ReturnType<typeof createTestDb>[] = [];

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("returns an empty learning overview on a fresh database", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-02T12:00:00.000Z",
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      lessonRepo: createFridayLearnedLessonRepository(),
      actionRepo: createFridayAutoFixActionRepository(),
      approvalRepo: createFridayApprovalRequestRepository(),
      factRepo: createFridayPreferenceFactRepository(),
      diagnosisService: {} as never,
      planService: {} as never,
      riskService: {} as never,
      executionService: {} as never,
      rollbackService: {} as never,
      approvalService: {} as never,
      autoFixDispatcher: {} as never,
      metricsService: {} as never,
      pipeline: {} as never,
    });

    const overview = service.getLearningOverview({ userId: "user-1", limit: 10 });

    expect(overview.coverage).toMatchObject({
      lessons: 0,
      patterns: 0,
      routeAdjustments: 0,
      recentDecisionDiffs: 0,
      blockedRoutes: 0,
      rejectedFixes: 0,
      rollbackHotspots: 0,
      incidents: 0,
      diagnoses: 0,
      autoFixActions: 0,
    });
    expect(overview.lessons).toEqual([]);
    expect(overview.patterns).toEqual([]);
    expect(overview.blockedRoutes).toEqual([]);
  });
});
