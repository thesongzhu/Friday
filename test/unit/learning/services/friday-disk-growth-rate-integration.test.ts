import { afterEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";

import { createFridaySystemHealthMonitor } from "../../../../src/learning/services/friday-system-health-monitor.js";
import { createFridayDiskGrowthRateSampler } from "../../../../src/learning/services/friday-disk-growth-rate-sampler.js";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

/**
 * RETENTION-R3c integration — the real bounded sampler wired into the REAL health
 * monitor and driving #1613's UNCHANGED classifier, the same way bootstrap wires it:
 * `probeDiskSpace` (called BEFORE `probeGrowthRateBytesPerDay`) records the tick's
 * free reading into the sampler, and `probeGrowthRateBytesPerDay` serves the
 * conservative consumption rate.
 *
 * NOTE (accurate scope, no overclaim): this exercises the sampler → real-monitor →
 * classifier seam THROUGH the sampler's production `monotonicNowMs` INJECTION POINT
 * (the exact dependency bootstrap relies on). It does NOT boot a full `createFridayHub`
 * (impractical here); the production monotonic clock adapter itself
 * (`defaultMonotonicNowMs`) is unit-tested separately in the sampler test. Long
 * histories are pre-loaded via the same sampler the monitor uses; every STATUS is read
 * through a real `monitor.runAll()` at the measurement tick.
 */
describe("RETENTION-R3c integration — real sampler (monotonic-injected) → #1613 classifier via the monitor", () => {
  const dbs: FridaySqliteLayer[] = [];
  const GiB = 1024 ** 3;
  const TiB = 1024 ** 4;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
   * A rig sharing ONE sampler wired via its production `monotonicNowMs` injection
   * point. `warm` pre-loads history into that same sampler (fast — no monitor run);
   * `tick` runs the REAL monitor at a measurement point and returns the disk_growth
   * detail. Both record through the identical sampler the monitor reads.
   */
  function makeRig(db: FridaySqliteLayer) {
    const cur = { mono: 0, free: 0, cap: 0 };
    const sampler = createFridayDiskGrowthRateSampler({ monotonicNowMs: () => cur.mono });
    function warm(monoMs: number, free: number): void {
      cur.mono = monoMs;
      sampler.record(free);
    }
    function tick(monoMs: number, free: number, cap: number): DiskDetail {
      cur.mono = monoMs;
      cur.free = free;
      cur.cap = cap;
      const summary = createFridaySystemHealthMonitor({
        db,
        nowIso: () => "2026-07-16T12:00:00.000Z",
        probeDiskSpace: () => {
          sampler.record(cur.free); // production records the valid reading here
          return { freeBytes: cur.free, totalBytes: cur.cap };
        },
        probeGrowthRateBytesPerDay: () => sampler.getGrowthRateBytesPerDay(),
      }).runAll();
      const disk = summary.checks.find((c) => c.name === "disk_growth")!;
      expect(disk).toBeDefined();
      return disk.detail as DiskDetail;
    }
    return { warm, tick };
  }

  it("startup (first tick, 1 sample) → UNKNOWN, fail-closed, above the floor", () => {
    const { tick } = makeRig(makeDb());
    const d = tick(0, 200 * GiB, 1000 * GiB); // floor = max(10, 100) = 100 GiB → above
    expect(d.belowFloor).toBe(false);
    expect(d.status).toBe("unknown");
    expect(d.failClosed).toBe(true);
  });

  it("transition null→0: accumulating STABLE samples flips unknown → ok (measured no-growth)", () => {
    const { tick } = makeRig(makeDb());
    expect(tick(0, 200 * GiB, 1000 * GiB).status).toBe("unknown"); // 1 sample
    const d2 = tick(2 * 60 * 60 * 1000, 200 * GiB, 1000 * GiB); // 2h later, flat → rate 0
    expect(d2.status).toBe("ok");
    expect(d2.withinExhaustionWindow).toBe(false);
    expect(d2.belowFloor).toBe(false);
  });

  it("steady positive rate with AMPLE runway → ok (KNOWN rate, > 7 days out)", () => {
    const { warm, tick } = makeRig(makeDb());
    const start = 203 * GiB;
    for (let t = 0; t < 3 * MS_PER_DAY; t += 60 * 60 * 1000) warm(t, start - (GiB * t) / MS_PER_DAY); // ~1 GiB/day
    const d = tick(3 * MS_PER_DAY, 200 * GiB, 1000 * GiB);
    expect(d.status).toBe("ok");
    expect(d.withinExhaustionWindow).toBe(false);
    expect(d.projectedExhaustionDays).not.toBeNull();
    expect(d.projectedExhaustionDays!).toBeGreaterThan(7);
    expect(d.belowFloor).toBe(false);
  });

  it("positive rate with SHORT runway → WARN, driven by the growth branch ABOVE the floor", () => {
    const { warm, tick } = makeRig(makeDb());
    const start = 35 * GiB; // 5 GiB/day over 3 days → ends 20 GiB on 100 GiB (floor 10 GiB)
    for (let t = 0; t < 3 * MS_PER_DAY; t += 60 * 60 * 1000) warm(t, start - (5 * GiB * t) / MS_PER_DAY);
    const d = tick(3 * MS_PER_DAY, 20 * GiB, 100 * GiB);
    expect(d.belowFloor).toBe(false); // 20 GiB > 10 GiB floor → NOT the floor branch
    expect(d.withinExhaustionWindow).toBe(true); // growth branch drives the warn
    expect(d.status).toBe("warn");
    expect(d.projectedExhaustionDays!).toBeLessThanOrEqual(7);
  });

  it("free INCREASING (recovery) → measured-zero → ok, never a spurious warn", () => {
    const { warm, tick } = makeRig(makeDb());
    const start = 150 * GiB;
    for (let t = 0; t < 2 * MS_PER_DAY; t += 60 * 60 * 1000) warm(t, start + (3 * GiB * t) / MS_PER_DAY); // rising
    const d = tick(2 * MS_PER_DAY, 156 * GiB, 1000 * GiB);
    expect(d.status).toBe("ok");
    expect(d.withinExhaustionWindow).toBe(false);
  });

  // ── Advisor Finding 2: recovery-then-rapid-depletion MUST resolve to warn ──────
  it("7 DAYS RISING then a 1h 360 GiB CLIFF → WARN (non-stationarity), NEVER ok/measured-zero", () => {
    const { warm, tick } = makeRig(makeDb());
    const riseEnd = 7 * MS_PER_DAY - 60 * 60 * 1000;
    for (let t = 0; t <= riseEnd; t += 60 * 60 * 1000) warm(t, 100 * GiB + (380 * GiB * t) / riseEnd); // 100 → 480 GiB
    for (let t = riseEnd + 5 * 60 * 1000; t <= 7 * MS_PER_DAY; t += 5 * 60 * 1000) {
      warm(t, 480 * GiB - (360 * GiB * (t - riseEnd)) / (60 * 60 * 1000)); // 480 → 120 GiB over the last hour
    }
    // 120 GiB free on a 1 TB volume → floor = max(10 GiB, ~102.4 GiB) = 102.4 GiB → ABOVE the floor.
    const d = tick(7 * MS_PER_DAY + 5 * 60 * 1000, 120 * GiB, TiB);
    expect(d.belowFloor).toBe(false); // above the floor: ONLY the 7-day growth branch could catch it
    expect(d.status).not.toBe("ok"); // the recovery-then-depletion cliff must not read healthy
    expect(d.status).toBe("warn");
    expect(d.withinExhaustionWindow).toBe(true);
  });

  // ── Advisor Finding 1: wall-clock jump is irrelevant (monotonic elapsed) ───────
  it("FORWARD wall-clock jump scenario: 50 GiB in 1h MONOTONIC → WARN (not the buggy ok)", () => {
    const { warm, tick } = makeRig(makeDb());
    // 200 → 150 GiB over ONE HOUR of monotonic elapsed on a 1 TB volume (floor ~102.4
    // GiB → 150 GiB is ABOVE the floor). A wall clock could jump +8 days across this
    // window; the sampler never reads it, so the rate reflects the true ~1h elapsed
    // (~1200 GiB/day) → exhaustion ≪ 7 days → warn. The pre-fix wall-clock code would
    // have computed ~6.25 GiB/day → ~24 days → a false ok.
    for (let m = 0; m < 60 * 60 * 1000; m += 5 * 60 * 1000) warm(m, 200 * GiB - (50 * GiB * m) / (60 * 60 * 1000));
    const d = tick(60 * 60 * 1000 + 5 * 60 * 1000, 150 * GiB, TiB);
    expect(d.belowFloor).toBe(false);
    expect(d.status).toBe("warn");
    expect(d.withinExhaustionWindow).toBe(true);
    expect(d.projectedExhaustionDays!).toBeLessThanOrEqual(7);
  });
});
