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
    const listRejectedByUserSpy = vi.spyOn(actionRepo, "listRejectedByUser");
    const summarizeRecentHotspotsSpy = vi.spyOn(actionRepo, "summarizeRecentHotspots");
    const listActionsByUserSpy = vi.spyOn(actionRepo, "listByUser");
    const listByUserPrefixesSpy = vi.spyOn(factRepo, "listByUserAndKeyPrefixes");
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

    expect(listRejectedByUserSpy).toHaveBeenCalledTimes(1);
    expect(summarizeRecentHotspotsSpy).toHaveBeenCalledTimes(1);
    expect(listActionsByUserSpy).not.toHaveBeenCalled();
    expect(listByUserPrefixesSpy).toHaveBeenCalledTimes(1);
    expect(listByUserSpy).not.toHaveBeenCalled();
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

  it("batches action and incident lookups when building issue cards", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listActionIdsSpy = vi.spyOn(actionRepo, "listByIds");
    const getActionByIdSpy = vi.spyOn(actionRepo, "getById");
    const listIncidentIdsSpy = vi.spyOn(incidentRepo, "listByIds");
    const getIncidentByIdSpy = vi.spyOn(incidentRepo, "getById");
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
      for (const index of [1, 2, 3]) {
        incidentRepo.insert(writerDb, {
          incidentId: `incident-${index}`,
          userId: "test-user",
          ts: `2026-04-02T09:0${index}:00.000Z`,
          category: "workflow",
          severity: index === 1 ? "high" : "medium",
          signature: `workflow:signature:${index}`,
          context: { incident: index },
          autoFixEligible: true,
          status: "open",
          createdAt: `2026-04-02T09:0${index}:00.000Z`,
          updatedAt: `2026-04-02T09:0${index}:00.000Z`,
        });

        actionRepo.insert(writerDb, {
          actionId: `action-${index}`,
          incidentId: `incident-${index}`,
          userId: "test-user",
          riskTier: 2,
          plan: {
            title: `Fix workflow issue ${index}`,
            summary: "Apply a guarded remediation",
            steps: [],
            evidence: {
              fingerprint: `workflow:signature:${index}`,
              matchedLessonIds: [],
              diagnosisId: `diag-${index}`,
              recurrenceCount: index,
            },
          },
          status: "planned",
          outcome: null,
          createdAt: `2026-04-02T09:1${index}:00.000Z`,
          updatedAt: `2026-04-02T09:1${index}:00.000Z`,
        });

        approvalRepo.insert(writerDb, {
          requestId: `approval-${index}`,
          actionId: `action-${index}`,
          userId: "test-user",
          description: `Approve workflow fix ${index}`,
          riskTier: 2,
          plan: {
            title: `Fix workflow issue ${index}`,
            summary: "Apply a guarded remediation",
            steps: [],
            evidence: {
              fingerprint: `workflow:signature:${index}`,
              matchedLessonIds: [],
              diagnosisId: `diag-${index}`,
              recurrenceCount: index,
            },
          },
          requestedAt: `2026-04-02T09:2${index}:00.000Z`,
          expiresAt: `2026-04-02T10:2${index}:00.000Z`,
          status: "pending",
          createdAt: `2026-04-02T09:2${index}:00.000Z`,
          updatedAt: `2026-04-02T09:2${index}:00.000Z`,
        });
      }
    });

    const cards = service.listIssueCards({ userId: "test-user", limit: 10 });

    expect(listActionIdsSpy).toHaveBeenCalledTimes(1);
    expect(getActionByIdSpy).not.toHaveBeenCalled();
    expect(listIncidentIdsSpy).toHaveBeenCalledTimes(1);
    expect(getIncidentByIdSpy).not.toHaveBeenCalled();
    expect(cards.filter((card) => card.kind === "approval_required")).toEqual([
      expect.objectContaining({
        id: "approval:approval-3",
        incidentId: "incident-3",
        actionId: "action-3",
        title: "Fix workflow issue 3",
        severity: "medium",
      }),
      expect.objectContaining({
        id: "approval:approval-2",
        incidentId: "incident-2",
        actionId: "action-2",
        title: "Fix workflow issue 2",
        severity: "medium",
      }),
      expect.objectContaining({
        id: "approval:approval-1",
        incidentId: "incident-1",
        actionId: "action-1",
        title: "Fix workflow issue 1",
        severity: "high",
      }),
    ]);
  });

  it("batches related lookups when listing incidents", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listLatestDiagnosisSpy = vi.spyOn(diagnosisRepo, "listLatestByIncidentIds");
    const getLatestDiagnosisSpy = vi.spyOn(diagnosisRepo, "getLatestByIncidentId");
    const listLatestActionsSpy = vi.spyOn(actionRepo, "listLatestByIncidentIds");
    const listActionsByUserSpy = vi.spyOn(actionRepo, "listByUser");
    const countRecentBySignaturesSpy = vi.spyOn(incidentRepo, "countRecentBySignatures");
    const findRecentBySignatureSpy = vi.spyOn(incidentRepo, "findRecentBySignature");
    const listIncidentIdsSpy = vi.spyOn(incidentRepo, "listByIds");
    const listDiagnosisIdsSpy = vi.spyOn(diagnosisRepo, "listByIds");
    const listApprovalActionIdsSpy = vi.spyOn(approvalRepo, "listByActionIds");
    const listLessonFingerprintsSpy = vi.spyOn(lessonRepo, "listByFingerprints");
    const getLessonByFingerprintSpy = vi.spyOn(lessonRepo, "getByFingerprint");
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-03T09:00:00.000Z",
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      actionRepo,
      approvalRepo,
      factRepo,
      diagnosisService: {} as never,
      planService: {} as never,
      riskService: {
        assess: () => ({
          riskTier: 2,
          reasons: ["incident-batch-check"],
          requiresApproval: true,
          autoApplyAllowed: false,
        }),
      } as never,
      executionService: {} as never,
      rollbackService: {} as never,
      approvalService: {} as never,
      autoFixDispatcher: {} as never,
      metricsService: {} as never,
      pipeline: {} as never,
    });

    db.withWriteTransaction((writerDb) => {
      for (const index of [1, 2]) {
        const signature = `incident-batch:fingerprint:${index}`;
        lessonRepo.upsertByFingerprint(writerDb, {
          id: `incident-lesson-${index}`,
          fingerprint: signature,
          title: `Incident lesson ${index}`,
          cause: `Incident cause ${index}`,
          fix: `Incident fix ${index}`,
          nowIso: `2026-04-03T08:0${index}:00.000Z`,
        });

        for (const occurrence of [1, 2, 3]) {
          incidentRepo.insert(writerDb, {
            incidentId: `incident-batch-${index}-${occurrence}`,
            userId: "test-user",
            ts: `2026-04-03T07:${index}${occurrence}:00.000Z`,
            category: "workflow",
            severity: occurrence === 1 ? "high" : "medium",
            signature,
            context: { index, occurrence },
            autoFixEligible: true,
            status: occurrence === 1 ? "open" : "resolved",
            createdAt: `2026-04-03T07:${index}${occurrence}:00.000Z`,
            updatedAt: `2026-04-03T07:${index}${occurrence}:00.000Z`,
          });
        }

        diagnosisRepo.insert(writerDb, {
          id: `incident-diagnosis-${index}`,
          incidentId: `incident-batch-${index}-1`,
          errorFingerprint: signature,
          confidence: 0.86,
          diagnosis: {
            summary: `Incident summary ${index}`,
            rootCause: `Incident root cause ${index}`,
          },
          createdAt: `2026-04-03T08:1${index}:00.000Z`,
          updatedAt: `2026-04-03T08:1${index}:00.000Z`,
        });

        actionRepo.insert(writerDb, {
          actionId: `incident-action-${index}`,
          incidentId: `incident-batch-${index}-1`,
          userId: "test-user",
          riskTier: 2,
          plan: {
            title: `Incident action ${index}`,
            summary: "Apply a bounded remediation",
            steps: [],
            evidence: {
              fingerprint: signature,
              matchedLessonIds: [`incident-lesson-${index}`],
              diagnosisId: `incident-diagnosis-${index}`,
              recurrenceCount: 3,
            },
          },
          status: index === 1 ? "planned" : "rejected",
          outcome: null,
          createdAt: `2026-04-03T08:2${index}:00.000Z`,
          updatedAt: `2026-04-03T08:2${index}:00.000Z`,
        });

        approvalRepo.insert(writerDb, {
          requestId: `incident-approval-${index}`,
          actionId: `incident-action-${index}`,
          userId: "test-user",
          description: `Incident approval ${index}`,
          riskTier: 2,
          plan: {
            title: `Incident action ${index}`,
            summary: "Apply a bounded remediation",
            steps: [],
            evidence: {
              fingerprint: signature,
              matchedLessonIds: [`incident-lesson-${index}`],
              diagnosisId: `incident-diagnosis-${index}`,
              recurrenceCount: 3,
            },
          },
          requestedAt: `2026-04-03T08:3${index}:00.000Z`,
          expiresAt: `2026-04-03T09:3${index}:00.000Z`,
          status: index === 1 ? "pending" : "rejected",
          responseReason: index === 2 ? "Need a broader rollback plan" : undefined,
          createdAt: `2026-04-03T08:3${index}:00.000Z`,
          updatedAt: `2026-04-03T08:3${index}:00.000Z`,
        });
      }
    });

    const incidents = service.listIncidents({ userId: "test-user", status: "open", limit: 10 });

    expect(listLatestDiagnosisSpy).toHaveBeenCalledTimes(1);
    expect(getLatestDiagnosisSpy).not.toHaveBeenCalled();
    expect(listLatestActionsSpy).toHaveBeenCalledTimes(1);
    expect(listActionsByUserSpy).not.toHaveBeenCalled();
    expect(countRecentBySignaturesSpy).toHaveBeenCalledTimes(1);
    expect(findRecentBySignatureSpy).not.toHaveBeenCalled();
    expect(listIncidentIdsSpy).not.toHaveBeenCalled();
    expect(listDiagnosisIdsSpy).not.toHaveBeenCalled();
    expect(listApprovalActionIdsSpy).toHaveBeenCalledTimes(1);
    expect(listLessonFingerprintsSpy).toHaveBeenCalledTimes(1);
    expect(getLessonByFingerprintSpy).not.toHaveBeenCalled();
    expect(incidents).toEqual([
      expect.objectContaining({
        incident: expect.objectContaining({ incidentId: "incident-batch-2-1" }),
        diagnosis: expect.objectContaining({ id: "incident-diagnosis-2" }),
        lesson: expect.objectContaining({ fingerprint: "incident-batch:fingerprint:2" }),
        recurrenceCount: 3,
        action: expect.objectContaining({
          action: expect.objectContaining({ actionId: "incident-action-2" }),
          approval: expect.objectContaining({ requestId: "incident-approval-2" }),
        }),
      }),
      expect.objectContaining({
        incident: expect.objectContaining({ incidentId: "incident-batch-1-1" }),
        diagnosis: expect.objectContaining({ id: "incident-diagnosis-1" }),
        lesson: expect.objectContaining({ fingerprint: "incident-batch:fingerprint:1" }),
        recurrenceCount: 3,
        action: expect.objectContaining({
          action: expect.objectContaining({ actionId: "incident-action-1" }),
          approval: expect.objectContaining({ requestId: "incident-approval-1" }),
        }),
      }),
    ]);
  });

  it("batches related lookups when listing action details", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listIncidentIdsSpy = vi.spyOn(incidentRepo, "listByIds");
    const getIncidentByIdSpy = vi.spyOn(incidentRepo, "getById");
    const listDiagnosisIdsSpy = vi.spyOn(diagnosisRepo, "listByIds");
    const getDiagnosisByIdSpy = vi.spyOn(diagnosisRepo, "getById");
    const listApprovalActionIdsSpy = vi.spyOn(approvalRepo, "listByActionIds");
    const getApprovalByActionIdSpy = vi.spyOn(approvalRepo, "getByActionId");
    const listLessonFingerprintsSpy = vi.spyOn(lessonRepo, "listByFingerprints");
    const getLessonByFingerprintSpy = vi.spyOn(lessonRepo, "getByFingerprint");
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
      riskService: {
        assess: () => ({
          riskTier: 2,
          reasons: ["batched-risk-check"],
          requiresApproval: true,
          autoApplyAllowed: false,
        }),
      } as never,
      executionService: {} as never,
      rollbackService: {} as never,
      approvalService: {} as never,
      autoFixDispatcher: {} as never,
      metricsService: {} as never,
      pipeline: {} as never,
    });

    db.withWriteTransaction((writerDb) => {
      for (const index of [1, 2]) {
        incidentRepo.insert(writerDb, {
          incidentId: `detail-incident-${index}`,
          userId: "test-user",
          ts: `2026-04-02T08:0${index}:00.000Z`,
          category: "tool",
          severity: index === 1 ? "high" : "medium",
          signature: `detail:fingerprint:${index}`,
          context: { index },
          autoFixEligible: true,
          status: "open",
          createdAt: `2026-04-02T08:0${index}:00.000Z`,
          updatedAt: `2026-04-02T08:0${index}:00.000Z`,
        });

        diagnosisRepo.insert(writerDb, {
          id: `diag-${index}`,
          incidentId: `detail-incident-${index}`,
          errorFingerprint: `detail:fingerprint:${index}`,
          confidence: 0.9,
          diagnosis: {
            summary: `Root cause ${index}`,
            rootCause: `Tool failure ${index}`,
          },
          createdAt: `2026-04-02T08:1${index}:00.000Z`,
          updatedAt: `2026-04-02T08:1${index}:00.000Z`,
        });

        lessonRepo.upsertByFingerprint(writerDb, {
          id: `lesson-detail-${index}`,
          fingerprint: `detail:fingerprint:${index}`,
          title: `Lesson ${index}`,
          cause: `Cause ${index}`,
          fix: `Fix ${index}`,
          nowIso: `2026-04-02T08:2${index}:00.000Z`,
        });

        actionRepo.insert(writerDb, {
          actionId: `detail-action-${index}`,
          incidentId: `detail-incident-${index}`,
          userId: "test-user",
          riskTier: 2,
          plan: {
            title: `Detail action ${index}`,
            summary: "Reduce retries and trim payload",
            steps: [],
            evidence: {
              fingerprint: `detail:fingerprint:${index}`,
              matchedLessonIds: [`lesson-detail-${index}`],
              diagnosisId: `diag-${index}`,
              recurrenceCount: index + 1,
            },
          },
          status: index === 1 ? "planned" : "rejected",
          outcome: null,
          createdAt: `2026-04-02T08:3${index}:00.000Z`,
          updatedAt: `2026-04-02T08:3${index}:00.000Z`,
        });

        approvalRepo.insert(writerDb, {
          requestId: `detail-approval-${index}`,
          actionId: `detail-action-${index}`,
          userId: "test-user",
          description: `Approval detail ${index}`,
          riskTier: 2,
          plan: {
            title: `Detail action ${index}`,
            summary: "Reduce retries and trim payload",
            steps: [],
            evidence: {
              fingerprint: `detail:fingerprint:${index}`,
              matchedLessonIds: [`lesson-detail-${index}`],
              diagnosisId: `diag-${index}`,
              recurrenceCount: index + 1,
            },
          },
          requestedAt: `2026-04-02T08:4${index}:00.000Z`,
          expiresAt: `2026-04-02T09:4${index}:00.000Z`,
          status: index === 1 ? "pending" : "rejected",
          responseReason: index === 2 ? "Needs manual confirmation" : undefined,
          createdAt: `2026-04-02T08:4${index}:00.000Z`,
          updatedAt: `2026-04-02T08:4${index}:00.000Z`,
        });
      }
    });

    const actions = service.listActions({ userId: "test-user", limit: 10 });

    expect(listIncidentIdsSpy).toHaveBeenCalledTimes(1);
    expect(getIncidentByIdSpy).not.toHaveBeenCalled();
    expect(listDiagnosisIdsSpy).toHaveBeenCalledTimes(1);
    expect(getDiagnosisByIdSpy).not.toHaveBeenCalled();
    expect(listApprovalActionIdsSpy).toHaveBeenCalledTimes(1);
    expect(getApprovalByActionIdSpy).not.toHaveBeenCalled();
    expect(listLessonFingerprintsSpy).toHaveBeenCalledTimes(1);
    expect(getLessonByFingerprintSpy).not.toHaveBeenCalled();
    expect(actions).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({ actionId: "detail-action-2" }),
        incident: expect.objectContaining({ incidentId: "detail-incident-2" }),
        diagnosis: expect.objectContaining({ id: "diag-2" }),
        approval: expect.objectContaining({ requestId: "detail-approval-2" }),
        lesson: expect.objectContaining({ fingerprint: "detail:fingerprint:2" }),
      }),
      expect.objectContaining({
        action: expect.objectContaining({ actionId: "detail-action-1" }),
        incident: expect.objectContaining({ incidentId: "detail-incident-1" }),
        diagnosis: expect.objectContaining({ id: "diag-1" }),
        approval: expect.objectContaining({ requestId: "detail-approval-1" }),
        lesson: expect.objectContaining({ fingerprint: "detail:fingerprint:1" }),
      }),
    ]);
  });

  it("batches planned action lookups when emitting process results", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listByIncidentIdsSpy = vi.spyOn(actionRepo, "listByIncidentIds");
    const listActionsByUserSpy = vi.spyOn(actionRepo, "listByUser");
    const listApprovalActionIdsSpy = vi.spyOn(approvalRepo, "listByActionIds");
    const getApprovalByActionIdSpy = vi.spyOn(approvalRepo, "getByActionId");
    const listIncidentIdsSpy = vi.spyOn(incidentRepo, "listByIds");
    const listDiagnosisIdsSpy = vi.spyOn(diagnosisRepo, "listByIds");
    const listLessonFingerprintsSpy = vi.spyOn(lessonRepo, "listByFingerprints");
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-03T11:00:00.000Z",
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      actionRepo,
      approvalRepo,
      factRepo,
      diagnosisService: {} as never,
      planService: {} as never,
      riskService: {
        assess: () => ({
          riskTier: 2,
          reasons: ["emit-process-batch"],
          requiresApproval: true,
          autoApplyAllowed: false,
        }),
      } as never,
      executionService: {} as never,
      rollbackService: {} as never,
      approvalService: {} as never,
      autoFixDispatcher: {} as never,
      metricsService: {} as never,
      pipeline: {} as never,
    });

    const lessons = db.withWriteTransaction((writerDb) =>
      [1, 2].map((index) =>
        lessonRepo.upsertByFingerprint(writerDb, {
          id: `emit-lesson-${index}`,
          fingerprint: `emit:fingerprint:${index}`,
          title: `Emit lesson ${index}`,
          cause: `Emit cause ${index}`,
          fix: `Emit fix ${index}`,
          nowIso: `2026-04-03T10:0${index}:00.000Z`,
        }),
      ),
    );

    const incidents = [1, 2].map((index) => ({
      incidentId: `emit-incident-${index}`,
      userId: "test-user",
      ts: `2026-04-03T09:0${index}:00.000Z`,
      category: "workflow" as const,
      severity: index === 1 ? "high" as const : "medium" as const,
      signature: `emit:fingerprint:${index}`,
      context: { index },
      autoFixEligible: true,
      status: "open" as const,
      createdAt: `2026-04-03T09:0${index}:00.000Z`,
      updatedAt: `2026-04-03T09:0${index}:00.000Z`,
    }));
    const diagnoses = [1, 2].map((index) => ({
      id: `emit-diagnosis-${index}`,
      incidentId: `emit-incident-${index}`,
      errorFingerprint: `emit:fingerprint:${index}`,
      confidence: 0.9,
      diagnosis: {
        summary: `Emit summary ${index}`,
        rootCause: `Emit root cause ${index}`,
      },
      createdAt: `2026-04-03T09:1${index}:00.000Z`,
      updatedAt: `2026-04-03T09:1${index}:00.000Z`,
    }));

    db.withWriteTransaction((writerDb) => {
      for (const incident of incidents) {
        incidentRepo.insert(writerDb, incident);
      }
      for (const diagnosis of diagnoses) {
        diagnosisRepo.insert(writerDb, diagnosis);
      }

      for (const index of [1, 2]) {
        for (const actionIndex of [1, 2]) {
          const actionId = `emit-action-${index}-${actionIndex}`;
          actionRepo.insert(writerDb, {
            actionId,
            incidentId: `emit-incident-${index}`,
            userId: "test-user",
            riskTier: 2,
            plan: {
              title: `Emit action ${index}-${actionIndex}`,
              summary: "Emit remediation action",
              steps: [],
              evidence: {
                fingerprint: `emit:fingerprint:${index}`,
                matchedLessonIds: [`emit-lesson-${index}`],
                diagnosisId: `emit-diagnosis-${index}`,
                recurrenceCount: 2,
              },
            },
            status: actionIndex === 1 ? "planned" : "rejected",
            outcome: null,
            createdAt: `2026-04-03T09:2${index}${actionIndex}:00.000Z`,
            updatedAt: `2026-04-03T09:2${index}${actionIndex}:00.000Z`,
          });
          approvalRepo.insert(writerDb, {
            requestId: `emit-approval-${index}-${actionIndex}`,
            actionId,
            userId: "test-user",
            description: `Emit approval ${index}-${actionIndex}`,
            riskTier: 2,
            plan: {
              title: `Emit action ${index}-${actionIndex}`,
              summary: "Emit remediation action",
              steps: [],
              evidence: {
                fingerprint: `emit:fingerprint:${index}`,
                matchedLessonIds: [`emit-lesson-${index}`],
                diagnosisId: `emit-diagnosis-${index}`,
                recurrenceCount: 2,
              },
            },
            requestedAt: `2026-04-03T09:3${index}${actionIndex}:00.000Z`,
            expiresAt: `2026-04-03T10:3${index}${actionIndex}:00.000Z`,
            status: actionIndex === 1 ? "pending" : "rejected",
            responseReason: actionIndex === 2 ? "Already covered by a better plan" : undefined,
            createdAt: `2026-04-03T09:3${index}${actionIndex}:00.000Z`,
            updatedAt: `2026-04-03T09:3${index}${actionIndex}:00.000Z`,
          });
        }
      }
    });

    const results = [
      {
        eventId: "result-1",
        inserted: true,
        extractedSignals: [],
        factsUpdated: [],
        incidentsCreated: incidents,
        diagnosisCreated: diagnoses,
        lessonsUpdated: lessons,
        lifecycleState: "steady_state",
      },
    ] as Parameters<typeof service.emitProcessResults>[0];

    service.emitProcessResults(results, "corr-emit");

    expect(listByIncidentIdsSpy).toHaveBeenCalledTimes(1);
    expect(listActionsByUserSpy).not.toHaveBeenCalled();
    expect(listApprovalActionIdsSpy).toHaveBeenCalledTimes(1);
    expect(getApprovalByActionIdSpy).not.toHaveBeenCalled();
    expect(listIncidentIdsSpy).not.toHaveBeenCalled();
    expect(listDiagnosisIdsSpy).not.toHaveBeenCalled();
    expect(listLessonFingerprintsSpy).not.toHaveBeenCalled();
  });

  it("uses direct lesson lookup instead of rebuilding the full overview", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const getLessonByIdSpy = vi.spyOn(lessonRepo, "getById");
    const listRecentLessonsSpy = vi.spyOn(lessonRepo, "listRecent");
    const listPrefixedFactsSpy = vi.spyOn(factRepo, "listByUserAndKeyPrefixes");
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-03T12:00:00.000Z",
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
        id: "lesson-direct-1",
        fingerprint: "direct:fingerprint:1",
        title: "Direct lesson",
        cause: "Cause",
        fix: "Fix",
        nowIso: "2026-04-03T10:00:00.000Z",
      });
    });

    const result = service.setLessonEnabled({
      userId: "test-user",
      lessonId: "lesson-direct-1",
      enabled: false,
      reason: "Operator disabled it",
    });

    expect(getLessonByIdSpy).toHaveBeenCalledTimes(1);
    expect(listRecentLessonsSpy).not.toHaveBeenCalled();
    expect(listPrefixedFactsSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      lesson: { id: "lesson-direct-1" },
      disabled: true,
      disabledReason: "Operator disabled it",
    });
  });

  it("uses direct pattern lookup instead of rebuilding the full overview", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const idGenerator = createTestIdGenerator();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const factRepo = createFridayPreferenceFactRepository();
    const listRecentLessonsSpy = vi.spyOn(lessonRepo, "listRecent");
    const listActionsByUserSpy = vi.spyOn(actionRepo, "listByUser");
    const listIncidentsByUserSpy = vi.spyOn(incidentRepo, "listByUser");
    const listPrefixedFactsSpy = vi.spyOn(factRepo, "listByUserAndKeyPrefixes");
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => "2026-04-03T12:00:00.000Z",
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
      writerDb
        .prepare(
          `INSERT INTO friday_learned_patterns
             (id, user_id, kind, description, pattern_json, confidence, sample_count, last_updated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "pattern-direct-1",
          "test-user",
          "tool_sequence",
          "Repeated trimming before retries",
          JSON.stringify({ tool: "trim_context" }),
          0.72,
          4,
          "2026-04-03T09:00:00.000Z",
          "2026-04-02T09:00:00.000Z",
        );
    });

    const result = service.demotePattern({
      userId: "test-user",
      patternId: "pattern-direct-1",
      factor: 0.3,
      reason: "Too noisy",
    });

    expect(listRecentLessonsSpy).not.toHaveBeenCalled();
    expect(listActionsByUserSpy).not.toHaveBeenCalled();
    expect(listIncidentsByUserSpy).not.toHaveBeenCalled();
    expect(listPrefixedFactsSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      patternId: "pattern-direct-1",
      demoted: true,
      demotionFactor: 0.3,
      demotionReason: "Too noisy",
    });
  });
});
