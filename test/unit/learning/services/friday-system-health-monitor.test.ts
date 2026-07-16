import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridaySystemHealthMonitor,
  classifyRealtimeEventsGrowth,
  createFridayHealthLogDeduper,
  healthCheckStatusLabel,
  REALTIME_EVENTS_GROWTH_THRESHOLDS,
  REALTIME_EVENTS_SAMPLE_SIZE,
  REALTIME_EVENTS_ROWCOUNT_PROXY_SQL,
  REALTIME_EVENTS_SAMPLE_BYTES_SQL,
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
      // RETENTION-R3b: inject a healthy free-space probe AND a KNOWN measured
      // no-growth rate (0 B/day) so the report-only `disk_growth` check resolves to
      // `ok` on this fresh test DB. Without a probe — OR with a healthy probe but an
      // UNKNOWN/null growth rate — the check correctly fails closed to `unknown`
      // (never assumes healthy free space); those fail-closed paths are covered in
      // friday-system-health-disk-growth.test.ts.
      probeDiskSpace: () => ({ freeBytes: 500_000_000_000, totalBytes: 1_000_000_000_000 }),
      probeGrowthRateBytesPerDay: () => 0,
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

  function insertRealtimeEvents(count: number, payload: string): void {
    db.withWriteTransaction((writerDb) => {
      const stmt = writerDb.prepare(
        `INSERT INTO realtime_events
           (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, 'stream-1', ?, 'projection.update', ?, ?, NULL, NULL, ?)`,
      );
      for (let i = 0; i < count; i++) {
        stmt.run(`evt-${i}`, i, payload, PAST_DATE, PAST_DATE);
      }
    });
  }

  function countRealtimeEvents(): number {
    const row = db.withReadConnection((readerDb) =>
      readerDb.prepare("SELECT COUNT(*) AS cnt FROM realtime_events").get(),
    ) as { cnt: number };
    return row.cnt;
  }

  function explainPlan(sql: string): string {
    const rows = db.withReadConnection((readerDb) =>
      readerDb.prepare("EXPLAIN QUERY PLAN " + sql).all(),
    ) as Array<{ detail: string }>;
    return rows.map((r) => r.detail).join(" | ");
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

  // ─── realtime_events growth observability (report-only; bounded; DATA-RETENTION-001) ───

  it("reports realtime_events row count and byte estimate (report-only, no deletion)", () => {
    const N = 25;
    const payload = JSON.stringify({ kind: "projection.update", data: "x".repeat(64) });
    insertRealtimeEvents(N, payload);

    const summary = monitor.runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth");

    expect(growth).toBeDefined();
    expect(growth!.unit).toBe("bytes");
    expect(growth!.healthy).toBe(true); // tiny rows → below thresholds → healthy
    expect(growth!.detail).toBeDefined();
    expect(growth!.detail!.status).toBe("healthy");
    expect(growth!.detail!.rowCount).toBe(N); // MAX(rowid) == N under append-only
    expect(growth!.detail!.estimatedBytes).toBeGreaterThan(0);
    expect(growth!.detail!.sampleSize).toBe(N);
    expect(growth!.value).toBe(growth!.detail!.estimatedBytes); // db_size style
    expect(growth!.detail!.reclaim_status).toBe("deferred_to_rust_epoch_resync");
    // Report-only: no maintenance recommendation/receipt, and nothing deleted.
    expect(summary.maintenanceRecommendations.find((r) => r.name === "realtime_events_growth")).toBeUndefined();
    expect(summary.maintenanceReceipts).toHaveLength(0);
    expect(countRealtimeEvents()).toBe(N);
  });

  it("reports the ACTUAL sampled row count after rowid gaps from deletion (not min(LIMIT, MAX(rowid)))", () => {
    // Append 1200 rows (rowids 1..1200), then delete all but the newest 10. The
    // survivors are 10, but MAX(rowid) stays 1200 (rowid gaps never reused). The
    // public sampleSize MUST report the real sampled COUNT(*) = 10, NOT
    // min(REALTIME_EVENTS_SAMPLE_SIZE, MAX(rowid)) = 1000 (the misleading proxy).
    insertRealtimeEvents(1200, JSON.stringify({ data: "x".repeat(16) }));
    db.withWriteTransaction((writerDb) => {
      writerDb.prepare("DELETE FROM realtime_events WHERE rowid <= 1190").run();
    });
    const survivors = countRealtimeEvents();
    const maxRowid = (
      db.withReadConnection((r) => r.prepare("SELECT MAX(rowid) AS m FROM realtime_events").get()) as { m: number }
    ).m;
    expect(survivors).toBe(10);
    expect(maxRowid).toBe(1200);
    expect(Math.min(REALTIME_EVENTS_SAMPLE_SIZE, maxRowid)).toBe(1000); // the OLD (wrong) value

    const summary = monitor.runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;

    // FIX: sampleSize is the ACTUAL sampled COUNT(*), not the rowid-derived proxy.
    expect(growth.detail!.sampleSize).toBe(survivors); // 10
    expect(growth.detail!.sampleSize).not.toBe(Math.min(REALTIME_EVENTS_SAMPLE_SIZE, maxRowid)); // not 1000
    expect(growth.detail!.sampleSize).toBeLessThanOrEqual(REALTIME_EVENTS_SAMPLE_SIZE);
    // The byte estimate stays honestly LABELLED as a bounded-sample extrapolation.
    expect(growth.detail!.estimateBasis).toMatch(/bounded-sample estimate/);
    expect(growth.detail!.estimatedBytes).toBeGreaterThan(0);
  });

  it("classifies growth by heuristic thresholds (below → healthy, above → warn/critical)", () => {
    const t = REALTIME_EVENTS_GROWTH_THRESHOLDS;
    expect(classifyRealtimeEventsGrowth(0, 0).status).toBe("healthy");
    expect(classifyRealtimeEventsGrowth(t.warnRows - 1, t.warnBytes - 1).status).toBe("healthy");
    expect(classifyRealtimeEventsGrowth(0, t.warnBytes).status).toBe("warn");
    expect(classifyRealtimeEventsGrowth(t.warnRows, 0).status).toBe("warn");
    expect(classifyRealtimeEventsGrowth(0, t.criticalBytes).status).toBe("critical");
    expect(classifyRealtimeEventsGrowth(t.criticalRows, 0).status).toBe("critical");
    for (const detail of [
      classifyRealtimeEventsGrowth(0, 0),
      classifyRealtimeEventsGrowth(0, t.warnBytes),
      classifyRealtimeEventsGrowth(0, t.criticalBytes),
    ]) {
      expect(detail.reclaim_status).toBe("deferred_to_rust_epoch_resync");
      expect(detail.thresholds.heuristic).toBe(true);
    }
  });

  it("estimates TRUE UTF-8 BYTES for CJK + emoji payloads (not character count)", () => {
    // Uniform multibyte payload: sample avg == exact per-row byte length, so the
    // whole-table estimate is exact and provably byte-accurate.
    const payload = JSON.stringify({ msg: "你好世界🌍こんにちは" });
    const trueBytesPerRow = Buffer.byteLength(payload, "utf8");
    const charsPerRow = payload.length; // UTF-16 units < UTF-8 bytes for this string
    expect(trueBytesPerRow).toBeGreaterThan(charsPerRow); // multibyte, so bytes > chars
    const N = 30;
    insertRealtimeEvents(N, payload);

    const summary = monitor.runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;

    expect(growth.detail!.rowCount).toBe(N);
    // Reported bytes == true UTF-8 byte length × rows (NOT the char-count product).
    expect(growth.detail!.estimatedBytes).toBe(trueBytesPerRow * N);
    expect(growth.detail!.estimatedBytes).not.toBe(charsPerRow * N);
  });

  it("uses only BOUNDED / index-backed queries (EXPLAIN QUERY PLAN proof)", () => {
    insertRealtimeEvents(500, JSON.stringify({ data: "y".repeat(32) }));

    // Row count proxy is O(1): MAX(rowid) → a b-tree SEARCH, never a SCAN.
    const countPlan = explainPlan(REALTIME_EVENTS_ROWCOUNT_PROXY_SQL);
    expect(countPlan).toMatch(/SEARCH/);
    expect(countPlan).not.toMatch(/SCAN/);

    // Byte sample is bounded: the SQL carries a LIMIT and the plan does NOT sort
    // the whole table (no TEMP B-TREE) — it walks the rowid index and stops.
    expect(REALTIME_EVENTS_SAMPLE_BYTES_SQL).toMatch(new RegExp(`LIMIT ${REALTIME_EVENTS_SAMPLE_SIZE}\\b`));
    const samplePlan = explainPlan(REALTIME_EVENTS_SAMPLE_BYTES_SQL);
    expect(samplePlan).not.toMatch(/USE TEMP B-TREE/);

    // Red-first contrast: the rejected naive approach IS an unbounded full payload
    // scan (SCAN over the table, no LIMIT) — this is exactly what we avoid.
    const naivePlan = explainPlan("SELECT SUM(LENGTH(payload_json)) FROM realtime_events");
    expect(naivePlan).toMatch(/SCAN realtime_events/);
    expect(REALTIME_EVENTS_SAMPLE_BYTES_SQL).not.toMatch(/SUM\(LENGTH\(payload_json\)\)\s+FROM realtime_events/i);
  });

  it("stays within a bounded budget on a large table (50k+ rows)", () => {
    // Seed well beyond the sample size; the check must NOT scale with table size.
    insertRealtimeEvents(60_000, JSON.stringify({ data: "z".repeat(48) }));

    const start = Date.now();
    const summary = monitor.runAll();
    const elapsed = Date.now() - start;

    const growth = summary.checks.find((c) => c.name === "realtime_events_growth")!;
    expect(growth.detail!.rowCount).toBe(60_000);
    expect(growth.detail!.estimatedBytes).toBeGreaterThan(0);
    expect(growth.detail!.sampleSize).toBe(REALTIME_EVENTS_SAMPLE_SIZE); // capped, not 60k
    // Bounded: the O(1) proxy + LIMIT sample finish fast regardless of the 60k rows.
    // Generous ceiling (all checks incl. db_size/heap) to stay non-flaky in CI.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("fails closed (degraded, no deletion) when the realtime_events query throws", () => {
    db.withWriteTransaction((writerDb) => {
      writerDb.exec("DROP TABLE realtime_events");
    });

    const summary = monitor.runAll();
    const growth = summary.checks.find((c) => c.name === "realtime_events_growth");

    expect(growth).toBeDefined();
    expect(growth!.healthy).toBe(false);
    expect(growth!.detail!.status).toBe("degraded");
    expect(growth!.detail!.failClosed).toBe(true);
    expect(growth!.detail!.reclaim_status).toBe("deferred_to_rust_epoch_resync");
    expect(summary.maintenanceReceipts).toHaveLength(0);
    expect(summary.maintenanceRecommendations.find((r) => r.name === "realtime_events_growth")).toBeUndefined();
  });

  it("rate-limits repeated warnings: logs only on a status transition", () => {
    const dedup = createFridayHealthLogDeduper();
    // First warn logs; repeats are suppressed until the status changes.
    expect(dedup.shouldLog("realtime_events_growth", "warn")).toBe(true);
    expect(dedup.shouldLog("realtime_events_growth", "warn")).toBe(false);
    expect(dedup.shouldLog("realtime_events_growth", "warn")).toBe(false);
    // Escalation is a transition → logs again.
    expect(dedup.shouldLog("realtime_events_growth", "critical")).toBe(true);
    expect(dedup.shouldLog("realtime_events_growth", "critical")).toBe(false);
    // Recovery resets, so a later regression re-alerts.
    expect(dedup.shouldLog("realtime_events_growth", "healthy")).toBe(true);
    expect(dedup.shouldLog("realtime_events_growth", "warn")).toBe(true);
    // Independent per check name.
    expect(dedup.shouldLog("db_size", "unhealthy")).toBe(true);
  });

  it("healthCheckStatusLabel derives status from growth detail or healthy flag", () => {
    expect(healthCheckStatusLabel({ name: "x", healthy: true, value: 1, unit: "b" })).toBe("healthy");
    expect(healthCheckStatusLabel({ name: "x", healthy: false, value: 1, unit: "b" })).toBe("unhealthy");
    expect(
      healthCheckStatusLabel({
        name: "realtime_events_growth",
        healthy: false,
        value: 1,
        unit: "bytes",
        detail: classifyRealtimeEventsGrowth(0, REALTIME_EVENTS_GROWTH_THRESHOLDS.criticalBytes),
      }),
    ).toBe("critical");
  });
});
