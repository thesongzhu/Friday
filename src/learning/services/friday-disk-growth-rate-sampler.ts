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
  /**
   * Projected-exhaustion horizon (days) that mirrors U13's 7-day warn window. Used
   * ONLY by the change-point signal to decide whether a tail decline run is "fast"
   * (implies exhaustion within this many days) — the threshold that both corroborates
   * a warn and naturally filters minor fluctuations. Must equal #1613's
   * `projectedExhaustionWarnDays`; the classifier remains the sole authority on status.
   */
  exhaustionWarnDays: number;
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
  exhaustionWarnDays: 7, // mirrors U13 / #1613 projectedExhaustionWarnDays
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
 * Average consumption (bytes/day) over an already-time-sorted, strictly-decreasing
 * tail run — a CHANGE-POINT-AWARE short horizon that is NOT diluted by old flat
 * history and (deliberately) imposes NO `minSpanMs`, so a fresh sustained depletion
 * is measured on its own terms. Returns `null` unless there is a genuine decrease over
 * positive elapsed time.
 */
function runConsumptionRateBytesPerDay(sortedRun: readonly DiskUsageSample[]): number | null {
  const first = sortedRun.at(0);
  const last = sortedRun.at(-1);
  if (!first || !last) return null;
  const elapsedMs = last.monotonicMs - first.monotonicMs;
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) return null;
  const consumed = first.freeBytes - last.freeBytes; // > 0 for a decline
  const rate = (consumed / elapsedMs) * MS_PER_DAY;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.min(rate, Number.MAX_SAFE_INTEGER);
}

/** Count consecutive strictly-decreasing steps at the TAIL of a time-sorted series. */
function tailDeclineRunLength(sortedSamples: readonly DiskUsageSample[]): number {
  let run = 0;
  let prevFree: number | null = null;
  for (let i = sortedSamples.length - 1; i >= 0; i--) {
    const free = sortedSamples.at(i)!.freeBytes;
    if (prevFree === null) {
      prevFree = free;
      continue;
    }
    if (prevFree < free) {
      // newer sample is LOWER than this (older) one ⇒ a decrease at the tail
      run++;
      prevFree = free;
    } else {
      break;
    }
  }
  return run;
}

/**
 * PURE conservative estimator (the one the sampler serves): the SAFETY-CONSERVATIVE
 * consumption rate under NON-STATIONARITY, hardened with a CHANGE-POINT-AWARE
 * short-horizon signal (advisor round-2). A fixed "recent" least-squares window is
 * still diluted by preceding flat history during a genuine SUSTAINED depletion (6h of
 * flat + a few minutes of decline → a slow averaged slope → a dangerous false `ok`).
 *
 * The rate is the SOONEST-exhaustion max of THREE signals:
 *   • the full-window least-squares consumption,
 *   • the recent-`recentWindowMs` least-squares consumption,
 *   • a CONFIRMED short-horizon consumption over ONLY the strictly-decreasing tail run
 *     (undiluted), included ONLY when the run is CORROBORATED (≥ 2 consecutive
 *     production-cadence decreases) AND its rate implies exhaustion ≤ `exhaustionWarnDays`.
 *
 * Decision (soonest exhaustion wins; the classifier remains the sole status authority):
 *   • any exposed signal implies exhaustion ≤ warn-days → return it (→ classifier WARNS);
 *   • a SINGLE unconfirmed fast decrease (1 tail decrease implying ≤ warn-days, not yet
 *     corroborated, and no other signal warns) → `null` (UNKNOWN → fail-closed, NOT a
 *     false `ok`, but NOT cry-wolf `warn` either);
 *   • otherwise the max of the observable horizons: `0` (MEASURED-ZERO) only when
 *     NOTHING shows depletion, a slow positive rate for a slow decline, or `null` when
 *     neither horizon is observable. Minor fluctuations imply ≫ warn-days, so the
 *     change-point logic never fires for them → they stay `ok`. Genuine recovery
 *     (rising tail) has run length 0 → never warned.
 *
 * Preserves the round-1/round-2 behavior: recovery-then-sustained-cliff still warns
 * (the cliff is a long corroborated tail run), and all null-on-insufficient/invalid
 * cases hold.
 */
export function estimateConservativeConsumptionRateBytesPerDay(
  samples: readonly DiskUsageSample[],
  config: DiskGrowthRateSamplerConfig = DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG,
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  for (const s of samples) {
    if (!isNonNegativeFinite(s.monotonicMs) || !isNonNegativeFinite(s.freeBytes)) return null;
  }
  const sorted = [...samples].sort((a, b) => a.monotonicMs - b.monotonicMs);
  const latestFree = sorted.at(-1)!.freeBytes;
  const maxMono = sorted.at(-1)!.monotonicMs;

  const fullRate = estimateConsumptionRateBytesPerDay(sorted, config);
  const recentCutoff = maxMono - config.recentWindowMs;
  const recentRate = estimateConsumptionRateBytesPerDay(
    sorted.filter((s) => s.monotonicMs >= recentCutoff),
    config,
  );

  // Change-point: the undiluted consumption over the strictly-decreasing tail run.
  const declineRun = tailDeclineRunLength(sorted);
  let shortRate: number | null = null;
  let shortImpliesWarn = false;
  if (declineRun >= 1) {
    shortRate = runConsumptionRateBytesPerDay(sorted.slice(sorted.length - 1 - declineRun));
    if (shortRate !== null) {
      const days = latestFree / shortRate;
      shortImpliesWarn = Number.isFinite(days) && days <= config.exhaustionWarnDays;
    }
  }

  const candidates: number[] = [];
  if (fullRate !== null) candidates.push(fullRate);
  if (recentRate !== null) candidates.push(recentRate);
  // A CORROBORATED (≥2) fast tail run is exposed so the classifier warns — it must NOT
  // be averaged away by hours of old flat data.
  if (declineRun >= 2 && shortImpliesWarn && shortRate !== null) candidates.push(shortRate);

  const baseMax = candidates.length > 0 ? Math.max(...candidates) : null;

  // Any exposed signal already implies exhaustion ≤ warn-days → return it (WARN).
  if (baseMax !== null && baseMax > 0 && Number.isFinite(latestFree / baseMax) && latestFree / baseMax <= config.exhaustionWarnDays) {
    return baseMax;
  }

  // A SINGLE unconfirmed fast decrease → UNKNOWN (avoid both false-ok and cry-wolf).
  if (declineRun === 1 && shortImpliesWarn) return null;

  return baseMax; // 0 (measured-zero) / slow positive / null (neither horizon observable)
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
