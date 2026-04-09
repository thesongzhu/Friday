import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridaySystemHealthMonitor,
  type FridaySystemHealthMonitor,
  type FridaySystemHealthRunSummary,
} from "../../../../src/learning/services/friday-system-health-monitor.js";

describe("FridaySystemHealthMonitor", () => {
  let db: FridaySqliteLayer;
  let monitor: FridaySystemHealthMonitor;
  const NOW = "2025-06-15T10:00:00.000Z";
  const summaries: FridaySystemHealthRunSummary[] = [];

  beforeEach(() => {
    db = createTestDb();
    summaries.length = 0;

    monitor = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      onRunComplete: (summary) => summaries.push(summary),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("runs all health checks and returns summary", () => {
    const summary = monitor.runAll();

    expect(summary.runAt).toBe(NOW);
    expect(summary.checks.length).toBeGreaterThanOrEqual(1);

    // process_heap should always be present
    const heapCheck = summary.checks.find((c) => c.name === "process_heap");
    expect(heapCheck).toBeDefined();
    expect(heapCheck!.unit).toBe("MB");
    expect(heapCheck!.value).toBeGreaterThan(0);
  });

  it("reports db_size check", () => {
    const summary = monitor.runAll();
    const dbCheck = summary.checks.find((c) => c.name === "db_size");
    expect(dbCheck).toBeDefined();
    expect(dbCheck!.unit).toBe("bytes");
    // Test DB should be small and healthy
    expect(dbCheck!.healthy).toBe(true);
  });

  it("invokes onRunComplete callback", () => {
    monitor.runAll();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.runAt).toBe(NOW);
  });

  it("does not crash when tables are missing", () => {
    // The monitor should handle missing tables gracefully
    const summary = monitor.runAll();
    expect(summary.checks.length).toBeGreaterThanOrEqual(1);
  });
});
