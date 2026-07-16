import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

/**
 * RETENTION-R3b — report-only `disk_growth` health check (U13-STORAGE-PRESSURE).
 *
 * It feeds the pure U13 warning evaluator with AUTHORITATIVE free + capacity (from
 * the injected statfs probe) and surfaces ONLY via the monitor's run summary →
 * transition-only warning logs. It has NO `maintenance` block, imports/uses no
 * deletion path, and fails closed to `unknown` (never "ok") on any probe/read
 * failure.
 */
describe("friday-system-health-monitor — disk_growth (report-only; zero deletion; fail-closed)", () => {
  const dbs: FridaySqliteLayer[] = [];
  const GiB = 1024 ** 3;
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

  it("computes a real disk_growth detail (report-only) from a seeded DB + healthy probe + known no-growth → ok", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 20, JSON.stringify({ data: "x".repeat(40) }));

    const monitor = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 500 * GiB, totalBytes: 1000 * GiB }),
      // KNOWN measured no-growth → the projected-exhaustion branch is observable
      // and never exhausts → ok (above the floor). A null/omitted growth probe
      // would correctly fail closed to `unknown` — see the advisor-CE test below.
      probeGrowthRateBytesPerDay: () => 0,
    });
    const summary = monitor.runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth");
    expect(disk).toBeDefined();
    const detail = disk!.detail as {
      status: string;
      freeBytes: number | null;
      totalCapacityBytes: number | null;
      diagnostics?: { totalDbBytes?: number };
    };
    expect(detail.status).toBe("ok");
    expect(detail.freeBytes).toBe(500 * GiB);
    expect(detail.totalCapacityBytes).toBe(1000 * GiB);
    // Report-only diagnostics are carried but never authoritative.
    expect(typeof detail.diagnostics?.totalDbBytes).toBe("number");
    expect(disk!.healthy).toBe(true);
  });

  it("DEFAULT SILENT: a small seeded DB + healthy free + known no-growth → disk_growth.status === 'ok'", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 3, JSON.stringify({ data: "y" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 800 * GiB, totalBytes: 1000 * GiB }),
      probeGrowthRateBytesPerDay: () => 0,
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    expect((disk.detail as { status: string }).status).toBe("ok");
    expect(disk.healthy).toBe(true);
  });

  it("FAIL-CLOSED (advisor P1): healthy free ABOVE the floor but UNKNOWN growth → 'unknown', NOT healthy", () => {
    // The exact advisor counterexample at the PRODUCTION seam: 50 GiB free on a
    // 100 GiB volume (above the floor = max(10 GiB, 10 GiB) = 10 GiB) with NO
    // growth-rate probe (production wires it to null). The 7-day projected-
    // exhaustion branch is UNOBSERVABLE, so the monitor must publish healthy=false
    // (status 'unknown') — it must NEVER publish a false healthy 'ok'.
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 50 * GiB, totalBytes: 100 * GiB }),
      // No probeGrowthRateBytesPerDay → growth is UNKNOWN (matches production null).
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as { status: string; belowFloor: boolean | null; failClosed?: boolean };
    expect(detail.status).toBe("unknown");
    expect(detail.status).not.toBe("ok");
    expect(detail.belowFloor).toBe(false); // above the floor — the floor branch alone would be ok
    expect(detail.failClosed).toBe(true);
    expect(disk.healthy).toBe(false); // the monitor must NOT publish healthy=true
  });

  it("BELOW-FLOOR still warns even when growth is UNKNOWN (floor governs regardless)", () => {
    // 9 GiB free on a 100 GiB volume is below the 10 GiB floor. With NO growth
    // probe (unknown growth) the reading must be 'warn' (not 'unknown') — the
    // absolute floor governs the warn regardless of the growth branch.
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 9 * GiB, totalBytes: 100 * GiB }),
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as { status: string; belowFloor: boolean | null };
    expect(detail.status).toBe("warn");
    expect(detail.belowFloor).toBe(true);
    expect(disk.healthy).toBe(false);
  });

  it("KNOWN growth 7-day projected-exhaustion boundary: == 7d → warn; just past 7d → ok", () => {
    // 5 TiB capacity → floor = max(10 GiB, 512 GiB) = 512 GiB. free 700 GiB is above
    // the floor, so ONLY the exhaustion branch can warn. free/7 B/day → exactly 7d.
    const capacity = 5 * 1024 * GiB;
    const free = 700 * GiB;
    const db = makeDb();
    insertRealtimeEvents(db, 3, JSON.stringify({ data: "y" }));
    const atBoundary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: free, totalBytes: capacity }),
      probeGrowthRateBytesPerDay: () => free / 7,
    }).runAll();
    const atDisk = atBoundary.checks.find((c) => c.name === "disk_growth")!;
    expect((atDisk.detail as { status: string; withinExhaustionWindow: boolean }).status).toBe("warn");
    expect((atDisk.detail as { withinExhaustionWindow: boolean }).withinExhaustionWindow).toBe(true);
    expect(atDisk.healthy).toBe(false);

    const past = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: free, totalBytes: capacity }),
      probeGrowthRateBytesPerDay: () => free / 7.001,
    }).runAll();
    const pastDisk = past.checks.find((c) => c.name === "disk_growth")!;
    expect((pastDisk.detail as { status: string }).status).toBe("ok");
    expect(pastDisk.healthy).toBe(true);
  });

  it("COMBINED SIGNAL (advisor P1): below-floor AND within-7d exposes BOTH truthfully at the monitor seam", () => {
    // 5 GiB free on a 100 GiB volume (below the 10 GiB floor) growing 1 GiB/day →
    // exhausts in 5 days. The readback detail must surface status=warn, belowFloor=true,
    // AND the simultaneously-active exhaustion signal (projectedExhaustionDays=5,
    // withinExhaustionWindow=true) — not hide it behind the floor warning.
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 5 * GiB, totalBytes: 100 * GiB }),
      probeGrowthRateBytesPerDay: () => 1 * GiB,
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as {
      status: string;
      belowFloor: boolean | null;
      projectedExhaustionDays: number | null;
      withinExhaustionWindow: boolean | null;
      reasons: string[];
    };
    expect(detail.status).toBe("warn");
    expect(detail.belowFloor).toBe(true);
    expect(detail.projectedExhaustionDays).toBe(5); // NOT null
    expect(detail.withinExhaustionWindow).toBe(true); // NOT false
    expect([...detail.reasons].sort()).toEqual(["below_floor", "within_7d_exhaustion"]);
    expect(disk.healthy).toBe(false);
  });

  it("WARN below the U13 floor: free 5 GiB on a 1000 GiB volume → disk_growth warn (below max(10GiB,10%))", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 3, JSON.stringify({ data: "y" }));
    const summary = createFridaySystemHealthMonitor({
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 5 * GiB, totalBytes: 1000 * GiB }),
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    expect((disk.detail as { status: string; belowFloor: boolean }).status).toBe("warn");
    expect(disk.healthy).toBe(false);
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
      probeDiskSpace: () => ({ freeBytes: 500 * GiB, totalBytes: 1000 * GiB }),
    }).runAll();
    const disk = summary.checks.find((c) => c.name === "disk_growth")!;
    const detail = disk.detail as { status: string; failClosed?: boolean };
    expect(detail.status).toBe("unknown");
    expect(detail.status).not.toBe("ok");
    expect(detail.failClosed).toBe(true);

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

  it("NO MAINTENANCE: even a warn disk_growth emits NO maintenance recommendation or receipt", () => {
    const db = makeDb();
    insertRealtimeEvents(db, 5, JSON.stringify({ data: "z" }));
    // Below the U13 floor → warn (unhealthy). If the check wrongly carried a
    // maintenance block, an unhealthy result would emit a recommendation (no gate)
    // or a receipt (with a gate). It must emit NEITHER.
    const warnDeps = {
      db,
      nowIso: () => NOW,
      probeDiskSpace: () => ({ freeBytes: 5 * GiB, totalBytes: 1000 * GiB }),
    };
    const noGate = createFridaySystemHealthMonitor(warnDeps).runAll();
    const disk = noGate.checks.find((c) => c.name === "disk_growth")!;
    expect((disk.detail as { status: string }).status).toBe("warn");
    expect(disk.healthy).toBe(false);
    expect(noGate.maintenanceRecommendations.some((r) => r.name === "disk_growth")).toBe(false);

    const withGate = createFridaySystemHealthMonitor(warnDeps).runAll({
      maintenanceGate: { requestedBy: "operator", reason: "test", approvedAt: NOW },
    });
    expect(withGate.maintenanceReceipts.some((r) => r.name === "disk_growth")).toBe(false);
  });
});
