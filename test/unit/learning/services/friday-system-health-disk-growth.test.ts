import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

/**
 * RETENTION-R3b — report-only `disk_growth` health check.
 *
 * A sibling of `realtime_events_growth`: it feeds the pure disk-growth warning
 * evaluator (total DB bytes + free-space fraction) and surfaces ONLY via the
 * monitor's run summary → transition-only warning logs. It has NO `maintenance`
 * block, imports/uses no deletion path, and fails closed to `unknown` (never
 * "ok") on any probe/read failure.
 */
describe("friday-system-health-monitor — disk_growth (report-only; zero deletion; fail-closed)", () => {
  const dbs: FridaySqliteLayer[] = [];
  const GB = 1_000_000_000;
  const NOW = "2026-07-15T12:00:00.000Z";

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function makeDb(): FridaySqliteLayer {
    const db = createTestDb();
    dbs.push(db);
    return db;
  }

  function insertRealtimeEvents(db: FridaySqliteLayer, count: number, payload: string): void {
    db.withWriteTransaction((writerDb) => {
      const stmt = writerDb.prepare(
        `INSERT INTO realtime_events
           (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, 'stream-1', ?, 'projection.update', ?, ?, NULL, NULL, ?)`,
      );
      for (let i = 0; i < count; i++) stmt.run(`evt-${i}`, i, payload, NOW, NOW);
    });
  }

  function snapshotRows(db: FridaySqliteLayer): { count: number; ids: string[]; digest: string } {
    const rows = db.withReadConnection((r) =>
      r.prepare("SELECT rowid AS rid, event_id, payload_json FROM realtime_events ORDER BY rowid").all(),
    ) as Array<{ rid: number; event_id: string; payload_json: string }>;
    return {
      count: rows.length,
      ids: rows.map((row) => row.event_id),
      digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }

  function makeBrokenReadDb(real: FridaySqliteLayer): FridaySqliteLayer {
    const failRead = (): never => {
      throw new Error("injected read failure: disk_growth db query connection is broken");
    };
    return {
      ...real,
      reads: { ...real.reads, withReadConnection: failRead },
      withReadConnection: failRead,
    } as FridaySqliteLayer;
  }

  it("computes a real disk_growth detail (report-only) from a seeded DB + healthy probe → ok", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 20, JSON.stringify({ data: "x".repeat(40) }));

    const monitor = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 500 * GB, totalBytes: 1000 * GB }),
    });
    const summary = monitor.runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth");
    expect(disk).toBeDefined();
    const detail = disk!.detail as { status: string; totalDbBytes: number | null; freeFraction: number | null; estimatedBytes: number | null };
    expect(detail.status).toBe("ok");
    expect(typeof detail.totalDbBytes).toBe("number");
    expect(detail.freeFraction).toBeCloseTo(0.5, 5);
    expect(typeof detail.estimatedBytes).toBe("number");
    expect(disk!.healthy).toBe(true);
  });

  it("DEFAULT SILENT: a small seeded DB + healthy free → disk_growth.status === 'ok'", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 3, JSON.stringify({ data: "y" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 800 * GB, totalBytes: 1000 * GB }),
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    expect((disk.detail as { status: string }).status).toBe("ok");
  });

  it("FAIL-CLOSED + ZERO DELETION: a broken DB read → unknown/failClosed and every row byte-identical", () => {
    const realDb = makeDb();
    insertRealtimeEvents(realDb, 12, JSON.stringify({ data: "b".repeat(8) }));
    const before = snapshotRows(realDb);
    expect(before.count).toBe(12);

    const brokenReadDb = makeBrokenReadDb(realDb);
    const summary = createFridaySystemHealthMonitor({
      db: brokenReadDb,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 500 * GB, totalBytes: 1000 * GB }),
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as { status: string; failClosed?: boolean };
    expect(detail.status).toBe("unknown");
    expect(detail.status).not.toBe("ok");
    expect(detail.failClosed).toBe(true);

    // The read failed — the data did not. Every row is byte-identical.
    const after = snapshotRows(realDb);
    expect(after.count).toBe(before.count);
    expect(after.ids).toEqual(before.ids);
    expect(after.digest).toBe(before.digest);
  });

  it("FAIL-CLOSED: an unresolved (throwing) probe → unknown, never ok", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => {
        throw new Error("statfs unsupported on this platform");
      },
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as { status: string; failClosed?: boolean };
    expect(detail.status).toBe("unknown");
    expect(detail.failClosed).toBe(true);
  });

  it("NO MAINTENANCE: even a critical disk_growth emits NO maintenance recommendation or receipt", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    // Critically low free fraction (1%) → disk_growth critical (unhealthy). If the
    // check wrongly carried a maintenance block, an unhealthy result would emit a
    // recommendation (no gate) or a receipt (with a gate). It must emit NEITHER.
    const criticalDeps = {
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 10 * GB, totalBytes: 1000 * GB }),
    };
    const noGate = createFridaySystemHealthMonitor(criticalDeps).runAll();
    const disk = noGate.checks.find((c) => c.name === "disk_growth")!;
    expect((disk.detail as { status: string }).status).toBe("critical");
    expect(disk.healthy).toBe(false);
    expect(noGate.maintenanceRecommendations.some((r) => r.name === "disk_growth")).toBe(false);

    const withGate = createFridaySystemHealthMonitor(criticalDeps).runAll({
      maintenanceGate: {
        requestedBy: "operator",
        reason: "test",
        approvedAt: NOW,
      },
    });
    expect(withGate.maintenanceReceipts.some((r) => r.name === "disk_growth")).toBe(false);
  });
});
