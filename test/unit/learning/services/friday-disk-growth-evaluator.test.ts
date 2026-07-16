import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FRIDAY_STORAGE_PRESSURE_AUTHORITY,
  classifyDiskGrowth,
  evaluateLargeWriteSafety,
} from "../../../../src/learning/services/friday-disk-growth-evaluator.js";

/**
 * RETENTION-R3b — PURE storage-pressure formulas bound to the OPERATOR-LOCKED
 * decision U13-STORAGE-PRESSURE:
 *
 *   "Warn when free space is below max(10 GiB,10%) or projected exhaustion is
 *    within 7 days. For large writes compute reserve=max(5 GiB,5% capacity) and
 *    projected_free=current_free-estimated_peak_temp-estimated_persistent_growth;
 *    pause when current or projected free is below reserve, and fail closed on
 *    unknown/overflow estimates. Reads, search, streaming export, settings,
 *    diagnostics and all deletion remain available. Never auto-delete or corrupt
 *    data."
 *
 * Includes the two advisor counterexamples the pre-fix code got wrong.
 */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe("classifyDiskGrowth — U13 warning formula", () => {
  it("CE1 (advisor): 9 GiB free on a 50 GiB volume → WARN (below the absolute 10 GiB floor)", () => {
    const out = classifyDiskGrowth({ freeBytes: 9 * GiB, totalCapacityBytes: 50 * GiB });
    expect(out.status).toBe("warn");
    expect(out.belowFloor).toBe(true);
    expect(out.freeSpaceFloorBytes).toBe(10 * GiB); // max(10 GiB, 10%×50 GiB=5 GiB) = 10 GiB
  });

  it("boundary: free == 10 GiB floor on a 50 GiB volume → ok (below is strict <)", () => {
    const out = classifyDiskGrowth({ freeBytes: 10 * GiB, totalCapacityBytes: 50 * GiB });
    expect(out.status).toBe("ok");
    expect(out.belowFloor).toBe(false);
    const justBelow = classifyDiskGrowth({ freeBytes: 10 * GiB - 1, totalCapacityBytes: 50 * GiB });
    expect(justBelow.status).toBe("warn");
  });

  it("boundary: 10% branch dominates on a large volume — free == 10% → ok, just below → warn", () => {
    // 200 GiB capacity → floor = max(10 GiB, 20 GiB) = 20 GiB.
    const floor = 20 * GiB;
    const at = classifyDiskGrowth({ freeBytes: floor, totalCapacityBytes: 200 * GiB });
    expect(at.freeSpaceFloorBytes).toBe(floor);
    expect(at.status).toBe("ok");
    const below = classifyDiskGrowth({ freeBytes: floor - 1, totalCapacityBytes: 200 * GiB });
    expect(below.status).toBe("warn");
  });

  it("healthy: free well above both floors, growth unknown → ok", () => {
    const out = classifyDiskGrowth({ freeBytes: 500 * GiB, totalCapacityBytes: 1000 * GiB });
    expect(out.status).toBe("ok");
    expect(out.belowFloor).toBe(false);
    expect(out.growthBranch).toBe("unknown");
  });

  it("projected-exhaustion boundary: == 7 days → warn; just over 7 → ok (floor otherwise satisfied)", () => {
    // 5 TiB capacity → floor = max(10 GiB, 512 GiB) = 512 GiB. free 700 GiB is above it,
    // so ONLY the exhaustion branch can warn.
    const capacity = 5 * 1024 * GiB; // 5 TiB
    const free = 700 * GiB;
    const at = classifyDiskGrowth({
      freeBytes: free,
      totalCapacityBytes: capacity,
      growthRateBytesPerDay: free / 7,
    });
    expect(at.belowFloor).toBe(false);
    expect(at.withinExhaustionWindow).toBe(true);
    expect(at.status).toBe("warn");

    const over = classifyDiskGrowth({
      freeBytes: free,
      totalCapacityBytes: capacity,
      growthRateBytesPerDay: free / 7.001,
    });
    expect(over.withinExhaustionWindow).toBe(false);
    expect(over.status).toBe("ok");
  });

  it("growth branch unknown does NOT force unknown: floor still governs (ok when above floor)", () => {
    const out = classifyDiskGrowth({
      freeBytes: 800 * GiB,
      totalCapacityBytes: 1000 * GiB,
      growthRateBytesPerDay: null,
    });
    expect(out.status).toBe("ok");
    expect(out.growthBranch).toBe("unknown");
  });

  it("zero/negative growth never exhausts → not a warning by the exhaustion branch", () => {
    const zero = classifyDiskGrowth({ freeBytes: 800 * GiB, totalCapacityBytes: 1000 * GiB, growthRateBytesPerDay: 0 });
    expect(zero.withinExhaustionWindow).toBe(false);
    expect(zero.status).toBe("ok");
  });

  it("FAIL-CLOSED (free space itself): null / NaN / overflow / inconsistent → unknown, never ok", () => {
    expect(classifyDiskGrowth({ freeBytes: null, totalCapacityBytes: 1000 * GiB }).status).toBe("unknown");
    expect(classifyDiskGrowth({ freeBytes: Number.NaN, totalCapacityBytes: 1000 * GiB }).status).toBe("unknown");
    expect(classifyDiskGrowth({ freeBytes: 9 * GiB, totalCapacityBytes: null }).status).toBe("unknown");
    expect(
      classifyDiskGrowth({ freeBytes: Number.MAX_SAFE_INTEGER + 1, totalCapacityBytes: 1000 * GiB }).status,
    ).toBe("unknown");
    const inconsistent = classifyDiskGrowth({ freeBytes: 2000 * GiB, totalCapacityBytes: 1000 * GiB });
    expect(inconsistent.status).toBe("unknown");
    expect(inconsistent.failClosed).toBe(true);
    expect(inconsistent.status).not.toBe("ok");
  });

  it("NON-authoritative diagnostics NEVER override the locked result", () => {
    // A huge DB size must NOT turn a healthy (above-floor, no-exhaustion) reading into a warning.
    const out = classifyDiskGrowth({
      freeBytes: 800 * GiB,
      totalCapacityBytes: 1000 * GiB,
      growthRateBytesPerDay: 0,
      diagnostics: { totalDbBytes: 500 * GiB, realtimeEventsEstimatedBytes: 400 * GiB },
    });
    expect(out.status).toBe("ok");
    expect(out.diagnostics?.totalDbBytes).toBe(500 * GiB);
  });

  it("status is a magnitude enum, not a boolean; carries the locked authority reference", () => {
    const out = classifyDiskGrowth({ freeBytes: 9 * GiB, totalCapacityBytes: 50 * GiB });
    expect(["ok", "warn", "unknown"]).toContain(out.status);
    expect(out.authority.decision).toBe("U13-STORAGE-PRESSURE");
    expect(out.authority.authority).toBe("operator_locked");
    expect(FRIDAY_STORAGE_PRESSURE_AUTHORITY.freeSpaceFloorBytes).toBe(10 * GiB);
  });
});

describe("evaluateLargeWriteSafety — U13 large-write formula", () => {
  it("CE2 (advisor): 1 MiB write, 40 GiB free on a 1 TiB volume → PAUSE (40 < reserve max(5 GiB,5%)=51.2 GiB)", () => {
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 40 * GiB,
      totalCapacityBytes: 1024 * GiB, // 1 TiB
      estimatedPeakTempBytes: 1 * MiB,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(v.safe).toBe(false);
    expect(v.reserveBytes).toBe(Math.floor(1024 * GiB * 0.05)); // ≈ 51.2 GiB
    expect(v.currentFreeBytes! < v.reserveBytes!).toBe(true);
  });

  it("reserve boundary: current_free == reserve → safe; just below → PAUSE", () => {
    // 200 GiB capacity → reserve = max(5 GiB, 10 GiB) = 10 GiB.
    const reserve = 10 * GiB;
    const at = evaluateLargeWriteSafety({
      currentFreeBytes: reserve,
      totalCapacityBytes: 200 * GiB,
      estimatedPeakTempBytes: 0,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(at.reserveBytes).toBe(reserve);
    expect(at.safe).toBe(true);
    const below = evaluateLargeWriteSafety({
      currentFreeBytes: reserve - 1,
      totalCapacityBytes: 200 * GiB,
      estimatedPeakTempBytes: 0,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(below.safe).toBe(false);
  });

  it("PAUSE when projected_free < reserve even though current_free >= reserve", () => {
    // reserve 10 GiB; current 12 GiB (>= reserve) but peak 5 GiB → projected 7 GiB < 10 GiB.
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 12 * GiB,
      totalCapacityBytes: 200 * GiB,
      estimatedPeakTempBytes: 5 * GiB,
      estimatedPersistentGrowthBytes: 0,
    });
    expect(v.currentFreeBytes! >= v.reserveBytes!).toBe(true);
    expect(v.projectedFreeBytes).toBe(7 * GiB);
    expect(v.safe).toBe(false);
    expect(v.reason).toContain("projected_free");
  });

  it("safe when both current and projected free are at/above reserve; carries numeric estimates", () => {
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 500 * GiB,
      totalCapacityBytes: 1000 * GiB,
      estimatedPeakTempBytes: 2 * GiB,
      estimatedPersistentGrowthBytes: 1 * GiB,
    });
    expect(v.safe).toBe(true);
    expect(typeof v.reserveBytes).toBe("number");
    expect(v.projectedFreeBytes).toBe(500 * GiB - 3 * GiB);
  });

  it("FAIL-CLOSED: unknown free/capacity/peak/growth → unsafe (non-escape)", () => {
    expect(
      evaluateLargeWriteSafety({
        currentFreeBytes: null,
        totalCapacityBytes: 1000 * GiB,
        estimatedPeakTempBytes: 0,
        estimatedPersistentGrowthBytes: 0,
      }),
    ).toMatchObject({ safe: false, failClosed: true });
    expect(
      evaluateLargeWriteSafety({
        currentFreeBytes: 500 * GiB,
        totalCapacityBytes: 1000 * GiB,
        estimatedPeakTempBytes: null,
        estimatedPersistentGrowthBytes: 0,
      }),
    ).toMatchObject({ safe: false, failClosed: true });
  });

  it("FAIL-CLOSED: overflow computing projected_free → unsafe (never wraps to safe)", () => {
    const v = evaluateLargeWriteSafety({
      currentFreeBytes: 1000,
      totalCapacityBytes: 1000 * GiB,
      estimatedPeakTempBytes: Number.MAX_SAFE_INTEGER - 5,
      estimatedPersistentGrowthBytes: Number.MAX_SAFE_INTEGER - 5,
    });
    expect(v.safe).toBe(false);
    expect(v.failClosed).toBe(true);
  });

  it("ESCAPE op always available even under severe pressure / unknown free (never blocked)", () => {
    const severe = evaluateLargeWriteSafety({
      currentFreeBytes: 1,
      totalCapacityBytes: 1000 * GiB,
      estimatedPeakTempBytes: 900 * GiB,
      estimatedPersistentGrowthBytes: 100 * GiB,
      isEscapeOperation: true,
    });
    expect(severe.safe).toBe(true);
    expect(severe.escapeOperation).toBe(true);
    expect(typeof severe.reserveBytes).toBe("number");

    const unknownFree = evaluateLargeWriteSafety({
      currentFreeBytes: null,
      totalCapacityBytes: null,
      estimatedPeakTempBytes: null,
      estimatedPersistentGrowthBytes: null,
      isEscapeOperation: true,
    });
    expect(unknownFree.safe).toBe(true);
    expect(unknownFree.escapeOperation).toBe(true);
  });
});

describe("friday-disk-growth-evaluator — ZERO deletion / no side effects (structural)", () => {
  it("the evaluator module imports NO fs / DB / child_process and contains no DELETE/write verbs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const modPath = resolve(here, "../../../../src/learning/services/friday-disk-growth-evaluator.ts");
    const src = readFileSync(modPath, "utf8");
    expect(src).not.toMatch(/from\s+["']node:fs["']/);
    expect(src).not.toMatch(/from\s+["']fs["']/);
    expect(src).not.toMatch(/from\s+["']node:child_process["']/);
    expect(src).not.toMatch(/require\(\s*["'](node:)?fs["']\s*\)/);
    expect(src).not.toMatch(/withWriteTransaction|withReadConnection|\.prepare\(/);
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|incremental_vacuum/);
  });
});
