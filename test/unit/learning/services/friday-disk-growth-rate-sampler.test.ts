import { describe, expect, it } from "vitest";

import {
  createFridayDiskGrowthRateSampler,
  defaultMonotonicNowMs,
  estimateConservativeConsumptionRateBytesPerDay,
  estimateConsumptionRateBytesPerDay,
  recentDeclineSignal,
  DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG,
  type DiskUsageSample,
  type FridayDiskGrowthRateSampler,
} from "../../../../src/learning/services/friday-disk-growth-rate-sampler.js";

/**
 * RETENTION-R3c — the bounded rolling growth-rate measurement that feeds #1613's
 * (RETENTION-R3b) projected-exhaustion branch, HARDENED per the advisor NEEDS_CHANGES:
 *   (A) the PURE single-window estimator's null-vs-measured-zero-vs-positive decision
 *       points align EXACTLY with #1613's contract;
 *   (B) the PURE conservative estimator is safety-conservative under non-stationarity
 *       (a recent cliff on top of a rising trend still yields a positive rate);
 *   (C) the buffer is BOUNDED both ways (count cap + age window) and derives all
 *       elapsed-time math from an injected MONOTONIC clock — a wall-clock jump cannot
 *       distort the rate, and a non-monotonic sample is rejected.
 */

const GIB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build a linear series. `perDayConsumption` > 0 ⇒ free DECREASING by that many
 * bytes/day (net consumption); < 0 ⇒ free increasing. Monotonic timestamps from 0.
 */
function series(
  startFree: number,
  perDayConsumption: number,
  spanMs: number,
  stepMs: number,
  monoStart = 0,
): DiskUsageSample[] {
  const out: DiskUsageSample[] = [];
  for (let t = 0; t <= spanMs; t += stepMs) {
    out.push({ monotonicMs: monoStart + t, freeBytes: startFree - (perDayConsumption * t) / MS_PER_DAY });
  }
  return out;
}

/** Flat readings for `flatCount` ticks, then a sustained decline of `declinePerStep` for `declineCount` ticks. */
function flatThenDecline(opts: {
  flatFree: number;
  flatCount: number;
  stepMs: number;
  declinePerStep: number;
  declineCount: number;
}): DiskUsageSample[] {
  const out: DiskUsageSample[] = [];
  let mono = 0;
  for (let i = 0; i < opts.flatCount; i++, mono += opts.stepMs) out.push({ monotonicMs: mono, freeBytes: opts.flatFree });
  let free = opts.flatFree;
  for (let i = 0; i < opts.declineCount; i++, mono += opts.stepMs) {
    free -= opts.declinePerStep;
    out.push({ monotonicMs: mono, freeBytes: free });
  }
  return out;
}

// Deterministic LCG so "noisy" cases are reproducible (no Math.random flake).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1_664_525 * s + 1_013_904_223) >>> 0;
    return s / 0xffff_ffff;
  };
}

/** A sampler wired to a controllable monotonic clock; `recordAt` sets the clock then records. */
function makeSampler(cfg: Parameters<typeof createFridayDiskGrowthRateSampler>[0] = {}): {
  sampler: FridayDiskGrowthRateSampler;
  setMono: (m: number) => void;
  recordAt: (monoMs: number, freeBytes: number) => void;
} {
  const state = { mono: 0 };
  const sampler = createFridayDiskGrowthRateSampler({ ...cfg, monotonicNowMs: () => state.mono });
  return {
    sampler,
    setMono: (m) => {
      state.mono = m;
    },
    recordAt: (monoMs, freeBytes) => {
      state.mono = monoMs;
      sampler.record(freeBytes);
    },
  };
}

describe("estimateConsumptionRateBytesPerDay (pure single-window estimator, monotonic time)", () => {
  it("steady 1 GiB/day decrease over 7 days → ≈ 1 GiB/day consumption", () => {
    const rate = estimateConsumptionRateBytesPerDay(series(500 * GIB, GIB, 7 * MS_PER_DAY, 60 * 60 * 1000));
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1, 6);
  });

  it("free INCREASING (net consumption < 0) → measured-zero 0, NOT null", () => {
    expect(estimateConsumptionRateBytesPerDay(series(100 * GIB, -2 * GIB, 5 * MS_PER_DAY, 60 * 60 * 1000))).toBe(0);
  });

  it("free FLAT → measured-zero 0, NOT null", () => {
    const flat: DiskUsageSample[] = [];
    for (let d = 0; d < 6; d++) flat.push({ monotonicMs: d * MS_PER_DAY, freeBytes: 42 * GIB });
    expect(estimateConsumptionRateBytesPerDay(flat)).toBe(0);
  });

  it("fewer than MIN_SAMPLES → null", () => {
    expect(estimateConsumptionRateBytesPerDay([])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([{ monotonicMs: 0, freeBytes: 10 * GIB }])).toBeNull();
  });

  it("span shorter than MIN_SPAN_MS → null even with enough samples", () => {
    const s: DiskUsageSample[] = [];
    for (let i = 0; i < 10; i++) s.push({ monotonicMs: i * 3 * 60 * 1000, freeBytes: 10 * GIB - i * GIB }); // 30 min
    expect(estimateConsumptionRateBytesPerDay(s)).toBeNull();
  });

  it("any invalid sample (NaN / +Inf / negative time / negative free) → null", () => {
    const base: DiskUsageSample[] = [
      { monotonicMs: 0, freeBytes: 10 * GIB },
      { monotonicMs: 2 * MS_PER_DAY, freeBytes: 9 * GIB },
    ];
    expect(estimateConsumptionRateBytesPerDay([...base, { monotonicMs: 3 * MS_PER_DAY, freeBytes: Number.NaN }])).toBeNull();
    expect(
      estimateConsumptionRateBytesPerDay([...base, { monotonicMs: 3 * MS_PER_DAY, freeBytes: Number.POSITIVE_INFINITY }]),
    ).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { monotonicMs: -1, freeBytes: 8 * GIB }])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { monotonicMs: 3 * MS_PER_DAY, freeBytes: -1 }])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { monotonicMs: Number.NaN, freeBytes: 8 * GIB }])).toBeNull();
  });

  it("zero time-variance (all identical timestamps) → null (degenerate regression)", () => {
    expect(
      estimateConsumptionRateBytesPerDay([
        { monotonicMs: 5, freeBytes: 10 * GIB },
        { monotonicMs: 5, freeBytes: 8 * GIB },
        { monotonicMs: 5, freeBytes: 6 * GIB },
      ]),
    ).toBeNull();
  });

  it("noisy-but-trending decrease → robust estimate within tolerance", () => {
    const rnd = lcg(12345);
    const s: DiskUsageSample[] = [];
    for (let t = 0; t <= 7 * MS_PER_DAY; t += 60 * 60 * 1000) {
      const trend = 300 * GIB - (2 * GIB * t) / MS_PER_DAY;
      s.push({ monotonicMs: t, freeBytes: Math.max(0, trend + (rnd() - 0.5) * 0.5 * GIB) });
    }
    const rate = estimateConsumptionRateBytesPerDay(s);
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(2, 1);
  });
});

describe("estimateConservativeConsumptionRateBytesPerDay (non-stationarity safety)", () => {
  it("both horizons stable/increasing → measured-zero 0", () => {
    expect(estimateConservativeConsumptionRateBytesPerDay(series(200 * GIB, -1 * GIB, 3 * MS_PER_DAY, 30 * 60 * 1000))).toBe(0);
  });

  it("FULL window rising but RECENT horizon a cliff → positive (conservative max), NOT 0", () => {
    // 7 days RISING free, then a 360 GiB drop in the LAST HOUR. The full-window slope
    // still reads "increasing" (→ 0), but the recent 6h horizon captures the cliff.
    const s: DiskUsageSample[] = [];
    const riseEnd = 7 * MS_PER_DAY - 60 * 60 * 1000;
    for (let t = 0; t <= riseEnd; t += 5 * 60 * 1000) {
      s.push({ monotonicMs: t, freeBytes: 100 * GIB + (380 * GIB * t) / riseEnd }); // 100 → 480 GiB
    }
    for (let t = riseEnd + 5 * 60 * 1000; t <= 7 * MS_PER_DAY; t += 5 * 60 * 1000) {
      const into = t - riseEnd;
      s.push({ monotonicMs: t, freeBytes: 480 * GIB - (360 * GIB * into) / (60 * 60 * 1000) }); // 480 → 120 GiB
    }
    expect(estimateConsumptionRateBytesPerDay(s)).toBe(0); // full window alone hides the cliff
    const conservative = estimateConservativeConsumptionRateBytesPerDay(s);
    expect(conservative).not.toBeNull();
    expect(conservative!).toBeGreaterThan(0); // recent horizon rescues it
  });

  it("recent horizon insufficient (sparse) → falls back to the full window", () => {
    // Steady 1 GiB/day over 3 days, but only ONE sample in the last 6h → recent=null → use full.
    const s = series(200 * GIB, GIB, 3 * MS_PER_DAY - 60 * 60 * 1000, 30 * 60 * 1000);
    s.push({ monotonicMs: 3 * MS_PER_DAY, freeBytes: 200 * GIB - 3 * GIB }); // lone recent sample
    const conservative = estimateConservativeConsumptionRateBytesPerDay(s);
    expect(conservative).not.toBeNull();
    expect(conservative! / GIB).toBeCloseTo(1, 1); // full-window ~1 GiB/day
  });

  it("neither horizon observable → null", () => {
    expect(estimateConservativeConsumptionRateBytesPerDay([])).toBeNull();
    expect(estimateConservativeConsumptionRateBytesPerDay([{ monotonicMs: 0, freeBytes: 10 * GIB }])).toBeNull();
  });
});

// ── Advisor round-2: change-point / confirmed-short-horizon (a fixed "recent" LSQ is
//    still diluted by preceding flat history during a genuine SUSTAINED depletion) ──
describe("estimateConservativeConsumptionRateBytesPerDay — change-point / confirmed short-horizon", () => {
  const STEP = 5 * 60 * 1000; // production cadence
  const FLAT_6H = (6 * 60) / 5 + 1; // 6 hours of 5-min ticks

  const impliesWithin7d = (rate: number | null, latestFree: number): boolean =>
    rate !== null && rate > 0 && Number.isFinite(latestFree / rate) && latestFree / rate <= 7;

  it("EXACT PROBE: 6h flat 500 GiB then 1 UNCONFIRMED −10 GiB/5min decrease → null (UNKNOWN, never a diluted ok)", () => {
    const s = flatThenDecline({ flatFree: 500 * GIB, flatCount: FLAT_6H, stepMs: STEP, declinePerStep: 10 * GIB, declineCount: 1 });
    expect(estimateConservativeConsumptionRateBytesPerDay(s)).toBeNull();
  });

  it("EXACT PROBE: ≥2 CORROBORATING −10 GiB/5min decreases → a positive rate implying exhaustion ≤ 7 days (not diluted)", () => {
    for (const declineCount of [2, 3, 4, 5]) {
      const s = flatThenDecline({ flatFree: 500 * GIB, flatCount: FLAT_6H, stepMs: STEP, declinePerStep: 10 * GIB, declineCount });
      const rate = estimateConservativeConsumptionRateBytesPerDay(s);
      const latestFree = s.at(-1)!.freeBytes;
      expect(rate).not.toBeNull();
      expect(impliesWithin7d(rate, latestFree)).toBe(true);
    }
  });

  it("SINGLE fast dip → null; then RECOVERY → not warn-implying, never stuck (measured no-growth)", () => {
    const dip = flatThenDecline({ flatFree: 500 * GIB, flatCount: FLAT_6H, stepMs: STEP, declinePerStep: 40 * GIB, declineCount: 1 });
    expect(estimateConservativeConsumptionRateBytesPerDay(dip)).toBeNull(); // ambiguous single step → unknown
    const recovered: DiskUsageSample[] = [...dip, { monotonicMs: dip.at(-1)!.monotonicMs + STEP, freeBytes: 500 * GIB }];
    const r = estimateConservativeConsumptionRateBytesPerDay(recovered);
    expect(r).not.toBeNull();
    expect(impliesWithin7d(r, 500 * GIB)).toBe(false); // rising tail clears the alarm
  });

  it("NOISY stable (small ± fluctuations, implies ≫ 7 days) → not null and never warn-implying", () => {
    const rnd = lcg(4242);
    const s: DiskUsageSample[] = [];
    for (let i = 0; i < 300; i++) s.push({ monotonicMs: i * STEP, freeBytes: 500 * GIB + Math.round((rnd() - 0.5) * 2 * 1024 * 1024) }); // ±1 MiB, INTEGER
    const rate = estimateConservativeConsumptionRateBytesPerDay(s);
    expect(rate).not.toBeNull();
    expect(impliesWithin7d(rate, s.at(-1)!.freeBytes)).toBe(false);
  });

  it("PRESERVE: steady SLOW decline (huge free, implies ≫ 7 days) stays a positive rate, not forced to null", () => {
    const rate = estimateConservativeConsumptionRateBytesPerDay(series(5000 * GIB, GIB, 3 * MS_PER_DAY, STEP)); // ~1 GiB/day
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1, 1);
  });

  // ── Reviewer round-3 P0: interior TIES / sub-tolerance upticks must NOT silence the
  //    corroboration (a strict consecutive-decrease run does — this is the false-ok). ──
  it("TIE mid-decline: 6h flat then [−10, TIE, −10, −10] still corroborates (≥2 confirming) → warn-implying, NOT diluted to ok", () => {
    const s: DiskUsageSample[] = [];
    let mono = 0;
    for (let i = 0; i < FLAT_6H; i++, mono += STEP) s.push({ monotonicMs: mono, freeBytes: 500 * GIB });
    for (const g of [490, 490, 480, 470]) {
      // 490,490 = an exact-repeat tie in the middle of the decline
      s.push({ monotonicMs: mono, freeBytes: g * GIB });
      mono += STEP;
    }
    const rate = estimateConservativeConsumptionRateBytesPerDay(s);
    expect(rate).not.toBeNull();
    expect(impliesWithin7d(rate, s.at(-1)!.freeBytes)).toBe(true); // tie absorbed, corroboration survives
  });

  it("recentDeclineSignal absorbs interior ties/upticks (net from the recent peak, undiluted)", () => {
    const s: DiskUsageSample[] = [];
    let mono = 0;
    for (let i = 0; i < FLAT_6H; i++, mono += STEP) s.push({ monotonicMs: mono, freeBytes: 500 * GIB }); // flat prefix
    for (const g of [490, 490, 492, 480, 470]) {
      // interior tie (490,490) AND a sub-peak uptick (490→492) — both must be absorbed
      s.push({ monotonicMs: mono, freeBytes: g * GIB });
      mono += STEP;
    }
    const sig = recentDeclineSignal(s, DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG.shortWindowMs)!;
    expect(sig).not.toBeNull();
    expect(sig.confirmingDecreases).toBeGreaterThanOrEqual(2); // not reset to 0/1 by the tie or uptick
    // net from the last flat-500 peak to 470 GiB, NOT diluted by the 6h flat prefix
    const latestFree = 470 * GIB;
    expect(latestFree / sig.shortRateBytesPerDay).toBeLessThanOrEqual(7);
  });
});

describe("createFridayDiskGrowthRateSampler (bounded buffer + monotonic clock)", () => {
  it("record → getGrowthRateBytesPerDay reproduces the conservative estimator", () => {
    const { sampler, recordAt } = makeSampler();
    for (const s of series(500 * GIB, GIB, 7 * MS_PER_DAY, 60 * 60 * 1000)) recordAt(s.monotonicMs, s.freeBytes);
    const rate = sampler.getGrowthRateBytesPerDay();
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1, 6);
  });

  it("never exceeds MAX_SAMPLES (count cap) under many in-window ticks", () => {
    const { sampler, recordAt } = makeSampler({ maxSamples: 100, windowMs: 10_000 * MS_PER_DAY });
    for (let i = 0; i < 5000; i++) recordAt(i * 60 * 1000, 100 * GIB - i);
    expect(sampler.size()).toBeLessThanOrEqual(100);
  });

  it("prunes samples older than WINDOW_MS (age cap), by monotonic time", () => {
    const windowMs = 8 * MS_PER_DAY;
    const { sampler, recordAt } = makeSampler({ windowMs, maxSamples: 100_000 });
    for (let d = 0; d < 30; d++) recordAt(d * MS_PER_DAY, 100 * GIB - d * GIB);
    const snap = sampler.snapshot();
    const newest = Math.max(...snap.map((s) => s.monotonicMs));
    expect(snap.every((s) => s.monotonicMs >= newest - windowMs)).toBe(true);
    expect(snap.length).toBeLessThanOrEqual(9);
  });

  it("memory stays bounded under a very long tick history (both caps active)", () => {
    const { sampler, recordAt } = makeSampler();
    const stepMs = 5 * 60 * 1000;
    for (let i = 0; i < 200_000; i++) recordAt(i * stepMs, 1000 * GIB - i * 1000);
    expect(sampler.size()).toBeLessThanOrEqual(DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG.maxSamples);
    expect(sampler.size()).toBeLessThanOrEqual((8 * MS_PER_DAY) / stepMs + 1); // 8-day window is tighter here
  });

  it("startup: no samples → null; one sample → null; short span → null (fail-closed)", () => {
    const { sampler, recordAt, setMono } = makeSampler();
    setMono(0);
    expect(sampler.getGrowthRateBytesPerDay()).toBeNull();
    recordAt(0, 50 * GIB);
    expect(sampler.getGrowthRateBytesPerDay()).toBeNull();
    recordAt(5 * 60 * 1000, 50 * GIB - 1000); // 5 min span < 1h
    expect(sampler.getGrowthRateBytesPerDay()).toBeNull();
  });

  // ── Advisor Finding 1: monotonic-clock trust ─────────────────────────────────
  it("FORWARD wall-clock jump is irrelevant: rate reflects MONOTONIC elapsed → high consumption", () => {
    // 50 GiB consumed over ONE HOUR of MONOTONIC elapsed. A wall clock could jump +8
    // days here; the sampler never reads it, so the rate is ~50 GiB/h = 1200 GiB/day
    // (the buggy wall-clock version would have read ~6.25 GiB/day and said "ok").
    const { sampler, recordAt } = makeSampler();
    for (let m = 0; m <= 60 * 60 * 1000; m += 5 * 60 * 1000) recordAt(m, 200 * GIB - (50 * GIB * m) / (60 * 60 * 1000));
    const rate = sampler.getGrowthRateBytesPerDay();
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1200, 0); // ≈ 1200 GiB/day, NOT ~6.25
  });

  it("OUT-OF-ORDER monotonic sample is rejected (fail-closed skip), keeping order == time", () => {
    const { sampler, recordAt } = makeSampler();
    recordAt(100, 10 * GIB);
    recordAt(200, 9 * GIB);
    recordAt(150, 8 * GIB); // ≤ previous monotonic → REJECTED
    recordAt(300, 7 * GIB);
    const snap = sampler.snapshot();
    expect(snap.map((s) => s.monotonicMs)).toEqual([100, 200, 300]); // 150 dropped
    expect(sampler.size()).toBe(3);
  });

  it("STALLED loop: monotonic advances far beyond the window with no new samples → prune to null", () => {
    const { sampler, recordAt, setMono } = makeSampler({ windowMs: 8 * MS_PER_DAY });
    for (const s of series(500 * GIB, GIB, 7 * MS_PER_DAY, 60 * 60 * 1000)) recordAt(s.monotonicMs, s.freeBytes);
    expect(sampler.size()).toBeGreaterThan(0);
    setMono(7 * MS_PER_DAY + 100 * MS_PER_DAY); // now jumps far ahead, no records
    const rate = sampler.getGrowthRateBytesPerDay();
    expect(sampler.size()).toBe(0);
    expect(rate).toBeNull();
  });
});

// ── Advisor Finding 3: the REAL production clock adapter is exercised directly ───
describe("defaultMonotonicNowMs (the production monotonic clock adapter)", () => {
  it("returns finite, non-negative, monotonically non-decreasing readings", () => {
    const a = defaultMonotonicNowMs();
    const b = defaultMonotonicNowMs();
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("strictly increases across a busy interval (a real elapsed-time source)", () => {
    const a = defaultMonotonicNowMs();
    let acc = 0;
    for (let i = 0; i < 5_000_000; i++) acc += i % 7; // burn a little wall time
    const b = defaultMonotonicNowMs();
    expect(b).toBeGreaterThan(a);
    expect(acc).toBeGreaterThan(0); // keep the loop from being optimized away
  });
});
