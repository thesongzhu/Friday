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
 *   • INSUFFICIENT / INVALID data  → `null` (UNKNOWN) → #1613 fail-closes the
 *     above-floor reading to `status='unknown'`, healthy=false. Never fabricate a
 *     rate from too little data.
 *   • Free stable or INCREASING (net consumption ≤ 0) → `0` (MEASURED-ZERO, a KNOWN
 *     no-growth estimate) → #1613 treats it as KNOWN → `ok` on the exhaustion branch.
 *   • Genuine sustained DECREASE → a positive `bytes/day` rate → #1613 computes
 *     `days = free / rate`, `within = days ≤ 7`.
 *
 * DELIBERATELY PURE / IO-FREE: the estimator is a pure function of the sample array
 * (the caller supplies timestamps; no wall-clock is read here). The buffer is an
 * in-memory rolling window — bounded BOTH ways (a hard count cap AND age-pruning) so
 * memory can never grow unbounded (U13 / DATA-RETENTION-001 spirit). Report-only; it
 * never deletes anything. NOT restart-durable (re-accrues after restart; the reading
 * is `unknown` until enough samples accumulate — the correct fail-closed startup).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DiskUsageSample {
  /** Monotonic-ish wall-clock at sampling, in epoch milliseconds. */
  timestampMs: number;
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
}

/**
 * Defaults tuned to the health monitor's 5-minute tick and U13's 7-day window:
 * an ~8-day age window (slightly beyond 7 days so the estimate is stable at the
 * boundary), a 1-hour minimum span (below which the slope is untrustworthy), and a
 * 4096-sample hard cap (≈14 days at 5-min ticks; ~96 KB — trivially bounded).
 */
export const DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG: DiskGrowthRateSamplerConfig = {
  maxSamples: 4096,
  windowMs: 8 * MS_PER_DAY,
  minSamples: 2,
  minSpanMs: 60 * 60 * 1000, // 1 hour
};

function isNonNegativeFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * PURE robust estimator: net CONSUMPTION rate in bytes/day (positive = free space
 * DECREASING) over the supplied samples, via the least-squares slope of `freeBytes`
 * vs time (consumption = −slope) — resists noise far better than a two-point delta.
 *
 * Returns:
 *   • `null` (UNKNOWN, fail-closed) when: fewer than `minSamples`; any sample is
 *     invalid (NaN/±Inf/negative time or free); the window span < `minSpanMs`; or the
 *     regression is degenerate (zero time variance).
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
    if (!isNonNegativeFinite(s.timestampMs) || !isNonNegativeFinite(s.freeBytes)) return null;
    if (s.timestampMs < minT) minT = s.timestampMs;
    if (s.timestampMs > maxT) maxT = s.timestampMs;
  }
  if (maxT - minT < config.minSpanMs) return null; // span too short → untrustworthy

  // Least-squares slope of freeBytes vs time, time normalized to DAYS from minT for
  // numerical stability (raw epoch-ms would inflate the sums). Iterate by value (no
  // numeric indexing) so the loops stay free of object-injection lint noise.
  const n = samples.length;
  const points = samples.map((s) => ({ x: (s.timestampMs - minT) / MS_PER_DAY, y: s.freeBytes }));
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

/** A bounded rolling sampler owning the in-memory window. */
export interface FridayDiskGrowthRateSampler {
  /** Append a disk-usage sample; prunes to keep the buffer bounded (count + age). */
  record(timestampMs: number, freeBytes: number): void;
  /**
   * Authoritative consumption rate (bytes/day) over the current window, or `null`
   * when insufficient/invalid (see the estimator contract). `nowMs`, when supplied,
   * age-prunes stale samples relative to now (so a stalled tick loop cannot serve a
   * rate computed from stale data).
   */
  getGrowthRateBytesPerDay(nowMs?: number): number | null;
  /** Current retained sample count (bounded by `maxSamples`). For tests/diagnostics. */
  size(): number;
  /** A copy of the current buffer. For tests/diagnostics. */
  snapshot(): DiskUsageSample[];
}

export function createFridayDiskGrowthRateSampler(
  config: Partial<DiskGrowthRateSamplerConfig> = {},
): FridayDiskGrowthRateSampler {
  const cfg: DiskGrowthRateSamplerConfig = { ...DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG, ...config };
  let samples: DiskUsageSample[] = [];

  function latestTimestamp(): number {
    let m = -Infinity;
    for (const s of samples) if (s.timestampMs > m) m = s.timestampMs;
    return m;
  }

  function prune(referenceNowMs: number): void {
    // Age-prune: drop samples older than the window relative to the reference now.
    if (Number.isFinite(referenceNowMs)) {
      const cutoff = referenceNowMs - cfg.windowMs;
      if (Number.isFinite(cutoff)) samples = samples.filter((s) => s.timestampMs >= cutoff);
    }
    // Count-cap: keep only the most-recent `maxSamples` (insertion == time order in prod).
    if (samples.length > cfg.maxSamples) {
      samples = samples.slice(samples.length - cfg.maxSamples);
    }
  }

  return {
    record(timestampMs, freeBytes) {
      samples.push({ timestampMs, freeBytes });
      // Prune relative to the newest observed timestamp — robust to out-of-order
      // records (never drops the just-appended newest) and monotonic in production.
      prune(Math.max(timestampMs, latestTimestamp()));
    },
    getGrowthRateBytesPerDay(nowMs) {
      const ref =
        typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.max(nowMs, latestTimestamp()) : latestTimestamp();
      prune(ref);
      return estimateConsumptionRateBytesPerDay(samples, cfg);
    },
    size() {
      return samples.length;
    },
    snapshot() {
      return samples.slice();
    },
  };
}
