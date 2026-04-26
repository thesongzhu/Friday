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
});
