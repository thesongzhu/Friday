/**
 * Unified Job Scheduler Service
 *
 * Wraps existing job modules with persistent state, catch-up on startup,
 * per-job timeout, exponential backoff, and safe timer behavior.
 *
 * Supports multiple schedule kinds:
 *   - at: one-shot absolute time (auto-disables after execution)
 *   - every: repeating interval with optional anchor
 *   - cron: cron expression with optional timezone
 *   - interval: legacy alias for every
 *
 * OpenClaw-derived guards:
 *   - Max timer delay clamp: 60_000ms
 *   - Default timeout per run: 600_000ms
 *   - Error backoff schedule: [30s, 60s, 5m, 15m, 60m]
 *   - Re-arm timer when scheduler is already running
 */

import type { FridayJobSchedulerRepository } from "./friday-job-scheduler-repository.js";
import type {
  FridayJobSchedule,
  FridayJobSchedulerService,
  FridayJobSchedulerStatus,
  FridayScheduledJobDefinition,
} from "./friday-job-scheduler.types.js";
import {
  FRIDAY_SCHEDULER_BACKOFF_MS,
  FRIDAY_SCHEDULER_DEFAULT_CATCH_UP_RUNS,
  FRIDAY_SCHEDULER_DEFAULT_TIMEOUT_MS,
  FRIDAY_SCHEDULER_MAX_TIMER_DELAY_MS,
} from "./friday-job-scheduler.types.js";
import {
  computeNextRunAtMs,
  resolveJobSchedule,
  scheduleFromState,
  scheduleToIntervalMs,
} from "./friday-job-schedule-utils.js";

// ─── Dependencies ───

export interface CreateFridayJobSchedulerServiceDeps {
  repository: FridayJobSchedulerRepository;
  jobs: FridayScheduledJobDefinition[];
  nowIso?: () => string;
  nowMs?: () => number;
}

// ─── Factory ───

export function createFridayJobSchedulerService(
  deps: CreateFridayJobSchedulerServiceDeps,
): FridayJobSchedulerService {
  const { repository, jobs } = deps;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Job lookup
  const jobMap = new Map<string, FridayScheduledJobDefinition>();
  for (const job of jobs) {
    jobMap.set(job.id, job);
  }

  let enabled = false;
  let running = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let nextWakeAt: string | undefined;
  let pendingWake = false;

  // F11: Track the in-flight run loop promise so stop() can await it
  let inFlightRunLoopPromise: Promise<void> | null = null;

  // ─── Timer management ───

  function armTimer(delayMs: number): void {
    if (wakeTimer) clearTimeout(wakeTimer);

    // Clamp to max timer delay
    const clamped = Math.min(delayMs, FRIDAY_SCHEDULER_MAX_TIMER_DELAY_MS);
    nextWakeAt = new Date(nowMs() + clamped).toISOString();

    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      nextWakeAt = undefined;
      const p = runLoop();
      inFlightRunLoopPromise = p;
      p.catch((err) => {
        console.error("[friday] Job scheduler run loop failed:", err instanceof Error ? err.message : String(err));
      }).finally(() => {
        if (inFlightRunLoopPromise === p) inFlightRunLoopPromise = null;
      });
    }, clamped);
  }

  function cancelTimer(): void {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
      nextWakeAt = undefined;
    }
  }

  // ─── Resolve schedule for a job definition ───

  function getJobSchedule(jobDef: FridayScheduledJobDefinition): FridayJobSchedule {
    return resolveJobSchedule(jobDef);
  }

  // ─── Constants for at-job backoff ───

  /** Max retries for one-shot "at" jobs before disabling. */
  const AT_JOB_MAX_RETRIES = 3;

  /** Base backoff for at-job retries: min(30s * 2^failures, 1h). */
  function atJobBackoffMs(failures: number): number {
    return Math.min(30_000 * Math.pow(2, failures), 3_600_000);
  }

  // ─── Unschedulable job helper ───

  /** Disable a job whose schedule cannot compute a next run (prevents hot-loops). */
  function handleUnschedulableJob(jobId: string, reason: string): void {
    console.warn(`[scheduler] Disabling job "${jobId}": ${reason}`);
    repository.disableJob(jobId, nowIso());
  }

  // ─── Compute next run with backoff ───

  function computeNextRunAt(jobDef: FridayScheduledJobDefinition, consecutiveFailures: number): string | null {
    const schedule = getJobSchedule(jobDef);

    // For one-shot "at" jobs: no next run on success; exponential backoff on failure
    if (schedule.kind === "at") {
      if (consecutiveFailures > 0) {
        return new Date(nowMs() + atJobBackoffMs(consecutiveFailures)).toISOString();
      }
      return null;
    }

    const baseMs = computeNextRunAtMs(schedule, nowMs());
    if (baseMs == null) return null;

    if (consecutiveFailures > 0) {
      const backoffIndex = Math.min(consecutiveFailures - 1, FRIDAY_SCHEDULER_BACKOFF_MS.length - 1);
      const backoffMs = FRIDAY_SCHEDULER_BACKOFF_MS[backoffIndex]!;
      // Use the later of: scheduled time or now + backoff
      const backoffTarget = nowMs() + backoffMs;
      return new Date(Math.max(baseMs, backoffTarget)).toISOString();
    }

    return new Date(baseMs).toISOString();
  }

  // ─── Execute a single job with timeout ───

  async function executeJob(jobDef: FridayScheduledJobDefinition, jobId: string): Promise<void> {
    const timeoutMs = jobDef.timeoutMs ?? FRIDAY_SCHEDULER_DEFAULT_TIMEOUT_MS;
    const startMs = nowMs();
    const schedule = getJobSchedule(jobDef);

    repository.markRunning(jobId, nowIso());

    try {
      await Promise.race([
        jobDef.run(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("SCHEDULER_JOB_TIMEOUT")), timeoutMs);
        }),
      ]);

      const durationMs = nowMs() - startMs;
      const nextRunAt = computeNextRunAt(jobDef, 0);

      if (schedule.kind === "at") {
        // One-shot: mark completed and disable
        repository.markCompleted(jobId, durationMs, nowIso(), nowIso());
        repository.disableJob(jobId, nowIso());
      } else if (nextRunAt == null) {
        // Schedule cannot compute next run — disable to prevent hot-loop
        repository.markCompleted(jobId, durationMs, nowIso(), nowIso());
        handleUnschedulableJob(jobId, "schedule returned no next run after successful execution");
      } else {
        repository.markCompleted(jobId, durationMs, nextRunAt, nowIso());
      }
    } catch (err) {
      const durationMs = nowMs() - startMs;
      const isTimeout = err instanceof Error && err.message === "SCHEDULER_JOB_TIMEOUT";

      // Fetch current state to get consecutiveFailures
      const state = repository.getById(jobId);
      const failures = (state?.consecutiveFailures ?? 0) + 1;
      const nextRunAt = computeNextRunAt(jobDef, failures);

      if (schedule.kind !== "at" && nextRunAt == null) {
        // Schedule cannot compute next run — record error then disable
        if (isTimeout) {
          repository.markTimedOut(jobId, durationMs, nowIso(), nowIso());
        } else {
          const errorMsg = err instanceof Error ? err.message : String(err);
          repository.markFailed(jobId, errorMsg, durationMs, nowIso(), nowIso());
        }
        handleUnschedulableJob(jobId, "schedule returned no next run after failed execution");
      } else if (isTimeout) {
        repository.markTimedOut(jobId, durationMs, nextRunAt ?? nowIso(), nowIso());
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        repository.markFailed(jobId, errorMsg, durationMs, nextRunAt ?? nowIso(), nowIso());
      }

      // For one-shot "at" jobs: disable after max retries to prevent hot-looping
      if (schedule.kind === "at" && failures >= AT_JOB_MAX_RETRIES) {
        repository.disableJob(jobId, nowIso());
      }
    }
  }

  // ─── Run loop ───

  async function runLoop(): Promise<void> {
    if (!enabled) return;

    if (running) {
      // Re-arm: schedule another wake after current run finishes
      pendingWake = true;
      return;
    }

    running = true;

    try {
      const dueJobs = repository.listDue(nowIso());

      for (const dueState of dueJobs) {
        if (!enabled) break;

        const jobDef = jobMap.get(dueState.id);
        if (!jobDef) continue;

        await executeJob(jobDef, dueState.id);
      }
    } finally {
      running = false;

      if (enabled) {
        // Determine next wake time
        const allJobs = repository.listAll();
        let earliestMs = Infinity;

        for (const job of allJobs) {
          if (!job.enabled || !job.nextRunAt) continue;
          const runAtMs = new Date(job.nextRunAt).getTime();
          if (runAtMs < earliestMs) earliestMs = runAtMs;
        }

        if (earliestMs < Infinity) {
          const delayMs = Math.max(0, earliestMs - nowMs());
          armTimer(delayMs);
        }

        // Handle pending re-arm
        if (pendingWake) {
          pendingWake = false;
          // Immediate re-check
          armTimer(0);
        }
      }
    }
  }

  // ─── Catch-up logic (F9: respect catchUpRuns, schedule-kind aware) ───

  async function runCatchUp(): Promise<void> {
    const allJobs = repository.listAll();

    for (const jobState of allJobs) {
      const jobDef = jobMap.get(jobState.id);
      if (!jobDef || !jobState.enabled) continue;

      const catchUpRuns = jobDef.catchUpRuns ?? FRIDAY_SCHEDULER_DEFAULT_CATCH_UP_RUNS;
      if (catchUpRuns <= 0) continue;

      // If job has a next_run_at in the past, it's overdue
      if (jobState.nextRunAt && new Date(jobState.nextRunAt).getTime() < nowMs()) {
        const schedule = getJobSchedule(jobDef);

        if (schedule.kind === "at") {
          // One-shot: run exactly once on catch-up
          await executeJob(jobDef, jobState.id);
        } else if (schedule.kind === "cron") {
          // Cron: run once on catch-up (cron intervals aren't fixed-size)
          const runsToExecute = Math.min(1, catchUpRuns);
          for (let i = 0; i < runsToExecute; i++) {
            await executeJob(jobDef, jobState.id);
          }
        } else {
          // every / interval: compute missed intervals
          const effectiveMs = scheduleToIntervalMs(schedule);
          if (effectiveMs <= 0) continue;

          const overdueMs = nowMs() - new Date(jobState.nextRunAt).getTime();
          const missed = Math.floor(overdueMs / effectiveMs) + 1;
          const runsToExecute = Math.min(missed, catchUpRuns);

          for (let i = 0; i < runsToExecute; i++) {
            await executeJob(jobDef, jobState.id);
          }
        }
      }
    }
  }

  // ─── Upsert schedule fields helper ───

  function buildUpsertFields(jobDef: FridayScheduledJobDefinition) {
    const schedule = getJobSchedule(jobDef);
    const base = {
      id: jobDef.id,
      intervalMs: scheduleToIntervalMs(schedule),
      timeoutMs: jobDef.timeoutMs ?? FRIDAY_SCHEDULER_DEFAULT_TIMEOUT_MS,
      catchUpRuns: jobDef.catchUpRuns ?? FRIDAY_SCHEDULER_DEFAULT_CATCH_UP_RUNS,
      scheduleKind: schedule.kind,
      scheduleAt: null as string | null,
      scheduleEveryMs: null as number | null,
      scheduleAnchorMs: null as number | null,
      scheduleCronExpr: null as string | null,
      scheduleTz: null as string | null,
    };

    switch (schedule.kind) {
      case "at":
        base.scheduleAt = schedule.at;
        break;
      case "every":
        base.scheduleEveryMs = schedule.everyMs;
        base.scheduleAnchorMs = schedule.anchorMs ?? null;
        break;
      case "cron":
        base.scheduleCronExpr = schedule.cronExpr;
        base.scheduleTz = schedule.tz ?? null;
        break;
      case "interval":
        base.scheduleEveryMs = schedule.intervalMs;
        break;
    }

    return base;
  }

  // ─── Service interface ───

  return {
    async start(): Promise<void> {
      if (enabled) return;
      enabled = true;

      const now = nowIso();

      // Seed/upsert all job definitions
      for (const jobDef of jobs) {
        const fields = buildUpsertFields(jobDef);
        repository.upsert({ ...fields, nowIso: now });

        // Set initial next_run_at if not already set
        const existing = repository.getById(jobDef.id);
        if (existing && !existing.nextRunAt) {
          const schedule = getJobSchedule(jobDef);
          if (schedule.kind === "at") {
            // For "at" jobs, set next_run_at to the target time
            repository.setNextRunAt(jobDef.id, schedule.at, now);
          } else if (
            (schedule.kind === "every" && schedule.anchorMs != null) ||
            schedule.kind === "cron"
          ) {
            // Anchored every / cron: compute proper first run time so they
            // don't fire immediately before their intended schedule.
            const nextMs = computeNextRunAtMs(schedule, nowMs());
            if (nextMs == null) {
              // Invalid schedule — disable immediately to prevent hot-loop
              handleUnschedulableJob(jobDef.id, "cannot compute initial next run from schedule");
              continue;
            }
            const nextIso = new Date(nextMs).toISOString();
            repository.setNextRunAt(jobDef.id, nextIso, now);
          } else {
            // Plain every / interval: immediate first run (backward compat)
            repository.setNextRunAt(jobDef.id, now, now);
          }
        }
      }

      // Clear stale running markers (crash recovery)
      repository.clearStaleRunning(now);

      // Run catch-up for overdue jobs
      await runCatchUp();

      // Start the run loop
      const p = runLoop();
      inFlightRunLoopPromise = p;
      p.catch((err) => {
        console.error("[friday] Job scheduler run loop failed:", err instanceof Error ? err.message : String(err));
      }).finally(() => {
        if (inFlightRunLoopPromise === p) inFlightRunLoopPromise = null;
      });
      await p;
    },

    // F11: stop() is async and awaits the in-flight run loop promise
    async stop(): Promise<void> {
      enabled = false;
      cancelTimer();

      // Await in-flight run loop if any
      if (inFlightRunLoopPromise) {
        await inFlightRunLoopPromise.catch((err) => {
          console.error("[friday] Job scheduler run loop failed during stop:", err instanceof Error ? err.message : String(err));
        });
        inFlightRunLoopPromise = null;
      }
    },

    wakeNow(reason?: string): void {
      if (!enabled) return;
      armTimer(0);
    },

    async status(): Promise<FridayJobSchedulerStatus> {
      const allJobs = repository.listAll();
      return {
        enabled,
        running,
        jobs: allJobs.length,
        nextWakeAt,
      };
    },

    registerDynamicJob(job: FridayScheduledJobDefinition): void {
      jobMap.set(job.id, job);
    },

    updateJobSchedule(jobId: string, schedule: FridayJobSchedule): void {
      const existing = jobMap.get(jobId);
      if (existing) {
        // Replace the schedule on the in-memory definition so
        // computeNextRunAt uses the updated value.
        existing.schedule = schedule;
      }
    },
  };
}
