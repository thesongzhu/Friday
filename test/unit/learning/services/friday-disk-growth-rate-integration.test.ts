import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createFridayDiskGrowthRateSampler } from "../../../../src/learning/services/friday-disk-growth-rate-sampler.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

/**
 * RETENTION-R3c — END-TO-END proof of the exact PRODUCTION seam: the real bounded
 * sampler wired the way bootstrap wires it (record the tick's free-space reading in
 * probeDiskSpace, which the monitor calls BEFORE probeGrowthRateBytesPerDay, then
 * serve the least-squares consumption rate), driving #1613's UNCHANGED classifier.
 *
 * Proves the observable transition the R3c goal is about: across ticks the disk_growth
 * reading moves null→0→positive, i.e. `unknown` (startup, insufficient samples) →
 * `ok` (measured no-growth or ample runway) → `warn` (genuine sustained decrease
 * projecting exhaustion within 7 days) — all ABOVE the absolute free-space floor, so
 * it is the GROWTH branch (not the floor branch) being exercised.
 */
describe("RETENTION-R3c integration — real sampler → #1613 classifier via the monitor", () => {
  const dbs: FridaySqliteLayer[] = [];
  const GiB = 1024 ** 3;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const T0 = 1_700_000_000_000;

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function makeDb(): FridaySqliteLayer {
    const db = createTestDb();
    dbs.push(db);
    return db;
  }

  interface DiskDetail {
    status: string;
    belowFloor: boolean | null;
    withinExhaustionWindow: boolean | null;
    projectedExhaustionDays: number | null;
    failClosed?: boolean;
    freeBytes: number | null;
    totalCapacityBytes: number | null;
  }

  /**
   * Wire the monitor to a shared sampler + shared "current tick" state EXACTLY like
   * bootstrap: probeDiskSpace records (clock, free) then returns {free, cap};
   * probeGrowthRateBytesPerDay reads the sampler at the same clock.
   */
  function makeRig(db: FridaySqliteLayer) {
    const sampler = createFridayDiskGrowthRateSampler();
    const cur = { clock: T0, free: 0, cap: 0 };
    function tick(clock: number, free: number, cap: number): DiskDetail {
      cur.clock = clock;
      cur.free = free;
      cur.cap = cap;
      const summary = createFridaySystemHealthMonitor({
        db,
        nowIso: () => new Date(clock).toISOString(),
        probeDiskSpace: () => {
          sampler.record(cur.clock, cur.free); // production records the valid reading here
          return { freeBytes: cur.free, totalBytes: cur.cap };
        },
        probeGrowthRateBytesPerDay: () => sampler.getGrowthRateBytesPerDay(cur.clock),
      }).runAll();
      const disk = summary.checks.find((c) => c.name === "disk_growth")!;
      expect(disk).toBeDefined();
      return disk.detail as DiskDetail;
    }
    return { sampler, tick };
  }

  it("startup (first tick, 1 sample) → UNKNOWN, fail-closed, above the floor", () => {
    const { tick } = makeRig(makeDb());
    // 200 GiB free on a 1000 GiB volume → floor = max(10 GiB, 100 GiB) = 100 GiB → above floor.
    const d = tick(T0, 200 * GiB, 1000 * GiB);
    expect(d.belowFloor).toBe(false); // floor branch alone would be ok
    expect(d.status).toBe("unknown"); // but growth is UNOBSERVABLE with <2 samples
    expect(d.failClosed).toBe(true);
  });

  it("transition null→0: accumulating STABLE samples flips unknown → ok (measured no-growth)", () => {
    const { tick } = makeRig(makeDb());
    const d1 = tick(T0, 200 * GiB, 1000 * GiB); // 1 sample
    expect(d1.status).toBe("unknown");
    // Second tick 2h later, same free → 2 samples spanning ≥ 1h, flat slope → rate 0.
    const d2 = tick(T0 + 2 * 60 * 60 * 1000, 200 * GiB, 1000 * GiB);
    expect(d2.status).toBe("ok");
    expect(d2.withinExhaustionWindow).toBe(false); // KNOWN no-growth, never exhausts
    expect(d2.belowFloor).toBe(false);
  });

  it("transition 0→positive with AMPLE runway → stays ok (KNOWN rate, > 7 days out)", () => {
    const { tick } = makeRig(makeDb());
    // Steady 1 GiB/day decrease, hourly ticks over 3 days, ending ~200 GiB free on 1000 GiB.
    let last: DiskDetail | undefined;
    const startFree = 203 * GiB;
    for (let t = 0; t <= 3 * MS_PER_DAY; t += 60 * 60 * 1000) {
      last = tick(T0 + t, startFree - (GiB * t) / MS_PER_DAY, 1000 * GiB);
    }
    expect(last!.status).toBe("ok"); // ~200 GiB free / 1 GiB/day = ~200 days ≫ 7
    expect(last!.withinExhaustionWindow).toBe(false);
    expect(last!.projectedExhaustionDays).not.toBeNull();
    expect(last!.projectedExhaustionDays!).toBeGreaterThan(7);
    expect(last!.belowFloor).toBe(false);
  });

  it("transition to positive with SHORT runway → WARN, driven by the growth branch ABOVE the floor", () => {
    const { tick } = makeRig(makeDb());
    // Steady 5 GiB/day decrease, hourly ticks over 3 days, ending 20 GiB free on 100 GiB
    // (floor = 10 GiB → ABOVE floor). Projected exhaustion ≈ 20/5 = 4 days ≤ 7 → warn.
    let last: DiskDetail | undefined;
    const startFree = 35 * GiB;
    for (let t = 0; t <= 3 * MS_PER_DAY; t += 60 * 60 * 1000) {
      last = tick(T0 + t, startFree - (5 * GiB * t) / MS_PER_DAY, 100 * GiB);
    }
    expect(last!.belowFloor).toBe(false); // 20 GiB > 10 GiB floor: it is NOT the floor branch
    expect(last!.withinExhaustionWindow).toBe(true); // the growth branch drives the warning
    expect(last!.status).toBe("warn");
    expect(last!.projectedExhaustionDays).not.toBeNull();
    expect(last!.projectedExhaustionDays!).toBeLessThanOrEqual(7);
  });

  it("free INCREASING (recovery) → measured-zero → ok, never a spurious warn", () => {
    const { tick } = makeRig(makeDb());
    let last: DiskDetail | undefined;
    const startFree = 150 * GiB;
    for (let t = 0; t <= 2 * MS_PER_DAY; t += 60 * 60 * 1000) {
      last = tick(T0 + t, startFree + (3 * GiB * t) / MS_PER_DAY, 1000 * GiB); // free rising
    }
    expect(last!.status).toBe("ok");
    expect(last!.withinExhaustionWindow).toBe(false); // consumption ≤ 0 → measured-zero
  });
});
