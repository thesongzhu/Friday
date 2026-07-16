import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FRIDAY_DISK_GROWTH_THRESHOLDS,
  FRIDAY_LARGE_WRITE_OVERHEAD,
  classifyDiskGrowth,
  evaluateLargeWriteSafety,
} from "../../../../src/learning/services/friday-disk-growth-evaluator.js";

/**
 * RETENTION-R3b — PURE disk-growth WARNING + large-write evaluator formulas.
 *
 * These are the two named formulas the DATA-RETENTION-001 acceptance oracle
 * requires: "Implement exact warning and large-write evaluator formulas with
 * overflow/unknown fail-closed; disk pressure never auto-deletes and escape
 * operations remain usable."
 *
 * Each negative control from the oracle's `:negative` clause is its own RED-first
 * test:
 *   - boolean-only peak flag            → status is a magnitude-derived ENUM, verdict carries numeric estimates
 *   - current-free-only check           → a write that fits raw free bytes is UNSAFE once overhead is added
 *   - integer overflow                  → checked-add trips → unknown / unsafe (never wraps to ok/safe)
 *   - omitted WAL/COW/…/rollback estimate → overhead is an explicit named sum, surfaced numerically
 *   - disabled export/delete            → an escape operation is ALWAYS usable
 *   - silent purge/corruption           → the module is structurally incapable of IO/deletion
 */
describe("friday-disk-growth-evaluator — classifyDiskGrowth (warning formula)", () => {
  const GB = 1_000_000_000;

  // A healthy baseline: tiny DB, plenty of free space.
  function healthyInput(over: Partial<Parameters<typeof classifyDiskGrowth>[0]> = {}) {
    return {
      totalDbBytes: 10_000_000, // 10 MB
      realtimeEventsEstimatedBytes: 1_000_000,
      freeBytes: 500 * GB,
      totalDiskBytes: 1000 * GB, // 50% free
      ...over,
    };
  }

  it("SILENT by default: a small DB with healthy free space → ok, empty reasons (never cries wolf)", () => {
    const out = classifyDiskGrowth(healthyInput());
    expect(out.status).toBe("ok");
    expect(out.reasons).toEqual([]);
    expect(out.failClosed).toBeUndefined();
    // Status is an enum, not a boolean.
    expect(typeof out.status).toBe("string");
  });

  it("warn fires when total DB bytes cross the warn ceiling (magnitude enum, not a boolean flag)", () => {
    const out = classifyDiskGrowth(
      healthyInput({ totalDbBytes: FRIDAY_DISK_GROWTH_THRESHOLDS.warnTotalBytes + 1 }),
    );
    expect(out.status).toBe("warn");
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it("critical fires when total DB bytes cross the critical ceiling", () => {
    const out = classifyDiskGrowth(
      healthyInput({ totalDbBytes: FRIDAY_DISK_GROWTH_THRESHOLDS.criticalTotalBytes + 1 }),
    );
    expect(out.status).toBe("critical");
  });

  it("free-space FRACTION is a real signal (not a boolean): low free-fraction warns/criticals", () => {
    // 12% free → below warn 15%, above critical 5% → warn.
    const warnOut = classifyDiskGrowth(
      healthyInput({ freeBytes: 120 * GB, totalDiskBytes: 1000 * GB }),
    );
    expect(warnOut.status).toBe("warn");
    expect(warnOut.freeFraction).toBeCloseTo(0.12, 5);

    // 3% free → below critical 5% → critical.
    const critOut = classifyDiskGrowth(
      healthyInput({ freeBytes: 30 * GB, totalDiskBytes: 1000 * GB }),
    );
    expect(critOut.status).toBe("critical");
  });

  it("worst-of: a healthy byte signal with a critical free-fraction → critical", () => {
    const out = classifyDiskGrowth(
      healthyInput({ totalDbBytes: 10_000_000, freeBytes: 10 * GB, totalDiskBytes: 1000 * GB }),
    );
    expect(out.status).toBe("critical");
  });

  it("overflow/unknown FAIL-CLOSED: NaN totalDbBytes → unknown (never ok), enum not boolean", () => {
    const out = classifyDiskGrowth(healthyInput({ totalDbBytes: Number.NaN }));
    expect(out.status).toBe("unknown");
    expect(out.status).not.toBe("ok");
    expect(out.failClosed).toBe(true);
  });

  it("overflow/unknown FAIL-CLOSED: Infinity → unknown", () => {
    const out = classifyDiskGrowth(healthyInput({ totalDbBytes: Number.POSITIVE_INFINITY }));
    expect(out.status).toBe("unknown");
    expect(out.failClosed).toBe(true);
  });

  it("overflow/unknown FAIL-CLOSED: negative bytes → unknown", () => {
    const out = classifyDiskGrowth(healthyInput({ totalDbBytes: -1 }));
    expect(out.status).toBe("unknown");
    expect(out.failClosed).toBe(true);
  });

  it("overflow FAIL-CLOSED: a value beyond MAX_SAFE_INTEGER → unknown (never silently ok)", () => {
    const out = classifyDiskGrowth(healthyInput({ totalDbBytes: Number.MAX_SAFE_INTEGER + 1 }));
    expect(out.status).toBe("unknown");
    expect(out.failClosed).toBe(true);
  });

  it("unresolved probe FAIL-CLOSED: freeBytes:null → unknown (never ok)", () => {
    const out = classifyDiskGrowth(healthyInput({ freeBytes: null, totalDiskBytes: null }));
    expect(out.status).toBe("unknown");
    expect(out.status).not.toBe("ok");
    expect(out.failClosed).toBe(true);
  });

  it("inconsistent reading FAIL-CLOSED: free > capacity → unknown", () => {
    const out = classifyDiskGrowth(healthyInput({ freeBytes: 2000 * GB, totalDiskBytes: 1000 * GB }));
    expect(out.status).toBe("unknown");
    expect(out.failClosed).toBe(true);
  });
});

describe("friday-disk-growth-evaluator — evaluateLargeWriteSafety (large-write formula)", () => {
  const MB = 1_000_000;

  it("carries NUMERIC estimates (not a bare boolean): required/overhead/shortfall present", () => {
    const v = evaluateLargeWriteSafety({ projectedWriteBytes: 100 * MB, freeBytes: 10_000 * MB });
    expect(typeof v.requiredBytes).toBe("number");
    expect(typeof v.overheadBytes).toBe("number");
    expect(v.overheadBytes! > 0).toBe(true);
    expect(typeof v.shortfallBytes).toBe("number");
    expect(v.safe).toBe(true);
  });

  it("overhead is an EXPLICIT named sum of WAL/rollback/COW-backup-archive/partial-margin", () => {
    const projected = 100 * MB;
    const v = evaluateLargeWriteSafety({ projectedWriteBytes: projected, freeBytes: 10_000 * MB });
    const o = FRIDAY_LARGE_WRITE_OVERHEAD;
    const expectedOverhead =
      Math.ceil(projected * o.walHeadroomFraction) +
      Math.ceil(projected * o.rollbackJournalHeadroomFraction) +
      Math.ceil(projected * o.cowBackupArchiveFraction) +
      o.partialWriteSafetyMarginBytes;
    expect(v.overheadBytes).toBe(expectedOverhead);
    expect(v.requiredBytes).toBe(projected + expectedOverhead);
  });

  it("CURRENT-FREE-ONLY would pass, but overhead makes it UNSAFE (kills current-free-only + omitted-overhead)", () => {
    // projected 100MB fits raw free 130MB; but projected + overhead (>130MB) does not.
    const v = evaluateLargeWriteSafety({ projectedWriteBytes: 100 * MB, freeBytes: 130 * MB });
    expect(v.safe).toBe(false);
    expect(v.shortfallBytes! > 0).toBe(true);
    // A naive current-free-only check would have said "fits".
    expect(v.projectedBytes! <= v.freeBytes!).toBe(true);
  });

  it("integer overflow FAIL-CLOSED: projected near MAX_SAFE_INTEGER → unsafe (never wraps to safe)", () => {
    const v = evaluateLargeWriteSafety({
      projectedWriteBytes: Number.MAX_SAFE_INTEGER - 10,
      freeBytes: 1_000,
    });
    expect(v.safe).toBe(false);
    expect(v.failClosed).toBe(true);
  });

  it("unknown free space FAIL-CLOSED: freeBytes:null → unsafe", () => {
    const v = evaluateLargeWriteSafety({ projectedWriteBytes: 1 * MB, freeBytes: null });
    expect(v.safe).toBe(false);
    expect(v.failClosed).toBe(true);
  });

  it("NaN/negative projected FAIL-CLOSED: → unsafe (non-escape)", () => {
    expect(evaluateLargeWriteSafety({ projectedWriteBytes: Number.NaN, freeBytes: 10 * MB }).safe).toBe(false);
    expect(evaluateLargeWriteSafety({ projectedWriteBytes: -1, freeBytes: 10 * MB }).safe).toBe(false);
  });

  it("ESCAPE operation is ALWAYS usable even under severe pressure (kills disabled export/delete)", () => {
    const v = evaluateLargeWriteSafety({
      projectedWriteBytes: 10_000 * MB,
      freeBytes: 1, // effectively no space
      isEscapeOperation: true,
    });
    expect(v.safe).toBe(true);
    expect(v.escapeOperation).toBe(true);
    // Still reports the estimate rather than hiding it.
    expect(typeof v.requiredBytes).toBe("number");
  });

  it("ESCAPE operation is usable even when free space is unknown", () => {
    const v = evaluateLargeWriteSafety({
      projectedWriteBytes: 10_000 * MB,
      freeBytes: null,
      isEscapeOperation: true,
    });
    expect(v.safe).toBe(true);
    expect(v.escapeOperation).toBe(true);
  });
});

describe("friday-disk-growth-evaluator — ZERO deletion / no side effects (structural)", () => {
  it("the evaluator module imports NO fs / DB / child_process and contains no DELETE/write verbs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const modPath = resolve(
      here,
      "../../../../src/learning/services/friday-disk-growth-evaluator.ts",
    );
    const src = readFileSync(modPath, "utf8");
    // No IO / DB / process-spawning imports.
    expect(src).not.toMatch(/from\s+["']node:fs["']/);
    expect(src).not.toMatch(/from\s+["']fs["']/);
    expect(src).not.toMatch(/from\s+["']node:child_process["']/);
    expect(src).not.toMatch(/require\(\s*["'](node:)?fs["']\s*\)/);
    // No DB handle / SQL deletion verbs.
    expect(src).not.toMatch(/withWriteTransaction|withReadConnection|\.prepare\(/);
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|incremental_vacuum/);
  });
});
