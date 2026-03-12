import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayLearningMetricsRepository } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayLearningMetricsService } from "#learning";
import { createFridayLearningMetricsJob } from "#jobs";
import type { FridayLearningMetricsJob } from "#jobs";
import { createFridayLearningEventLedger } from "#ledger";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayPreferenceFactRepository } from "#learning";
import type { FridayAutoFixPlan } from "#learning";

describe("FridayLearningMetricsJob", () => {
  let db: FridaySqliteLayer;
  let job: FridayLearningMetricsJob;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    const metricsRepo = createFridayLearningMetricsRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const metricsService = createFridayLearningMetricsService({
      db,
      metricsRepo,
      actionRepo,
      nowIso: () => NOW,
    });

    job = createFridayLearningMetricsJob({
      metricsService,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("aggregates metrics for a day with no data", () => {
    const result = job.run("2025-06-15");

    expect(result.day).toBe("2025-06-15");
    expect(result.metric.incidentsTotal).toBe(0);
    expect(result.metric.factsUpdated).toBe(0);
    expect(result.metric.actionsExecuted).toBe(0); // Phase 6: always 0
    expect(result.metric.successRate).toBeUndefined();
  });

  it("aggregates metrics for a day with incidents", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert incidents for the day
    db.withWriteTransaction((writer) => {
      for (let i = 0; i < 3; i++) {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-15T0${i + 1}:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: `sig-${i}`,
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });

    const result = job.run("2025-06-15");
    expect(result.metric.incidentsTotal).toBe(3);
  });

  it("aggregates metrics for a day with preference facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert facts updated on target day
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.90,
        evidenceCountDelta: 1,
        lastConfirmedAt: "2025-06-15T08:00:00.000Z",
        sourceEventId: "evt-001",
        nowIso: "2025-06-15T08:00:00.000Z",
      });
    });

    const result = job.run("2025-06-15");
    expect(result.metric.factsUpdated).toBe(1);
  });

  it("computes success rate from workflow outcomes", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Insert successful and failed workflow outcomes
    ledger.appendEvent({
      eventId: "evt-success-1",
      ts: "2025-06-15T08:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: true, workflowId: "wf-1" },
    });
    ledger.appendEvent({
      eventId: "evt-success-2",
      ts: "2025-06-15T09:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: true, workflowId: "wf-2" },
    });
    ledger.appendEvent({
      eventId: "evt-fail-1",
      ts: "2025-06-15T10:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: false, workflowId: "wf-3" },
    });

    const result = job.run("2025-06-15");
    // 2 success out of 3 total = ~0.666
    expect(result.metric.successRate).toBeCloseTo(0.666, 2);
  });

  it("uses current day when no override provided", () => {
    const result = job.run();
    // Should use NOW.slice(0,10) = "2025-06-15"
    expect(result.day).toBe("2025-06-15");
  });

  it("actionsExecuted is 0 when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.actionsExecuted).toBe(0);
  });

  it("autoFixSuccessRate is undefined when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.autoFixSuccessRate).toBeUndefined();
  });

  it("rollbackRate is undefined when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.rollbackRate).toBeUndefined();
  });

  it("computes auto-fix metrics when actions exist", () => {
    const incidentRepo = createFridayErrorIncidentRepository();
    const actionRepo = createFridayAutoFixActionRepository();

    const basePlan: FridayAutoFixPlan = {
      title: "test",
      summary: "test",
      steps: [{ stepId: "s1", kind: "retry_node", target: "t", payload: {} }],
      evidence: { fingerprint: "sig", matchedLessonIds: [], diagnosisId: "d1", recurrenceCount: 1 },
    };

    // Create incidents + actions
    db.withWriteTransaction((writer) => {
      incidentRepo.insert(writer, {
        incidentId: "inc-m1",
        userId: "test-user",
        ts: "2025-06-15T01:00:00.000Z",
        category: "tool",
        severity: "medium",
        signature: "sig-m1",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
      incidentRepo.insert(writer, {
        incidentId: "inc-m2",
        userId: "test-user",
        ts: "2025-06-15T02:00:00.000Z",
        category: "tool",
        severity: "medium",
        signature: "sig-m2",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      actionRepo.insert(writer, {
        actionId: "act-m1",
        incidentId: "inc-m1",
        userId: "test-user",
        riskTier: 0,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.markApplied(writer, "act-m1", "success", NOW);

      actionRepo.insert(writer, {
        actionId: "act-m2",
        incidentId: "inc-m2",
        userId: "test-user",
        riskTier: 0,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.markRolledBack(writer, "act-m2", NOW);
    });

    const result = job.run("2025-06-15");
    expect(result.metric.actionsExecuted).toBe(2);
    expect(result.metric.autoFixSuccessRate).toBeCloseTo(0.5, 2);
    expect(result.metric.rollbackRate).toBeCloseTo(0.5, 2);
  });
});
