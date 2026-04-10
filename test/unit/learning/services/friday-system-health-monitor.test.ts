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

  it("triggers auto-fix when expired memory items exceed threshold", () => {
    // Insert expired memory items to trigger unhealthy state
    const pastDate = "2020-01-01T00:00:00.000Z";
    db.withWriteTransaction((writerDb) => {
      for (let i = 0; i < 600; i++) {
        writerDb.prepare(
          "INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at, expires_at) VALUES (?, 'test', ?, '{}', '[]', ?, ?, ?)",
        ).run(`mem-${i}`, `key-${i}`, pastDate, pastDate, pastDate);
      }
    });

    const summary = monitor.runAll();
    const memCheck = summary.checks.find((c) => c.name === "expired_memory_items");
    expect(memCheck).toBeDefined();
    expect(memCheck!.healthy).toBe(false);
    expect(memCheck!.value).toBe(600);

    // Should have triggered auto-fix
    const memFix = summary.autoFixes.find((f) => f.name === "expired_memory_items");
    expect(memFix).toBeDefined();
    expect(memFix!.fixed).toBe(true);
    expect(memFix!.detail).toMatch(/Pruned \d+ expired memory items/);
  });

  it("does not trigger auto-fix when checks are healthy", () => {
    const summary = monitor.runAll();
    // All checks should be healthy on a fresh test DB
    for (const check of summary.checks) {
      if (check.name !== "stale_realtime_checkpoints" && check.name !== "expired_memory_items") {
        expect(check.healthy).toBe(true);
      }
    }
    // No auto-fixes should run for healthy checks
    expect(summary.autoFixes.filter((f) => f.name === "db_size")).toHaveLength(0);
  });
});
