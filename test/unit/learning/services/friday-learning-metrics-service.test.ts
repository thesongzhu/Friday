import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayLearningMetricsService,
  createFridayLearningMetricsRepository,
} from "#learning";
import type { FridayLearningMetricsService } from "#learning";

describe("FridayLearningMetricsService", () => {
  let db: FridaySqliteLayer;
  let service: FridayLearningMetricsService;
  const NOW = "2025-06-15T10:00:00.000Z";
  const DAY = "2025-06-15";

  beforeEach(() => {
    db = createTestDb();
    const metricsRepo = createFridayLearningMetricsRepository();
    service = createFridayLearningMetricsService({
      db,
      metricsRepo,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function insertLearningEvent(kind: string, ts: string, payload: Record<string, unknown> = {}) {
    db.writer.prepare(
      `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json)
       VALUES (?, ?, 'test-user', ?, ?)`,
    ).run(`evt-${Math.random().toString(36).slice(2, 10)}`, ts, kind, JSON.stringify(payload));
  }

  function insertIncident(ts: string) {
    const id = `inc-${Math.random().toString(36).slice(2, 10)}`;
    db.writer.prepare(
      `INSERT INTO error_incidents (incident_id, user_id, ts, category, severity, signature, context_json, auto_fix_eligible, status, created_at, updated_at)
       VALUES (?, 'test-user', ?, 'tool', 'medium', 'sig-abc', '{}', 1, 'open', ?, ?)`,
    ).run(id, ts, ts, ts);
  }

  let factCounter = 0;
  function insertPreferenceFact(updatedAt: string) {
    const id = `fact-${++factCounter}`;
    const key = `pref:test-${factCounter}`;
    db.writer.prepare(
      `INSERT INTO preference_facts (fact_id, user_id, key, value_json, confidence, evidence_count, last_confirmed_at, source_event_ids_json, created_at, updated_at)
       VALUES (?, 'test-user', ?, '"val"', 0.9, 1, ?, '["evt-001"]', ?, ?)`,
    ).run(id, key, updatedAt, updatedAt, updatedAt);
  }

  it("aggregates a day with no data", () => {
    const result = service.aggregateDay(DAY);
    expect(result.day).toBe(DAY);
    expect(result.incidentsTotal).toBe(0);
    expect(result.factsUpdated).toBe(0);
    expect(result.actionsExecuted).toBe(0);
    expect(result.successRate).toBeUndefined();
    expect(result.activationRate).toBeUndefined();
  });

  it("counts incidents for the day", () => {
    insertIncident("2025-06-15T05:00:00.000Z");
    insertIncident("2025-06-15T12:00:00.000Z");
    // Outside the day range
    insertIncident("2025-06-16T01:00:00.000Z");

    const result = service.aggregateDay(DAY);
    expect(result.incidentsTotal).toBe(2);
  });

  it("counts facts updated for the day", () => {
    insertPreferenceFact("2025-06-15T08:00:00.000Z");
    insertPreferenceFact("2025-06-15T14:00:00.000Z");
    // Outside the day range
    insertPreferenceFact("2025-06-14T23:00:00.000Z");

    const result = service.aggregateDay(DAY);
    expect(result.factsUpdated).toBe(2);
  });

  it("computes success rate from workflow outcomes", () => {
    insertLearningEvent("workflow_outcome", "2025-06-15T10:00:00.000Z", { success: 1 });
    insertLearningEvent("workflow_outcome", "2025-06-15T11:00:00.000Z", { success: 1 });
    insertLearningEvent("workflow_outcome", "2025-06-15T12:00:00.000Z", { success: 0 });

    const result = service.aggregateDay(DAY);
    expect(result.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("computes activation rate", () => {
    insertLearningEvent("workflow_outcome", "2025-06-15T10:00:00.000Z", { success: 1 });
    insertLearningEvent("automation_saved", "2025-06-15T11:00:00.000Z");
    insertLearningEvent("user_message", "2025-06-15T12:00:00.000Z");

    const result = service.aggregateDay(DAY);
    // 2 activation events out of 3 total
    expect(result.activationRate).toBeCloseTo(2 / 3, 5);
  });

  it("computes save rate", () => {
    insertLearningEvent("automation_saved", "2025-06-15T10:00:00.000Z");
    insertLearningEvent("user_message", "2025-06-15T11:00:00.000Z");

    const result = service.aggregateDay(DAY);
    expect(result.saveRate).toBeCloseTo(0.5, 5);
  });

  it("aggregates a range of days", () => {
    insertIncident("2025-06-15T05:00:00.000Z");
    insertIncident("2025-06-16T08:00:00.000Z");

    const results = service.aggregateRange("2025-06-15", "2025-06-16");
    expect(results).toHaveLength(2);
    expect(results[0]!.day).toBe("2025-06-15");
    expect(results[0]!.incidentsTotal).toBe(1);
    expect(results[1]!.day).toBe("2025-06-16");
    expect(results[1]!.incidentsTotal).toBe(1);
  });

  it("sets timestamps on aggregated metrics", () => {
    const result = service.aggregateDay(DAY);
    expect(result.createdAt).toBe(NOW);
    expect(result.updatedAt).toBe(NOW);
  });
});
