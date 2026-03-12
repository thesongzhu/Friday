import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayErrorDiagnosisService } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import { createFridayLearnedLessonRepository } from "#learning";
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

    service = createFridayErrorDiagnosisService({
      db,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
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
});
