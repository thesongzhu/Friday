import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("reuses fact and approval lookups when building a populated learning overview", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listByUserSpy = vi.spyOn(factRepo, "listByUser");
    const listByActionIdsSpy = vi.spyOn(approvalRepo, "listByActionIds");
    const getByActionIdSpy = vi.spyOn(approvalRepo, "getByActionId");
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-02T12:00:00.000Z",
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      actionRepo,
      approvalRepo,
      factRepo,
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

    db.withWriteTransaction((writerDb) => {
      lessonRepo.upsertByFingerprint(writerDb, {
        id: "lesson-1",
        fingerprint: "fp-lesson-1",
        title: "Trim oversized context",
        cause: "The previous run sent too much context",
        fix: "Trim the attached files before retrying",
        nowIso: "2026-04-02T09:00:00.000Z",
      });

      factRepo.upsert(writerDb, {
        factId: "fact-lesson-disabled",
        userId: "test-user",
        key: "lesson_disabled:lesson-1",
        value: {
          disabled: true,
          reason: "Operator disabled this lesson after a false positive",
        },
        confidence: 0.92,
        evidenceCountDelta: 1,
        lastConfirmedAt: "2026-04-02T09:01:00.000Z",
        sourceEventId: "evt-lesson-disabled",
        nowIso: "2026-04-02T09:01:00.000Z",
      });

      writerDb
        .prepare(
          `INSERT INTO friday_learned_patterns
             (id, user_id, kind, description, pattern_json, confidence, sample_count, last_updated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "pattern-1",
          "test-user",
          "tool_sequence",
          "Repeatedly trims large payloads before retrying",
          JSON.stringify({ tool: "trim_context", successRate: 0.8 }),
          0.81,
          7,
          "2026-04-02T09:02:00.000Z",
          "2026-04-01T09:02:00.000Z",
        );

      factRepo.upsert(writerDb, {
        factId: "fact-pattern-demotion",
        userId: "test-user",
        key: "pattern_demotion:pattern-1",
        value: {
          factor: 0.25,
          reason: "Operator marked this pattern as low-value",
        },
        confidence: 0.88,
        evidenceCountDelta: 1,
        lastConfirmedAt: "2026-04-02T09:03:00.000Z",
        sourceEventId: "evt-pattern-demotion",
        nowIso: "2026-04-02T09:03:00.000Z",
      });

      factRepo.upsert(writerDb, {
        factId: "fact-route-penalty",
        userId: "test-user",
        key: "route_penalty:task-triage",
        value: {
          providerId: "openai",
          model: "gpt-5",
          backendKind: "http",
        },
        confidence: 0.77,
        evidenceCountDelta: 1,
        lastConfirmedAt: "2026-04-02T09:04:00.000Z",
        sourceEventId: "evt-route-penalty",
        nowIso: "2026-04-02T09:04:00.000Z",
      });

      incidentRepo.insert(writerDb, {
        incidentId: "incident-1",
        userId: "test-user",
        ts: "2026-04-02T09:05:00.000Z",
        category: "routing",
        severity: "high",
        signature: "routing:openai:gpt-5",
        context: { route: "openai:gpt-5" },
        autoFixEligible: true,
        status: "open",
        createdAt: "2026-04-02T09:05:00.000Z",
        updatedAt: "2026-04-02T09:05:00.000Z",
      });

      actionRepo.insert(writerDb, {
        actionId: "action-1",
        incidentId: "incident-1",
        userId: "test-user",
        riskTier: 2,
        plan: {
          title: "Downgrade to a safer route",
          summary: "Switch the failing task to a lower-cost fallback",
          steps: [],
          evidence: {
            fingerprint: "routing:openai:gpt-5",
            matchedLessonIds: ["lesson-1"],
            diagnosisId: "diag-1",
            recurrenceCount: 3,
          },
        },
        status: "rejected",
        outcome: null,
        createdAt: "2026-04-02T09:06:00.000Z",
        updatedAt: "2026-04-02T09:07:00.000Z",
      });

      approvalRepo.insert(writerDb, {
        requestId: "approval-1",
        actionId: "action-1",
        userId: "test-user",
        description: "Approve route downgrade",
        riskTier: 2,
        plan: {
          title: "Downgrade to a safer route",
          summary: "Switch the failing task to a lower-cost fallback",
          steps: [],
          evidence: {
            fingerprint: "routing:openai:gpt-5",
            matchedLessonIds: ["lesson-1"],
            diagnosisId: "diag-1",
            recurrenceCount: 3,
          },
        },
        requestedAt: "2026-04-02T09:06:30.000Z",
        expiresAt: "2026-04-02T10:06:30.000Z",
        status: "rejected",
        responseReason: "Need a safer remediation plan",
        respondedAt: "2026-04-02T09:07:00.000Z",
        respondedBy: "test-user",
        createdAt: "2026-04-02T09:06:30.000Z",
        updatedAt: "2026-04-02T09:07:00.000Z",
      });
    });

    const overview = service.getLearningOverview({ userId: "test-user", limit: 10 });

    expect(listByUserSpy).toHaveBeenCalledTimes(1);
    expect(listByActionIdsSpy).toHaveBeenCalledTimes(1);
    expect(getByActionIdSpy).not.toHaveBeenCalled();
    expect(overview.lessons).toEqual([
      expect.objectContaining({
        disabled: true,
        disabledReason: "Operator disabled this lesson after a false positive",
      }),
    ]);
    expect(overview.patterns).toEqual([
      expect.objectContaining({
        patternId: "pattern-1",
        demoted: true,
        demotionFactor: 0.25,
        demotionReason: "Operator marked this pattern as low-value",
      }),
    ]);
    expect(overview.routeAdjustments).toEqual([
      expect.objectContaining({
        kind: "penalty",
        key: "route_penalty:task-triage",
        taskProfileId: "task-triage",
        providerId: "openai",
        model: "gpt-5",
        backendKind: "http",
      }),
    ]);
    expect(overview.rejectedFixes).toEqual([
      expect.objectContaining({
        actionId: "action-1",
        incidentId: "incident-1",
        title: "Downgrade to a safer route",
        fingerprint: "routing:openai:gpt-5",
        reason: "Need a safer remediation plan",
      }),
    ]);
    expect(overview.coverage).toMatchObject({
      lessons: 1,
      patterns: 1,
      routeAdjustments: 1,
      rejectedFixes: 1,
      incidents: 1,
      autoFixActions: 1,
    });
  });
});
