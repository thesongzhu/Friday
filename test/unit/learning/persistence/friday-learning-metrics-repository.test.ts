import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayLearningMetricsRepository } from "#learning";
import type { FridayLearningMetricsRepository } from "#learning";
import type { FridayLearningMetricsEntity } from "#learning";

describe("FridayLearningMetricsRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayLearningMetricsRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseMetric: FridayLearningMetricsEntity = {
    day: "2025-06-15",
    successRate: 0.85,
    incidentsTotal: 3,
    factsUpdated: 5,
    actionsExecuted: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayLearningMetricsRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("upsertDay inserts a new day metric", () => {
    const result = repo.upsertDay(db.writer, baseMetric);
    expect(result.day).toBe("2025-06-15");
    expect(result.successRate).toBe(0.85);
    expect(result.incidentsTotal).toBe(3);
    expect(result.factsUpdated).toBe(5);
    expect(result.actionsExecuted).toBe(0);
  });

  it("upsertDay updates existing day metric on conflict", () => {
    repo.upsertDay(db.writer, baseMetric);

    const updated = repo.upsertDay(db.writer, {
      ...baseMetric,
      successRate: 0.90,
      incidentsTotal: 5,
      updatedAt: "2025-06-15T12:00:00.000Z",
    });

    expect(updated.successRate).toBe(0.90);
    expect(updated.incidentsTotal).toBe(5);
  });

  it("getDay returns null for non-existent day", () => {
    const result = repo.getDay(db.writer, "2025-01-01");
    expect(result).toBeNull();
  });

  it("getDay returns the metric for existing day", () => {
    repo.upsertDay(db.writer, baseMetric);
    const result = repo.getDay(db.writer, "2025-06-15");
    expect(result).not.toBeNull();
    expect(result!.day).toBe("2025-06-15");
  });

  it("listDays returns metrics in descending order", () => {
    for (let d = 15; d <= 18; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
        incidentsTotal: d,
      });
    }

    const results = repo.listDays(db.writer);
    expect(results).toHaveLength(4);
    expect(results[0]!.day).toBe("2025-06-18");
    expect(results[3]!.day).toBe("2025-06-15");
  });

  it("listDays filters by date range", () => {
    for (let d = 15; d <= 18; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
      });
    }

    const filtered = repo.listDays(db.writer, "2025-06-16", "2025-06-17");
    expect(filtered).toHaveLength(2);
  });

  it("listDays respects limit", () => {
    for (let d = 10; d <= 20; d++) {
      repo.upsertDay(db.writer, {
        ...baseMetric,
        day: `2025-06-${d}`,
      });
    }

    const limited = repo.listDays(db.writer, undefined, undefined, 3);
    expect(limited).toHaveLength(3);
  });

  it("handles null optional rates", () => {
    const metric: FridayLearningMetricsEntity = {
      day: "2025-06-15",
      incidentsTotal: 0,
      factsUpdated: 0,
      actionsExecuted: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };

    repo.upsertDay(db.writer, metric);
    const result = repo.getDay(db.writer, "2025-06-15");
    expect(result!.successRate).toBeUndefined();
    expect(result!.autoFixSuccessRate).toBeUndefined();
    expect(result!.rollbackRate).toBeUndefined();
    expect(result!.activationRate).toBeUndefined();
    expect(result!.saveRate).toBeUndefined();
    expect(result!.reuseRate).toBeUndefined();
    expect(result!.promotionRate).toBeUndefined();
    expect(result!.supportConversionRate).toBeUndefined();
    expect(result!.requestFulfillmentRate).toBeUndefined();
  });

  it("persists expanded conversion metrics", () => {
    repo.upsertDay(db.writer, {
      ...baseMetric,
      activationRate: 0.4,
      saveRate: 0.2,
      reuseRate: 0.1,
      promotionRate: 0.05,
      supportConversionRate: 0.02,
      requestFulfillmentRate: 0.03,
    });

    const result = repo.getDay(db.writer, "2025-06-15");
    expect(result).toMatchObject({
      activationRate: 0.4,
      saveRate: 0.2,
      reuseRate: 0.1,
      promotionRate: 0.05,
      supportConversionRate: 0.02,
      requestFulfillmentRate: 0.03,
    });
  });
});
