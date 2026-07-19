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

  // ── Advisor round-2: a fixed 6h "recent" LSQ is still diluted by preceding flat
  //    history during a genuine SUSTAINED depletion → false ok for several intervals.
  const STEP = 5 * 60 * 1000; // production cadence

  it("EXACT PROBE: 6h flat 500 GiB then −10 GiB/5min → 1st decrease UNKNOWN, then WARN — NEVER ok×5", () => {
    const { warm, tick } = makeRig(makeDb());
    let mono = 0;
    for (; mono <= 6 * 60 * 60 * 1000; mono += STEP) warm(mono, 500 * GiB); // 6h flat
    const statuses: string[] = [];
    const withinFlags: Array<boolean | null> = [];
    let free = 500 * GiB;
    for (let i = 1; i <= 5; i++) {
      mono += STEP;
      free -= 10 * GiB; // sustained, continuing depletion (well above the 100 GiB floor on 1 TB)
      const d = tick(mono, free, 1000 * GiB);
      statuses.push(d.status);
      withinFlags.push(d.withinExhaustionWindow);
    }
    expect(statuses).not.toContain("ok"); // a dangerous observed trend must never read healthy
    expect(statuses[0]).toBe("unknown"); // 1 unconfirmed fast decrease → unknown (not a diluted ok, not cry-wolf)
    expect(statuses.slice(1)).toEqual(["warn", "warn", "warn", "warn"]); // ≥2 corroborating → warn
    expect(withinFlags.slice(1)).toEqual([true, true, true, true]);
  });

  it("TRANSIENT dip → UNKNOWN for one tick, then RECOVERY → back to ok (never stuck warned)", () => {
    const { warm, tick } = makeRig(makeDb());
    let mono = 0;
    for (; mono <= 6 * 60 * 60 * 1000; mono += STEP) warm(mono, 500 * GiB);
    mono += STEP;
    expect(tick(mono, 460 * GiB, 1000 * GiB).status).toBe("unknown"); // single 40 GiB dip → unknown
    mono += STEP;
    expect(tick(mono, 500 * GiB, 1000 * GiB).status).toBe("ok"); // recovered → ok, not stuck
  });

  it("NOISY stable (small ± fluctuations) → stays ok, no false warn/unknown", () => {
    const { warm, tick } = makeRig(makeDb());
    let seed = 4242 >>> 0;
    const rnd = (): number => ((seed = (1_664_525 * seed + 1_013_904_223) >>> 0), seed / 0xffff_ffff);
    let mono = 0;
    for (let i = 0; i < 250; i++, mono += STEP) warm(mono, 500 * GiB + Math.round((rnd() - 0.5) * 2 * 1024 * 1024)); // ±1 MiB, INTEGER
    const d = tick(mono + STEP, 500 * GiB, 1000 * GiB);
    expect(d.status).toBe("ok");
  });

  it("GENUINE multi-day recovery (free rising for days) → ok, never warned", () => {
    const { warm, tick } = makeRig(makeDb());
    for (let t = 0; t < 3 * MS_PER_DAY; t += 60 * 60 * 1000) warm(t, 300 * GiB + Math.round((5 * GiB * t) / MS_PER_DAY)); // rising
    const d = tick(3 * MS_PER_DAY, 315 * GiB, 1000 * GiB);
    expect(d.status).toBe("ok");
    expect(d.withinExhaustionWindow).toBe(false);
  });

  // ── Reviewer round-3 P0: a STRICT consecutive-decrease run is silenced by a single
  //    TIE (an exact-repeat statfs read) or sub-tolerance uptick → dilution → false ok.
  //    Noise-tolerant net-trend corroboration must absorb interior ties/upticks. All
  //    free values are INTEGER byte counts (classifyDiskGrowth validates integers).

  it("(a) EXACT-REPEAT TIE mid-decline: 6h flat 500 GiB then −10/tick with tick2 a repeat → NEVER ok; corroborated → warn", () => {
    const { warm, tick } = makeRig(makeDb());
    let mono = 0;
    for (; mono <= 6 * 60 * 60 * 1000; mono += STEP) warm(mono, 500 * GiB); // 6h flat
    const freeSeq = [490, 490, 480, 470, 460].map((g) => g * GiB); // tick2 is an EXACT REPEAT of tick1
    const statuses = freeSeq.map((free) => {
      mono += STEP;
      return tick(mono, free, 1000 * GiB).status;
    });
    expect(statuses).not.toContain("ok"); // the tie must NOT dilute back to a false ok
    expect(statuses.slice(2)).toEqual(["warn", "warn", "warn"]); // ≥2 real decreases → warn
  });

  it("(b) ALTERNATING decrease/flat (−15 every other tick, sustained) → warn once corroborated, never ok mid-depletion", () => {
    const { warm, tick } = makeRig(makeDb());
    let mono = 0;
    for (; mono <= 6 * 60 * 60 * 1000; mono += STEP) warm(mono, 500 * GiB);
    const freeSeq = [485, 485, 470, 470, 455, 455, 440].map((g) => g * GiB); // decrease, tie, decrease, tie, ...
    const statuses = freeSeq.map((free) => {
      mono += STEP;
      return tick(mono, free, 1000 * GiB).status;
    });
    expect(statuses).not.toContain("ok"); // ties never re-open a false ok
    expect(statuses.slice(2)).toEqual(["warn", "warn", "warn", "warn", "warn"]); // corroborated → sustained warn
  });

  it("(c) REALISTIC 1-in-4 exact-repeat noise (3 decreases + 1 tie) → sustained warn, NO flip-flop, NEVER ok", () => {
    const { warm, tick } = makeRig(makeDb());
    let mono = 0;
    for (; mono <= 6 * 60 * 60 * 1000; mono += STEP) warm(mono, 500 * GiB);
    // ~2-day-exhaustion continuous depletion with a 1-in-4 exact-repeat tie pattern.
    const gib: number[] = [];
    let free = 500;
    for (let i = 0; i < 16; i++) {
      if (i % 4 === 3) gib.push(free); // exact-repeat tie every 4th tick
      else gib.push((free -= 10)); // real decrease
    }
    const statuses = gib.map((g) => {
      mono += STEP;
      return tick(mono, g * GiB, 1000 * GiB).status;
    });
    expect(statuses).not.toContain("ok"); // never a false ok mid-depletion
    expect(statuses.slice(1).every((s) => s === "warn")).toBe(true); // corroborated by tick2 → NO flip-flop, sustained warn
  });
});
