import type { FridaySqliteLayer } from "#state";
import type { FridayJobScheduleKind, FridaySchedulerJobState } from "./friday-job-scheduler.types.js";

// ─── Raw DB row ───

interface SchedulerJobRow {
  id: string;
  interval_ms: number;
  timeout_ms: number;
  catch_up_runs: number;
  enabled: number;
  next_run_at: string | null;
  running_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  schedule_kind: string;
  schedule_at: string | null;
  schedule_every_ms: number | null;
  schedule_anchor_ms: number | null;
  schedule_cron_expr: string | null;
  schedule_tz: string | null;
}

// ─── Interface ───

export interface FridayJobSchedulerRepository {
  /** Get all registered jobs. */
  listAll(): FridaySchedulerJobState[];

  /** Get a single job by ID. */
  getById(id: string): FridaySchedulerJobState | null;

  /** Upsert a job definition (called at scheduler start). */
  upsert(job: {
    id: string;
    intervalMs: number;
    timeoutMs: number;
    catchUpRuns: number;
    nowIso: string;
    scheduleKind?: FridayJobScheduleKind;
    scheduleAt?: string | null;
    scheduleEveryMs?: number | null;
    scheduleAnchorMs?: number | null;
    scheduleCronExpr?: string | null;
    scheduleTz?: string | null;
  }): void;

  /** Mark job as running. */
  markRunning(id: string, nowIso: string): void;

  /** Mark job as completed (ok). */
  markCompleted(id: string, durationMs: number, nextRunAt: string, nowIso: string): void;

  /** Mark job as failed with error. */
  markFailed(id: string, error: string, durationMs: number, nextRunAt: string, nowIso: string): void;

  /** Mark job as timed out. */
  markTimedOut(id: string, durationMs: number, nextRunAt: string, nowIso: string): void;

  /** Clear stale running_at markers (for crash recovery). */
  clearStaleRunning(nowIso: string): number;

  /** List jobs that are due to run. */
  listDue(nowIso: string): FridaySchedulerJobState[];

  /** Update next_run_at for a job. */
  setNextRunAt(id: string, nextRunAt: string, nowIso: string): void;

  /** Disable a job (for one-shot "at" after execution). */
  disableJob(id: string, nowIso: string): void;

  /** Enable a job and keep its existing next_run_at. */
  enableJob(id: string, nowIso: string): void;
}

// ─── Factory ───

export function createFridayJobSchedulerRepository(deps: {
  db: FridaySqliteLayer;
}): FridayJobSchedulerRepository {
  const { db } = deps;

  return {
    listAll(): FridaySchedulerJobState[] {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare("SELECT * FROM friday_scheduler_jobs ORDER BY id")
          .all() as SchedulerJobRow[];
        return rows.map(mapRow);
      });
    },

    getById(id: string): FridaySchedulerJobState | null {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare("SELECT * FROM friday_scheduler_jobs WHERE id = ?")
          .get(id) as SchedulerJobRow | undefined;
        return row ? mapRow(row) : null;
      });
    },

    upsert(job): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_scheduler_jobs (id, interval_ms, timeout_ms, catch_up_runs, enabled, schedule_kind, schedule_at, schedule_every_ms, schedule_anchor_ms, schedule_cron_expr, schedule_tz, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id)
             DO UPDATE SET interval_ms = excluded.interval_ms,
                           timeout_ms = excluded.timeout_ms,
                           catch_up_runs = excluded.catch_up_runs,
                           schedule_kind = excluded.schedule_kind,
                           schedule_at = excluded.schedule_at,
                           schedule_every_ms = excluded.schedule_every_ms,
                           schedule_anchor_ms = excluded.schedule_anchor_ms,
                           schedule_cron_expr = excluded.schedule_cron_expr,
                           schedule_tz = excluded.schedule_tz,
                           updated_at = excluded.updated_at`,
          )
          .run(
            job.id,
            job.intervalMs,
            job.timeoutMs,
            job.catchUpRuns,
            job.scheduleKind ?? "every",
            job.scheduleAt ?? null,
            job.scheduleEveryMs ?? null,
            job.scheduleAnchorMs ?? null,
            job.scheduleCronExpr ?? null,
            job.scheduleTz ?? null,
            job.nowIso,
            job.nowIso,
          );
      });
    },

    markRunning(id: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare("UPDATE friday_scheduler_jobs SET running_at = ?, updated_at = ? WHERE id = ?")
          .run(nowIso, nowIso, id);
      });
    },

    markCompleted(id: string, durationMs: number, nextRunAt: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `UPDATE friday_scheduler_jobs
             SET running_at = NULL,
                 last_run_at = ?,
                 last_status = 'ok',
                 last_error = NULL,
                 last_duration_ms = ?,
                 consecutive_failures = 0,
                 next_run_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, durationMs, nextRunAt, nowIso, id);
      });
    },

    markFailed(id: string, error: string, durationMs: number, nextRunAt: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `UPDATE friday_scheduler_jobs
             SET running_at = NULL,
                 last_run_at = ?,
                 last_status = 'error',
                 last_error = ?,
                 last_duration_ms = ?,
                 consecutive_failures = consecutive_failures + 1,
                 next_run_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, error, durationMs, nextRunAt, nowIso, id);
      });
    },

    markTimedOut(id: string, durationMs: number, nextRunAt: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `UPDATE friday_scheduler_jobs
             SET running_at = NULL,
                 last_run_at = ?,
                 last_status = 'timeout',
                 last_error = 'Execution timed out',
                 last_duration_ms = ?,
                 consecutive_failures = consecutive_failures + 1,
                 next_run_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(nowIso, durationMs, nextRunAt, nowIso, id);
      });
    },

    clearStaleRunning(nowIso: string): number {
      return db.withWriteTransaction((conn) => {
        const info = conn
          .prepare(
            `UPDATE friday_scheduler_jobs
             SET running_at = NULL,
                 last_status = 'error',
                 last_error = 'Stale running marker cleared on startup',
                 consecutive_failures = consecutive_failures + 1,
                 updated_at = ?
             WHERE running_at IS NOT NULL`,
          )
          .run(nowIso);
        return info.changes;
      });
    },

    listDue(nowIso: string): FridaySchedulerJobState[] {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM friday_scheduler_jobs
             WHERE enabled = 1
               AND running_at IS NULL
               AND next_run_at IS NOT NULL
               AND next_run_at <= ?
             ORDER BY next_run_at ASC`,
          )
          .all(nowIso) as SchedulerJobRow[];
        return rows.map(mapRow);
      });
    },

    setNextRunAt(id: string, nextRunAt: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare("UPDATE friday_scheduler_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(nextRunAt, nowIso, id);
      });
    },

    disableJob(id: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare("UPDATE friday_scheduler_jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?")
          .run(nowIso, id);
      });
    },

    enableJob(id: string, nowIso: string): void {
      db.withWriteTransaction((conn) => {
        conn
          .prepare("UPDATE friday_scheduler_jobs SET enabled = 1, updated_at = ? WHERE id = ?")
          .run(nowIso, id);
      });
    },
  };
}

// ─── Mapper ───

function mapRow(row: SchedulerJobRow): FridaySchedulerJobState {
  return {
    id: row.id,
    intervalMs: row.interval_ms,
    timeoutMs: row.timeout_ms,
    catchUpRuns: row.catch_up_runs,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    runningAt: row.running_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as FridaySchedulerJobState["lastStatus"],
    lastError: row.last_error,
    lastDurationMs: row.last_duration_ms,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduleKind: (row.schedule_kind ?? "every") as FridayJobScheduleKind,
    scheduleAt: row.schedule_at,
    scheduleEveryMs: row.schedule_every_ms,
    scheduleAnchorMs: row.schedule_anchor_ms,
    scheduleCronExpr: row.schedule_cron_expr,
    scheduleTz: row.schedule_tz,
  };
}
