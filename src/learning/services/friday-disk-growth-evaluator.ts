/**
 * RETENTION-R3b — PURE storage-pressure warning + large-write evaluator formulas.
 *
 * The binding formulas are the OPERATOR-LOCKED decision **U13-STORAGE-PRESSURE**
 * (authority: operator_locked), verbatim:
 *
 *   "Warn when free space is below max(10 GiB,10%) or projected exhaustion is
 *    within 7 days. For large writes compute reserve=max(5 GiB,5% capacity) and
 *    projected_free=current_free-estimated_peak_temp-estimated_persistent_growth;
 *    pause when current or projected free is below reserve, and fail closed on
 *    unknown/overflow estimates. Reads, search, streaming export, settings,
 *    diagnostics and all deletion remain available. Never auto-delete or corrupt
 *    data."
 *
 * This module is DELIBERATELY PURE: no `fs`, no DB handle, no IO, no process
 * spawning. It only labels observed magnitudes — being pure it is STRUCTURALLY
 * incapable of pruning/vacuuming/removing data (the DATA-RETENTION-001 report-only,
 * zero-deletion posture). "pause" is computed as a VERDICT; it is not wired as a
 * blocking gate at any write site in this slice, so escape operations are
 * structurally never blockable by it.
 *
 * Non-authoritative diagnostics (DB size, realtime-stream estimate) may be carried
 * for the UI, but they NEVER override the locked result — status is derived ONLY
 * from the U13 formula.
 */

const GIB = 1024 ** 3;

// ─── Operator-locked authority (U13-STORAGE-PRESSURE) ───

/**
 * The exact operator-locked thresholds. These REPLACE the earlier ad-hoc DB-size
 * (1 GB/4 GB) and free-fraction (15%/5%) heuristics — those were non-authoritative
 * prose and must never drive or override this locked result.
 */
export const FRIDAY_STORAGE_PRESSURE_AUTHORITY = {
  decision: "U13-STORAGE-PRESSURE",
  authority: "operator_locked",
  /** Warn when free space is below max(10 GiB, 10% of capacity). */
  freeSpaceFloorBytes: 10 * GIB,
  freeSpaceFloorFraction: 0.1,
  /** ...OR when projected exhaustion is within 7 days. */
  projectedExhaustionWarnDays: 7,
  /** Large-write reserve = max(5 GiB, 5% of capacity). */
  largeWriteReserveBytes: 5 * GIB,
  largeWriteReserveFraction: 0.05,
} as const;

// ─── Types ───

export type FridayDiskGrowthStatus = "ok" | "warn" | "unknown";

export interface FridayDiskGrowthDiagnostics {
  /** Report-only local SQLite size (`page_count × page_size`). NON-authoritative. */
  totalDbBytes?: number;
  /** Report-only realtime_events growth estimate. NON-authoritative. */
  realtimeEventsEstimatedBytes?: number;
}

export interface FridayDiskGrowthInput {
  /** Free bytes on the state volume; `null` = unresolved probe → unknown. */
  freeBytes: number | null;
  /** Total capacity of the state volume; `null` = unresolved probe → unknown. */
  totalCapacityBytes: number | null;
  /**
   * AUTHORITATIVE growth rate (bytes/day) for the projected-exhaustion branch.
   * A measured `0` is a KNOWN no-growth estimate (never exhausts → ok). When
   * missing/null/NaN/±Inf/negative/overflow the estimate is UNKNOWN: the
   * projected-exhaustion branch is UNOBSERVABLE, so ABOVE the floor the whole
   * reading FAILS CLOSED to `unknown` (never `ok`/healthy) per U13 — while
   * BELOW the floor the absolute max(10 GiB, 10%) floor still forces `warn`
   * regardless of the growth branch.
   */
  growthRateBytesPerDay?: number | null;
  /** Optional report-only NON-authoritative context; NEVER affects status. */
  diagnostics?: FridayDiskGrowthDiagnostics;
}

export interface FridayDiskGrowthWarning {
  /** Magnitude-derived enum (NEVER a boolean). `unknown` is never treated as `ok`. */
  status: FridayDiskGrowthStatus;
  freeBytes: number | null;
  totalCapacityBytes: number | null;
  freeFraction: number | null;
  /** The computed max(10 GiB, 10% capacity) floor. */
  freeSpaceFloorBytes: number | null;
  belowFloor: boolean | null;
  /** free / growthRate; `null` when the growth branch is unknown or non-exhausting. */
  projectedExhaustionDays: number | null;
  withinExhaustionWindow: boolean;
  growthBranch: "known" | "unknown";
  authority: typeof FRIDAY_STORAGE_PRESSURE_AUTHORITY;
  /** Human-readable reasons for any warn/unknown signal (empty when ok). */
  reasons: string[];
  /** Optional NON-authoritative diagnostics (never affect `status`). */
  diagnostics?: FridayDiskGrowthDiagnostics;
  /**
   * True when the reading fell back to `unknown` (fail-closed): either the
   * FREE-SPACE reading itself was unresolvable/inconsistent, OR the reading was
   * above the floor but the growth-rate estimate was unknown/invalid so the
   * projected-exhaustion branch was unobservable.
   */
  failClosed?: boolean;
}

export interface FridayLargeWriteInput {
  /** Current free bytes. */
  currentFreeBytes: number | null;
  /** Total capacity (drives the reserve). */
  totalCapacityBytes: number | null;
  /** Estimated transient peak temp bytes the write needs. */
  estimatedPeakTempBytes: number | null;
  /** Estimated persistent growth bytes the write commits. */
  estimatedPersistentGrowthBytes: number | null;
  /**
   * When true this is an ESCAPE operation — reads, search, streaming export,
   * settings, diagnostics, and ALL deletion — which must ALWAYS remain available.
   */
  isEscapeOperation?: boolean;
}

export interface FridayLargeWriteVerdict {
  /** `false` = PAUSE. Escape ops are always `true`. */
  safe: boolean;
  reserveBytes: number | null;
  currentFreeBytes: number | null;
  projectedFreeBytes: number | null;
  totalCapacityBytes: number | null;
  estimatedPeakTempBytes: number | null;
  estimatedPersistentGrowthBytes: number | null;
  reason: string;
  /** True when the verdict fell back to unsafe due to unknown/overflow (non-escape). */
  failClosed?: boolean;
  /** True when this verdict is for an escape operation (always available). */
  escapeOperation?: boolean;
}

// ─── Fail-closed helpers ───

/**
 * A finite, non-negative byte count within the exact-integer range. Rejects NaN,
 * ±Infinity, negative, or a magnitude beyond `MAX_SAFE_INTEGER` (where integer
 * arithmetic silently loses precision) — the choke-point defeating the "integer
 * overflow" and "unknown" negative controls.
 */
function isValidByteCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
}

/** Checked addition: `null` on any non-finite/negative term or overflow past MAX_SAFE_INTEGER. */
function checkedAddAll(terms: number[]): number | null {
  let sum = 0;
  for (const term of terms) {
    if (!Number.isFinite(term) || term < 0) return null;
    sum += term;
    if (sum > Number.MAX_SAFE_INTEGER) return null;
  }
  return sum;
}

/** 10% / 5% thresholds computed integer-safe (`Math.floor`) so exact byte boundaries are stable. */
function fractionBytes(capacity: number, fraction: number): number {
  return Math.floor(capacity * fraction);
}

/**
 * Fail-closed disk-growth reading (status `unknown`, never `ok`). Exported so the
 * collector can fail closed on a DB read error too.
 */
export function failClosedDiskGrowth(reason: string): FridayDiskGrowthWarning {
  return {
    status: "unknown",
    freeBytes: null,
    totalCapacityBytes: null,
    freeFraction: null,
    freeSpaceFloorBytes: null,
    belowFloor: null,
    projectedExhaustionDays: null,
    withinExhaustionWindow: false,
    growthBranch: "unknown",
    authority: FRIDAY_STORAGE_PRESSURE_AUTHORITY,
    reasons: [`fail-closed to unknown: ${reason}`],
    failClosed: true,
  };
}

function unknownDiskGrowth(input: FridayDiskGrowthInput, reason: string): FridayDiskGrowthWarning {
  const out = failClosedDiskGrowth(reason);
  out.freeBytes = isValidByteCount(input.freeBytes) ? input.freeBytes : null;
  out.totalCapacityBytes = isValidByteCount(input.totalCapacityBytes) ? input.totalCapacityBytes : null;
  if (input.diagnostics) out.diagnostics = input.diagnostics;
  return out;
}

// ─── U13 warning formula ───

/**
 * The operator-locked disk-growth warning formula. Exact U13 truth table:
 *
 *  1. FREE-SPACE reading invalid (free/capacity null/NaN/±Inf/negative/overflow,
 *     capacity ≤ 0, or free > capacity) → `unknown` (never `ok`).
 *  2. Compute `floor = max(10 GiB, floor(10% capacity))`; `belowFloor = free < floor`.
 *  3. `belowFloor` → `warn` — the absolute floor governs the warn REGARDLESS of the
 *     growth branch (even when the growth estimate is unknown).
 *  4. ABOVE the floor, the 7-day projected-exhaustion branch decides:
 *     a. growth estimate is a KNOWN finite `>= 0`:
 *        - `== 0` (measured no-growth) → never exhausts → `ok`.
 *        - `> 0` → `days = free / rate`; non-finite/overflow → `unknown` (fail-closed);
 *          else `warn` when `days <= 7`, otherwise `ok`.
 *     b. growth estimate is UNKNOWN/invalid (null/undefined/NaN/±Inf/negative/overflow)
 *        → the projected-exhaustion branch is UNOBSERVABLE → U13 FAIL-CLOSED to
 *        `unknown` (never `ok`/healthy). A measured ZERO is KNOWN and must NOT be
 *        collapsed with an unknown/null estimate.
 *
 * `unknown` is never `ok`/healthy — the monitor maps `status !== "ok"` to
 * `healthy=false`, so an unobservable exhaustion branch can never publish a false
 * healthy reading. Performs NO IO and can never delete.
 */
export function classifyDiskGrowth(input: FridayDiskGrowthInput): FridayDiskGrowthWarning {
  const A = FRIDAY_STORAGE_PRESSURE_AUTHORITY;

  // (1) FAIL-CLOSED on the FREE-SPACE reading itself: free + capacity must be
  // resolvable and consistent, else nothing downstream can be trusted → unknown.
  if (!isValidByteCount(input.freeBytes) || !isValidByteCount(input.totalCapacityBytes)) {
    return unknownDiskGrowth(input, "free-space/capacity is null/NaN/overflow/invalid");
  }
  const freeBytes = input.freeBytes;
  const capacity = input.totalCapacityBytes;
  if (capacity <= 0) {
    return unknownDiskGrowth(input, "capacity is zero/invalid");
  }
  if (freeBytes > capacity) {
    return unknownDiskGrowth(input, "inconsistent reading: freeBytes exceeds capacity");
  }

  // (2) Absolute + relative free-space floor = max(10 GiB, 10% capacity).
  const floorBytes = Math.max(A.freeSpaceFloorBytes, fractionBytes(capacity, A.freeSpaceFloorFraction));
  const belowFloor = freeBytes < floorBytes;

  // Is the growth-rate estimate a KNOWN, finite, non-negative magnitude? A measured
  // ZERO (no-growth) is KNOWN; null/undefined/NaN/±Inf/negative/overflow are UNKNOWN
  // and must NOT be treated as a healthy `ok`.
  const rate = input.growthRateBytesPerDay;
  const rateKnown =
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= Number.MAX_SAFE_INTEGER;

  const reasons: string[] = [];
  const base = {
    freeBytes,
    totalCapacityBytes: capacity,
    freeFraction: freeBytes / capacity,
    freeSpaceFloorBytes: floorBytes,
    belowFloor,
    authority: A,
  };
  const withDiagnostics = (out: FridayDiskGrowthWarning): FridayDiskGrowthWarning => {
    if (input.diagnostics) out.diagnostics = input.diagnostics;
    return out;
  };

  // (3) The absolute floor governs the WARN regardless of the growth branch (U13):
  // below-floor is ALWAYS a warn, even when the growth estimate is unknown.
  if (belowFloor) {
    reasons.push(
      `free ${freeBytes} < floor max(${A.freeSpaceFloorBytes}, 10% capacity)=${floorBytes} bytes`,
    );
    return withDiagnostics({
      ...base,
      status: "warn",
      projectedExhaustionDays: null,
      withinExhaustionWindow: false,
      growthBranch: rateKnown ? "known" : "unknown",
      reasons,
    });
  }

  // (4b) ABOVE the floor + UNKNOWN/invalid growth estimate → the projected-exhaustion
  // branch is UNOBSERVABLE → U13 FAIL-CLOSED to `unknown` (never `ok`/healthy). This
  // is the fix: above-floor + null/unknown growth must NOT silently report healthy.
  if (!rateKnown) {
    reasons.push(
      "growth-rate estimate is null/undefined/NaN/±Inf/negative/overflow → projected-exhaustion " +
        "branch UNOBSERVABLE; U13 fail-closed to unknown (never ok/healthy)",
    );
    return withDiagnostics({
      ...base,
      status: "unknown",
      projectedExhaustionDays: null,
      withinExhaustionWindow: false,
      growthBranch: "unknown",
      reasons,
      failClosed: true,
    });
  }

  // (4a) ABOVE the floor + KNOWN finite non-negative growth estimate.
  let projectedExhaustionDays: number | null = null;
  let withinExhaustionWindow = false;
  if ((rate as number) > 0) {
    const days = freeBytes / (rate as number);
    if (!Number.isFinite(days)) {
      // Overflow (e.g. a sub-normal rate) → the estimate is unusable → fail-closed.
      reasons.push("projected exhaustion (free / growth) is not finite → U13 fail-closed to unknown");
      return withDiagnostics({
        ...base,
        status: "unknown",
        projectedExhaustionDays: null,
        withinExhaustionWindow: false,
        growthBranch: "known",
        reasons,
        failClosed: true,
      });
    }
    projectedExhaustionDays = days;
    withinExhaustionWindow = days <= A.projectedExhaustionWarnDays;
    if (withinExhaustionWindow) {
      reasons.push(
        `projected exhaustion ${days.toFixed(2)}d <= ${A.projectedExhaustionWarnDays}d ` +
          `(free ${freeBytes} / growth ${rate as number} B/day)`,
      );
    }
  }
  // rate === 0 → measured no-growth → never exhausts → ok.

  const status: FridayDiskGrowthStatus = withinExhaustionWindow ? "warn" : "ok";
  return withDiagnostics({
    ...base,
    status,
    projectedExhaustionDays,
    withinExhaustionWindow,
    growthBranch: "known",
    reasons,
  });
}

// ─── U13 large-write formula (formula only; NOT wired as a gate) ───

function failClosedWrite(
  reason: string,
  partial: Omit<FridayLargeWriteVerdict, "safe" | "reason" | "failClosed" | "escapeOperation">,
): FridayLargeWriteVerdict {
  return {
    safe: false,
    ...partial,
    reason: `fail-closed to unsafe: ${reason}`,
    failClosed: true,
  };
}

/**
 * The operator-locked large-write space-safety evaluator. reserve = max(5 GiB, 5%
 * capacity); projected_free = current_free − estimated_peak_temp −
 * estimated_persistent_growth (CHECKED arithmetic). PAUSE (unsafe) when current OR
 * projected free is below reserve. Fails closed to unsafe on any unknown/overflow
 * estimate. ESCAPE operations (reads/search/streaming export/settings/diagnostics/
 * deletion) are ALWAYS `safe:true` — never blocked — while still reporting the
 * estimate. Pure formula plus tests; NOT wired as a pre-flight gate at any write
 * site in this slice.
 */
export function evaluateLargeWriteSafety(input: FridayLargeWriteInput): FridayLargeWriteVerdict {
  const A = FRIDAY_STORAGE_PRESSURE_AUTHORITY;
  const isEscape = input.isEscapeOperation === true;

  const capacityValid = isValidByteCount(input.totalCapacityBytes);
  const capacity = capacityValid ? input.totalCapacityBytes : null;
  const reserveBytes =
    capacity === null ? null : Math.max(A.largeWriteReserveBytes, fractionBytes(capacity, A.largeWriteReserveFraction));

  const currentValid = isValidByteCount(input.currentFreeBytes);
  const currentFree = currentValid ? input.currentFreeBytes : null;
  const peakValid = isValidByteCount(input.estimatedPeakTempBytes);
  const peakTemp = peakValid ? input.estimatedPeakTempBytes : null;
  const growthValid = isValidByteCount(input.estimatedPersistentGrowthBytes);
  const persistentGrowth = growthValid ? input.estimatedPersistentGrowthBytes : null;

  // projected_free = current_free − peak_temp − persistent_growth (checked).
  let projectedFree: number | null = null;
  let projectedOverflow = false;
  if (currentValid && peakValid && growthValid) {
    const consumed = checkedAddAll([peakTemp as number, persistentGrowth as number]);
    if (consumed === null) {
      projectedOverflow = true;
    } else {
      const pf = (currentFree as number) - consumed;
      if (Number.isFinite(pf)) projectedFree = pf;
      else projectedOverflow = true;
    }
  }

  // Escape operations always remain available regardless of pressure.
  if (isEscape) {
    return {
      safe: true,
      reserveBytes,
      currentFreeBytes: currentFree,
      projectedFreeBytes: projectedFree,
      totalCapacityBytes: capacity,
      estimatedPeakTempBytes: peakTemp,
      estimatedPersistentGrowthBytes: persistentGrowth,
      reason:
        "escape operation (reads/search/streaming export/settings/diagnostics/deletion) always available; disk pressure never blocks it",
      escapeOperation: true,
    };
  }

  // Non-escape: fail-closed on any unknown / overflow estimate.
  if (!currentValid || !capacityValid || !peakValid || !growthValid || reserveBytes === null) {
    return failClosedWrite("current_free/capacity/peak_temp/persistent_growth is null/NaN/overflow", {
      reserveBytes,
      currentFreeBytes: currentFree,
      projectedFreeBytes: null,
      totalCapacityBytes: capacity,
      estimatedPeakTempBytes: peakTemp,
      estimatedPersistentGrowthBytes: persistentGrowth,
    });
  }
  if (projectedOverflow || projectedFree === null) {
    return failClosedWrite("overflow computing projected_free = current_free − peak_temp − persistent_growth", {
      reserveBytes,
      currentFreeBytes: currentFree,
      projectedFreeBytes: null,
      totalCapacityBytes: capacity,
      estimatedPeakTempBytes: peakTemp,
      estimatedPersistentGrowthBytes: persistentGrowth,
    });
  }

  const currentBelow = (currentFree as number) < reserveBytes;
  const projectedBelow = projectedFree < reserveBytes;
  const paused = currentBelow || projectedBelow;
  return {
    safe: !paused,
    reserveBytes,
    currentFreeBytes: currentFree,
    projectedFreeBytes: projectedFree,
    totalCapacityBytes: capacity,
    estimatedPeakTempBytes: peakTemp,
    estimatedPersistentGrowthBytes: persistentGrowth,
    reason: paused
      ? `PAUSE: ${currentBelow ? "current_free" : "projected_free"} < reserve max(5 GiB, 5% capacity)=${reserveBytes} bytes`
      : `fits: current_free ${currentFree} and projected_free ${projectedFree} both >= reserve ${reserveBytes} bytes`,
  };
}

// ─── Report-only in-memory holder (the readback snapshot; never persisted as canonical) ───

/**
 * A tiny in-memory holder for the latest disk-growth reading — the report-only
 * snapshot the owner-bound readback serves. DERIVED/observable, never persisted as
 * canonical (DATA-RETENTION-001 forbids treating derived observations as
 * authoritative data subject to retention).
 */
export interface FridayDiskGrowthHolder {
  get(): FridayDiskGrowthWarning | null;
  set(reading: FridayDiskGrowthWarning): void;
}

export function createFridayDiskGrowthHolder(): FridayDiskGrowthHolder {
  let last: FridayDiskGrowthWarning | null = null;
  return {
    get: () => last,
    set: (reading) => {
      last = reading;
    },
  };
}
