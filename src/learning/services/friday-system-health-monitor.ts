import type { FridaySqliteLayer } from "#state";

// ─── Types ───

export interface FridaySystemHealthResult {
  name: string;
  healthy: boolean;
  value: number;
  unit: string;
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
      detail: "Prune expired memory items in a bounded local batch",
      nonReversibleReason: "Expired memory item deletion removes local rows and cannot be reconstructed by Friday.",
      run: (deps) => {
        const nowIso = deps.nowIso();
        const result = deps.db.withWriteTransaction((db) =>
          db
            .prepare("DELETE FROM memory_items WHERE rowid IN (SELECT rowid FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 200)")
            .run(nowIso),
        );
        const pruned = (result as { changes?: number })?.changes ?? 0;
        return { detail: `Pruned ${pruned} expired memory items`, changes: pruned };
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
