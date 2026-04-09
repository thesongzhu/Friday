import type { FridaySqliteLayer } from "#state";

// ─── Types ───

export interface FridaySystemHealthResult {
  name: string;
  healthy: boolean;
  value: number;
  unit: string;
}

export interface FridaySystemAutoFixResult {
  name: string;
  fixed: boolean;
  detail: string;
}

export interface FridaySystemHealthRunSummary {
  checks: FridaySystemHealthResult[];
  autoFixes: FridaySystemAutoFixResult[];
  runAt: string;
}

export interface FridaySystemHealthMonitor {
  runAll(): FridaySystemHealthRunSummary;
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
  autoFix?: (deps: CreateSystemHealthMonitorDeps) => FridaySystemAutoFixResult;
}

const HEALTH_CHECKS: HealthCheck[] = [
  {
    name: "db_size",
    check: (deps) => {
      const row = deps.db.withReadConnection((db) =>
        db.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get(),
      ) as { size: number } | undefined;
      const sizeBytes = row?.size ?? 0;
      return { name: "db_size", healthy: sizeBytes < 500_000_000, value: sizeBytes, unit: "bytes" };
    },
    autoFix: (deps) => {
      // Incremental vacuum: reclaim free pages without full rebuild
      deps.db.withWriteTransaction((db) => {
        db.pragma("incremental_vacuum(100)");
      });
      return { name: "db_size", fixed: true, detail: "Ran incremental vacuum (up to 100 pages)" };
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
    autoFix: (deps) => {
      const nowIso = deps.nowIso();
      const result = deps.db.withWriteTransaction((db) =>
        db
          .prepare("DELETE FROM memory_items WHERE rowid IN (SELECT rowid FROM memory_items WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 200)")
          .run(nowIso),
      );
      const pruned = (result as { changes?: number })?.changes ?? 0;
      return { name: "expired_memory_items", fixed: true, detail: `Pruned ${pruned} expired memory items` };
    },
  },
  {
    name: "stale_realtime_checkpoints",
    check: (deps) => {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT COUNT(*) AS cnt FROM realtime_event_checkpoints WHERE updated_at < ?")
          .get(cutoff),
      ) as { cnt: number } | undefined;
      const count = row?.cnt ?? 0;
      return { name: "stale_realtime_checkpoints", healthy: count < 1000, value: count, unit: "checkpoints" };
    },
    autoFix: (deps) => {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const result = deps.db.withWriteTransaction((db) =>
        db.prepare("DELETE FROM realtime_event_checkpoints WHERE updated_at < ?").run(cutoff),
      );
      const pruned = (result as { changes?: number })?.changes ?? 0;
      return { name: "stale_realtime_checkpoints", fixed: true, detail: `Pruned ${pruned} stale checkpoints` };
    },
  },
  {
    name: "process_heap",
    check: () => {
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return { name: "process_heap", healthy: heapMB < 512, value: heapMB, unit: "MB" };
    },
    // No auto-fix for heap — report only
  },
];

// ─── Factory ───

export function createFridaySystemHealthMonitor(
  deps: CreateSystemHealthMonitorDeps,
): FridaySystemHealthMonitor {
  return {
    runAll() {
      const checks: FridaySystemHealthResult[] = [];
      const autoFixes: FridaySystemAutoFixResult[] = [];
      const runAt = deps.nowIso();

      for (const healthCheck of HEALTH_CHECKS) {
        try {
          const result = healthCheck.check(deps);
          checks.push(result);

          if (!result.healthy && healthCheck.autoFix) {
            try {
              const fixResult = healthCheck.autoFix(deps);
              autoFixes.push(fixResult);
            } catch {
              autoFixes.push({ name: healthCheck.name, fixed: false, detail: "Auto-fix threw an error" });
            }
          }
        } catch {
          checks.push({ name: healthCheck.name, healthy: false, value: -1, unit: "error" });
        }
      }

      const summary: FridaySystemHealthRunSummary = { checks, autoFixes, runAt };

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
