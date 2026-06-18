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
  const PAST_DATE = "2020-01-01T00:00:00.000Z";

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

  function countExpiredMemoryItems(): number {
    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT COUNT(*) AS cnt FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < ?")
        .get(NOW),
    ) as { cnt: number };
    return row.cnt;
  }

  function countStaleRealtimeCheckpoints(): number {
    const cutoff = new Date(new Date(NOW).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT COUNT(*) AS cnt FROM realtime_checkpoints WHERE updated_at < ?")
        .get(cutoff),
    ) as { cnt: number };
    return row.cnt;
  }

  function insertExpiredMemoryItems(count: number): void {
    db.withWriteTransaction((writerDb) => {
      for (let i = 0; i < count; i++) {
        writerDb.prepare(
          "INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at, expires_at) VALUES (?, 'test', ?, '{}', '[]', ?, ?, ?)",
        ).run(`mem-${i}`, `key-${i}`, PAST_DATE, PAST_DATE, PAST_DATE);
      }
    });
  }

  function insertStaleRealtimeCheckpoints(count: number): void {
    db.withWriteTransaction((writerDb) => {
      for (let i = 0; i < count; i++) {
        writerDb.prepare(
          "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, cursor, updated_at) VALUES (?, ?, 0, 1, NULL, ?)",
        ).run(`principal-${i}`, `stream-${i}`, PAST_DATE);
      }
    });
  }

  it("diagnoses expired memory items without cleanup by default", () => {
    insertExpiredMemoryItems(600);

    const summary = monitor.runAll();
    const memCheck = summary.checks.find((c) => c.name === "expired_memory_items");
    expect(memCheck).toBeDefined();
    expect(memCheck!.healthy).toBe(false);
    expect(memCheck!.value).toBe(600);

    expect(summary.maintenanceReceipts).toHaveLength(0);
    expect(summary.maintenanceRecommendations).toContainEqual({
      name: "expired_memory_items",
      gateRequired: "explicit_maintenance",
      detail: "Expired memory item cleanup must run through the Rust memory owner/migration path",
      value: 600,
      unit: "items",
    });
    expect(countExpiredMemoryItems()).toBe(600);
  });

  it("diagnoses stale realtime checkpoints without cleanup by default", () => {
    insertStaleRealtimeCheckpoints(1001);

    const summary = monitor.runAll();
    const checkpointCheck = summary.checks.find((c) => c.name === "stale_realtime_checkpoints");

    expect(checkpointCheck).toBeDefined();
    expect(checkpointCheck!.healthy).toBe(false);
    expect(checkpointCheck!.value).toBe(1001);
    expect(summary.maintenanceReceipts).toHaveLength(0);
    expect(summary.maintenanceRecommendations).toContainEqual({
      name: "stale_realtime_checkpoints",
      gateRequired: "explicit_maintenance",
      detail: "Prune stale realtime checkpoints",
      value: 1001,
      unit: "checkpoints",
    });
    expect(countStaleRealtimeCheckpoints()).toBe(1001);
  });

  it("fails closed for expired memory cleanup even with an explicit maintenance gate", () => {
    insertExpiredMemoryItems(600);

    const summary = monitor.runAll({
      maintenanceGate: {
        requestedBy: "owner-user",
        reason: "manual maintenance window",
        approvedAt: NOW,
        approvalRef: "maintenance-ticket-001",
      },
    });
    const receipt = summary.maintenanceReceipts.find((item) => item.name === "expired_memory_items");

    expect(summary.maintenanceRecommendations.find((item) => item.name === "expired_memory_items")).toBeUndefined();
    expect(receipt).toMatchObject({
      receiptId: `system-health-maintenance:expired_memory_items:${NOW}`,
      name: "expired_memory_items",
      status: "failed",
      detail:
        "Maintenance failed: TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED: expired memory_items maintenance is disabled in the TypeScript runtime; use the Rust memory owner/migration path instead.",
      runAt: NOW,
      requestedBy: "owner-user",
      reason: "manual maintenance window",
      approvedAt: NOW,
      approvalRef: "maintenance-ticket-001",
      rollbackClass: "non_reversible_local",
      nonReversibleReason: "Expired memory item deletion removes local rows and cannot be reconstructed by Friday.",
      evidence: { beforeValue: 600, unit: "items" },
    });
    expect(countExpiredMemoryItems()).toBe(600);
  });

  it("does not run cleanup with an incomplete maintenance gate", () => {
    insertExpiredMemoryItems(600);

    const summary = monitor.runAll({
      maintenanceGate: { requestedBy: "owner-user", reason: "", approvedAt: NOW },
    });

    expect(summary.maintenanceReceipts).toHaveLength(0);
    expect(summary.maintenanceRecommendations.find((item) => item.name === "expired_memory_items")).toBeDefined();
    expect(countExpiredMemoryItems()).toBe(600);
  });

  it("does not recommend maintenance when checks are healthy", () => {
    const summary = monitor.runAll();
    // All checks should be healthy on a fresh test DB
    for (const check of summary.checks) {
      if (check.name !== "stale_realtime_checkpoints" && check.name !== "expired_memory_items") {
        expect(check.healthy).toBe(true);
      }
    }
    expect(summary.maintenanceRecommendations).toHaveLength(0);
    expect(summary.maintenanceReceipts).toHaveLength(0);
  });
});
