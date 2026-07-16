import { describe, expect, it } from "vitest";

import {
  createFridayDiskGrowthRateSampler,
  estimateConsumptionRateBytesPerDay,
  DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG,
  type DiskUsageSample,
} from "../../../../src/learning/services/friday-disk-growth-rate-sampler.js";

/**
 * RETENTION-R3c — the bounded rolling growth-rate measurement that feeds #1613's
 * (RETENTION-R3b) projected-exhaustion branch. Two properties are proven here:
 *   (A) the PURE estimator's null-vs-measured-zero-vs-positive decision points align
 *       EXACTLY with #1613's contract (null=UNKNOWN→fail-closed; 0=KNOWN no-growth→ok;
 *       positive=genuine decrease→7-day projection), and
 *   (B) the buffer is BOUNDED both ways (count cap + age window) so memory can never
 *       grow without bound regardless of tick cadence or uptime.
 */

const GIB = 1024 ** 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000; // fixed epoch base (deterministic)

function steadyDecrease(startFree: number, perDay: number, days: number, stepMs: number): DiskUsageSample[] {
  const out: DiskUsageSample[] = [];
  for (let t = 0; t <= days * MS_PER_DAY; t += stepMs) {
    out.push({ timestampMs: T0 + t, freeBytes: startFree - (perDay * t) / MS_PER_DAY });
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

describe("estimateConsumptionRateBytesPerDay (pure estimator)", () => {
  it("steady 1 GiB/day decrease over 7 days → ≈ 1 GiB/day consumption", () => {
    const samples = steadyDecrease(500 * GIB, GIB, 7, 60 * 60 * 1000); // hourly
    const rate = estimateConsumptionRateBytesPerDay(samples);
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1, 6);
  });

  it("free INCREASING (net consumption < 0) → measured-zero 0, NOT null", () => {
    const samples = steadyDecrease(100 * GIB, -2 * GIB, 5, 60 * 60 * 1000); // negative perDay ⇒ increasing free
    const rate = estimateConsumptionRateBytesPerDay(samples);
    expect(rate).toBe(0);
  });

  it("free FLAT → measured-zero 0, NOT null", () => {
    const samples: DiskUsageSample[] = [];
    for (let d = 0; d < 6; d++) samples.push({ timestampMs: T0 + d * MS_PER_DAY, freeBytes: 42 * GIB });
    const rate = estimateConsumptionRateBytesPerDay(samples);
    expect(rate).toBe(0);
  });

  it("fewer than MIN_SAMPLES → null (UNKNOWN, fail-closed)", () => {
    expect(estimateConsumptionRateBytesPerDay([])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([{ timestampMs: T0, freeBytes: 10 * GIB }])).toBeNull();
  });

  it("span shorter than MIN_SPAN_MS → null even with enough samples", () => {
    const samples: DiskUsageSample[] = [];
    // 10 samples across only 30 minutes (< 1h min span)
    for (let i = 0; i < 10; i++) samples.push({ timestampMs: T0 + i * 3 * 60 * 1000, freeBytes: 10 * GIB - i * GIB });
    expect(estimateConsumptionRateBytesPerDay(samples)).toBeNull();
  });

  it("any invalid sample (NaN / +Inf / negative time / negative free) → null", () => {
    const base: DiskUsageSample[] = [
      { timestampMs: T0, freeBytes: 10 * GIB },
      { timestampMs: T0 + 2 * MS_PER_DAY, freeBytes: 9 * GIB },
    ];
    expect(estimateConsumptionRateBytesPerDay([...base, { timestampMs: T0 + 3 * MS_PER_DAY, freeBytes: Number.NaN }])).toBeNull();
    expect(
      estimateConsumptionRateBytesPerDay([...base, { timestampMs: T0 + 3 * MS_PER_DAY, freeBytes: Number.POSITIVE_INFINITY }]),
    ).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { timestampMs: -1, freeBytes: 8 * GIB }])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { timestampMs: T0 + 3 * MS_PER_DAY, freeBytes: -1 }])).toBeNull();
    expect(estimateConsumptionRateBytesPerDay([...base, { timestampMs: Number.NaN, freeBytes: 8 * GIB }])).toBeNull();
  });

  it("zero time-variance (all identical timestamps) → null (degenerate regression)", () => {
    const samples: DiskUsageSample[] = [
      { timestampMs: T0, freeBytes: 10 * GIB },
      { timestampMs: T0, freeBytes: 8 * GIB },
      { timestampMs: T0, freeBytes: 6 * GIB },
    ];
    expect(estimateConsumptionRateBytesPerDay(samples)).toBeNull();
  });

  it("noisy-but-trending decrease → robust estimate within tolerance", () => {
    const rnd = lcg(12345);
    const perDay = 2 * GIB;
    const samples: DiskUsageSample[] = [];
    for (let t = 0; t <= 7 * MS_PER_DAY; t += 60 * 60 * 1000) {
      const trend = 300 * GIB - (perDay * t) / MS_PER_DAY;
      const noise = (rnd() - 0.5) * 0.5 * GIB; // ±0.25 GiB jitter
      samples.push({ timestampMs: T0 + t, freeBytes: Math.max(0, trend + noise) });
    }
    const rate = estimateConsumptionRateBytesPerDay(samples);
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(2, 1); // within ~0.05 GiB/day despite noise
  });
});

describe("createFridayDiskGrowthRateSampler (bounded buffer)", () => {
  it("record → getGrowthRateBytesPerDay reproduces the estimator over the window", () => {
    const sampler = createFridayDiskGrowthRateSampler();
    for (const s of steadyDecrease(500 * GIB, GIB, 7, 60 * 60 * 1000)) sampler.record(s.timestampMs, s.freeBytes);
    const rate = sampler.getGrowthRateBytesPerDay();
    expect(rate).not.toBeNull();
    expect(rate! / GIB).toBeCloseTo(1, 6);
  });

  it("never exceeds MAX_SAMPLES (count cap) even under many in-window ticks", () => {
    const sampler = createFridayDiskGrowthRateSampler({ maxSamples: 100, windowMs: 10_000 * MS_PER_DAY });
    for (let i = 0; i < 5000; i++) sampler.record(T0 + i * 60 * 1000, 100 * GIB - i);
    expect(sampler.size()).toBeLessThanOrEqual(100);
  });

  it("prunes samples older than WINDOW_MS (age cap)", () => {
    const windowMs = 8 * MS_PER_DAY;
    const sampler = createFridayDiskGrowthRateSampler({ windowMs, maxSamples: 100_000 });
    // 30 daily samples; only those within the trailing 8-day window relative to newest survive.
    for (let d = 0; d < 30; d++) sampler.record(T0 + d * MS_PER_DAY, 100 * GIB - d * GIB);
    const snap = sampler.snapshot();
    const newest = Math.max(...snap.map((s) => s.timestampMs));
    expect(snap.every((s) => s.timestampMs >= newest - windowMs)).toBe(true);
    expect(snap.length).toBeLessThanOrEqual(9); // 8-day window at daily cadence
  });

  it("memory stays bounded under a very long tick history (both caps active)", () => {
    const sampler = createFridayDiskGrowthRateSampler(); // defaults: 4096 cap, 8-day window
    // Two years of 5-minute ticks — far exceeds both caps.
    const stepMs = 5 * 60 * 1000;
    for (let i = 0; i < 200_000; i++) sampler.record(T0 + i * stepMs, 1000 * GIB - i * 1000);
    expect(sampler.size()).toBeLessThanOrEqual(DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG.maxSamples);
    // Age window (8 days) is the tighter bound at 5-min cadence: 8*288 = 2304 < 4096.
    expect(sampler.size()).toBeLessThanOrEqual((8 * MS_PER_DAY) / stepMs + 1);
  });

  it("startup: no samples → null; one sample → null; short span → null (fail-closed)", () => {
    const sampler = createFridayDiskGrowthRateSampler();
    expect(sampler.getGrowthRateBytesPerDay(T0)).toBeNull();
    sampler.record(T0, 50 * GIB);
    expect(sampler.getGrowthRateBytesPerDay(T0)).toBeNull();
    sampler.record(T0 + 5 * 60 * 1000, 50 * GIB - 1000); // 5 min span < 1h
    expect(sampler.getGrowthRateBytesPerDay(T0 + 5 * 60 * 1000)).toBeNull();
  });

  it("nowMs age-prunes stale samples so a stalled loop cannot serve stale data", () => {
    const sampler = createFridayDiskGrowthRateSampler({ windowMs: 8 * MS_PER_DAY });
    for (const s of steadyDecrease(500 * GIB, GIB, 7, 60 * 60 * 1000)) sampler.record(s.timestampMs, s.freeBytes);
    expect(sampler.size()).toBeGreaterThan(0);
    // Advance now far beyond the window with no new samples: all prune away → null.
    const rate = sampler.getGrowthRateBytesPerDay(T0 + 100 * MS_PER_DAY);
    expect(sampler.size()).toBe(0);
    expect(rate).toBeNull();
  });
});
