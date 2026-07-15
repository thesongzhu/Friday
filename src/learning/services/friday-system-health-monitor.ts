import type { FridaySqliteLayer } from "#state";

// ─── Types ───

export interface FridaySystemHealthResult {
  name: string;
  healthy: boolean;
  value: number;
  unit: string;
  /**
   * Optional report-only diagnostic detail. Populated by diagnose-only checks
   * (e.g. `realtime_events_growth`) that surface richer, multi-field telemetry
   * than the binary healthy/value/unit shape. Never used to gate, schedule, or
   * perform any maintenance/deletion.
   */
  detail?: FridaySystemHealthGrowthDetail;
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
  /** Rows actually sampled for the byte average (≤ REALTIME_EVENTS_SAMPLE_SIZE). */
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
 * Narrow structural sink for report-only growth telemetry. Deliberately mirrors
 * the observability `FridayMetricsCollector.setGauge` signature so the real
 * collector satisfies it WITHOUT the monitor importing the observability engine.
 * The gauges (a numeric time series) are the durable readback surface for the
 * growth TREND; `status` + `reclaim_status` ride along as labels.
 */
export interface FridayHealthMetricsSink {
  setGauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
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
   * Optional report-only telemetry sink. When provided, the
   * `realtime_events_growth` check publishes its rows/bytes estimate (with
   * status + reclaim_status labels) so the growth trend lands in a durable,
   * readback-able surface. Never used for any deletion.
   */
  metricsSink?: FridayHealthMetricsSink;
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

/** Gauge names for the growth trend (durable readback via the metrics collector). */
export const REALTIME_EVENTS_ROWS_GAUGE = "friday.realtime_events.rows_estimate";
export const REALTIME_EVENTS_BYTES_GAUGE = "friday.realtime_events.bytes_estimate";

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
 * recent `REALTIME_EVENTS_SAMPLE_SIZE` rows in rowid order. The `LIMIT` caps the
 * payload reads; the rowid ordering avoids a full-table sort (no TEMP B-TREE).
 * Never a `SUM(...)` over the whole table.
 */
export const REALTIME_EVENTS_SAMPLE_BYTES_SQL =
  `SELECT AVG(LENGTH(CAST(payload_json AS BLOB))) AS avg_bytes ` +
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
    sampleSize: Math.min(REALTIME_EVENTS_SAMPLE_SIZE, Math.max(0, rowCount)),
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

/**
 * Publish the growth estimate to the metrics sink (report-only). Best-effort:
 * an unregistered gauge or any telemetry error must never break the health run.
 */
export function publishRealtimeEventsGrowthGauges(
  sink: FridayHealthMetricsSink | undefined,
  detail: FridaySystemHealthGrowthDetail,
): void {
  if (!sink) return;
  const labels = { status: detail.status, reclaim_status: detail.reclaim_status };
  try {
    sink.setGauge(REALTIME_EVENTS_ROWS_GAUGE, detail.rowCount, labels);
    sink.setGauge(REALTIME_EVENTS_BYTES_GAUGE, detail.estimatedBytes, labels);
  } catch {
    // Report-only telemetry is best-effort; swallow so health never fails on it.
  }
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
            | { avg_bytes: number | null }
            | undefined;
          const avgBytes = sampleRow?.avg_bytes ?? 0;
          const estimatedBytes = Math.round(avgBytes * rowCount);
          return classifyRealtimeEventsGrowth(rowCount, estimatedBytes);
        });
      } catch (err) {
        // FAIL-CLOSED: an unknown count/size reports degraded (never healthy) and
        // performs NO deletion. reclaim_status is still surfaced for the reader.
        detail = degradedRealtimeEventsGrowthDetail(err);
      }
      // Report-only readback: publish the trend to the durable metrics surface.
      publishRealtimeEventsGrowthGauges(deps.metricsSink, detail);
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
