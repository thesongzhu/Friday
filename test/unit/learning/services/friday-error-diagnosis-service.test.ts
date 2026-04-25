import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayErrorDiagnosisService } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import { createFridayLearnedLessonRepository } from "#learning";
import { createFridayPreferenceFactRepository } from "#learning";
import type { FridayErrorDiagnosisService } from "#learning";
import type { FridayErrorIncidentEntity } from "#learning";

describe("FridayErrorDiagnosisService", () => {
  let db: FridaySqliteLayer;
  let service: FridayErrorDiagnosisService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-tool-timeout",
    context: { toolName: "search", error: "timeout" },
    autoFixEligible: false,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();
    const factRepo = createFridayPreferenceFactRepository();

    service = createFridayErrorDiagnosisService({
      db,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      factRepo,
      idGenerator: idGen,
    });

    // Insert base incident
    incidentRepo.insert(db.writer, baseIncident);
  });

  afterEach(() => {
    db.close();
  });

  it("produces a diagnosis for a simple incident", () => {
    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });

    expect(result.diagnosis).toBeDefined();
    expect(result.diagnosis.errorFingerprint).toBe("sig-tool-timeout");
    expect(result.diagnosis.confidence).toBeGreaterThan(0);
    expect(result.recurrenceCount).toBeGreaterThanOrEqual(1);
  });

  it("returns autoFixEligible=false for low confidence", () => {
    // Fresh incident with no lessons and no recurrence → low confidence
    const freshIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-fresh",
      signature: "sig-never-seen-before",
    };

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, freshIncident);

    const result = service.diagnose({ incident: freshIncident, nowIso: NOW });
    expect(result.autoFixEligible).toBe(false);
    expect(result.candidatePlans).toHaveLength(0);
  });

  it("boosts confidence with matched lessons", () => {
    // Insert a lesson matching the fingerprint
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-001",
      fingerprint: "sig-tool-timeout",
      title: "Tool Timeout Fix",
      cause: "Network latency",
      fix: "Increase timeout to 30s",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });
    expect(result.matchedLessons).toHaveLength(1);
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.autoFixEligible).toBe(true);
    expect(result.candidatePlans.length).toBeGreaterThan(0);
  });

  it("normalizes recursive lesson prefixes before emitting candidate plans", () => {
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-recursive-title",
      fingerprint: "sig-tool-timeout",
      title: "Auto-fixed: Auto-fix: retry workflow",
      cause: "Historical retry resolved the issue",
      fix: "Retry the workflow",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });

    expect(result.candidatePlans).toHaveLength(1);
    expect(result.candidatePlans[0]!.title).toBe("Auto-fix: retry workflow");
  });

  it("ignores disabled lessons when a matching disable fact exists", () => {
    const lessonRepo = createFridayLearnedLessonRepository();
    const factRepo = createFridayPreferenceFactRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-disabled",
      fingerprint: "sig-tool-timeout",
      title: "Tool Timeout Fix",
      cause: "Network latency",
      fix: "Increase timeout to 30s",
      nowIso: NOW,
    });
    factRepo.upsert(db.writer, {
      factId: "fact-001",
      userId: "test-user",
      key: "lesson_disabled:lesson-disabled",
      value: {
        disabled: true,
        reason: "Operator override",
      },
      confidence: 1,
      evidenceCountDelta: 1,
      lastConfirmedAt: NOW,
      sourceEventId: "test:event",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });
    expect(result.matchedLessons).toHaveLength(0);
    expect(result.diagnosis.diagnosis.matchedLessonIds).toEqual([]);
    expect(result.autoFixEligible).toBe(false);
  });

  it("boosts confidence with recurrence", () => {
    // Insert multiple incidents with same signature
    const incidentRepo = createFridayErrorIncidentRepository();
    for (let i = 2; i <= 6; i++) {
      incidentRepo.insert(db.writer, {
        ...baseIncident,
        incidentId: `inc-00${i}`,
        ts: `2025-06-15T1${i}:00:00.000Z`,
      });
    }

    // Also insert a lesson to push over the threshold
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-recur",
      fingerprint: "sig-tool-timeout",
      title: "Recurring timeout",
      cause: "Persistent issue",
      fix: "Apply retry logic",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });
    expect(result.recurrenceCount).toBeGreaterThanOrEqual(5);
    expect(result.autoFixEligible).toBe(true);
  });

  it("creates a diagnosis record in the database", () => {
    service.diagnose({ incident: baseIncident, nowIso: NOW });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const records = diagnosisRepo.listByFingerprint(
      db.writer,
      "sig-tool-timeout",
    );
    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("handles high severity incidents", () => {
    const highSev: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-high",
      severity: "high",
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, highSev);

    const result = service.diagnose({ incident: highSev, nowIso: NOW });
    // High severity starts at 0.5 base confidence
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("boosts deterministic internal runtime failures into supervised auto-fix eligibility", () => {
    const internalRuntimeIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-internal-runtime",
      category: "config",
      severity: "medium",
      signature: "sig-satellite-runtime",
      context: {
        source: "satellite_runtime",
        satelliteId: "sat-1",
      },
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, internalRuntimeIncident);

    const result = service.diagnose({ incident: internalRuntimeIncident, nowIso: NOW });

    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.autoFixEligible).toBe(true);
  });

  it("does not emit marker-only config candidate plans from matched lessons", () => {
    const lessonRepo = createFridayLearnedLessonRepository();
    const configIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-config-lesson",
      category: "config",
      signature: "sig-config-lesson",
      context: { key: "provider.defaultModel", error: "invalid" },
    };
    createFridayErrorIncidentRepository().insert(db.writer, configIncident);
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-config-001",
      fingerprint: "sig-config-lesson",
      title: "Config Fix",
      cause: "Invalid config",
      fix: "Patch provider.defaultModel",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: configIncident, nowIso: NOW });

    expect(result.autoFixEligible).toBe(true);
    expect(result.matchedLessons).toHaveLength(1);
    expect(result.candidatePlans).toHaveLength(0);
  });

  it("boosts structured workflow runtime failures with run and node evidence", () => {
    db.writer.prepare(
      `INSERT INTO workflows (
        id, slug, name, latest_version_number, revision, is_archived, etag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-1",
      "workflow-runtime-proof",
      "Workflow Runtime Proof",
      1,
      1,
      0,
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
      "Synthetic version for diagnosis test",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload_json,
        started_by_user_id, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-run-1",
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

    const workflowRuntimeIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-workflow-runtime",
      category: "workflow",
      severity: "medium",
      signature: "sig-workflow-runtime",
      runId: "wf-run-1",
      nodeId: "ai-1",
      context: {
        source: "workflow_runtime",
        workflowId: "wf-1",
        workflowVersionId: "wf-v-1",
      },
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, workflowRuntimeIncident);

    const result = service.diagnose({ incident: workflowRuntimeIncident, nowIso: NOW });

    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.autoFixEligible).toBe(true);
  });

  it("builds disable_skill candidate plans for skills_lifecycle verification failures", () => {
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-skill-001",
      fingerprint: "sig-skill-verify",
      title: "Disable incompatible skill",
      cause: "Verification failed after contract drift",
      fix: "Disable the broken skill until repaired",
      nowIso: NOW,
    });

    const skillLifecycleIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-skill-lifecycle",
      category: "workflow",
      severity: "medium",
      signature: "sig-skill-verify",
      context: {
        source: "skills_lifecycle",
        skillId: "extract-action-items",
        stage: "verify",
      },
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, skillLifecycleIncident);

    const result = service.diagnose({ incident: skillLifecycleIncident, nowIso: NOW });

    expect(result.autoFixEligible).toBe(true);
    expect(result.candidatePlans).toHaveLength(1);
    expect(result.candidatePlans[0]!.steps[0]!.kind).toBe("disable_skill");
    expect(result.candidatePlans[0]!.steps[0]!.target).toBe("extract-action-items");
  });

  it("preserves workflow run context in lesson-backed retry plans", () => {
    db.writer.prepare(
      `INSERT INTO workflows (
        id, slug, name, latest_version_number, revision, is_archived, etag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-ctx-1",
      "workflow-context-proof",
      "Workflow Context Proof",
      1,
      1,
      0,
      "etag-wf-ctx-1",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_versions (
        id, workflow_id, version_number, checksum, graph_json, created_by_user_id,
        is_published, change_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-ctx-version-1",
      "wf-ctx-1",
      1,
      "checksum-wf-ctx-1",
      "{\"nodes\":[],\"edges\":[]}",
      "test-user",
      1,
      "Synthetic version for plan payload test",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload_json,
        started_by_user_id, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-ctx-run-1",
      "wf-ctx-1",
      "wf-ctx-version-1",
      "failed",
      "manual",
      "{}",
      "test-user",
      NOW,
      NOW,
      NOW,
    );
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-wf-ctx",
      fingerprint: "sig-workflow-context",
      title: "Retry workflow action",
      cause: "Known transient workflow failure",
      fix: "Retry the failed workflow operation",
      nowIso: NOW,
    });

    const workflowRuntimeIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-workflow-context",
      category: "workflow",
      severity: "medium",
      signature: "sig-workflow-context",
      runId: "wf-ctx-run-1",
      nodeId: "ai-ctx-1",
      context: {
        source: "workflow_runtime",
        workflowId: "wf-ctx-1",
      },
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, workflowRuntimeIncident);

    const result = service.diagnose({ incident: workflowRuntimeIncident, nowIso: NOW });
    const payload = result.candidatePlans[0]?.steps[0]?.payload as Record<string, unknown> | undefined;

    expect(result.autoFixEligible).toBe(true);
    expect(payload?.runId).toBe("wf-ctx-run-1");
    expect(payload?.nodeId).toBe("ai-ctx-1");
  });

  it("suppresses auto-fix for deterministic workflow_runtime skill-missing failures", () => {
    db.writer.prepare(
      `INSERT INTO workflows (
        id, slug, name, latest_version_number, revision, is_archived, etag, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-missing-skill",
      "workflow-missing-skill",
      "Workflow Missing Skill",
      1,
      1,
      0,
      "etag-wf-missing-skill",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_versions (
        id, workflow_id, version_number, checksum, graph_json, created_by_user_id,
        is_published, change_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-missing-skill-v1",
      "wf-missing-skill",
      1,
      "checksum-missing-skill",
      "{\"nodes\":[],\"edges\":[]}",
      "test-user",
      1,
      "Synthetic version for missing-skill suppression test",
      NOW,
      NOW,
    );
    db.writer.prepare(
      `INSERT INTO workflow_runs (
        id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload_json,
        started_by_user_id, started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wf-run-missing-skill",
      "wf-missing-skill",
      "wf-missing-skill-v1",
      "failed",
      "manual",
      "{}",
      "test-user",
      NOW,
      NOW,
      NOW,
    );

    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-skill-missing",
      fingerprint: "sig-workflow-skill-missing",
      title: "Auto-fixed: retry workflow",
      cause: "Historical auto-fix claimed retry resolved it",
      fix: "Retry the failed workflow operation",
      mitigation: { autoFixApplied: true },
      nowIso: NOW,
    });

    const workflowRuntimeIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-workflow-skill-missing",
      category: "workflow",
      severity: "medium",
      signature: "sig-workflow-skill-missing",
      runId: "wf-run-missing-skill",
      nodeId: "action1",
      context: {
        source: "workflow_runtime",
        workflowId: "wf-missing-skill",
        workflowVersionId: "wf-missing-skill-v1",
        failedNodeErrorCode: "NODE_EXECUTION_FAILED",
        failedNodeErrorMessage:
          "NODE_EXECUTION_FAILED: Step \"execute\" failed: NODE_EXECUTION_FAILED: skill 'missing-skill' not found",
        failedNodeRetryable: false,
      },
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, workflowRuntimeIncident);

    const result = service.diagnose({ incident: workflowRuntimeIncident, nowIso: NOW });

    expect(result.matchedLessons).toHaveLength(1);
    expect(result.autoFixEligible).toBe(false);
    expect(result.candidatePlans).toHaveLength(0);
    expect(result.diagnosis.diagnosis.autoFixSuppressedReason).toBeDefined();
  });

  it("excludes negative lessons (rejected fixes) from candidate plans", () => {
    const lessonRepo = createFridayLearnedLessonRepository();

    // Seed a rejected (negative) lesson for the incident's fingerprint
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-neg",
      fingerprint: "sig-tool-timeout",
      title: "Rejected: Retry node",
      cause: "Fix rejected by operator",
      fix: "Do not auto-apply retry_node",
      mitigation: { rejected: true, rejectedReason: "wrong approach" },
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });

    // Negative lessons should be excluded from matched lessons and candidate plans
    expect(result.matchedLessons).toHaveLength(0);
    expect(result.candidatePlans).toHaveLength(0);
  });

  it("excludes failed-fix lessons from candidate plans", () => {
    const lessonRepo = createFridayLearnedLessonRepository();

    // Seed a failed-fix lesson
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-fail",
      fingerprint: "sig-tool-timeout",
      title: "Failed fix: Retry node",
      cause: "Auto-fix did not resolve issue",
      fix: "Avoid repeating retry_node",
      mitigation: { autoFixFailed: true, outcome: "failed" },
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });

    expect(result.matchedLessons).toHaveLength(0);
    expect(result.candidatePlans).toHaveLength(0);
  });

  it("confidence is always clamped to [0, 1]", () => {
    // High severity (0.5) + lesson match (0.3) + max recurrence (0.2) + historical (0.1) + internal source (0.3)
    // = 1.4 unclamped, should be clamped to 1.0
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-clamp",
      fingerprint: "sig-internal-crash",
      title: "Known fix",
      cause: "Internal crash",
      fix: "Retry",
      nowIso: NOW,
    });
    const incidentRepo = createFridayErrorIncidentRepository();
    const highSeverityIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-clamp",
      severity: "high",
      signature: "sig-internal-crash",
      context: { source: "assistant" },
    };
    incidentRepo.insert(db.writer, highSeverityIncident);
    // Seed recurrence (insert multiple incidents with same signature)
    for (let i = 0; i < 10; i++) {
      incidentRepo.insert(db.writer, {
        ...highSeverityIncident,
        incidentId: `inc-recur-${i}`,
      });
    }

    const result = service.diagnose({ incident: highSeverityIncident, nowIso: NOW });

    expect(result.diagnosis.confidence).toBeLessThanOrEqual(1.0);
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0);
  });

  it("autoFixEligible boundary: confidence exactly at threshold (0.6)", () => {
    // Medium severity (0.3) + lesson match (0.3) = 0.6 exactly
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-boundary",
      fingerprint: "sig-boundary",
      title: "Boundary fix",
      cause: "Boundary error",
      fix: "Boundary fix",
      nowIso: NOW,
    });
    const boundaryIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-boundary",
      severity: "medium",
      signature: "sig-boundary",
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, boundaryIncident);

    const result = service.diagnose({ incident: boundaryIncident, nowIso: NOW });

    // 0.3 (medium) + 0.3 (lesson) + recurrence boost from the 1 incident = 0.65
    // Auto-fix threshold is 0.6
    expect(result.autoFixEligible).toBe(true);
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.6);
  });
});
