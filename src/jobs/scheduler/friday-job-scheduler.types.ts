// ─── Schedule types ───

/** Schedule kind discriminator. */
export type FridayJobScheduleKind = "at" | "every" | "cron" | "interval";

/**
 * Multi-schedule definition.
 *
 * - `at`: Run once at an absolute ISO timestamp. One-shot, auto-disables after execution.
 * - `every`: Run every N ms, optionally anchored to a specific epoch.
 * - `cron`: Run on a cron expression with optional timezone.
 * - `interval`: Alias for `every` — backward compatibility with `intervalMs`.
 */
export type FridayJobSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; cronExpr: string; tz?: string }
  | { kind: "interval"; intervalMs: number };

// ─── Job definition ───

export interface FridayScheduledJobDefinition {
  /** Unique identifier for this job. */
  id: string;
  /**
   * Interval between runs in milliseconds.
   * @deprecated Use `schedule` instead. Kept for backward compatibility.
   */
  intervalMs?: number;
  /** Multi-schedule definition. When absent, falls back to `intervalMs` as `every`. */
  schedule?: FridayJobSchedule;
  /** Max execution time before timeout (default 600_000ms). */
  timeoutMs?: number;
  /** Max catch-up runs on startup for overdue jobs (default 1). */
  catchUpRuns?: number;
  /** The job function to execute. */
  run: () => Promise<unknown>;
}

// ─── Service ───

export interface FridayJobSchedulerService {
  start(): Promise<void>;
  /** F11: stop() is async — awaits in-flight run loop before resolving. */
  stop(): Promise<void>;
  wakeNow(reason?: string): void;
  status(): Promise<FridayJobSchedulerStatus>;

  /**
   * Register a new job definition at runtime (e.g. from cron tool).
   * The job is added to the in-memory map so the scheduler can execute it.
   */
  registerDynamicJob(job: FridayScheduledJobDefinition): void;

  /**
   * Update the schedule of an existing in-memory job definition.
   * Used when cron update changes the schedule fields — ensures the scheduler
   * computes next-run from the new schedule, not the stale definition.
   */
  updateJobSchedule(jobId: string, schedule: FridayJobSchedule): void;
}

export interface FridayJobSchedulerStatus {
  enabled: boolean;
  running: boolean;
  jobs: number;
  nextWakeAt?: string;
}

// ─── Persisted state ───

export interface FridaySchedulerJobState {
  id: string;
  intervalMs: number;
  timeoutMs: number;
  catchUpRuns: number;
  enabled: boolean;
  nextRunAt: string | null;
  runningAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | "timeout" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
  /** Schedule kind — defaults to 'every' for legacy rows. */
  scheduleKind: FridayJobScheduleKind;
  scheduleAt: string | null;
  scheduleEveryMs: number | null;
  scheduleAnchorMs: number | null;
  scheduleCronExpr: string | null;
  scheduleTz: string | null;
}

// ─── Constants ───

/** Backoff schedule in milliseconds: [30s, 60s, 5m, 15m, 60m]. */
export const FRIDAY_SCHEDULER_BACKOFF_MS = [
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
] as const;

/** Maximum timer delay before clamping (60s). */
export const FRIDAY_SCHEDULER_MAX_TIMER_DELAY_MS = 60_000;

/** Default execution timeout per job (600s). */
export const FRIDAY_SCHEDULER_DEFAULT_TIMEOUT_MS = 600_000;

/** Default catch-up runs on startup. */
export const FRIDAY_SCHEDULER_DEFAULT_CATCH_UP_RUNS = 1;
