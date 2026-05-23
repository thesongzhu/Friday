import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayLearningEventLedger } from "#ledger";
import { createFridayPreferenceFactRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import { createFridayLearnedLessonRepository } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayApprovalRequestRepository } from "#learning";
import { createFridayLearningEventCollectionService } from "#learning";
import { createFridayPreferenceExtractionService } from "#learning";
import { createFridayPreferenceFactService } from "#learning";
import { createFridayLearningLifecycleService } from "#learning";
import { createFridaySelfLearningPipelineService } from "#learning";
import { createFridayErrorDiagnosisService } from "#learning";
import { createFridayAutoFixPlanService } from "#learning";
import { createFridayAutoFixRiskAssessmentService } from "#learning";
import { createFridayAutoFixExecutionService } from "#learning";
import { createFridayAutoFixRollbackService } from "#learning";
import { createFridayAutoFixDispatcherService } from "#learning";
import { createFridayApprovalWorkflowService } from "#learning";
import type { FridaySelfLearningPipelineService } from "#learning";
import type { FridayLearningEventAppendInput } from "#ledger";

describe("FridaySelfLearningPipelineService", () => {
  let db: FridaySqliteLayer;
  let pipeline: FridaySelfLearningPipelineService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const ledger = createFridayLearningEventLedger({ db });
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();

    const events = createFridayLearningEventCollectionService({ ledger });
    const extraction = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
    const facts = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const lifecycle = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    pipeline = createFridaySelfLearningPipelineService({
      db,
      events,
      extraction,
      facts,
      lifecycle,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

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
      "Synthetic workflow for learning tests",
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
      "Synthetic version for learning tests",
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

  it("processEvent collects the event and returns result", () => {
    const event = makeEvent();
    const result = pipeline.processEvent(event);

    expect(result.eventId).toBe("evt-001");
    expect(result.inserted).toBe(true);
    expect(result.lifecycleState).toBe("cold_start");
  });

  it("processEvent is idempotent on duplicate eventId", () => {
    const event = makeEvent();
    pipeline.processEvent(event);
    const result = pipeline.processEvent(event);

    expect(result.inserted).toBe(false);
  });

  it("duplicate eventId short-circuits with no downstream writes", () => {
    // First: process an error event that would create incidents/diagnosis/lessons
    const event = makeEvent({
      eventId: "evt-dup",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });
    const first = pipeline.processEvent(event);
    expect(first.inserted).toBe(true);
    expect(first.incidentsCreated).toHaveLength(1);
    expect(first.diagnosisCreated).toHaveLength(1);
    expect(first.lessonsUpdated).toHaveLength(1);

    // Count rows before duplicate
    const incidentsBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM error_incidents").get() as { cnt: number }
    ).cnt;
    const diagnosisBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM diagnosis_records").get() as { cnt: number }
    ).cnt;
    const lessonsBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM learned_lessons").get() as { cnt: number }
    ).cnt;

    // Second: duplicate should short-circuit
    const second = pipeline.processEvent(event);
    expect(second.inserted).toBe(false);
    expect(second.extractedSignals).toHaveLength(0);
    expect(second.factsUpdated).toHaveLength(0);
    expect(second.incidentsCreated).toHaveLength(0);
    expect(second.diagnosisCreated).toHaveLength(0);
    expect(second.lessonsUpdated).toHaveLength(0);

    // Verify no new rows were written
    const incidentsAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM error_incidents").get() as { cnt: number }
    ).cnt;
    const diagnosisAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM diagnosis_records").get() as { cnt: number }
    ).cnt;
    const lessonsAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM learned_lessons").get() as { cnt: number }
    ).cnt;

    expect(incidentsAfter).toBe(incidentsBefore);
    expect(diagnosisAfter).toBe(diagnosisBefore);
    expect(lessonsAfter).toBe(lessonsBefore);
  });

  it("processEvent extracts correction signals and updates facts", () => {
    const event = makeEvent({
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(1);
    expect(result.extractedSignals[0]!.kind).toBe("correction");
    expect(result.factsUpdated).toHaveLength(1);
    expect(result.factsUpdated[0]!.key).toBe("pref:language");
    expect(result.factsUpdated[0]!.value).toBe("Python");
  });

  it("keeps learned preferences in preference facts instead of durable memory", () => {
    const result = pipeline.processEvent(makeEvent({
      kind: "user_message",
      payload: { text: "Call me Codex." },
    }));

    expect(result.factsUpdated).toHaveLength(1);
    expect(result.factsUpdated[0]!.key).toBe("pref:display_name");
    const memoryCount = db.withReadConnection((reader) =>
      reader.prepare("SELECT COUNT(*) as cnt FROM memory_items").get() as { cnt: number });
    expect(memoryCount.cnt).toBe(0);
  });

  it("processEvent creates incidents for error signals", () => {
    const event = makeEvent({
      kind: "tool_result",
      payload: { ok: false, toolName: "search", errorCode: "timeout" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals.length).toBeGreaterThan(0);
    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.category).toBe("tool");
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false); // Phase 6 invariant
  });

  it("processEvent creates diagnosis records for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "config", message: "missing_key" },
    });

    const result = pipeline.processEvent(event);

    expect(result.diagnosisCreated).toHaveLength(1);
    expect(result.diagnosisCreated[0]!.incidentId).toBe(
      result.incidentsCreated[0]!.incidentId,
    );
  });

  it("carries workflow runId and nodeId through incident and diagnosis creation", () => {
    seedWorkflowRun("run-workflow-123");
    const event = makeEvent({
      eventId: "evt-workflow-node-001",
      kind: "error_incident",
      payload: {
        category: "workflow",
        message: "node execution failed",
        workflowRunId: "run-workflow-123",
        nodeId: "node-transform-1",
      },
    });

    const result = pipeline.processEvent(event);

    expect(result.incidentsCreated[0]!.runId).toBe("run-workflow-123");
    expect(result.incidentsCreated[0]!.nodeId).toBe("node-transform-1");
    expect(result.diagnosisCreated[0]!.runId).toBe("run-workflow-123");
    expect(result.diagnosisCreated[0]!.nodeId).toBe("node-transform-1");
  });

  it("processEvent creates learned lessons for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "workflow", message: "step_failed" },
    });

    const result = pipeline.processEvent(event);

    expect(result.lessonsUpdated).toHaveLength(1);
    expect(result.lessonsUpdated[0]!.fingerprint).toBeTruthy();
    expect(result.lessonsUpdated[0]!.occurrences).toBe(1);
  });

  it("processEvent accumulates lesson occurrences on repeated errors", () => {
    const event1 = makeEvent({
      eventId: "evt-001",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });
    const event2 = makeEvent({
      eventId: "evt-002",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });

    const result1 = pipeline.processEvent(event1);
    const result2 = pipeline.processEvent(event2);

    // Both should have same fingerprint, second should increment occurrences
    expect(result1.lessonsUpdated[0]!.fingerprint).toBe(
      result2.lessonsUpdated[0]!.fingerprint,
    );
    expect(result2.lessonsUpdated[0]!.occurrences).toBe(2);
  });

  it("processEvent returns empty arrays for assistant_message (no signals)", () => {
    const event = makeEvent({
      kind: "assistant_message",
      payload: { text: "I prefer TypeScript" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(0);
    expect(result.factsUpdated).toHaveLength(0);
    expect(result.incidentsCreated).toHaveLength(0);
  });

  it("processBatch processes multiple events", () => {
    const events = [
      makeEvent({ eventId: "evt-001", kind: "user_message", payload: { text: "hello" } }),
      makeEvent({
        eventId: "evt-002",
        kind: "user_correction",
        payload: { correctedField: "theme", newValue: "dark" },
      }),
      makeEvent({
        eventId: "evt-003",
        kind: "tool_result",
        payload: { ok: false, toolName: "api", errorCode: "500" },
      }),
    ];

    const results = pipeline.processBatch(events);

    expect(results).toHaveLength(3);
    expect(results[0]!.inserted).toBe(true);
    expect(results[1]!.factsUpdated).toHaveLength(1);
    expect(results[2]!.incidentsCreated).toHaveLength(1);
  });

  it("Phase 6 fallback: no auto_fix_actions or approval_requests when no diagnosis service", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "tool", message: "failure" },
    });

    pipeline.processEvent(event);

    // Without diagnosis service, no auto_fix_actions should be written
    const autoFixCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions")
      .get() as { cnt: number };
    expect(autoFixCount.cnt).toBe(0);

    // Without diagnosis service, no approval_requests should be written
    const approvalCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM approval_requests")
      .get() as { cnt: number };
    expect(approvalCount.cnt).toBe(0);
  });
});

describe("Phase 7 pipeline integration", () => {
  let db: FridaySqliteLayer;
  let pipeline: FridaySelfLearningPipelineService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const ledger = createFridayLearningEventLedger({ db });
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();

    const events = createFridayLearningEventCollectionService({ ledger });
    const extraction = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
    const facts = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const lifecycle = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    const diagnosisService = createFridayErrorDiagnosisService({
      db,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      idGenerator: idGen,
    });

    const planService = createFridayAutoFixPlanService({
      idGenerator: idGen,
    });

    const riskService = createFridayAutoFixRiskAssessmentService({
      db,
      actionRepo,
    });

    pipeline = createFridaySelfLearningPipelineService({
      db,
      events,
      extraction,
      facts,
      lifecycle,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      actionRepo,
      approvalRepo,
      diagnosisService,
      planService,
      riskService,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-p7-001",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
      ...overrides,
    };
  }

  it("full pipeline: incident → diagnosis → action creation", () => {
    // Seed a matching lesson to boost confidence above threshold (0.6)
    // so the incident becomes auto-fix eligible
    const lessonRepo = createFridayLearnedLessonRepository();
    // The error_incident extraction creates a signature from the hash of
    // "error_incident:incident:tool:timeout:tool". We need to match it.
    // First, process an event to discover the signature it generates
    const firstResult = pipeline.processEvent(makeEvent({ eventId: "evt-seed" }));
    expect(firstResult.incidentsCreated).toHaveLength(1);
    const signature = firstResult.incidentsCreated[0]!.signature;

    // Now insert a matching lesson for that signature
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-seed",
      fingerprint: signature,
      title: "Known timeout issue",
      cause: "Service timeout",
      fix: "Retry the node",
      nowIso: NOW,
    });

    // Process a second event — now with lesson match → high confidence → autoFixEligible
    const result = pipeline.processEvent(makeEvent({
      eventId: "evt-p7-002",
    }));

    expect(result.inserted).toBe(true);
    expect(result.incidentsCreated).toHaveLength(0);
    expect(result.diagnosisCreated).toHaveLength(1);

    // Should create auto_fix_actions
    const actionCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions")
      .get() as { cnt: number };
    expect(actionCount.cnt).toBeGreaterThanOrEqual(1);
  });

  it("creates approval request for high severity incidents (Tier 2)", () => {
    // Seed a lesson for the "critical" signature so confidence ≥ 0.6 → autoFixEligible
    const firstResult = pipeline.processEvent(
      makeEvent({
        eventId: "evt-p7-seed-high",
        payload: { category: "tool", message: "critical", severity: "high" },
      }),
    );
    const signature = firstResult.incidentsCreated[0]!.signature;

    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-high",
      fingerprint: signature,
      title: "Known critical issue",
      cause: "Critical failure",
      fix: "Retry the node",
      nowIso: NOW,
    });

    // Now process with high severity + matching lesson
    const result = pipeline.processEvent(
      makeEvent({
        eventId: "evt-p7-high",
        payload: { category: "tool", message: "critical", severity: "high" },
      }),
    );

    expect(result.incidentsCreated).toHaveLength(0);
    const openIncident = db.writer.prepare(
      "SELECT severity FROM error_incidents WHERE user_id = ? AND signature = ? AND status = 'open'",
    ).get("test-user", signature) as { severity: string } | undefined;
    expect(openIncident?.severity).toBe("high");

    // High severity → Tier 2 → approval request should be created
    const approvalCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM approval_requests")
      .get() as { cnt: number };
    expect(approvalCount.cnt).toBe(1);
  });

  it("reuses the same open incident and suppresses duplicate planned actions for a fingerprint", () => {
    const firstResult = pipeline.processEvent(makeEvent({ eventId: "evt-p7-dedup-seed" }));
    const signature = firstResult.incidentsCreated[0]!.signature;

    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-dedup",
      fingerprint: signature,
      title: "Auto-fixed: Auto-fix: retry workflow",
      cause: "Known workflow timeout",
      fix: "Retry the workflow step",
      nowIso: NOW,
    });

    pipeline.processEvent(makeEvent({ eventId: "evt-p7-dedup-first" }));
    const dedupResult = pipeline.processEvent(makeEvent({ eventId: "evt-p7-dedup-second" }));

    const incidentCount = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM error_incidents WHERE signature = ?").get(signature) as { cnt: number }
    ).cnt;
    const diagnosisCount = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM diagnosis_records WHERE error_fingerprint = ?").get(signature) as { cnt: number }
    ).cnt;
    const actionCount = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions").get() as { cnt: number }
    ).cnt;

    expect(dedupResult.incidentsCreated).toHaveLength(0);
    expect(incidentCount).toBe(1);
    expect(diagnosisCount).toBe(3);
    expect(actionCount).toBe(1);
  });

  it("does not create a new planned action when fingerprint history is already in cooldown", () => {
    const seedResult = pipeline.processEvent(makeEvent({ eventId: "evt-p7-cooldown-seed" }));
    const signature = seedResult.incidentsCreated[0]!.signature;
    const incidentId = db.writer.prepare(
      "SELECT incident_id FROM error_incidents WHERE signature = ? LIMIT 1",
    ).get(signature) as { incident_id: string };

    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-cooldown",
      fingerprint: signature,
      title: "Known timeout issue",
      cause: "Repeated timeout",
      fix: "Retry the node",
      nowIso: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-cooldown-1",
      incidentId: incidentId.incident_id,
      userId: "test-user",
      riskTier: 0,
      plan: {
        title: "Auto-fix: retry tool",
        summary: "Retry the failed tool operation",
        steps: [
          {
            stepId: "step-cooldown-1",
            kind: "retry_node",
            target: "tool",
            payload: {},
            verify: { method: "error_absent", timeoutMs: 5000 },
          },
        ],
        evidence: {
          fingerprint: signature,
          matchedLessonIds: [],
          diagnosisId: "diag-cooldown-1",
          recurrenceCount: 1,
        },
      },
      status: "planned",
      outcome: null,
      createdAt: "2025-06-15T09:00:00.000Z",
      updatedAt: "2025-06-15T09:00:00.000Z",
    });
    actionRepo.markRejected(db.writer, "action-cooldown-1", "2025-06-15T09:05:00.000Z");

    actionRepo.insert(db.writer, {
      actionId: "action-cooldown-2",
      incidentId: incidentId.incident_id,
      userId: "test-user",
      riskTier: 0,
      plan: {
        title: "Auto-fix: retry tool",
        summary: "Retry the failed tool operation",
        steps: [
          {
            stepId: "step-cooldown-2",
            kind: "retry_node",
            target: "tool",
            payload: {},
            verify: { method: "error_absent", timeoutMs: 5000 },
          },
        ],
        evidence: {
          fingerprint: signature,
          matchedLessonIds: [],
          diagnosisId: "diag-cooldown-2",
          recurrenceCount: 1,
        },
      },
      status: "planned",
      outcome: null,
      createdAt: "2025-06-15T09:10:00.000Z",
      updatedAt: "2025-06-15T09:10:00.000Z",
    });
    actionRepo.markRejected(db.writer, "action-cooldown-2", "2025-06-15T09:15:00.000Z");

    pipeline.processEvent(makeEvent({ eventId: "evt-p7-cooldown-final" }));

    const plannedCount = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions WHERE status = 'planned'").get() as { cnt: number }
    ).cnt;
    const totalCount = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions").get() as { cnt: number }
    ).cnt;

    expect(plannedCount).toBe(0);
    expect(totalCount).toBe(2);
  });

  it("does NOT create lessons during ingestion (Phase 7 path)", () => {
    const result = pipeline.processEvent(makeEvent());

    // Phase 7 path should NOT create lessons during ingestion
    // (lessons are extracted after successful execution, not at ingestion time)
    expect(result.lessonsUpdated).toHaveLength(0);

    // Verify no learned_lessons rows were written to the database
    const lessonCount = (
      db.writer
        .prepare("SELECT COUNT(*) as cnt FROM learned_lessons")
        .get() as { cnt: number }
    ).cnt;
    expect(lessonCount).toBe(0);
  });

  it("severity is derived from signal context", () => {
    const result = pipeline.processEvent(
      makeEvent({
        eventId: "evt-p7-sev",
        kind: "error_incident",
        payload: { category: "config", message: "broken", severity: "low" },
      }),
    );

    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.severity).toBe("low");
  });

  it("invalid severity falls back to medium", () => {
    const result = pipeline.processEvent(
      makeEvent({
        eventId: "evt-p7-badsev",
        kind: "error_incident",
        payload: { category: "tool", message: "broken", severity: "banana" },
      }),
    );

    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.severity).toBe("medium");
  });
});

describe("Approval → execution linkage", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EXPIRES = "2025-06-16T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  it("approveAndExecute chains approve → execute", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();

    // Setup FK deps
    incidentRepo.insert(db.writer, {
      incidentId: "inc-ae-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-ae",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-ae-001",
      incidentId: "inc-ae-001",
      errorFingerprint: "sig-ae",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const plan = {
      title: "Auto-fix: disable skill",
      summary: "Disable broken skill",
      steps: [
        {
          stepId: "step-ae-001",
          kind: "disable_skill" as const,
          target: "skill-x",
          payload: {},
          verify: { method: "error_absent" as const, timeoutMs: 5000 },
        },
      ],
      rollbackPlan: {
        summary: "Re-enable skill",
        steps: [
          {
            stepId: "rb-ae-001",
            kind: "disable_skill" as const,
            target: "skill-x",
            payload: { revert: true },
          },
        ],
      },
      evidence: {
        fingerprint: "sig-ae",
        matchedLessonIds: [],
        diagnosisId: "diag-ae-001",
        recurrenceCount: 1,
      },
    };

    actionRepo.insert(db.writer, {
      actionId: "action-ae-001",
      incidentId: "inc-ae-001",
      userId: "test-user",
      riskTier: 2,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: (step) => {
          const payload = step.payload as Record<string, unknown> | null;
          if (payload && typeof payload === "object") {
            payload._skillDisabled = true;
          }
          return true;
        },
      },
    });

    const approvalService = createFridayApprovalWorkflowService({
      db,
      approvalRepo,
      actionRepo,
      idGenerator: idGen,
      executionService,
    });

    // Create approval request
    const request = approvalService.createRequestForAction({
      action: {
        actionId: "action-ae-001",
        incidentId: "inc-ae-001",
        userId: "test-user",
        riskTier: 2,
        plan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      description: "Approve skill disable",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    expect(request.status).toBe("pending");

    // Approve and execute in one call
    const { approval, execution } = await approvalService.approveAndExecute({
      requestId: request.requestId,
      respondedBy: "test-user",
      reason: "Looks safe",
      nowIso: NOW,
    });

    expect(approval.status).toBe("approved");
    expect(execution.success).toBe(true);
    expect(execution.action.status).toBe("applied");
    expect(execution.action.outcome).toBe("success");
  });

  it("dispatcher runApprovedAction validates approval before execution", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const approvalRepo = createFridayApprovalRequestRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();

    incidentRepo.insert(db.writer, {
      incidentId: "inc-disp-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-disp",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-disp-001",
      incidentId: "inc-disp-001",
      errorFingerprint: "sig-disp",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const plan = {
      title: "Auto-fix: retry",
      summary: "Retry",
      steps: [
        {
          stepId: "step-disp-001",
          kind: "retry_node" as const,
          target: "tool",
          payload: {},
          verify: { method: "error_absent" as const, timeoutMs: 5000 },
        },
      ],
      rollbackPlan: {
        summary: "Revert retry",
        steps: [
          {
            stepId: "rb-disp-001",
            kind: "retry_node" as const,
            target: "tool",
            payload: { revert: true },
          },
        ],
      },
      evidence: {
        fingerprint: "sig-disp",
        matchedLessonIds: [],
        diagnosisId: "diag-disp-001",
        recurrenceCount: 1,
      },
    };

    actionRepo.insert(db.writer, {
      actionId: "action-disp-001",
      incidentId: "inc-disp-001",
      userId: "test-user",
      riskTier: 2,
      plan,
      rollbackPlan: plan.rollbackPlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: (step) => {
          const payload = step.payload as Record<string, unknown> | null;
          if (payload && typeof payload === "object") {
            payload._retryRequested = true;
          }
          return true;
        },
      },
    });

    const dispatcher = createFridayAutoFixDispatcherService({
      db,
      actionRepo,
      approvalRepo,
      executionService,
    });

    // Should throw because no approved approval exists
    await expect(dispatcher.runApprovedAction("action-disp-001")).rejects.toThrow(
      "no approved approval request",
    );

    // Now create and approve the request
    const planForApproval = { ...plan };
    approvalRepo.insert(db.writer, {
      requestId: "req-disp-001",
      actionId: "action-disp-001",
      userId: "test-user",
      description: "Approved",
      riskTier: 2,
      plan: planForApproval,
      requestedAt: NOW,
      expiresAt: EXPIRES,
      status: "approved",
      respondedAt: NOW,
      respondedBy: "test-user",
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Now it should work
    const result = await dispatcher.runApprovedAction("action-disp-001");
    expect(result.success).toBe(true);
    expect(result.action.status).toBe("applied");
  });
});
