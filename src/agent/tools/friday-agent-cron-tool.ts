import { CronExpressionParser } from "cron-parser";

import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayJobSchedulerRepository } from "../../jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridayJobSchedulerService } from "../../jobs/scheduler/friday-job-scheduler.types.js";
import { isValidCronExpression } from "../../jobs/scheduler/friday-job-schedule-utils.js";
import {
  errorResult,
  jsonResult,
  readBooleanParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Types ───

export interface CreateFridayAgentCronToolDeps {
  schedulerRepository: FridayJobSchedulerRepository;
  schedulerService: FridayJobSchedulerService;
  nowIso?: () => string;
  /**
   * Factory to build a run function for dynamically created jobs.
   * If not provided, dynamically created jobs will log a no-op warning when executed.
   */
  dynamicJobRunner?: (jobId: string, payload: Record<string, unknown>) => () => Promise<unknown>;
}

type CronAction = "list" | "create" | "update" | "delete" | "run";

const VALID_ACTIONS = new Set<CronAction>(["list", "create", "update", "delete", "run"]);

// ─── Factory ───

export function createFridayAgentCronTool(
  deps: CreateFridayAgentCronToolDeps,
): FridayAgentToolDefinition {
  const { schedulerRepository, schedulerService, dynamicJobRunner } = deps;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  return {
    name: "cron",
    description:
      "Manage scheduled jobs (cron). Actions: list (show all jobs), create (new scheduled job), " +
      "update (modify existing job), delete (disable/remove a job), run (trigger a job immediately).",
    parameters: {
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "delete", "run"],
          description: "Cron action to perform.",
        },
        id: {
          type: "string",
          description: "Job ID (required for create, update, delete, run).",
        },
        schedule: {
          type: "string",
          description: "Cron expression (e.g. '0 9 * * *'). Used for create/update.",
        },
        timezone: {
          type: "string",
          description: "Timezone for cron schedule (e.g. 'America/New_York'). Used for create/update.",
        },
        jobType: {
          type: "string",
          description: "Job type identifier (e.g. 'agent-task', 'workflow'). Used for create.",
        },
        payload: {
          type: "object",
          description: "Arbitrary payload for the job. Used for create/update.",
        },
        enabled: {
          type: "boolean",
          description: "Whether the job is enabled. Used for update.",
        },
      },
      required: ["action"],
    },

    async execute(
      args: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const action = readStringParam(args, "action", { required: true }) as CronAction;

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(
          `Invalid action "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`,
        );
      }

      try {
        switch (action) {
          case "list":
            return handleList();
          case "create":
            return handleCreate(args);
          case "update":
            return handleUpdate(args);
          case "delete":
            return handleDelete(args);
          case "run":
            return handleRun(args);
          default:
            return errorResult(`Unknown action: ${action as string}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  // ─── Action handlers ───

  function handleList(): FridayAgentToolResult {
    const jobs = schedulerRepository.listAll();
    return jsonResult({
      count: jobs.length,
      jobs: jobs.map((job) => ({
        id: job.id,
        enabled: job.enabled,
        scheduleKind: job.scheduleKind,
        scheduleCronExpr: job.scheduleCronExpr,
        scheduleTz: job.scheduleTz,
        intervalMs: job.intervalMs,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastStatus: job.lastStatus,
        lastError: job.lastError,
        lastDurationMs: job.lastDurationMs,
        consecutiveFailures: job.consecutiveFailures,
      })),
    });
  }

  function handleCreate(args: Record<string, unknown>): FridayAgentToolResult {
    const id = readStringParam(args, "id");
    const schedule = readStringParam(args, "schedule");
    const timezone = readStringParam(args, "timezone");
    const jobType = readStringParam(args, "jobType");

    if (!id) {
      return errorResult("id is required for create action.");
    }
    if (!schedule) {
      return errorResult("schedule (cron expression) is required for create action.");
    }

    // Validate cron expression
    if (!isValidCronExpression(schedule)) {
      return errorResult(`Invalid cron expression: "${schedule}". Use standard 5-field cron syntax (e.g. '0 9 * * *').`);
    }

    // Check if job already exists
    const existing = schedulerRepository.getById(id);
    if (existing) {
      return errorResult(`Job "${id}" already exists. Use "update" to modify it.`);
    }

    const now = nowIso();
    schedulerRepository.upsert({
      id,
      intervalMs: 0,
      timeoutMs: 600_000,
      catchUpRuns: 1,
      nowIso: now,
      scheduleKind: "cron",
      scheduleCronExpr: schedule,
      scheduleTz: timezone ?? null,
    });

    // Set next run so it becomes active
    try {
      const options: { currentDate?: Date; tz?: string } = { currentDate: new Date() };
      if (timezone) options.tz = timezone;
      const interval = CronExpressionParser.parse(schedule, options);
      const next = interval.next();
      const nextIso = next.toISOString();
      if (nextIso) {
        schedulerRepository.setNextRunAt(id, nextIso, now);
      }
    } catch {
      // best-effort: isValidCronExpression already validated
    }

    // Register executable job definition so the scheduler can actually run it
    const payload = (args.payload ?? {}) as Record<string, unknown>;
    const runFn = dynamicJobRunner
      ? dynamicJobRunner(id, payload)
      : async () => { console.warn(`[cron] Dynamic job "${id}" has no runner configured.`); };

    schedulerService.registerDynamicJob({
      id,
      schedule: { kind: "cron", cronExpr: schedule, tz: timezone },
      timeoutMs: 600_000,
      catchUpRuns: 1,
      run: runFn,
    });

    // Wake scheduler to pick up new job
    schedulerService.wakeNow("new cron job created");

    return jsonResult({
      created: true,
      id,
      schedule,
      timezone: timezone ?? null,
      jobType: jobType ?? null,
    });
  }

  function handleUpdate(args: Record<string, unknown>): FridayAgentToolResult {
    const id = readStringParam(args, "id");
    const schedule = readStringParam(args, "schedule");
    const timezone = readStringParam(args, "timezone");
    const enabled = readBooleanParam(args, "enabled");

    if (!id) {
      return errorResult("id is required for update action.");
    }

    const existing = schedulerRepository.getById(id);
    if (!existing) {
      return errorResult(`Job "${id}" not found.`);
    }

    // Validate new cron expression if provided
    if (schedule && !isValidCronExpression(schedule)) {
      return errorResult(`Invalid cron expression: "${schedule}".`);
    }

    const now = nowIso();

    // If disabling
    if (enabled === false) {
      schedulerRepository.disableJob(id, now);
      return jsonResult({ updated: true, id, enabled: false });
    }

    // Update schedule fields
    if (schedule || timezone !== undefined) {
      schedulerRepository.upsert({
        id,
        intervalMs: existing.intervalMs,
        timeoutMs: existing.timeoutMs,
        catchUpRuns: existing.catchUpRuns,
        nowIso: now,
        scheduleKind: "cron",
        scheduleCronExpr: schedule ?? existing.scheduleCronExpr ?? null,
        scheduleTz: timezone ?? existing.scheduleTz ?? null,
      });

      // Recompute next run
      const cronExpr = schedule ?? existing.scheduleCronExpr;
      const tz = timezone ?? existing.scheduleTz;
      if (cronExpr) {
        try {
          const options: { currentDate?: Date; tz?: string } = { currentDate: new Date() };
          if (tz) options.tz = tz;
          const interval = CronExpressionParser.parse(cronExpr, options);
          const next = interval.next();
          const nextIso = next.toISOString();
          if (nextIso) {
            schedulerRepository.setNextRunAt(id, nextIso, now);
          }
        } catch {
          // best-effort
        }
      }
    }

    // Also update the in-memory job definition's schedule so the scheduler
    // computes future runs from the new definition, not the stale one.
    const updatedCronExpr = schedule ?? existing.scheduleCronExpr;
    const updatedTz = timezone ?? existing.scheduleTz;
    if (updatedCronExpr) {
      schedulerService.updateJobSchedule(id, {
        kind: "cron",
        cronExpr: updatedCronExpr,
        tz: updatedTz ?? undefined,
      });
    }

    schedulerService.wakeNow("cron job updated");

    const updated = schedulerRepository.getById(id);
    return jsonResult({
      updated: true,
      id,
      schedule: updated?.scheduleCronExpr ?? null,
      timezone: updated?.scheduleTz ?? null,
      enabled: updated?.enabled ?? false,
      nextRunAt: updated?.nextRunAt ?? null,
    });
  }

  function handleDelete(args: Record<string, unknown>): FridayAgentToolResult {
    const id = readStringParam(args, "id");
    if (!id) {
      return errorResult("id is required for delete action.");
    }

    const existing = schedulerRepository.getById(id);
    if (!existing) {
      return errorResult(`Job "${id}" not found.`);
    }

    const now = nowIso();
    schedulerRepository.disableJob(id, now);

    return jsonResult({ deleted: true, id });
  }

  function handleRun(args: Record<string, unknown>): FridayAgentToolResult {
    const id = readStringParam(args, "id");
    if (!id) {
      return errorResult("id is required for run action.");
    }

    const existing = schedulerRepository.getById(id);
    if (!existing) {
      return errorResult(`Job "${id}" not found.`);
    }

    // Set next_run_at to now to trigger immediate execution
    const now = nowIso();
    schedulerRepository.setNextRunAt(id, now, now);
    schedulerService.wakeNow("manual job run triggered");

    return jsonResult({
      triggered: true,
      id,
      message: "Job has been scheduled for immediate execution.",
    });
  }
}
