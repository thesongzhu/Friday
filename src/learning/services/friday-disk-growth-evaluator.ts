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
  /**
   * `free / growthRate` in days. BOTH warning branches are evaluated independently,
   * so this is computed and exposed TRUTHFULLY whenever the growth rate is KNOWN —
   * EVEN when `belowFloor` is true (a simultaneously-active exhaustion signal is
   * never hidden). `null` when: inputs invalid, growth rate unknown/invalid, the
   * `free/rate` division overflowed to non-finite, or growth is a measured `0`
   * (never-exhausts sentinel).
   */
  projectedExhaustionDays: number | null;
  /**
   * `projectedExhaustionDays <= 7`. Exposed truthfully even when `belowFloor` is
   * true. `false` for measured-zero (never-exhausts) growth; `null` when the growth
   * branch is UNOBSERVABLE (unknown/invalid rate or overflow) or inputs are invalid.
   */
  withinExhaustionWindow: boolean | null;
  growthBranch: "known" | "unknown";
  authority: typeof FRIDAY_STORAGE_PRESSURE_AUTHORITY;
  /**
   * Machine reason codes for any warn/unknown signal (empty when ok):
   * `below_floor`, `within_7d_exhaustion`, `growth_rate_unknown_above_floor`,
   * `invalid_inputs`. Multiple codes may be present (e.g. both warning branches active).
   */
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
 * A valid byte COUNT: a non-negative SAFE INTEGER. Byte counts are DISCRETE — a
 * fractional count is physically impossible (`fs.statfsSync` always returns whole
 * bytes), so a non-integer is an untrustworthy/impossible reading and is REJECTED
 * (same fail-closed class as `capacity=0` / `free>capacity`). Also rejects NaN,
 * ±Infinity, negative, and any magnitude beyond `MAX_SAFE_INTEGER` (where integer
 * arithmetic silently loses precision).
 *
 * NOTE: this predicate is for byte COUNTS only (free/capacity/peak_temp/
 * persistent_growth). The growth RATE (bytes/day) is a CONTINUOUS quantity and is
 * validated separately (finite && >= 0 + overflow guard) — it may legitimately be
 * fractional (e.g. 0.5 GiB/day) and MUST NOT be integer-restricted.
 */
function isValidByteCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
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
    withinExhaustionWindow: null,
    growthBranch: "unknown",
    authority: FRIDAY_STORAGE_PRESSURE_AUTHORITY,
    reasons: [`fail-closed to unknown: ${reason}`],
    failClosed: true,
  };
}

// ─── U13 warning formula ───

/**
 * The operator-locked disk-growth warning formula. Both U13 warning branches — the
 * absolute free-space FLOOR and the 7-day projected-EXHAUSTION window — are
 * evaluated INDEPENDENTLY, and their observed fields (`belowFloor`,
 * `projectedExhaustionDays`, `withinExhaustionWindow`) are exposed TRUTHFULLY so
 * the owner-facing readback never hides a simultaneously-active signal. Status is
 * then DERIVED from both:
 *
 *  1. Inputs invalid (free/capacity null/NaN/±Inf/negative/overflow, capacity ≤ 0,
 *     or free > capacity) → `unknown` (fail-closed); belowFloor / projected /
 *     withinWindow all `null`; reason `invalid_inputs`.
 *  2. FLOOR branch (always): `floor = max(10 GiB, floor(10% capacity))`;
 *     `belowFloor = free < floor` (strict).
 *  3. EXHAUSTION branch (always, when the rate is KNOWN finite `>= 0`):
 *       • rate == 0 (measured no-growth): `projectedExhaustionDays = null`
 *         (never-exhausts sentinel), `withinExhaustionWindow = false`.
 *       • rate > 0: `days = free / rate`; overflow (non-finite) → branch UNOBSERVABLE
 *         (`projectedExhaustionDays = null`, `withinExhaustionWindow = null`); else
 *         `projectedExhaustionDays = days`, `withinExhaustionWindow = days <= 7`.
 *       • rate unknown/null/NaN/±Inf/negative → branch UNOBSERVABLE
 *         (`projectedExhaustionDays = null`, `withinExhaustionWindow = null`).
 *  4. DERIVE status from BOTH branches:
 *       • `belowFloor === true` OR `withinExhaustionWindow === true` → `warn`
 *         (reasons `below_floor` and/or `within_7d_exhaustion`).
 *       • else if the growth branch is UNOBSERVABLE (above floor, growth unknown) →
 *         FAIL-CLOSED `unknown` (reason `growth_rate_unknown_above_floor`).
 *       • else (above floor, growth known & beyond 7d, or measured-zero) → `ok`.
 *
 * A measured ZERO is KNOWN and must NOT be collapsed with an unknown/null estimate.
 * `unknown` is never `ok`/healthy — the monitor maps `status !== "ok"` to
 * `healthy=false`. Performs NO IO and can never delete.
 */
export function classifyDiskGrowth(input: FridayDiskGrowthInput): FridayDiskGrowthWarning {
  const A = FRIDAY_STORAGE_PRESSURE_AUTHORITY;

  const withDiagnostics = (out: FridayDiskGrowthWarning): FridayDiskGrowthWarning => {
    if (input.diagnostics) out.diagnostics = input.diagnostics;
    return out;
  };

  // ── (1) VALIDATE the free-space reading. Invalid free/capacity → nothing
  // downstream can be trusted → fail-closed `unknown`; all derived fields null.
  const freeValid = isValidByteCount(input.freeBytes);
  const capValid = isValidByteCount(input.totalCapacityBytes);
  if (
    !freeValid ||
    !capValid ||
    (input.totalCapacityBytes as number) <= 0 ||
    (input.freeBytes as number) > (input.totalCapacityBytes as number)
  ) {
    return withDiagnostics({
      status: "unknown",
      freeBytes: freeValid ? (input.freeBytes as number) : null,
      totalCapacityBytes: capValid ? (input.totalCapacityBytes as number) : null,
      freeFraction: null,
      freeSpaceFloorBytes: null,
      belowFloor: null,
      projectedExhaustionDays: null,
      withinExhaustionWindow: null,
      growthBranch: "unknown",
      authority: A,
      reasons: ["invalid_inputs"],
      failClosed: true,
    });
  }
  const freeBytes = input.freeBytes as number;
  const capacity = input.totalCapacityBytes as number;

  // ── (2) FLOOR branch — ALWAYS computed. Absolute + relative floor = max(10 GiB, 10%).
  const floorBytes = Math.max(A.freeSpaceFloorBytes, fractionBytes(capacity, A.freeSpaceFloorFraction));
  const belowFloor = freeBytes < floorBytes; // strict <

  // ── (3) EXHAUSTION branch — ALWAYS computed, INDEPENDENT of the floor branch. A
  // measured ZERO is a KNOWN no-growth estimate; null/undefined/NaN/±Inf/negative/
  // overflow leaves the branch UNOBSERVABLE (never a false `ok`).
  const rate = input.growthRateBytesPerDay;
  const rateKnown =
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= Number.MAX_SAFE_INTEGER;

  let projectedExhaustionDays: number | null = null;
  let withinExhaustionWindow: boolean | null = null;
  let growthUnknown: boolean;
  if (!rateKnown) {
    growthUnknown = true; // unknown/null/NaN/±Inf/negative → branch unobservable
  } else if ((rate as number) === 0) {
    growthUnknown = false; // measured no-growth → never exhausts
    withinExhaustionWindow = false;
  } else {
    const days = freeBytes / (rate as number);
    if (!Number.isFinite(days)) {
      growthUnknown = true; // overflow (e.g. sub-normal rate) → branch unobservable
    } else {
      growthUnknown = false;
      projectedExhaustionDays = days;
      withinExhaustionWindow = days <= A.projectedExhaustionWarnDays;
    }
  }
  const growthBranch: "known" | "unknown" = growthUnknown ? "unknown" : "known";

  // ── (4) DERIVE status/health from BOTH branches. All observed fields are exposed
  // truthfully regardless of which branch drives the status.
  const base = {
    freeBytes,
    totalCapacityBytes: capacity,
    freeFraction: freeBytes / capacity,
    freeSpaceFloorBytes: floorBytes,
    belowFloor,
    projectedExhaustionDays,
    withinExhaustionWindow,
    growthBranch,
    authority: A,
  };

  if (belowFloor || withinExhaustionWindow === true) {
    const reasons: string[] = [];
    if (belowFloor) reasons.push("below_floor");
    if (withinExhaustionWindow === true) reasons.push("within_7d_exhaustion");
    return withDiagnostics({ ...base, status: "warn", reasons, failClosed: false });
  }

  // Above the floor and NOT within the exhaustion window. If the growth branch is
  // UNOBSERVABLE, U13 requires FAIL-CLOSED `unknown` (never a false healthy `ok`).
  if (growthUnknown) {
    return withDiagnostics({
      ...base,
      status: "unknown",
      reasons: ["growth_rate_unknown_above_floor"],
      failClosed: true,
    });
  }

  // Above floor, growth KNOWN & beyond 7 days (or measured-zero) → healthy `ok`.
  return withDiagnostics({ ...base, status: "ok", reasons: [], failClosed: false });
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
 * The operator-locked large-write space-safety evaluator (U13-STORAGE-PRESSURE).
 * reserve = max(5 GiB, floor(5% capacity)); projected_free = current_free −
 * checkedAdd(estimated_peak_temp, estimated_persistent_growth). PAUSE (unsafe) when
 * current OR projected free is below reserve.
 *
 * FAIL-CLOSED (unsafe) for NON-escape operations on ANY untrustworthy reading —
 * individually-finite values are NOT sufficient, the RELATIONSHIPS must be
 * consistent too: a missing/NaN/±Inf/negative/overflow estimate, `capacity <= 0`,
 * `current_free > capacity` (an impossible reading), OR checked-add/subtraction
 * overflow all force `safe=false`.
 *
 * ESCAPE operations (reads/search/streaming export/settings/diagnostics/deletion)
 * are ALWAYS `safe:true` — checked FIRST, before any validity/relationship/pressure
 * logic — so they can never be blocked, while still reporting the estimate. Pure
 * formula plus tests; NOT wired as a pre-flight gate at any write site in this slice.
 */
export function evaluateLargeWriteSafety(input: FridayLargeWriteInput): FridayLargeWriteVerdict {
  const A = FRIDAY_STORAGE_PRESSURE_AUTHORITY;
  const isEscape = input.isEscapeOperation === true;

  // Normalize each field for report-only surfacing (null when individually invalid).
  const currentValid = isValidByteCount(input.currentFreeBytes);
  const capacityValid = isValidByteCount(input.totalCapacityBytes);
  const peakValid = isValidByteCount(input.estimatedPeakTempBytes);
  const growthValid = isValidByteCount(input.estimatedPersistentGrowthBytes);
  const currentFree = currentValid ? (input.currentFreeBytes as number) : null;
  const capacity = capacityValid ? (input.totalCapacityBytes as number) : null;
  const peakTemp = peakValid ? (input.estimatedPeakTempBytes as number) : null;
  const persistentGrowth = growthValid ? (input.estimatedPersistentGrowthBytes as number) : null;

  // reserve = max(5 GiB, floor(5% capacity)) — reportable whenever capacity is a
  // valid byte count (even 0; a 0 capacity still fails closed for non-escape ops).
  const reserveBytes =
    capacity === null ? null : Math.max(A.largeWriteReserveBytes, fractionBytes(capacity, A.largeWriteReserveFraction));

  // projected_free = current_free − checkedAdd(peak_temp, persistent_growth).
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

  const reportFields = {
    reserveBytes,
    currentFreeBytes: currentFree,
    projectedFreeBytes: projectedFree,
    totalCapacityBytes: capacity,
    estimatedPeakTempBytes: peakTemp,
    estimatedPersistentGrowthBytes: persistentGrowth,
  };

  // (0) ESCAPE operations ALWAYS remain available — checked FIRST, before any
  // validity/relationship/pressure logic can ever pause them.
  if (isEscape) {
    return {
      safe: true,
      ...reportFields,
      reason:
        "escape operation (reads/search/streaming export/settings/diagnostics/deletion) always available; disk pressure never blocks it",
      escapeOperation: true,
    };
  }

  // (1) FAIL-CLOSED for non-escape ops on any invalid OR INCONSISTENT reading:
  // capacity must be a valid byte count > 0, and current_free must not exceed it.
  const capacityPositive = capacityValid && (capacity as number) > 0;
  const currentExceedsCapacity =
    currentValid && capacityValid && (currentFree as number) > (capacity as number);
  if (
    !currentValid ||
    !capacityValid ||
    !peakValid ||
    !growthValid ||
    !capacityPositive ||
    currentExceedsCapacity ||
    reserveBytes === null
  ) {
    return failClosedWrite(
      "current_free/capacity/peak_temp/persistent_growth invalid, capacity<=0, or current_free>capacity (inconsistent reading)",
      { ...reportFields, projectedFreeBytes: null },
    );
  }
  // (2) FAIL-CLOSED on checked-add / subtraction overflow.
  if (projectedOverflow || projectedFree === null) {
    return failClosedWrite(
      "overflow computing projected_free = current_free − peak_temp − persistent_growth",
      { ...reportFields, projectedFreeBytes: null },
    );
  }

  // (3) U13 pressure formula: pause when current OR projected free is below reserve.
  const currentBelow = (currentFree as number) < reserveBytes;
  const projectedBelow = projectedFree < reserveBytes;
  const paused = currentBelow || projectedBelow;
  return {
    safe: !paused,
    ...reportFields,
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
