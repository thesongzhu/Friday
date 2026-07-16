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
 *   • Free stable / recovering (no net depletion) → `0` (MEASURED-ZERO, KNOWN) → `ok`.
 *   • Genuine sustained DECREASE → a positive `bytes/day` rate → #1613 computes
 *     `days = free / rate`, `within = days ≤ 7`.
 *
 * HARDENINGS over successive cuts (advisor / reviewer NEEDS_CHANGES):
 *
 *  (1) MONOTONIC TIME ONLY. Elapsed-time math (all slopes AND age-pruning) uses an
 *      injected MONOTONIC clock (`monotonicNowMs`, default `performance.now()`), NEVER
 *      wall-clock — a wall-clock jump (NTP/VM/manual) cannot distort the rate. A sample
 *      whose monotonic time is not strictly greater than the previous is rejected.
 *
 *  (2) CONSERVATIVE UNDER NON-STATIONARITY, NOISE-ROBUST CHANGE-POINT. A fixed-window
 *      least-squares slope — even a "recent" one — is diluted by preceding flat history
 *      during a genuine SUSTAINED depletion (6h flat + a few minutes of decline → a slow
 *      averaged slope → a dangerous false `ok`), AND a strict consecutive-decrease run is
 *      silenced by a single tie (an exact-repeat statfs read is realistic granularity
 *      noise) or a sub-tolerance uptick. The rate is therefore the SOONEST-exhaustion max
 *      of THREE signals: the full-window slope, the recent-`recentWindowMs` slope, and a
 *      NOISE-TOLERANT recent-decline signal — the net consumption measured from the most
 *      recent local PEAK within a short `shortWindowMs` horizon to now (endpoint-based, so
 *      leading flats do NOT dilute it and interior ties/upticks are ABSORBED, not reset).
 *      It is folded into the max only when CORROBORATED (≥ 2 confirming decreases in the
 *      segment) and implying exhaustion ≤ `exhaustionWarnDays`. A single unconfirmed fast
 *      drop → `null` (UNKNOWN, fail-closed, not cry-wolf). Measured-zero `0` is returned
 *      only when NOTHING shows depletion.
 *
 * DELIBERATELY PURE ESTIMATORS (no clock read inside — timestamps are on the samples).
 * The buffer is an in-memory rolling window, bounded BOTH ways (count cap + age-prune),
 * so memory can never grow unbounded. Report-only; never deletes. NOT restart-durable.
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
  /** Free bytes on the state volume at that instant (integer byte count in production). */
  freeBytes: number;
}

export interface DiskGrowthRateSamplerConfig {
  /** Hard cap on retained samples (bounds memory regardless of tick cadence). */
  maxSamples: number;
  /** Age window: samples older than this (relative to the newest) are pruned. */
  windowMs: number;
  /** Minimum samples before a least-squares rate is estimated (< this → null). Floored at 2. */
  minSamples: number;
  /** Minimum span a least-squares window must cover before a rate is estimated (< this → null). */
  minSpanMs: number;
  /** Span of the "recent" least-squares horizon folded into the conservative max. */
  recentWindowMs: number;
  /**
   * Span of the SHORT horizon for the noise-tolerant change-point signal (≪
   * `recentWindowMs`). The recent local peak is found within this horizon; net
   * consumption from that peak to now is the undiluted short rate.
   */
  shortWindowMs: number;
  /**
   * Projected-exhaustion horizon (days) mirroring U13's 7-day warn window. The
   * change-point signal fires only when the short rate implies exhaustion within this
   * many days — the threshold that both corroborates a warn and filters minor
   * fluctuations. Must equal #1613's `projectedExhaustionWarnDays`; the classifier
   * remains the sole authority on status.
   */
  exhaustionWarnDays: number;
}

/**
 * Defaults tuned to the health monitor's 5-minute tick and U13's 7-day window: an
 * ~8-day age window, a 1-hour minimum LSQ span, a 6-hour recent LSQ horizon, a 1-hour
 * short change-point horizon (enough ticks to corroborate; the peak anchor un-dilutes
 * regardless of length), and a 4096-sample hard cap (~96 KB — trivially bounded).
 */
export const DEFAULT_DISK_GROWTH_RATE_SAMPLER_CONFIG: DiskGrowthRateSamplerConfig = {
  maxSamples: 4096,
  windowMs: 8 * MS_PER_DAY,
  minSamples: 2,
  minSpanMs: 60 * 60 * 1000, // 1 hour
  recentWindowMs: 6 * 60 * 60 * 1000, // 6 hours
  shortWindowMs: 60 * 60 * 1000, // 1 hour
  exhaustionWarnDays: 7, // mirrors U13 / #1613 projectedExhaustionWarnDays
};

/**
 * Production MONOTONIC clock adapter — `performance.now()` is backed by a monotonic
 * clock, so it is immune to wall-clock jumps. Exported so the real adapter can be
 * unit-tested directly.
 */
export function defaultMonotonicNowMs(): number {
  return performance.now();
}

function isNonNegativeFinite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

/**
 * PURE robust estimator over a SINGLE window: net CONSUMPTION rate in bytes/day
 * (positive = free DECREASING), via the least-squares slope of `freeBytes` vs MONOTONIC
 * time (consumption = −slope). Returns `null` for insufficient/invalid/short-span/
 * degenerate; `0` for stable/increasing; a positive rate for a sustained decrease.
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

  const consumptionBytesPerDay = -(sxy / sxx); // positive ⇒ free decreasing
  if (!Number.isFinite(consumptionBytesPerDay)) return null;
  if (consumptionBytesPerDay <= 0) return 0; // stable / increasing → measured no-growth
  return Math.min(consumptionBytesPerDay, Number.MAX_SAFE_INTEGER);
}

/**
 * PURE noise-tolerant recent-decline signal (the change-point detector). Over the most
 * recent `shortWindowMs`, anchors at the LATEST-occurring local PEAK (max free) and
 * measures the NET consumption from that peak to the latest sample. This is
 * endpoint-based, so:
 *   • a leading flat prefix does NOT dilute the rate (the anchor is the last peak, i.e.
 *     the point where the decline began, not the window start), and
 *   • interior TIES (exact-repeat statfs reads) and sub-peak UPTICKS are ABSORBED — the
 *     net from the peak is unaffected, and the run is never reset by a single tie.
 * `confirmingDecreases` counts strictly-decreasing intervals in the peak→now segment so
 * the caller can distinguish a single unconfirmed drop (→ unknown) from a corroborated
 * one (→ warn). Returns `null` when the recent window shows no net depletion from a peak.
 */
export function recentDeclineSignal(
  sorted: readonly DiskUsageSample[],
  shortWindowMs: number,
): { shortRateBytesPerDay: number; confirmingDecreases: number } | null {
  const latest = sorted.at(-1);
  if (!latest) return null;
  const cutoff = latest.monotonicMs - shortWindowMs;
  const window = sorted.filter((s) => s.monotonicMs >= cutoff);
  if (window.length < 2) return null;

  // Anchor = the LATEST-occurring maximum free within the window (iterate ascending
  // with `>=` so ties land on the most recent peak → the tightest, most-conservative,
  // and un-diluted starting point for the net measurement).
  let anchorFree = Number.NEGATIVE_INFINITY;
  let anchorMono = Number.NEGATIVE_INFINITY;
  for (const s of window) {
    if (s.freeBytes >= anchorFree) {
      anchorFree = s.freeBytes;
      anchorMono = s.monotonicMs;
    }
  }

  const elapsedMs = latest.monotonicMs - anchorMono;
  const netConsumed = anchorFree - latest.freeBytes;
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs) || !(netConsumed > 0)) return null; // no net decline
  const rate = (netConsumed / elapsedMs) * MS_PER_DAY;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  // Count strictly-decreasing intervals within [anchor .. latest]; ties/upticks absorbed.
  let confirming = 0;
  let prev: number | null = null;
  for (const s of window) {
    if (s.monotonicMs < anchorMono) continue;
    if (prev !== null && s.freeBytes < prev) confirming++;
    prev = s.freeBytes;
  }
  return { shortRateBytesPerDay: Math.min(rate, Number.MAX_SAFE_INTEGER), confirmingDecreases: confirming };
}

/**
 * PURE conservative estimator (the one the sampler serves): the SOONEST-exhaustion max
 * of the full-window slope, the recent-`recentWindowMs` slope, and the noise-tolerant
 * recent-decline signal (folded in only when corroborated and warn-implying). The
 * classifier remains the sole status authority; no new warn branch.
 *
 *   • any exposed signal implies exhaustion ≤ `exhaustionWarnDays` → return it (→ WARN);
 *   • a SINGLE unconfirmed fast drop (exactly 1 confirming decrease implying ≤ warn-days,
 *     nothing else warning) → `null` (UNKNOWN — never false-`ok`, but not cry-wolf);
 *   • otherwise `0` (MEASURED-ZERO) when nothing depletes, a slow positive rate for a
 *     slow decline, or `null` when neither slope window is observable. Minor fluctuations
 *     imply ≫ warn-days so the change-point never fires; genuine recovery (rising tail /
 *     no net decline from a peak) is never warned.
 *
 * Preserves round-1/round-2 behavior (recovery-then-sustained-cliff still warns — the
 * cliff is a corroborated, undiluted peak→now decline) and all null-on-insufficient/
 * invalid/monotonic-violation cases.
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
  const recentRate = estimateConsumptionRateBytesPerDay(
    sorted.filter((s) => s.monotonicMs >= maxMono - config.recentWindowMs),
    config,
  );

  const signal = recentDeclineSignal(sorted, config.shortWindowMs);
  const shortRate = signal ? signal.shortRateBytesPerDay : null;
  const confirming = signal ? signal.confirmingDecreases : 0;
  const shortImpliesWarn =
    shortRate !== null && shortRate > 0 && Number.isFinite(latestFree / shortRate) && latestFree / shortRate <= config.exhaustionWarnDays;

  const candidates: number[] = [];
  if (fullRate !== null) candidates.push(fullRate);
  if (recentRate !== null) candidates.push(recentRate);
  // A CORROBORATED (≥2 confirming decreases) fast, undiluted recent decline is exposed
  // so the classifier warns — it must NOT be averaged away by old flat data or silenced
  // by a tie.
  if (confirming >= 2 && shortImpliesWarn && shortRate !== null) candidates.push(shortRate);

  const baseMax = candidates.length > 0 ? Math.max(...candidates) : null;

  // Any exposed signal already implies exhaustion ≤ warn-days → return it (WARN).
  if (baseMax !== null && baseMax > 0 && Number.isFinite(latestFree / baseMax) && latestFree / baseMax <= config.exhaustionWarnDays) {
    return baseMax;
  }

  // A SINGLE unconfirmed fast decrease → UNKNOWN (avoid both false-ok and cry-wolf).
  if (confirming === 1 && shortImpliesWarn) return null;

  return baseMax; // 0 (measured-zero) / slow positive / null (neither slope window observable)
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
   * Authoritative consumption rate (bytes/day) over the current window — the conservative
   * (full / recent / noise-tolerant change-point) max — or `null` when unobservable. Age-
   * prunes stale samples relative to the monotonic now, so a stalled loop cannot serve a
   * rate computed from stale data.
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
    if (Number.isFinite(refMono)) {
      const cutoff = refMono - cfg.windowMs;
      if (Number.isFinite(cutoff)) samples = samples.filter((s) => s.monotonicMs >= cutoff);
    }
    if (samples.length > cfg.maxSamples) {
      samples = samples.slice(samples.length - cfg.maxSamples);
    }
  }

  return {
    record(freeBytes) {
      const t = monotonicNowMs();
      if (!Number.isFinite(t) || t <= lastMono) return; // fail-closed skip of non-monotonic reading
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
