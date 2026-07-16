/**
 * RETENTION-R3c — bounded rolling disk-usage growth-rate measurement.
 *
 * Supplies the AUTHORITATIVE `bytes/day` consumption rate that RETENTION-R3b's
 * (#1613) `classifyDiskGrowth` projected-exhaustion branch consumes. #1613 wired the
 * rate to a constant `null` (honest fail-closed); R3c replaces that with a REAL
 * bounded rolling measurement so the 7-day exhaustion warning becomes OBSERVABLE —
 * WITHOUT changing any of #1613's merged classifier/evaluator logic.
 *
 * Contract alignment with #1613 (LOAD-BEARING — the null-vs-measured-zero
 * distinction is exactly what #1613 depends on):
 *   • INSUFFICIENT / INVALID / non-monotonic / degenerate → `null` (UNKNOWN) →
 *     #1613 fail-closes the above-floor reading to `status='unknown'`, healthy=false.
 *     Never fabricate a rate from too little (or untrustworthy) data.
 *   • Free stable or INCREASING over BOTH horizons (net consumption ≤ 0) → `0`
 *     (MEASURED-ZERO, a KNOWN no-growth estimate) → #1613 treats it as KNOWN → `ok`.
 *   • Genuine sustained DECREASE → a positive `bytes/day` rate → #1613 computes
 *     `days = free / rate`, `within = days ≤ 7`.
 *
 * TWO HARDENINGS over the first R3c cut (advisor NEEDS_CHANGES):
 *
 *  (1) MONOTONIC TIME ONLY. Elapsed-time math (least-squares slope AND age-pruning)
 *      is derived from an injected MONOTONIC clock (`monotonicNowMs`, default
 *      `performance.now()`), NEVER wall-clock. Wall-clock (`Date.now()`) can jump
 *      (NTP correction, VM migration, manual set); a forward jump would understate
 *      the rate and hide a real exhaustion. A monotonic clock is strictly increasing
 *      within the process, so it cannot be tricked AND insertion order == time order
 *      (making count-pruning by insertion order correct). A sample whose monotonic
 *      timestamp is ≤ the previous one is defensively rejected (fail-closed skip).
 *
 *  (2) CONSERVATIVE UNDER NON-STATIONARITY. A single full-window slope hides a recent
 *      cliff (e.g. days of rising free then a sudden large drop → a full-window fit
 *      still reads "increasing"). The rate is therefore the SAFETY-CONSERVATIVE max
 *      of the full-window consumption AND a RECENT-horizon consumption
 *      (`recentWindowMs`): whichever implies SOONER exhaustion wins. Measured-zero is
 *      returned ONLY when BOTH horizons show consumption ≤ 0. A false warn is
 *      fail-closed-safe; a hidden cliff is not.
 *
 * DELIBERATELY PURE ESTIMATORS: `estimateConsumptionRateBytesPerDay` and
 * `estimateConservativeConsumptionRateBytesPerDay` are pure functions of the sample
 * array (no clock read inside — the monotonic timestamps are already on the samples).
 * The buffer is an in-memory rolling window — bounded BOTH ways (a hard count cap AND
 * age-pruning) so memory can never grow unbounded (U13 / DATA-RETENTION-001 spirit).
 * Report-only; it never deletes anything. NOT restart-durable (re-accrues after
 * restart; the reading is `unknown` until enough samples accumulate — the correct
 * fail-closed startup).
 */

import { performance } from "node:perf_hooks";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DiskUsageSample {
  /**
   * MONOTONIC timestamp in milliseconds (from `monotonicNowMs`, e.g.
   * `performance.now()`) — NOT wall-clock. Strictly increasing within a process, so
   * elapsed-time math is immune to wall-clock jumps.
   */
  monotonicMs: number;
  /** Free bytes on the state volume at that instant. */
  freeBytes: number;
}

export interface DiskGrowthRateSamplerConfig {
  /** Hard cap on retained samples (bounds memory regardless of tick cadence). */
  maxSamples: number;
  /** Age window: samples older than this (relative to the newest) are pruned. */
  windowMs: number;
  /** Minimum samples before a rate is estimated (< this → null). Floored at 2. */
  minSamples: number;
  /** Minimum time span the window must cover before a rate is estimated (< this → null). */
  minSpanMs: number;
  /**
   * Recent-horizon span for the conservative non-stationarity check: consumption is
   * also estimated over just the most-recent `recentWindowMs` of samples, and the
   * SOONER-exhaustion (higher-consumption) of {full, recent} is reported.
   */
  recentWindowMs: number;
}

/**
 * Defaults tuned to the health monitor's 5-minute tick and U13's 7-day window:
 * an ~8-day age window (slightly beyond 7 days so the estimate is stable at the
 * boundary), a 1-hour minimum span (below which the slope is untrustworthy), a
 * 6-hour recent horizon (catches a fresh cliff without being twitchy), and a
 * 4096-sample hard cap (≈14 days at 5-min ticks; ~96 KB — trivially bounded).
 */
export const DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG: DiskGrowthRateSamplerConfig = {
  maxSamples: 4096,
  windowMs: 8 * MS_PER_DAY,
  minSamples: 2,
  minSpanMs: 60 * 60 * 1000, // 1 hour
  recentWindowMs: 6 * 60 * 60 * 1000, // 6 hours
};

/**
 * Production MONOTONIC clock adapter — `performance.now()` is backed by a monotonic
 * clock, so it is immune to wall-clock jumps (NTP correction, VM migration, manual
 * set). This is the default `monotonicNowMs` used by the sampler in production; it is
 * exported so the real adapter can be unit-tested directly.
 */
export function defaultMonotonicNowMs(): number {
  return performance.now();
}

function isNonNegativeFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * PURE robust estimator over a SINGLE window: net CONSUMPTION rate in bytes/day
 * (positive = free space DECREASING), via the least-squares slope of `freeBytes` vs
 * MONOTONIC time (consumption = −slope) — resists noise far better than a two-point
 * delta.
 *
 * Returns:
 *   • `null` (UNKNOWN, fail-closed) when: fewer than `minSamples`; any sample is
 *     invalid (NaN/±Inf/negative monotonic time or free); the span < `minSpanMs`; or
 *     the regression is degenerate (zero time variance).
 *   • `0` (MEASURED-ZERO, KNOWN no-growth) when free is stable or increasing
 *     (net consumption ≤ 0). NOT `null` — the distinction is load-bearing in #1613.
 *   • a positive bytes/day rate (capped to the safe-integer range so it stays a valid
 *     #1613 rate) for a genuine sustained decrease.
 */
export function estimateConsumptionRateBytesPerDay(
  samples: readonly DiskUsageSample[],
  config: DiskGrowthRateSamplerConfig = DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG,
): number | null {
  const minSamples = Math.max(2, config.minSamples);
  if (!Array.isArray(samples) || samples.length < minSamples) return null;

  let minT = Infinity;
  let maxT = -Infinity;
  for (const s of samples) {
    if (!isNonNegativeFinite(s.monotonicMs) || !isNonNegativeFinite(s.freeBytes)) return null;
    if (s.monotonicMs < minT) minT = s.monotonicMs;
    if (s.monotonicMs > maxT) maxT = s.monotonicMs;
  }
  if (maxT - minT < config.minSpanMs) return null; // span too short → untrustworthy

  // Least-squares slope of freeBytes vs time, time normalized to DAYS from minT for
  // numerical stability (raw ms would inflate the sums). Iterate by value (no numeric
  // indexing) so the loops stay free of object-injection lint noise.
  const n = samples.length;
  const points = samples.map((s) => ({ x: (s.monotonicMs - minT) / MS_PER_DAY, y: s.freeBytes }));
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const xMean = sumX / n;
  const yMean = sumY / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - xMean;
    sxx += dx * dx;
    sxy += dx * (p.y - yMean);
  }
  if (!(sxx > 0) || !Number.isFinite(sxx) || !Number.isFinite(sxy)) return null; // degenerate

  const slopeBytesPerDay = sxy / sxx; // free change per day (negative ⇒ consuming)
  const consumptionBytesPerDay = -slopeBytesPerDay; // positive ⇒ free decreasing
  if (!Number.isFinite(consumptionBytesPerDay)) return null;

  // Stable or increasing free → measured no-growth (KNOWN 0), never null.
  if (consumptionBytesPerDay <= 0) return 0;

  // Genuine decrease → positive rate; cap to the safe-integer range so it remains a
  // valid #1613 rate (finite, ≥ 0, ≤ MAX_SAFE_INTEGER).
  return Math.min(consumptionBytesPerDay, Number.MAX_SAFE_INTEGER);
}

/**
 * PURE conservative estimator (the one the sampler serves): the SAFETY-CONSERVATIVE
 * consumption rate under non-stationarity. Estimates consumption over BOTH the full
 * window AND the most-recent `recentWindowMs`, and returns whichever implies SOONER
 * exhaustion (the HIGHER consumption):
 *   • both horizons evaluable → `max(full, recent)` (so a recent cliff on top of a
 *     rising full-window trend still WARNS, and measured-zero `0` is returned only
 *     when BOTH are ≤ 0);
 *   • the recent horizon lacks enough samples/span → fall back to the full window;
 *   • the full window lacks enough samples/span but the recent horizon has a rate →
 *     use the recent rate (conservative; a false warn is fail-closed-safe);
 *   • neither horizon is evaluable → `null` (UNKNOWN).
 */
export function estimateConservativeConsumptionRateBytesPerDay(
  samples: readonly DiskUsageSample[],
  config: DiskGrowthRateSamplerConfig = DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG,
): number | null {
  const fullRate = estimateConsumptionRateBytesPerDay(samples, config);

  let maxMono = -Infinity;
  for (const s of samples) {
    if (typeof s.monotonicMs === "number" && s.monotonicMs > maxMono) maxMono = s.monotonicMs;
  }
  let recentRate: number | null = null;
  if (Number.isFinite(maxMono)) {
    const cutoff = maxMono - config.recentWindowMs;
    const recentSamples = samples.filter((s) => s.monotonicMs >= cutoff);
    recentRate = estimateConsumptionRateBytesPerDay(recentSamples, config);
  }

  const candidates = [fullRate, recentRate].filter((r): r is number => r !== null);
  if (candidates.length === 0) return null; // neither horizon observable → UNKNOWN
  return Math.max(...candidates); // sooner exhaustion wins (0 only if BOTH ≤ 0)
}

/** A bounded rolling sampler owning the in-memory window and a monotonic clock. */
export interface FridayDiskGrowthRateSampler {
  /**
   * Append a disk-usage sample, timestamped with the injected MONOTONIC clock. A
   * sample whose monotonic time is not strictly greater than the previous one is
   * rejected (fail-closed skip). Prunes to keep the buffer bounded (count + age).
   */
  record(freeBytes: number): void;
  /**
   * Authoritative consumption rate (bytes/day) over the current window — the
   * conservative max of the full-window and recent-horizon consumption — or `null`
   * when neither horizon is observable (see the estimator contract). Age-prunes stale
   * samples relative to the monotonic now, so a stalled tick loop cannot serve a rate
   * computed from stale data.
   */
  getGrowthRateBytesPerDay(): number | null;
  /** Current retained sample count (bounded by `maxSamples`). For tests/diagnostics. */
  size(): number;
  /** A copy of the current buffer. For tests/diagnostics. */
  snapshot(): DiskUsageSample[];
}

export interface DiskGrowthRateSamplerOptions extends Partial<DiskGrowthRateSamplerConfig> {
  /**
   * Injected MONOTONIC clock (ms). Defaults to `defaultMonotonicNowMs`
   * (`performance.now()`). MUST be monotonic — the sampler derives all elapsed-time
   * math from it and rejects any non-increasing reading. Injectable for tests.
   */
  monotonicNowMs?: () => number;
}

export function createFridayDiskGrowthRateSampler(
  options: DiskGrowthRateSamplerOptions = {},
): FridayDiskGrowthRateSampler {
  const { monotonicNowMs = defaultMonotonicNowMs, ...cfgOverrides } = options;
  const cfg: DiskGrowthRateSamplerConfig = { ...DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG, ...cfgOverrides };
  let samples: DiskUsageSample[] = [];
  let lastMono = -Infinity; // for strict-monotonic (out-of-order) rejection

  function prune(refMono: number): void {
    // Age-prune: drop samples older than the window relative to the monotonic now.
    if (Number.isFinite(refMono)) {
      const cutoff = refMono - cfg.windowMs;
      if (Number.isFinite(cutoff)) samples = samples.filter((s) => s.monotonicMs >= cutoff);
    }
    // Count-cap: monotonic time ⇒ insertion order == time order, so keeping the last
    // `maxSamples` keeps the most-recent.
    if (samples.length > cfg.maxSamples) {
      samples = samples.slice(samples.length - cfg.maxSamples);
    }
  }

  return {
    record(freeBytes) {
      const t = monotonicNowMs();
      // Fail-closed skip of a non-finite or non-strictly-increasing monotonic reading
      // (a real monotonic clock never regresses; this guards a misbehaving injection).
      if (!Number.isFinite(t) || t <= lastMono) return;
      lastMono = t;
      samples.push({ monotonicMs: t, freeBytes });
      prune(t);
    },
    getGrowthRateBytesPerDay() {
      const now = monotonicNowMs();
      const ref = Number.isFinite(now) ? Math.max(now, lastMono) : lastMono;
      prune(ref);
      return estimateConservativeConsumptionRateBytesPerDay(samples, cfg);
    },
    size() {
      return samples.length;
    },
    snapshot() {
      return samples.slice();
    },
  };
}
