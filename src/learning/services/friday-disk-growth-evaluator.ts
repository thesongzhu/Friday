/**
 * RETENTION-R3b — PURE disk-growth warning + large-write evaluator formulas.
 *
 * This module implements the two named formulas required by the
 * DATA-RETENTION-001 acceptance oracle:
 *
 *   "Implement exact warning and large-write evaluator formulas with
 *    overflow/unknown fail-closed; disk pressure never auto-deletes and escape
 *    operations remain usable."
 *
 * It is DELIBERATELY PURE: no `fs`, no DB handle, no IO, no process spawning. It
 * only labels observed magnitudes. Being pure means it is STRUCTURALLY incapable
 * of pruning, vacuuming, or removing any data — disk pressure here can only ever
 * WARN. The paired negative controls it must defeat (DATA-RETENTION-001 `:negative`):
 * boolean-only peak flag, current-free-only check, integer overflow, omitted
 * WAL/COW/archive/backup/partial/rollback estimate, disabled export/delete, or
 * silent purge/corruption.
 */

// ─── Thresholds (built-in heuristic defaults; report-only; NOT a retention knob) ───

/**
 * Heuristic thresholds for the report-only disk-growth warning. A `warn`/`critical`
 * on TOTAL DB bytes plus, when a free-space reading is present, a `warn`/`critical`
 * on the FREE-SPACE FRACTION (a fraction, never a boolean). Hand-picked for
 * VISIBILITY only — they are `heuristic:true` labelled and never gate any
 * deletion. "Off = clean disabled" does not apply: observation is always safe and
 * needs no user toggle to be correct (a user-tunable "warn me at N GB" knob is a
 * deferred follow-up that must use row-absence/null, never a sentinel).
 */
export const FRIDAY_DISK_GROWTH_THRESHOLDS = {
  /** Warn once the local SQLite DB crosses ~1 GB. */
  warnTotalBytes: 1_000_000_000,
  /** Critical once the local SQLite DB crosses ~4 GB. */
  criticalTotalBytes: 4_000_000_000,
  /** Warn once free disk drops to 15% of capacity. */
  warnFreeFraction: 0.15,
  /** Critical once free disk drops to 5% of capacity. */
  criticalFreeFraction: 0.05,
  /** Marks these as hand-picked heuristics, not a tuned/enforced policy. */
  heuristic: true,
} as const;

/**
 * EXPLICIT overhead multipliers/addends for the large-write space-safety formula.
 * The required space for a projected write is NEVER just the projected bytes
 * (that is the "current-free-only" negative control): a durable SQLite write can
 * transiently need WAL headroom, a rollback journal, a COW/backup/archive copy,
 * and a partial-write safety margin. Each is a NAMED, surfaced component so the
 * estimate can never silently omit WAL/COW/archive/backup/partial/rollback.
 */
export const FRIDAY_LARGE_WRITE_OVERHEAD = {
  /** WAL can transiently hold a copy of the pages being modified. */
  walHeadroomFraction: 0.25,
  /** A rollback journal may mirror the pre-image of the modified pages. */
  rollbackJournalHeadroomFraction: 0.25,
  /** A COW/backup/archive step may duplicate the written bytes. */
  cowBackupArchiveFraction: 1.0,
  /** Fixed floor to absorb partial-write / rollback churn (16 MB). */
  partialWriteSafetyMarginBytes: 16_000_000,
} as const;

// ─── Types ───

export type FridayDiskGrowthStatus = "ok" | "warn" | "critical" | "unknown";

export interface FridayDiskGrowthInput {
  /** Total local SQLite bytes (`page_count × page_size`). */
  totalDbBytes: number;
  /** Report-only realtime_events growth estimate (bounded-sample extrapolation). */
  realtimeEventsEstimatedBytes: number;
  /** Free bytes available on the state volume; `null` = unresolved probe → unknown. */
  freeBytes: number | null;
  /** Total capacity of the state volume; `null` = unresolved probe → unknown. */
  totalDiskBytes: number | null;
  /** Optional per-content-category byte breakdown (reserved for the UI card). */
  categoryBytes?: Record<string, number>;
}

export interface FridayDiskGrowthWarning {
  /** Magnitude-derived enum (NEVER a boolean). `unknown` is never treated as `ok`. */
  status: FridayDiskGrowthStatus;
  totalDbBytes: number | null;
  freeBytes: number | null;
  totalDiskBytes: number | null;
  /** free / capacity, in `[0,1]`; `null` when unresolved/fail-closed. */
  freeFraction: number | null;
  estimatedBytes: number | null;
  thresholds: typeof FRIDAY_DISK_GROWTH_THRESHOLDS;
  /** Human-readable reasons for any warn/critical/unknown signal (empty when ok). */
  reasons: string[];
  /** True only when the reading was unresolvable/overflowed and fell back to unknown. */
  failClosed?: boolean;
}

export interface FridayLargeWriteInput {
  /** Bytes the caller intends to write. */
  projectedWriteBytes: number;
  /** Free bytes available; `null` = unresolved probe → unsafe (unless escape). */
  freeBytes: number | null;
  /**
   * When true, this is an ESCAPE operation (export/delete): it must ALWAYS be
   * permitted — disk pressure must never block the user from reclaiming space or
   * exporting their data. The estimate is still reported.
   */
  isEscapeOperation?: boolean;
}

export interface FridayLargeWriteVerdict {
  /** Whether the projected write (plus overhead) fits. Escape ops are always safe. */
  safe: boolean;
  requiredBytes: number | null;
  projectedBytes: number | null;
  overheadBytes: number | null;
  freeBytes: number | null;
  shortfallBytes: number | null;
  reason: string;
  /** True when the verdict fell back to unsafe due to unknown/overflow (non-escape). */
  failClosed?: boolean;
  /** True when this verdict is for an escape operation (always usable). */
  escapeOperation?: boolean;
}

// ─── Fail-closed helpers ───

/**
 * A finite, non-negative byte count within the exact-integer range. Anything
 * else — NaN, ±Infinity, negative, or a magnitude beyond `MAX_SAFE_INTEGER`
 * (where integer arithmetic silently loses precision) — is REJECTED. This is the
 * single choke-point that defeats the "integer overflow" and "unknown" negatives.
 */
function isValidByteCount(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
}

/** Checked addition: returns `null` on any non-finite/negative term or overflow past MAX_SAFE_INTEGER. */
function checkedAddAll(terms: number[]): number | null {
  let sum = 0;
  for (const term of terms) {
    if (!Number.isFinite(term) || term < 0) return null;
    sum += term;
    if (sum > Number.MAX_SAFE_INTEGER) return null;
  }
  return sum;
}

function worstOkWarnCritical(
  a: "ok" | "warn" | "critical",
  b: "ok" | "warn" | "critical",
): "ok" | "warn" | "critical" {
  const rank = { ok: 0, warn: 1, critical: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Fail-closed disk-growth reading (status `unknown`, never `ok`). Echoes back any
 * inputs that WERE valid (for the reader) but carries no fraction and marks
 * `failClosed`. Exported so the collector can fail closed on a DB read error too.
 */
export function failClosedDiskGrowth(reason: string): FridayDiskGrowthWarning {
  return {
    status: "unknown",
    totalDbBytes: null,
    freeBytes: null,
    totalDiskBytes: null,
    freeFraction: null,
    estimatedBytes: null,
    thresholds: { ...FRIDAY_DISK_GROWTH_THRESHOLDS },
    reasons: [`fail-closed to unknown: ${reason}`],
    failClosed: true,
  };
}

function unknownDiskGrowth(input: FridayDiskGrowthInput, reason: string): FridayDiskGrowthWarning {
  return {
    status: "unknown",
    totalDbBytes: isValidByteCount(input.totalDbBytes) ? input.totalDbBytes : null,
    freeBytes: isValidByteCount(input.freeBytes) ? input.freeBytes : null,
    totalDiskBytes: isValidByteCount(input.totalDiskBytes) ? input.totalDiskBytes : null,
    freeFraction: null,
    estimatedBytes: isValidByteCount(input.realtimeEventsEstimatedBytes)
      ? input.realtimeEventsEstimatedBytes
      : null,
    thresholds: { ...FRIDAY_DISK_GROWTH_THRESHOLDS },
    reasons: [`fail-closed to unknown: ${reason}`],
    failClosed: true,
  };
}

// ─── R3b-1: disk-growth WARNING formula ───

/**
 * The EXACT report-only disk-growth warning formula. Derives a status from the
 * WORST of two magnitude signals: total DB bytes, and (when a free-space reading
 * is present) the free-space fraction. Any non-finite/negative/overflowing input,
 * or an unresolved/inconsistent free-space reading, fails closed to `unknown`
 * (never `ok`). Performs NO IO and can never delete — it only labels magnitudes.
 */
export function classifyDiskGrowth(input: FridayDiskGrowthInput): FridayDiskGrowthWarning {
  const t = FRIDAY_DISK_GROWTH_THRESHOLDS;

  // Fail-closed validation of the required byte inputs (NaN/Infinity/negative/overflow).
  if (!isValidByteCount(input.totalDbBytes)) {
    return unknownDiskGrowth(input, "totalDbBytes is not a finite in-range byte count");
  }
  if (!isValidByteCount(input.realtimeEventsEstimatedBytes)) {
    return unknownDiskGrowth(input, "realtimeEventsEstimatedBytes is not a finite in-range byte count");
  }

  // Unresolved probe → unknown (a missing free-space reading is never treated as ok).
  if (input.freeBytes === null || input.totalDiskBytes === null) {
    return unknownDiskGrowth(input, "free-space probe unresolved (freeBytes/totalDiskBytes is null)");
  }
  if (!isValidByteCount(input.freeBytes) || !isValidByteCount(input.totalDiskBytes) || input.totalDiskBytes === 0) {
    return unknownDiskGrowth(input, "free-space reading is not a finite positive byte count");
  }
  if (input.freeBytes > input.totalDiskBytes) {
    return unknownDiskGrowth(input, "inconsistent reading: freeBytes exceeds totalDiskBytes");
  }

  const freeFraction = input.freeBytes / input.totalDiskBytes;
  const reasons: string[] = [];

  // Byte signal.
  let byteStatus: "ok" | "warn" | "critical" = "ok";
  if (input.totalDbBytes >= t.criticalTotalBytes) {
    byteStatus = "critical";
    reasons.push(`total DB size ${input.totalDbBytes} >= critical ${t.criticalTotalBytes} bytes`);
  } else if (input.totalDbBytes >= t.warnTotalBytes) {
    byteStatus = "warn";
    reasons.push(`total DB size ${input.totalDbBytes} >= warn ${t.warnTotalBytes} bytes`);
  }

  // Free-space-fraction signal.
  let freeStatus: "ok" | "warn" | "critical" = "ok";
  if (freeFraction <= t.criticalFreeFraction) {
    freeStatus = "critical";
    reasons.push(`free disk fraction ${freeFraction.toFixed(4)} <= critical ${t.criticalFreeFraction}`);
  } else if (freeFraction <= t.warnFreeFraction) {
    freeStatus = "warn";
    reasons.push(`free disk fraction ${freeFraction.toFixed(4)} <= warn ${t.warnFreeFraction}`);
  }

  const status = worstOkWarnCritical(byteStatus, freeStatus);

  return {
    status,
    totalDbBytes: input.totalDbBytes,
    freeBytes: input.freeBytes,
    totalDiskBytes: input.totalDiskBytes,
    freeFraction,
    estimatedBytes: input.realtimeEventsEstimatedBytes,
    thresholds: { ...t },
    reasons,
  };
}

// ─── R3b-2: large-write space-safety formula (formula only; NOT wired as a gate) ───

function failClosedWrite(
  reason: string,
  partial: {
    projectedBytes: number | null;
    overheadBytes: number | null;
    requiredBytes: number | null;
    freeBytes: number | null;
  },
): FridayLargeWriteVerdict {
  return {
    safe: false,
    requiredBytes: partial.requiredBytes,
    projectedBytes: partial.projectedBytes,
    overheadBytes: partial.overheadBytes,
    freeBytes: partial.freeBytes,
    shortfallBytes: null,
    reason: `fail-closed to unsafe: ${reason}`,
    failClosed: true,
  };
}

/**
 * The large-write space-safety evaluator formula. required = projected + EXPLICIT
 * overhead (WAL + rollback-journal + COW/backup/archive + partial-write margin),
 * summed with a CHECKED add so a huge projected value can never wrap to a small
 * "safe" number. Fail-closed to `unsafe` on unknown free space or any overflow.
 *
 * ESCAPE operations (export/delete) are ALWAYS `safe:true` — disk pressure must
 * never block the user from exporting or reclaiming — while STILL reporting the
 * estimate. This is a PURE formula plus tests; it is NOT wired as a pre-flight
 * gate at any write site in this slice, so escape operations are structurally
 * never blockable by it.
 */
export function evaluateLargeWriteSafety(input: FridayLargeWriteInput): FridayLargeWriteVerdict {
  const isEscape = input.isEscapeOperation === true;
  const o = FRIDAY_LARGE_WRITE_OVERHEAD;

  // Compute the estimate best-effort so it is reported even for escape ops.
  const projectedValid = isValidByteCount(input.projectedWriteBytes);
  let overheadBytes: number | null = null;
  let requiredBytes: number | null = null;
  if (projectedValid) {
    const p = input.projectedWriteBytes;
    const walBytes = Math.ceil(p * o.walHeadroomFraction);
    const rollbackBytes = Math.ceil(p * o.rollbackJournalHeadroomFraction);
    const cowBackupBytes = Math.ceil(p * o.cowBackupArchiveFraction);
    overheadBytes = checkedAddAll([walBytes, rollbackBytes, cowBackupBytes, o.partialWriteSafetyMarginBytes]);
    requiredBytes = overheadBytes === null ? null : checkedAddAll([p, overheadBytes]);
  }

  const freeValid = isValidByteCount(input.freeBytes);
  const freeBytes = freeValid ? (input.freeBytes as number) : null;
  const projectedBytes = projectedValid ? input.projectedWriteBytes : null;

  // Escape operations must NEVER be blocked by disk pressure.
  if (isEscape) {
    return {
      safe: true,
      requiredBytes,
      projectedBytes,
      overheadBytes,
      freeBytes,
      shortfallBytes: null,
      reason: "escape operation (export/delete) is always permitted; disk pressure never blocks it",
      escapeOperation: true,
    };
  }

  // Non-escape: fail-closed on any unknown / overflow.
  if (!projectedValid) {
    return failClosedWrite("projectedWriteBytes is not a finite in-range byte count", {
      projectedBytes: null,
      overheadBytes: null,
      requiredBytes: null,
      freeBytes,
    });
  }
  if (overheadBytes === null || requiredBytes === null) {
    return failClosedWrite("integer overflow computing required = projected + overhead", {
      projectedBytes,
      overheadBytes: null,
      requiredBytes: null,
      freeBytes,
    });
  }
  if (!freeValid || freeBytes === null) {
    return failClosedWrite("free space is unknown (probe unresolved)", {
      projectedBytes,
      overheadBytes,
      requiredBytes,
      freeBytes: null,
    });
  }

  const safe = requiredBytes <= freeBytes;
  const shortfallBytes = safe ? 0 : requiredBytes - freeBytes;
  return {
    safe,
    requiredBytes,
    projectedBytes,
    overheadBytes,
    freeBytes,
    shortfallBytes,
    reason: safe
      ? `fits: required ${requiredBytes} <= free ${freeBytes} bytes`
      : `insufficient space: required ${requiredBytes} > free ${freeBytes} bytes (short ${shortfallBytes})`,
  };
}

// ─── Report-only in-memory holder (the readback snapshot; never persisted as canonical) ───

/**
 * A tiny in-memory holder for the latest disk-growth reading — the report-only
 * snapshot the owner-bound readback serves. It is DERIVED/observable, never
 * persisted as canonical (DATA-RETENTION-001 forbids treating derived
 * observations as authoritative data subject to retention).
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
