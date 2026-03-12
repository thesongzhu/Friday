import { describe, it, expect, vi } from "vitest";
import { createFridayAgentCronTool } from "#agent";
import type { FridayJobSchedulerRepository } from "../../../../src/jobs/scheduler/friday-job-scheduler-repository.js";
import type { FridayJobSchedulerService } from "../../../../src/jobs/scheduler/friday-job-scheduler.types.js";
import type { FridaySchedulerJobState } from "../../../../src/jobs/scheduler/friday-job-scheduler.types.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeJobState(overrides?: Partial<FridaySchedulerJobState>): FridaySchedulerJobState {
  return {
    id: "job-1",
    intervalMs: 60_000,
    timeoutMs: 300_000,
    catchUpRuns: 1,
    enabled: true,
    nextRunAt: "2026-01-15T13:00:00Z",
    runningAt: null,
    lastRunAt: "2026-01-15T12:00:00Z",
    lastStatus: "ok",
    lastError: null,
    lastDurationMs: 150,
    consecutiveFailures: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-15T12:00:00Z",
    scheduleKind: "cron",
    scheduleAt: null,
    scheduleEveryMs: null,
    scheduleAnchorMs: null,
    scheduleCronExpr: "0 * * * *",
    scheduleTz: "UTC",
    ...overrides,
  };
}

function mockSchedulerRepo(jobs?: FridaySchedulerJobState[]): FridayJobSchedulerRepository {
  const store = new Map<string, FridaySchedulerJobState>();
  for (const j of jobs ?? [makeJobState()]) {
    store.set(j.id, j);
  }
  return {
    listAll: vi.fn().mockImplementation(() => Array.from(store.values())),
    getById: vi.fn().mockImplementation((id: string) => store.get(id) ?? null),
    upsert: vi.fn().mockImplementation((job: { id: string }) => {
      store.set(job.id, { ...makeJobState({ id: job.id }), ...job } as FridaySchedulerJobState);
    }),
    setNextRunAt: vi.fn(),
    markRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    disableJob: vi.fn(),
    listDue: vi.fn().mockReturnValue([]),
  };
}

function mockSchedulerService(): FridayJobSchedulerService {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    wakeNow: vi.fn(),
    status: vi.fn().mockResolvedValue({ enabled: true, running: false, jobs: 0 }),
    registerDynamicJob: vi.fn(),
    updateJobSchedule: vi.fn(),
  };
}

describe("FridayAgentCronTool", () => {
  const nowIso = () => "2026-01-15T12:30:00Z";

  // ─── Definition ───

  it("has correct name and parameters", () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo(),
      schedulerService: mockSchedulerService(),
    });
    expect(tool.name).toBe("cron");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.required).toContain("action");
  });

  // ─── List action ───

  it("lists all jobs", async () => {
    const repo = mockSchedulerRepo([makeJobState(), makeJobState({ id: "job-2" })]);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute({ action: "list" }, signal());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { count: number; jobs: unknown[] };
    expect(parsed.count).toBe(2);
    expect(parsed.jobs).toHaveLength(2);
  });

  // ─── Create action ───

  it("creates a new cron job", async () => {
    const repo = mockSchedulerRepo([]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    const result = await tool.execute(
      { action: "create", id: "new-job", schedule: "0 9 * * *" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.created).toBe(true);
    expect(parsed.id).toBe("new-job");
    expect(parsed.schedule).toBe("0 9 * * *");
    expect(repo.upsert).toHaveBeenCalled();
    expect(svc.wakeNow).toHaveBeenCalled();
  });

  it("returns error for duplicate job id", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "existing" })]);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "create", id: "existing", schedule: "0 9 * * *" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
  });

  it("returns error for invalid cron expression", async () => {
    const repo = mockSchedulerRepo([]);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "create", id: "bad-cron", schedule: "invalid" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid cron expression");
  });

  it("returns error when id missing for create", async () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo([]),
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "create", schedule: "0 9 * * *" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("id is required");
  });

  it("returns error when schedule missing for create", async () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo([]),
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "create", id: "no-schedule" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("schedule");
  });

  // ─── Update action ───

  it("updates an existing job", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1" })]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    const result = await tool.execute(
      { action: "update", id: "job-1", schedule: "30 8 * * *" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.updated).toBe(true);
    expect(svc.wakeNow).toHaveBeenCalled();
  });

  it("disables a job via update", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1" })]);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "update", id: "job-1", enabled: false },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.enabled).toBe(false);
    expect(repo.disableJob).toHaveBeenCalledWith("job-1", nowIso());
  });

  it("returns error for non-existent job on update", async () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo([]),
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "update", id: "ghost" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  // ─── Delete action ───

  it("deletes (disables) a job", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1" })]);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "delete", id: "job-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.deleted).toBe(true);
    expect(repo.disableJob).toHaveBeenCalled();
  });

  it("returns error for non-existent job on delete", async () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo([]),
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute(
      { action: "delete", id: "ghost" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  // ─── Run action ───

  it("triggers immediate job execution", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1" })]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    const result = await tool.execute(
      { action: "run", id: "job-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.triggered).toBe(true);
    expect(repo.setNextRunAt).toHaveBeenCalled();
    expect(svc.wakeNow).toHaveBeenCalled();
  });

  // ─── Dynamic job registration (Issue 3 fix) ───

  it("registers a dynamic job on create", async () => {
    const repo = mockSchedulerRepo([]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    await tool.execute(
      { action: "create", id: "dyn-job", schedule: "0 9 * * *" },
      signal(),
    );

    expect(svc.registerDynamicJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dyn-job",
        schedule: expect.objectContaining({ kind: "cron", cronExpr: "0 9 * * *" }),
      }),
    );
  });

  it("uses dynamicJobRunner when provided on create", async () => {
    const repo = mockSchedulerRepo([]);
    const svc = mockSchedulerService();
    const runnerFn = vi.fn().mockResolvedValue(undefined);
    const dynamicJobRunner = vi.fn().mockReturnValue(runnerFn);
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
      dynamicJobRunner,
    });

    await tool.execute(
      { action: "create", id: "runner-job", schedule: "0 9 * * *", payload: { task: "hello" } },
      signal(),
    );

    expect(dynamicJobRunner).toHaveBeenCalledWith("runner-job", { task: "hello" });
    expect(svc.registerDynamicJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "runner-job", run: runnerFn }),
    );
  });

  // ─── In-memory schedule update (Issue 4 fix) ───

  it("updates in-memory job schedule on update", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1" })]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    await tool.execute(
      { action: "update", id: "job-1", schedule: "30 8 * * *", timezone: "America/New_York" },
      signal(),
    );

    expect(svc.updateJobSchedule).toHaveBeenCalledWith("job-1", {
      kind: "cron",
      cronExpr: "30 8 * * *",
      tz: "America/New_York",
    });
  });

  it("preserves existing cron expr in schedule update when only timezone changes", async () => {
    const repo = mockSchedulerRepo([makeJobState({ id: "job-1", scheduleCronExpr: "0 * * * *" })]);
    const svc = mockSchedulerService();
    const tool = createFridayAgentCronTool({
      schedulerRepository: repo,
      schedulerService: svc,
      nowIso,
    });

    await tool.execute(
      { action: "update", id: "job-1", timezone: "Europe/London" },
      signal(),
    );

    expect(svc.updateJobSchedule).toHaveBeenCalledWith("job-1", {
      kind: "cron",
      cronExpr: "0 * * * *",
      tz: "Europe/London",
    });
  });

  // ─── Parameter validation ───

  it("returns error for invalid action", async () => {
    const tool = createFridayAgentCronTool({
      schedulerRepository: mockSchedulerRepo(),
      schedulerService: mockSchedulerService(),
      nowIso,
    });

    const result = await tool.execute({ action: "purge" }, signal());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid action");
  });
});
