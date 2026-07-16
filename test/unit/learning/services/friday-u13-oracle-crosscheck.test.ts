import { describe, expect, it } from "vitest";

import {
  classifyDiskGrowth,
  evaluateLargeWriteSafety,
} from "../../../../src/learning/services/friday-disk-growth-evaluator.js";
import {
  oracleClassifyDiskGrowth,
  oracleEvaluateLargeWrite,
} from "./friday-u13-storage-pressure-oracle.js";

/**
 * RETENTION-R3b — root-cause deliverable (advisor round-4). BOTH U13 evaluators are
 * graded by an INDEPENDENT clean-room oracle (friday-u13-storage-pressure-oracle.ts),
 * not by duplicating production's own branching. The COMPLETE input domain is run
 * through production and the oracle and asserted to agree — so a production bug the
 * oracle does not share is caught. A grid over the boundary/degenerate values plus a
 * deterministically-seeded random sample make the cross-check exhaustive over the
 * domain rather than a couple of hand-picked cases.
 */

const GIB = 1024 ** 3;

// ── Input domain: null, NaN, ±Inf, negative, non-integer, zero capacity,
//    free>capacity, MAX_SAFE boundaries, floor/reserve boundaries, etc. ──
const BYTE_VALUES: Array<number | null> = [
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -1 * GIB,
  0,
  1,
  1.5, // non-integer → still a valid byte magnitude
  5 * GIB, // reserve==5 GiB boundary (for 100 GiB capacity)
  10 * GIB - 1,
  10 * GIB, // floor abs boundary; reserve==10 GiB boundary (for 200 GiB capacity)
  20 * GIB, // 10% floor boundary (for 200 GiB capacity)
  50 * GIB,
  100 * GIB,
  200 * GIB,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1, // just past the exact-integer range → invalid
];

const GROWTH_VALUES: Array<number | null | undefined> = [
  undefined,
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  0, // measured no-growth (KNOWN)
  1,
  1024,
  1 * GIB,
  10 * GIB,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE, // sub-normal rate → free/rate overflow → unobservable
];

// Smaller 4-D subset for the large-write grid (the seeded random sample covers the rest).
const LW_BYTE: Array<number | null> = [
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -1,
  0,
  5 * GIB,
  10 * GIB,
  100 * GIB,
  200 * GIB,
  Number.MAX_SAFE_INTEGER,
];

function eqNullableNum(a: number | null | undefined, b: number | null): boolean {
  if (a === null || a === undefined) return b === null;
  if (b === null) return false;
  return Object.is(a, b);
}
function eqNullableBool(a: boolean | null | undefined, b: boolean | null): boolean {
  if (a === null || a === undefined) return b === null;
  return a === b;
}

function diffDiskGrowth(free: number | null, capacity: number | null, growth: number | null | undefined): string[] {
  const prod = classifyDiskGrowth({ freeBytes: free, totalCapacityBytes: capacity, growthRateBytesPerDay: growth });
  const orc = oracleClassifyDiskGrowth(free, capacity, growth);
  const p: string[] = [];
  if (prod.status !== orc.status) p.push(`status prod=${prod.status} oracle=${orc.status}`);
  if ((prod.status === "ok") !== orc.healthy) p.push(`healthy prod=${prod.status === "ok"} oracle=${orc.healthy}`);
  if ((prod.failClosed ?? false) !== orc.failClosed) p.push(`failClosed prod=${prod.failClosed ?? false} oracle=${orc.failClosed}`);
  if (!eqNullableBool(prod.belowFloor, orc.belowFloor)) p.push(`belowFloor prod=${prod.belowFloor} oracle=${orc.belowFloor}`);
  if (!eqNullableNum(prod.projectedExhaustionDays, orc.projectedExhaustionDays)) {
    p.push(`projectedDays prod=${prod.projectedExhaustionDays} oracle=${orc.projectedExhaustionDays}`);
  }
  if (!eqNullableBool(prod.withinExhaustionWindow, orc.withinExhaustionWindow)) {
    p.push(`within prod=${prod.withinExhaustionWindow} oracle=${orc.withinExhaustionWindow}`);
  }
  return p;
}

function diffLargeWrite(
  cf: number | null,
  cap: number | null,
  peak: number | null,
  growth: number | null,
  isEscape: boolean,
): string[] {
  const prod = evaluateLargeWriteSafety({
    currentFreeBytes: cf,
    totalCapacityBytes: cap,
    estimatedPeakTempBytes: peak,
    estimatedPersistentGrowthBytes: growth,
    isEscapeOperation: isEscape,
  });
  const orc = oracleEvaluateLargeWrite(cf, cap, peak, growth, isEscape);
  const p: string[] = [];
  if (prod.safe !== orc.safe) p.push(`safe prod=${prod.safe} oracle=${orc.safe}`);
  if ((prod.failClosed ?? false) !== orc.failClosed) p.push(`failClosed prod=${prod.failClosed ?? false} oracle=${orc.failClosed}`);
  if ((prod.escapeOperation ?? false) !== orc.escapeOperation) {
    p.push(`escape prod=${prod.escapeOperation ?? false} oracle=${orc.escapeOperation}`);
  }
  if (!eqNullableNum(prod.reserveBytes, orc.reserveBytes)) p.push(`reserve prod=${prod.reserveBytes} oracle=${orc.reserveBytes}`);
  if (!eqNullableNum(prod.projectedFreeBytes, orc.projectedFreeBytes)) {
    p.push(`projFree prod=${prod.projectedFreeBytes} oracle=${orc.projectedFreeBytes}`);
  }
  return p;
}

// Deterministic LCG (fixed seed list) — reproducible, never Math.random().
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function randByte(rng: () => number): number | null {
  const r = rng();
  if (r < 0.18) return pick(rng, BYTE_VALUES); // special/degenerate values
  if (r < 0.22) return null;
  return Math.floor(rng() * 300 * GIB); // 0 .. 300 GiB continuous
}

describe("U13 disk-growth: production == independent oracle over the full input domain", () => {
  it("grid free × capacity × growth agrees on every decision field", () => {
    const mismatches: string[] = [];
    let count = 0;
    for (const free of BYTE_VALUES) {
      for (const capacity of BYTE_VALUES) {
        for (const growth of GROWTH_VALUES) {
          count++;
          const p = diffDiskGrowth(free, capacity, growth);
          if (p.length) mismatches.push(`[free=${free} cap=${capacity} growth=${growth}] ${p.join("; ")}`);
        }
      }
    }
    expect(count).toBeGreaterThan(4000);
    expect(mismatches.slice(0, 12), `${mismatches.length} mismatches`).toEqual([]);
  });

  it("seeded random sample (multiple seeds) agrees on every decision field", () => {
    const mismatches: string[] = [];
    for (const seed of [1, 7, 42, 1337, 99991]) {
      const rng = makeRng(seed);
      for (let i = 0; i < 2000; i++) {
        const free = randByte(rng);
        const capacity = randByte(rng);
        const growth = rng() < 0.3 ? pick(rng, GROWTH_VALUES) : Math.floor(rng() * 50 * GIB);
        const p = diffDiskGrowth(free, capacity, growth);
        if (p.length) mismatches.push(`seed=${seed} [free=${free} cap=${capacity} growth=${growth}] ${p.join("; ")}`);
      }
    }
    expect(mismatches.slice(0, 12), `${mismatches.length} mismatches`).toEqual([]);
  });

  it("7-day exhaustion boundary agrees: ==7d → warn, just past 7d → ok", () => {
    const capacity = 5 * 1024 * GIB; // floor = 512 GiB
    const free = 700 * GIB; // above floor → only the exhaustion branch decides
    for (const [rate, label] of [
      [free / 7, "==7d"],
      [free / 7.0001, "just-past-7d"],
    ] as const) {
      expect(diffDiskGrowth(free, capacity, rate), label).toEqual([]);
      const prod = classifyDiskGrowth({ freeBytes: free, totalCapacityBytes: capacity, growthRateBytesPerDay: rate });
      expect(prod.status, label).toBe(label === "==7d" ? "warn" : "ok");
    }
  });
});

describe("U13 large-write: production == independent oracle over the full input domain", () => {
  it("grid current_free × capacity × peak × growth × escape agrees on every decision field", () => {
    const mismatches: string[] = [];
    let count = 0;
    for (const cf of LW_BYTE) {
      for (const cap of LW_BYTE) {
        for (const peak of LW_BYTE) {
          for (const growth of LW_BYTE) {
            for (const isEscape of [false, true]) {
              count++;
              const p = diffLargeWrite(cf, cap, peak, growth, isEscape);
              if (p.length) {
                mismatches.push(`[cf=${cf} cap=${cap} peak=${peak} growth=${growth} escape=${isEscape}] ${p.join("; ")}`);
              }
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThan(10000);
    expect(mismatches.slice(0, 12), `${mismatches.length} mismatches`).toEqual([]);
  });

  it("seeded random sample (multiple seeds) agrees on every decision field", () => {
    const mismatches: string[] = [];
    for (const seed of [2, 11, 43, 2024, 88888]) {
      const rng = makeRng(seed);
      for (let i = 0; i < 2000; i++) {
        const cf = randByte(rng);
        const cap = randByte(rng);
        const peak = randByte(rng);
        const growth = randByte(rng);
        const isEscape = rng() < 0.25;
        const p = diffLargeWrite(cf, cap, peak, growth, isEscape);
        if (p.length) {
          mismatches.push(`seed=${seed} [cf=${cf} cap=${cap} peak=${peak} growth=${growth} escape=${isEscape}] ${p.join("; ")}`);
        }
      }
    }
    expect(mismatches.slice(0, 12), `${mismatches.length} mismatches`).toEqual([]);
  });
});

describe("Advisor round-4 counterexamples (large-write relationship validity) — RED before fix", () => {
  it("CE-A: capacity 0 / current_free 10 GiB (non-escape) → UNSAFE, fail-closed (impossible reading)", () => {
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 10 * GIB,
      totalCapacityBytes: 0,
      estimatedPeakTempBytes: 0,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(v.safe).toBe(false);
    expect(v.failClosed).toBe(true);
    expect(oracleEvaluateLargeWrite(10 * GIB, 0, 0, 0, false).safe).toBe(false);
    // …but an ESCAPE op with the same impossible reading is still available.
    expect(
      evaluateLargeWriteSafety({
        currentFreeBytes: 10 * GIB,
        totalCapacityBytes: 0,
        estimatedPeakTempBytes: 0,
        estimatedPersistentGrowthBytes: 0,
        isEscapeOperation: true,
      }).safe,
    ).toBe(true);
  });

  it("CE-B: capacity 100 GiB / current_free 200 GiB (non-escape) → UNSAFE, fail-closed (current_free>capacity)", () => {
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 200 * GIB,
      totalCapacityBytes: 100 * GIB,
      estimatedPeakTempBytes: 0,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(v.safe).toBe(false);
    expect(v.failClosed).toBe(true);
    expect(oracleEvaluateLargeWrite(200 * GIB, 100 * GIB, 0, 0, false).safe).toBe(false);
  });
});
