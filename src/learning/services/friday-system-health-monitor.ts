import type { FridaySqliteLayer } from "#state";
import {
  classifyDiskGrowth,
  failClosedDiskGrowth,
  type FridayDiskGrowthWarning,
} from "./friday-disk-growth-evaluator.js";

// ─── Types ───

export interface FridaySystemHealthResult {
  name: string;
  healthy: boolean;
  value: number;
  unit: string;
  /**
   * Optional report-only diagnostic detail. Populated by diagnose-only checks
   * (e.g. `realtime_events_growth`, `disk_growth`) that surface richer,
   * multi-field telemetry than the binary healthy/value/unit shape. Never used to
   * gate, schedule, or perform any maintenance/deletion.
   */
  detail?: FridaySystemHealthGrowthDetail | FridayDiskGrowthWarning;
}

/** Heuristic status for a report-only growth observation. */
export type FridaySystemHealthGrowthStatus = "healthy" | "warn" | "critical" | "degraded";

/**
 * Report-only growth telemetry for the append-only, redacted-at-write,
 * DERIVED `realtime_events` projection/replay stream. This is DIAGNOSE-ONLY:
 * it records how large the stream has grown so the growth is VISIBLE. It never
 * deletes, prunes, vacuums, schedules, or gates maintenance. Safe space
 * reclamation for this stream is owned by the Rust realtime epoch-resync path,
 * which is why `reclaim_status` is fixed to `deferred_to_rust_epoch_resync`.
 *
 * Both measurements are strictly BOUNDED so the 5-minute check can never block
 * the Hub event loop on a large table: `rowCount` is an O(1) `MAX(rowid)` proxy
 * (index-backed; exact under the append-only never-deleted invariant, a safe
 * upper bound otherwise), and `estimatedBytes` extrapolates from a bounded
 * `LIMIT`-sampled average payload byte-length — never a full-table SUM.
 */
export interface FridaySystemHealthGrowthDetail {
  /** Heuristic status derived from the thresholds below (report-only). */
  status: FridaySystemHealthGrowthStatus;
  /** Approx row count via `MAX(rowid)` (O(1) proxy); -1 when fail-closed. */
  rowCount: number;
  /**
   * Estimated total payload size in TRUE UTF-8 BYTES (`LENGTH(CAST(... AS
   * BLOB))`), extrapolated as sampled-average × rowCount; -1 when fail-closed.
   */
  estimatedBytes: number;
  /**
   * The ACTUAL number of rows the byte sample read (the real `COUNT(*)` of the
   * newest-≤`REALTIME_EVENTS_SAMPLE_SIZE`-rows subquery), NOT `min(LIMIT,
   * MAX(rowid))`. After a deletion, rowid gaps make `MAX(rowid)` exceed the
   * surviving-row count, so this stays honest (≤ surviving rows, ≤ the LIMIT).
   */
  sampleSize: number;
  /** Human-readable note describing the bounded/sampled estimate method. */
  estimateBasis: string;
  /** Heuristic thresholds used to derive `status` (labelled, not user-configurable). */
  thresholds: {
    warnBytes: number;
    criticalBytes: number;
    warnRows: number;
    criticalRows: number;
    /** Marks these as hand-picked heuristics, not a tuned/enforced policy. */
    heuristic: true;
  };
  /**
   * MANDATORY marker: safe space-reclaim for realtime_events is owned by the
   * Rust realtime epoch-resync path, NOT performed by this diagnose-only check.
   */
  reclaim_status: "deferred_to_rust_epoch_resync";
  /** True only when the count/size query failed and the check fell back to degraded. */
  failClosed?: boolean;
  /** Query error message when fail-closed. */
  error?: string;
}

/**
 * Rate-limits repeated health-status warnings. A persistently warn/critical
 * check must NOT emit a fresh log every 5 minutes forever — only on a status
 * TRANSITION. Feed every check's status (healthy included) so a recovery resets
 * the state and the next regression re-alerts.
 */
export interface FridayHealthLogDeduper {
  shouldLog(key: string, status: string): boolean;
}

export function createFridayHealthLogDeduper(): FridayHealthLogDeduper {
  const lastByKey = new Map<string, string>();
  return {
    shouldLog(key, status) {
      if (lastByKey.get(key) === status) return false;
      lastByKey.set(key, status);
      return true;
    },
  };
}

/** Status label for a check: the growth `detail.status` if present, else healthy/unhealthy. */
export function healthCheckStatusLabel(check: FridaySystemHealthResult): string {
  return check.detail?.status ?? (check.healthy ? "healthy" : "unhealthy");
}

export interface FridaySystemHealthMaintenanceGate {
  requestedBy: string;
  reason: string;
  approvedAt: string;
  approvalRef?: string;
}

export interface FridaySystemHealthMaintenanceRecommendation {
  name: string;
  gateRequired: "explicit_maintenance";
  detail: string;
  value: number;
  unit: string;
}

export interface FridaySystemHealthMaintenanceReceipt {
  receiptId: string;
  name: string;
  status: "applied" | "failed";
  detail: string;
  runAt: string;
  requestedBy: string;
  reason: string;
  approvedAt: string;
  approvalRef?: string;
  rollbackClass: "non_reversible_local";
  nonReversibleReason: string;
  evidence: {
    beforeValue: number;
    unit: string;
    changes?: number;
  };
}

export interface FridaySystemHealthRunSummary {
  checks: FridaySystemHealthResult[];
  maintenanceRecommendations: FridaySystemHealthMaintenanceRecommendation[];
  maintenanceReceipts: FridaySystemHealthMaintenanceReceipt[];
  runAt: string;
}

export interface FridaySystemHealthRunOptions {
  maintenanceGate?: FridaySystemHealthMaintenanceGate;
}

export interface FridaySystemHealthMonitor {
  runAll(options?: FridaySystemHealthRunOptions): FridaySystemHealthRunSummary;
}

export interface CreateSystemHealthMonitorDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  /** Optional callback invoked after each run for audit/observability. */
  onRunComplete?: (summary: FridaySystemHealthRunSummary) => void;
  /**
   * Report-only free-space probe for the `disk_growth` check (RETENTION-R3b).
   * INJECTED to keep this module IO-pure and testable. Returns free + total
   * capacity bytes for the state volume, or `null` when the reading is
   * unresolvable (unsupported platform / throw). Production wires
   * `fs.statfsSync(stateDir)` → `{ freeBytes: bavail×bsize, totalBytes: blocks×bsize }`.
   * When omitted, `disk_growth` fails closed to `unknown` (never `ok`) — it never
   * assumes healthy free space.
   */
  probeDiskSpace?: () => { freeBytes: number; totalBytes: number } | null;
  /**
   * Optional AUTHORITATIVE growth-rate probe (bytes/day) for the U13 projected-
   * exhaustion branch. A measured `0` is a KNOWN no-growth estimate. When omitted
   * or it returns null (the estimate is UNKNOWN), the projected-exhaustion branch
   * is UNOBSERVABLE: BELOW the `max(10 GiB, 10% capacity)` floor the reading is
   * still `warn`, but ABOVE the floor the reading FAILS CLOSED to `unknown`
   * (healthy=false) — it never publishes a false healthy `ok`. An authoritative
   * production growth-window measurement is the named R3c follow-up; until then
   * production wires this to `null` and honestly reports the exhaustion branch as
   * `unknown`.
   */
  probeGrowthRateBytesPerDay?: () => number | null;
}

// ─── Checks ───

interface HealthCheck {
  name: string;
  check: (deps: CreateSystemHealthMonitorDeps) => FridaySystemHealthResult;
  maintenance?: {
    detail: string;
    nonReversibleReason: string;
    run: (deps: CreateSystemHealthMonitorDeps) => { detail: string; changes?: number };
  };
}

const RETIRED_MEMORY_ITEMS_MAINTENANCE =
  "TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED: expired memory_items maintenance is disabled in the TypeScript runtime; use the Rust memory owner/migration path instead.";

// ─── realtime_events growth observability (report-only; bounded; DATA-RETENTION-001) ───

/**
 * Max rows read to estimate the average payload byte-length. Bounds the byte
 * estimate to O(sample) regardless of table size — never a full-table scan.
 */
export const REALTIME_EVENTS_SAMPLE_SIZE = 1000;

/**
 * O(1) row-count proxy: `MAX(rowid)` is answered from the rightmost b-tree entry
 * (EXPLAIN QUERY PLAN → `SEARCH`, not `SCAN`). Exact under the append-only,
 * never-deleted invariant; a safe upper bound otherwise. Never reads payloads.
 */
export const REALTIME_EVENTS_ROWCOUNT_PROXY_SQL =
  "SELECT MAX(rowid) AS max_rowid FROM realtime_events";

/**
 * Bounded byte-size sample: average TRUE UTF-8 byte-length
 * (`LENGTH(CAST(payload_json AS BLOB))` — NOT character count) over the most
 * recent `REALTIME_EVENTS_SAMPLE_SIZE` rows in rowid order, PLUS the ACTUAL
 * `COUNT(*)` of that bounded subquery. The `LIMIT` caps the payload reads; the
 * rowid ordering avoids a full-table sort (no TEMP B-TREE). Never a `SUM(...)`
 * over the whole table.
 *
 * `sample_count` is the REAL number of rows the sample read (≤ the LIMIT). It is
 * NOT derivable from `MAX(rowid)`: after a deletion, rowid gaps make MAX(rowid)
 * exceed the surviving-row count, so a `min(LIMIT, MAX(rowid))` proxy would
 * over-report. The check surfaces this real count as the public `sampleSize`.
 */
export const REALTIME_EVENTS_SAMPLE_BYTES_SQL =
  `SELECT COUNT(*) AS sample_count, AVG(LENGTH(CAST(payload_json AS BLOB))) AS avg_bytes ` +
  `FROM (SELECT payload_json FROM realtime_events ORDER BY rowid DESC LIMIT ${REALTIME_EVENTS_SAMPLE_SIZE})`;

/**
 * Heuristic thresholds for the report-only `realtime_events_growth` check.
 * Byte thresholds mirror the `db_size` check's style (a single 500MB ceiling);
 * here 250MB is a warn and 500MB a critical for this one derived stream. Row
 * thresholds are a coarse secondary signal for tiny-payload growth. These are
 * hand-picked heuristics for VISIBILITY only — never a deletion/retention knob.
 */
export const REALTIME_EVENTS_GROWTH_THRESHOLDS = {
  warnBytes: 250_000_000,
  criticalBytes: 500_000_000,
  warnRows: 1_000_000,
  criticalRows: 5_000_000,
  heuristic: true,
} as const;

const REALTIME_EVENTS_ESTIMATE_BASIS =
  `avg(LENGTH(CAST(payload_json AS BLOB))) over the newest ≤${REALTIME_EVENTS_SAMPLE_SIZE} rows × MAX(rowid); ` +
  "bounded-sample estimate in true UTF-8 bytes, excludes index/row overhead";

/**
 * Pure, report-only classifier for realtime_events growth. Derives a heuristic
 * status from the worst of the byte and row signals. Exported so threshold
 * behaviour is unit-testable without materialising millions of rows. Performs
 * NO IO and NO deletion — it only labels observed magnitudes.
 */
export function classifyRealtimeEventsGrowth(
  rowCount: number,
  estimatedBytes: number,
  sampleSize?: number,
): FridaySystemHealthGrowthDetail {
  const t = REALTIME_EVENTS_GROWTH_THRESHOLDS;
  let status: FridaySystemHealthGrowthStatus = "healthy";
  if (estimatedBytes >= t.criticalBytes || rowCount >= t.criticalRows) {
    status = "critical";
  } else if (estimatedBytes >= t.warnBytes || rowCount >= t.warnRows) {
    status = "warn";
  }
  return {
    status,
    rowCount,
    estimatedBytes,
    // Use the REAL sampled `COUNT(*)` when the caller supplies it (the production
    // check always does — see REALTIME_EVENTS_SAMPLE_BYTES_SQL). Only the pure
    // threshold unit tests omit it, where there is no sample query; in that case
    // fall back to a rowCount-derived upper bound. Never `min(LIMIT, MAX(rowid))`
    // on real data, which would over-report after rowid gaps from deletion.
    sampleSize: sampleSize ?? Math.min(REALTIME_EVENTS_SAMPLE_SIZE, Math.max(0, rowCount)),
    estimateBasis: REALTIME_EVENTS_ESTIMATE_BASIS,
    thresholds: { ...t },
    reclaim_status: "deferred_to_rust_epoch_resync",
  };
}

/** Fail-closed growth detail: degraded (never healthy), no deletion, marker retained. */
function degradedRealtimeEventsGrowthDetail(err: unknown): FridaySystemHealthGrowthDetail {
  return {
    status: "degraded",
    rowCount: -1,
    estimatedBytes: -1,
    sampleSize: 0,
    estimateBasis: REALTIME_EVENTS_ESTIMATE_BASIS,
    thresholds: { ...REALTIME_EVENTS_GROWTH_THRESHOLDS },
    reclaim_status: "deferred_to_rust_epoch_resync",
    failClosed: true,
    error: err instanceof Error ? err.message : String(err),
  };
}

const HEALTH_CHECKS: HealthCheck[] = [
  {
    name: "db_size",
    check: (deps) => {
      const sizeBytes = deps.db.withReadConnection((db) => {
        const pageCount = db.pragma("page_count", { simple: true }) as number;
        const pageSize = db.pragma("page_size", { simple: true }) as number;
        return pageCount * pageSize;
      });
      return { name: "db_size", healthy: sizeBytes < 500_000_000, value: sizeBytes, unit: "bytes" };
    },
    maintenance: {
      detail: "Run incremental vacuum for local SQLite storage",
      nonReversibleReason: "SQLite incremental vacuum changes the local database file layout and cannot be rolled back by Friday.",
      run: (deps) => {
        deps.db.withWriteTransaction((db) => {
          db.pragma("incremental_vacuum(100)");
        });
        return { detail: "Ran incremental vacuum (up to 100 pages)" };
      },
    },
  },
  {
    name: "expired_memory_items",
    check: (deps) => {
      const nowIso = deps.nowIso();
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT COUNT(*) AS cnt FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < ?")
          .get(nowIso),
      ) as { cnt: number } | undefined;
      const count = row?.cnt ?? 0;
      return { name: "expired_memory_items", healthy: count < 500, value: count, unit: "items" };
    },
    maintenance: {
      detail: "Expired memory item cleanup must run through the Rust memory owner/migration path",
      nonReversibleReason: "Expired memory item deletion removes local rows and cannot be reconstructed by Friday.",
      run: () => {
        throw new Error(RETIRED_MEMORY_ITEMS_MAINTENANCE);
      },
    },
  },
  {
    name: "stale_realtime_checkpoints",
    check: (deps) => {
      const cutoff = sevenDaysBefore(deps.nowIso());
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT COUNT(*) AS cnt FROM realtime_checkpoints WHERE updated_at < ?")
          .get(cutoff),
      ) as { cnt: number } | undefined;
      const count = row?.cnt ?? 0;
      return { name: "stale_realtime_checkpoints", healthy: count < 1000, value: count, unit: "checkpoints" };
    },
    maintenance: {
      detail: "Prune stale realtime checkpoints",
      nonReversibleReason: "Realtime checkpoint deletion removes local stream cursor rows and cannot be reconstructed by Friday.",
      run: (deps) => {
        const cutoff = sevenDaysBefore(deps.nowIso());
        const result = deps.db.withWriteTransaction((db) =>
          db.prepare("DELETE FROM realtime_checkpoints WHERE updated_at < ?").run(cutoff),
        );
        const pruned = (result as { changes?: number })?.changes ?? 0;
        return { detail: `Pruned ${pruned} stale checkpoints`, changes: pruned };
      },
    },
  },
  {
    // REPORT-ONLY growth observability for the unbounded, append-only, DERIVED
    // realtime_events projection/replay stream (DATA-RETENTION-001 compliant).
    // Deliberately has NO `maintenance` block: it must never prune, vacuum,
    // delete, schedule, or gate any cleanup. Safe space reclaim is owned by the
    // Rust realtime epoch-resync path (see reclaim_status). Both queries are
    // strictly BOUNDED (O(1) MAX(rowid) proxy + LIMIT-sampled byte average) so a
    // large table can never block the 5-minute Hub scheduler tick.
    name: "realtime_events_growth",
    check: (deps) => {
      let detail: FridaySystemHealthGrowthDetail;
      try {
        detail = deps.db.withReadConnection((db) => {
          const countRow = db.prepare(REALTIME_EVENTS_ROWCOUNT_PROXY_SQL).get() as
            | { max_rowid: number | null }
            | undefined;
          const rowCount = countRow?.max_rowid ?? 0;
          const sampleRow = db.prepare(REALTIME_EVENTS_SAMPLE_BYTES_SQL).get() as
            | { avg_bytes: number | null; sample_count: number | null }
            | undefined;
          const avgBytes = sampleRow?.avg_bytes ?? 0;
          // The REAL number of rows the byte sample read (honest even under rowid
          // gaps), NOT min(LIMIT, MAX(rowid)). Surfaced as the public sampleSize.
          const sampleCount = sampleRow?.sample_count ?? 0;
          const estimatedBytes = Math.round(avgBytes * rowCount);
          return classifyRealtimeEventsGrowth(rowCount, estimatedBytes, sampleCount);
        });
      } catch (err) {
        // FAIL-CLOSED: an unknown count/size reports degraded (never healthy) and
        // performs NO deletion. reclaim_status is still surfaced for the reader.
        detail = degradedRealtimeEventsGrowthDetail(err);
      }
      // Report-only: the growth reading rides in the returned check `detail` and is
      // surfaced ONLY through the monitor's run summary → transition-only warning
      // logs (see the Hub scheduler's onRunComplete). Per the #1606 split it is NOT
      // published to any observability route / HTTP surface; owner-authorized
      // readback is deferred to R3. Never used for any deletion.
      return {
        name: "realtime_events_growth",
        healthy: detail.status === "healthy",
        value: detail.estimatedBytes,
        unit: "bytes",
        detail,
      };
    },
    // No maintenance: diagnose-only. Space reclaim is deferred to the Rust
    // realtime epoch-resync path, never performed here.
  },
  {
    // REPORT-ONLY disk-growth observability (RETENTION-R3b). A sibling of
    // realtime_events_growth: it feeds the PURE disk-growth warning evaluator
    // (total DB bytes + free-space fraction). Deliberately has NO `maintenance`
    // block — it can never prune, vacuum, delete, or gate cleanup. Fails closed to
    // `unknown` (never `ok`) on any read/probe failure. Surfaced ONLY via the
    // monitor's run summary → transition-only warning logs plus the owner-bound
    // readback holder; never published to any observability route (the #1606 split).
    name: "disk_growth",
    check: (deps) => {
      let detail: FridayDiskGrowthWarning;
      try {
        // NON-authoritative diagnostics (report-only; NEVER drive the U13 result).
        const totalDbBytes = deps.db.withReadConnection((db) => {
          const pageCount = db.pragma("page_count", { simple: true }) as number;
          const pageSize = db.pragma("page_size", { simple: true }) as number;
          return pageCount * pageSize;
        });
        const realtimeEventsEstimatedBytes = deps.db.withReadConnection((db) => {
          const countRow = db.prepare(REALTIME_EVENTS_ROWCOUNT_PROXY_SQL).get() as
            | { max_rowid: number | null }
            | undefined;
          const rowCount = countRow?.max_rowid ?? 0;
          const sampleRow = db.prepare(REALTIME_EVENTS_SAMPLE_BYTES_SQL).get() as
            | { avg_bytes: number | null }
            | undefined;
          const avgBytes = sampleRow?.avg_bytes ?? 0;
          return Math.round(avgBytes * rowCount);
        });
        // AUTHORITATIVE inputs: free + capacity from the injected statfs probe; an
        // optional growth-rate probe for the projected-exhaustion branch. A missing
        // or null free/capacity reading → classifyDiskGrowth fails closed to
        // `unknown` (never assumes healthy free space).
        const probe = deps.probeDiskSpace ? deps.probeDiskSpace() : null;
        const growthRateBytesPerDay = deps.probeGrowthRateBytesPerDay
          ? deps.probeGrowthRateBytesPerDay()
          : null;
        detail = classifyDiskGrowth({
          freeBytes: probe ? probe.freeBytes : null,
          totalCapacityBytes: probe ? probe.totalBytes : null,
          growthRateBytesPerDay,
          diagnostics: { totalDbBytes, realtimeEventsEstimatedBytes },
        });
      } catch (err) {
        // FAIL-CLOSED: an unknown DB read / probe error reports `unknown` (never
        // `ok`) and performs NO deletion. Report-only.
        detail = failClosedDiskGrowth(err instanceof Error ? err.message : String(err));
      }
      // Report-only: the reading rides in the check `detail` and is surfaced ONLY
      // via the monitor's run summary → transition-only logs (Hub onRunComplete)
      // and the owner-bound readback holder. NOT on any observability/HTTP route.
      return {
        name: "disk_growth",
        healthy: detail.status === "ok",
        value: detail.freeBytes ?? -1,
        unit: "bytes",
        detail,
      };
    },
    // No maintenance: diagnose-only. Disk pressure here can ONLY warn — never prune/vacuum/delete.
  },
  {
    name: "process_heap",
    check: () => {
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return { name: "process_heap", healthy: heapMB < 512, value: heapMB, unit: "MB" };
    },
    // Heap pressure is report-only; it has no local maintenance cleanup.
  },
];

function sevenDaysBefore(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeMaintenanceGate(
  gate: FridaySystemHealthMaintenanceGate | undefined,
): FridaySystemHealthMaintenanceGate | undefined {
  const requestedBy = gate?.requestedBy.trim();
  const reason = gate?.reason.trim();
  const approvedAt = gate?.approvedAt.trim();

  if (!requestedBy || !reason || !approvedAt) {
    return undefined;
  }

  const approvalRef = gate?.approvalRef?.trim();
  return approvalRef ? { requestedBy, reason, approvedAt, approvalRef } : { requestedBy, reason, approvedAt };
}

function createMaintenanceReceipt(input: {
  gate: FridaySystemHealthMaintenanceGate;
  name: string;
  status: "applied" | "failed";
  detail: string;
  runAt: string;
  nonReversibleReason: string;
  beforeValue: number;
  unit: string;
  changes?: number;
}): FridaySystemHealthMaintenanceReceipt {
  const evidence = input.changes == null
    ? { beforeValue: input.beforeValue, unit: input.unit }
    : { beforeValue: input.beforeValue, unit: input.unit, changes: input.changes };
  const base = {
    receiptId: `system-health-maintenance:${input.name}:${input.runAt}`,
    name: input.name,
    status: input.status,
    detail: input.detail,
    runAt: input.runAt,
    requestedBy: input.gate.requestedBy,
    reason: input.gate.reason,
    approvedAt: input.gate.approvedAt,
    rollbackClass: "non_reversible_local" as const,
    nonReversibleReason: input.nonReversibleReason,
    evidence,
  };

  return input.gate.approvalRef ? { ...base, approvalRef: input.gate.approvalRef } : base;
}

// ─── Factory ───

export function createFridaySystemHealthMonitor(
  deps: CreateSystemHealthMonitorDeps,
): FridaySystemHealthMonitor {
  return {
    runAll(options) {
      const checks: FridaySystemHealthResult[] = [];
      const maintenanceRecommendations: FridaySystemHealthMaintenanceRecommendation[] = [];
      const maintenanceReceipts: FridaySystemHealthMaintenanceReceipt[] = [];
      const runAt = deps.nowIso();
      const maintenanceGate = normalizeMaintenanceGate(options?.maintenanceGate);

      for (const healthCheck of HEALTH_CHECKS) {
        try {
          const result = healthCheck.check(deps);
          checks.push(result);

          if (!result.healthy && healthCheck.maintenance) {
            if (!maintenanceGate) {
              maintenanceRecommendations.push({
                name: healthCheck.name,
                gateRequired: "explicit_maintenance",
                detail: healthCheck.maintenance.detail,
                value: result.value,
                unit: result.unit,
              });
              continue;
            }

            try {
              const maintenanceResult = healthCheck.maintenance.run(deps);
              maintenanceReceipts.push(createMaintenanceReceipt({
                gate: maintenanceGate,
                name: healthCheck.name,
                status: "applied",
                detail: maintenanceResult.detail,
                runAt,
                nonReversibleReason: healthCheck.maintenance.nonReversibleReason,
                beforeValue: result.value,
                unit: result.unit,
                changes: maintenanceResult.changes,
              }));
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              maintenanceReceipts.push(createMaintenanceReceipt({
                gate: maintenanceGate,
                name: healthCheck.name,
                status: "failed",
                detail: `Maintenance failed: ${message}`,
                runAt,
                nonReversibleReason: healthCheck.maintenance.nonReversibleReason,
                beforeValue: result.value,
                unit: result.unit,
              }));
            }
          }
        } catch {
          checks.push({ name: healthCheck.name, healthy: false, value: -1, unit: "error" });
        }
      }

      const summary: FridaySystemHealthRunSummary = {
        checks,
        maintenanceRecommendations,
        maintenanceReceipts,
        runAt,
      };

      if (deps.onRunComplete) {
        try {
          deps.onRunComplete(summary);
        } catch {
          // Callback errors are swallowed
        }
      }

      return summary;
    },
  };
}
