/**
 * INDEPENDENT clean-room reference oracle for the OPERATOR-LOCKED decision
 * U13-STORAGE-PRESSURE. Written directly from the U13 spec truth table — it does
 * NOT import or mirror production's branching. Its ONLY shared primitive with
 * production is the definition of a "valid byte count" (a spec primitive, not a
 * decision branch).
 *
 * The cross-check tests run the COMPLETE input domain through BOTH production and
 * this oracle and assert they agree, so a production branching bug the oracle does
 * NOT share is caught (rather than the tests grading production against a copy of
 * its own logic).
 *
 * U13 spec (verbatim intent):
 *   Warn when free space is below max(10 GiB, 10% capacity) OR projected exhaustion
 *   is within 7 days. For large writes, reserve = max(5 GiB, 5% capacity) and
 *   projected_free = current_free − estimated_peak_temp − estimated_persistent_growth;
 *   pause when current OR projected free is below reserve. Fail closed on
 *   unknown/overflow (and impossible/inconsistent) estimates. Escape operations
 *   remain available. Never auto-delete.
 */

const GIB = 1024 ** 3;
const FLOOR_ABS = 10 * GIB;
const WARN_DAYS = 7;
const RESERVE_ABS = 5 * GIB;

/**
 * GENUINE-INDEPENDENCE NOTE: the EXACT percentage thresholds are formulated here via
 * BigInt CROSS-MULTIPLICATION — `10 * free < capacity` (10% branch) and `20 * free <
 * capacity` (5% branch) — a STRUCTURALLY DIFFERENT exact form from production's
 * integer `ceilDiv`. The oracle deliberately does NOT import or replicate `ceilDiv`,
 * so a shared spec-error (e.g. floor-rounding) cannot hide: if the two formulations
 * ever disagree on any grid/random cell, the cross-check REDs. BigInt is exact and
 * overflow-free for any safe-integer input. Reported threshold VALUES (reserveBytes)
 * use BigInt ceil-division `(cap + d - 1) / d`, again distinct from production.
 */
const bi = (x: number): bigint => BigInt(x);

/**
 * A valid byte COUNT: a non-negative SAFE INTEGER. Byte counts are discrete — a
 * fractional count is a physically-impossible/untrustworthy reading → invalid
 * (same fail-closed class as capacity=0 / free>capacity). This is a spec primitive
 * ("a trustworthy byte magnitude"), independently stated here. The growth RATE
 * (bytes/day) is CONTINUOUS and validated separately below — never integer-restricted.
 */
function isValidByte(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
}

/**
 * A valid growth RATE (bytes/day): CONTINUOUS, so finite && non-negative within the
 * safe range — deliberately NOT integer-restricted (a fractional rate like
 * 0.5 GiB/day is legitimate). Mirrors production's inline rate validity.
 */
function isValidRate(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
}

export interface OracleDiskGrowth {
  status: "ok" | "warn" | "unknown";
  healthy: boolean;
  failClosed: boolean;
  belowFloor: boolean | null;
  projectedExhaustionDays: number | null;
  withinExhaustionWindow: boolean | null;
}

/**
 * Clean-room U13 disk-growth warning oracle. Both branches (floor + 7-day
 * exhaustion) are derived independently, then status is derived from both.
 */
export function oracleClassifyDiskGrowth(
  free: unknown,
  capacity: unknown,
  growth: unknown,
): OracleDiskGrowth {
  // (1) Validate free/capacity relationship.
  if (!isValidByte(free) || !isValidByte(capacity) || capacity <= 0 || free > capacity) {
    return {
      status: "unknown",
      healthy: false,
      failClosed: true,
      belowFloor: null,
      projectedExhaustionDays: null,
      withinExhaustionWindow: null,
    };
  }

  // (2) Floor branch. belowFloor = free < max(10 GiB, EXACT 10% capacity), where
  // the % branch is `10 * free < capacity` by BigInt cross-multiplication (distinct
  // from production's ceilDiv). `free < max(A, B)` ⟺ `free < A OR free < B`.
  const belowFloor = free < FLOOR_ABS || bi(free) * 10n < bi(capacity);

  // (3) Exhaustion branch (independent of the floor branch).
  let projectedExhaustionDays: number | null = null;
  let withinExhaustionWindow: boolean | null = null;
  let growthUnknown: boolean;
  if (!isValidRate(growth)) {
    growthUnknown = true; // null/NaN/±Inf/negative/overflow → unobservable (RATE is continuous)
  } else if (growth === 0) {
    growthUnknown = false; // measured no-growth → never exhausts
    withinExhaustionWindow = false;
  } else {
    const days = free / growth;
    if (!Number.isFinite(days)) {
      growthUnknown = true; // sub-normal rate → overflow → unobservable
    } else {
      growthUnknown = false;
      projectedExhaustionDays = days;
      withinExhaustionWindow = days <= WARN_DAYS;
    }
  }

  // (4) Derive status from BOTH branches.
  if (belowFloor || withinExhaustionWindow === true) {
    return { status: "warn", healthy: false, failClosed: false, belowFloor, projectedExhaustionDays, withinExhaustionWindow };
  }
  if (growthUnknown) {
    return { status: "unknown", healthy: false, failClosed: true, belowFloor, projectedExhaustionDays, withinExhaustionWindow };
  }
  return { status: "ok", healthy: true, failClosed: false, belowFloor, projectedExhaustionDays, withinExhaustionWindow };
}

export interface OracleLargeWrite {
  safe: boolean;
  failClosed: boolean;
  escapeOperation: boolean;
  reserveBytes: number | null;
  projectedFreeBytes: number | null;
}

/**
 * Clean-room U13 large-write space-safety oracle. Escape ops are always safe
 * (checked FIRST). Non-escape ops fail closed on any invalid/inconsistent reading
 * (capacity ≤ 0, current_free > capacity, invalid estimate, overflow), else pause
 * when current OR projected free is below reserve.
 */
export function oracleEvaluateLargeWrite(
  currentFree: unknown,
  capacity: unknown,
  peak: unknown,
  growth: unknown,
  isEscape: boolean,
): OracleLargeWrite {
  const capValid = isValidByte(capacity);
  // reserve = max(5 GiB, EXACT 5% capacity). The 5% is ceil(capacity/20) via BigInt
  // ceil-division `(cap + 19) / 20` — a distinct exact form from production's ceilDiv.
  const reserveBytes = capValid ? Math.max(RESERVE_ABS, Number((bi(capacity) + 19n) / 20n)) : null;

  // projected_free = current_free − (peak + growth), with overflow guard.
  let projectedFreeBytes: number | null = null;
  let overflow = false;
  if (isValidByte(currentFree) && isValidByte(peak) && isValidByte(growth)) {
    const consumed = peak + growth;
    if (consumed > Number.MAX_SAFE_INTEGER) {
      overflow = true;
    } else {
      const pf = currentFree - consumed;
      if (Number.isFinite(pf)) projectedFreeBytes = pf;
      else overflow = true;
    }
  }

  // (0) Escape ops always safe — decided FIRST.
  if (isEscape) {
    return { safe: true, failClosed: false, escapeOperation: true, reserveBytes, projectedFreeBytes };
  }

  // (1) Fail-closed on invalid OR inconsistent reading.
  const capacityPositive = capValid && capacity > 0;
  const currentExceedsCapacity = isValidByte(currentFree) && capValid && currentFree > capacity;
  if (
    !isValidByte(currentFree) ||
    !capValid ||
    !isValidByte(peak) ||
    !isValidByte(growth) ||
    !capacityPositive ||
    currentExceedsCapacity ||
    reserveBytes === null
  ) {
    return { safe: false, failClosed: true, escapeOperation: false, reserveBytes, projectedFreeBytes: null };
  }
  // (2) Fail-closed on overflow.
  if (overflow || projectedFreeBytes === null) {
    return { safe: false, failClosed: true, escapeOperation: false, reserveBytes, projectedFreeBytes: null };
  }

  // (3) Pressure formula: pause when current OR projected free < reserve, where the
  // % branch is `20 * free < capacity` by BigInt cross-multiplication (distinct from
  // production). `free < max(5 GiB, 5% cap)` ⟺ `free < 5 GiB OR 20 * free < cap`.
  const paused =
    currentFree < RESERVE_ABS ||
    bi(currentFree) * 20n < bi(capacity) ||
    projectedFreeBytes < RESERVE_ABS ||
    bi(projectedFreeBytes) * 20n < bi(capacity);
  return { safe: !paused, failClosed: false, escapeOperation: false, reserveBytes, projectedFreeBytes };
}
