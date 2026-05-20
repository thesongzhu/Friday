import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayApprovalRequestRepository,
  createFridayAutoFixActionRepository,
  createFridayAutoFixRollbackService,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  createFridayLearnedLessonRepository,
  createFridayPreferenceFactRepository,
  createFridaySelfHealingApiService,
  createFridaySelfLearningRuntime,
  type FridayAutoFixActionEntity,
  type FridayAutoFixPlan,
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

  function seedWorkflowRun(runId: string): void {
    db.writer.prepare(
      `INSERT INTO workflows (
        id, slug, name, description, owner_user_id, latest_version_number,
        published_version_number, is_archived, revision, etag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-1",
      "wf-1",
      "Workflow 1",
      "Synthetic workflow for self-healing tests",
      "test-user",
      1,
      1,
      0,
      1,
      "etag-wf-1",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_versions (
        id, workflow_id, version_number, checksum, graph_json, created_by_user_id,
        is_published, change_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-version-1",
      "wf-1",
      1,
      "checksum-wf-1",
      "{\"nodes\":[],\"edges\":[]}",
      "test-user",
      1,
      "Synthetic version for self-healing tests",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload_json,
        started_by_user_id, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "wf-1",
      "wf-version-1",
      "failed",
      "manual",
      "{}",
      "test-user",
      NOW,
      NOW,
      NOW,
    );
  }

  function buildPlan(suffix: string, payload: Record<string, unknown> = {}): FridayAutoFixPlan {
    return {
      title: `Repair ${suffix}`,
      summary: `Repair summary ${suffix}`,
      steps: [
        {
          stepId: `step-${suffix}`,
          kind: "apply_config_patch",
          target: "config",
          payload,
          verify: { method: "config_reload_valid", timeoutMs: 1000 },
        },
      ],
      rollbackPlan: {
        summary: `Rollback ${suffix}`,
        steps: [
          {
            stepId: `rollback-${suffix}`,
            kind: "apply_config_patch",
            target: "config",
            payload: { revert: true },
          },
        ],
      },
      evidence: {
        fingerprint: `sig-${suffix}`,
        matchedLessonIds: [],
        diagnosisId: `diag-${suffix}`,
        recurrenceCount: 1,
      },
    };
  }

  function seedActionGraph(
    suffix: string,
    actionRepo: ReturnType<typeof createFridayAutoFixActionRepository>,
    overrides: Partial<FridayAutoFixActionEntity> = {},
  ): FridayAutoFixActionEntity {
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const plan = overrides.plan ?? buildPlan(suffix);

    incidentRepo.insert(db.writer, {
      incidentId: `inc-${suffix}`,
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: plan.evidence.fingerprint,
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: plan.evidence.diagnosisId,
      incidentId: `inc-${suffix}`,
      errorFingerprint: plan.evidence.fingerprint,
      confidence: 0.9,
      diagnosis: { summary: `Diagnosis ${suffix}` },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const action: FridayAutoFixActionEntity = {
      actionId: `action-${suffix}`,
      incidentId: `inc-${suffix}`,
      userId: "test-user",
      riskTier: 1,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
    return actionRepo.insert(db.writer, action);
  }

  function buildService(
    actionRepo = createFridayAutoFixActionRepository(),
    rollbackService?: ReturnType<typeof createFridayAutoFixRollbackService>,
  ): ReturnType<typeof createFridaySelfHealingApiService> {
    const idGenerator = createTestIdGenerator();
    const runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    return createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => NOW,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      lessonRepo: createFridayLearnedLessonRepository(),
      actionRepo,
      approvalRepo: createFridayApprovalRequestRepository(),
      factRepo: createFridayPreferenceFactRepository(),
      diagnosisService: runtime.diagnosis,
      planService: runtime.autoFixPlan,
      riskService: runtime.autoFixRisk,
      executionService: runtime.autoFixExecution,
      rollbackService: rollbackService ?? runtime.autoFixRollback,
      approvalService: runtime.approvals,
      autoFixDispatcher: runtime.autoFixDispatcher,
      metricsService: runtime.metrics,
      pipeline: runtime.pipeline,
    });
  }

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

  it("reportStructuredFailure preserves workflow node context for auto-fix planning", () => {
    seedWorkflowRun("run-42");
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

    const result = service.reportStructuredFailure({
      userId: "test-user",
      runId: "run-42",
      nodeId: "node-a",
      category: "workflow",
      severity: "high",
      message: "Workflow node failed",
      context: {
        workflowId: "wf-1",
      },
    });

    expect(result.incidentsCreated[0]!.runId).toBe("run-42");
    expect(result.incidentsCreated[0]!.nodeId).toBe("node-a");
    expect(result.diagnosisCreated[0]!.nodeId).toBe("node-a");

    const overview = service.getLearningOverview({ userId: "test-user", limit: 10 });
    expect(overview.coverage.incidents).toBeGreaterThan(0);
    expect(overview.coverage.diagnoses).toBeGreaterThan(0);
  });

  it("manualResolveIncident normalizes recursive lesson titles before persisting them", () => {
    seedWorkflowRun("run-manual-resolve");
    const idGenerator = createTestIdGenerator();
    const runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator,
      nowIso: () => NOW,
    });
    const lessonRepo = createFridayLearnedLessonRepository();
    const service = createFridaySelfHealingApiService({
      db,
      idGenerator,
      nowIso: () => NOW,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      lessonRepo,
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

    const report = service.reportStructuredFailure({
      userId: "test-user",
      runId: "run-manual-resolve",
      nodeId: "node-manual-resolve",
      category: "workflow",
      severity: "medium",
      message: "Manual resolution normalization",
      context: {
        workflowId: "wf-1",
      },
    });

    const incident = report.incidentsCreated[0];
    expect(incident).toBeDefined();

    service.manualResolveIncident({
      incidentId: incident!.incidentId,
      resolvedBy: "operator-1",
      title: "Auto-fixed: Auto-fix: retry workflow",
      fix: "Retried the workflow and confirmed it completed",
    });

    const lesson = lessonRepo.getByFingerprint(db.writer, incident!.signature);
    expect(lesson).toBeTruthy();
    expect(lesson!.title).toBe("Auto-fixed: retry workflow");
  });

  it("reports auto-fix action counts separately from verified repair outcomes", () => {
    const actionRepo = createFridayAutoFixActionRepository();
    seedActionGraph("verified", actionRepo, {
      status: "applied",
      outcome: "success",
      appliedAt: NOW,
      plan: buildPlan("verified", {
        _configPatchApplied: true,
        _configPatchRevision: 1,
      }),
    });
    seedActionGraph("diagnostic", actionRepo, {
      status: "applied",
      outcome: "success",
      appliedAt: NOW,
      plan: buildPlan("diagnostic", {
        _configPatchApplied: false,
        _configPatchMode: "diagnostic_only",
      }),
    });
    seedActionGraph("rolled-back", actionRepo, {
      status: "rolled_back",
      outcome: "failed",
      rolledBackAt: NOW,
    });
    seedActionGraph("failed", actionRepo, {
      status: "applied",
      outcome: "failed",
      appliedAt: NOW,
    });
    seedActionGraph("rejected", actionRepo, {
      status: "rejected",
      outcome: null,
    });
    seedActionGraph("pending", actionRepo);
    seedActionGraph("rollback-failed", actionRepo, {
      status: "applied",
      outcome: "success",
      appliedAt: NOW,
      rollbackAttempted: true,
      rollbackAttemptedAt: NOW,
      rollbackSucceeded: false,
      rollbackErrorMessage: "rollback failed verification",
      plan: buildPlan("rollback-failed", {
        _configPatchApplied: true,
        _configPatchRevision: 2,
      }),
    });

    const overview = buildService(actionRepo).getLearningOverview({ userId: "test-user", limit: 10 });

    expect(overview.coverage.autoFixActions).toBe(7);
    expect(overview.coverage.autoFixOutcomeBuckets).toMatchObject({
      recordedActions: 7,
      verifiedRepairs: 2,
      diagnosticOnly: 1,
      rolledBack: 1,
      failed: 1,
      rejected: 1,
      pending: 1,
      rollbackAttempted: 2,
      rollbackFailed: 1,
    });
  });

  it("persists failed rollback attempts into later action detail receipts", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    seedActionGraph("receipt", actionRepo, {
      status: "applied",
      outcome: "success",
      appliedAt: NOW,
      plan: buildPlan("receipt", {
        _configPatchApplied: true,
        _configPatchRevision: 3,
      }),
    });
    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: {
        apply_config_patch: async () => true,
      },
      stepVerifiers: {
        apply_config_patch: async () => false,
      },
    });
    const service = buildService(actionRepo, rollbackService);

    const rollback = await service.rollbackAction({
      actionId: "action-receipt",
      userId: "test-user",
      reason: "verification failed",
    });

    expect(rollback.result.rollbackAttempted).toBe(true);
    expect(rollback.result.rollbackSucceeded).toBe(false);
    expect(rollback.details.evidence.rollbackResult).toMatchObject({
      rollbackAttempted: true,
      rollbackAttemptedAt: NOW,
      rollbackSucceeded: false,
    });
    expect(rollback.details.evidence.rollbackResult.rollbackErrorMessage).toContain("failed verification");

    const reloaded = service.getAction({ actionId: "action-receipt", userId: "test-user" });
    expect(reloaded?.evidence.rollbackResult).toMatchObject({
      rollbackAttempted: true,
      rollbackAttemptedAt: NOW,
      rollbackSucceeded: false,
    });
    expect(reloaded?.evidence.rollbackResult.rollbackErrorMessage).toContain("failed verification");
    expect(reloaded?.action.status).toBe("applied");
  });
});
