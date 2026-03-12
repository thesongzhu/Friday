/**
 * Job Schedule Utilities
 *
 * Computes next-run timestamps for each schedule kind:
 * - at: absolute one-shot
 * - every: repeating interval with optional anchor
 * - cron: cron expression with optional timezone
 * - interval: alias for every (backward compat)
 */

import { CronExpressionParser } from "cron-parser";
import type { FridayJobSchedule, FridayJobScheduleKind } from "./friday-job-scheduler.types.js";

/**
 * Resolve a FridayJobSchedule from a job definition.
 * Handles backward compatibility: if no `schedule` is provided, falls back to `intervalMs`.
 */
export function resolveJobSchedule(def: {
  schedule?: FridayJobSchedule;
  intervalMs?: number;
}): FridayJobSchedule {
  if (def.schedule) return def.schedule;
  if (def.intervalMs != null) return { kind: "every", everyMs: def.intervalMs };
  throw new Error("Job definition must specify either schedule or intervalMs");
}

/**
 * Compute the effective intervalMs for backward compatibility.
 * Returns the everyMs/intervalMs value, or 0 for at/cron schedules.
 */
export function scheduleToIntervalMs(schedule: FridayJobSchedule): number {
  switch (schedule.kind) {
    case "every":
      return schedule.everyMs;
    case "interval":
      return schedule.intervalMs;
    case "at":
    case "cron":
      return 0;
  }
}

/**
 * Compute the next run timestamp in milliseconds for the given schedule.
 *
 * @param schedule - The schedule definition
 * @param nowMs - Current time in ms
 * @param consecutiveFailures - For backoff calculation (caller handles backoff separately)
 * @returns Epoch ms of next run, or null if schedule is exhausted (one-shot "at" already past)
 */
export function computeNextRunAtMs(
  schedule: FridayJobSchedule,
  nowMs: number,
): number | null {
  switch (schedule.kind) {
    case "at": {
      const atMs = new Date(schedule.at).getTime();
      if (isNaN(atMs)) return null;
      // If the "at" time is in the past, return it so catch-up can handle it
      return atMs;
    }

    case "every": {
      if (schedule.anchorMs != null) {
        // If now is before the anchor, clamp to anchor
        if (nowMs < schedule.anchorMs) {
          return schedule.anchorMs;
        }
        // Compute next aligned interval from anchor
        const elapsed = nowMs - schedule.anchorMs;
        const intervals = Math.ceil(elapsed / schedule.everyMs);
        const next = schedule.anchorMs + intervals * schedule.everyMs;
        // Safety: ensure result is never before anchor
        return Math.max(next, schedule.anchorMs);
      }
      return nowMs + schedule.everyMs;
    }

    case "cron": {
      try {
        const options: { currentDate?: Date; tz?: string } = {
          currentDate: new Date(nowMs),
        };
        if (schedule.tz) {
          options.tz = schedule.tz;
        }
        const interval = CronExpressionParser.parse(schedule.cronExpr, options);
        const next = interval.next();
        return next.getTime();
      } catch {
        return null;
      }
    }

    case "interval": {
      return nowMs + schedule.intervalMs;
    }
  }
}

/**
 * Validate a cron expression. Returns true if valid.
 */
export function isValidCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract schedule kind from a FridayJobSchedule.
 */
export function getScheduleKind(schedule: FridayJobSchedule): FridayJobScheduleKind {
  return schedule.kind;
}

/**
 * Reconstruct a FridayJobSchedule from persisted state fields.
 */
export function scheduleFromState(state: {
  scheduleKind: FridayJobScheduleKind;
  scheduleAt: string | null;
  scheduleEveryMs: number | null;
  scheduleAnchorMs: number | null;
  scheduleCronExpr: string | null;
  scheduleTz: string | null;
  intervalMs: number;
}): FridayJobSchedule {
  switch (state.scheduleKind) {
    case "at":
      return { kind: "at", at: state.scheduleAt! };
    case "every":
      return {
        kind: "every",
        everyMs: state.scheduleEveryMs ?? state.intervalMs,
        ...(state.scheduleAnchorMs != null ? { anchorMs: state.scheduleAnchorMs } : {}),
      };
    case "cron":
      return {
        kind: "cron",
        cronExpr: state.scheduleCronExpr!,
        ...(state.scheduleTz ? { tz: state.scheduleTz } : {}),
      };
    case "interval":
      return { kind: "interval", intervalMs: state.intervalMs };
  }
}
