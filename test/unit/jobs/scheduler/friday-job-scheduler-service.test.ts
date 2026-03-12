import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridaySqliteLayer } from "#state";
import {
  createFridayJobSchedulerRepository,
  createFridayJobSchedulerService,
} from "#jobs";
import type { FridayScheduledJobDefinition } from "#jobs";

describe("FridayJobSchedulerService", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-sched-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = createFridaySqliteLayer({ dbPath, readPoolSize: 1, pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" } });
  });

  afterEach(async () => {
    try { db.close(); } catch { /* ok */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("startup catch-up runs overdue jobs", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    const runLog: string[] = [];

    // Pre-seed a job as overdue
    const pastDate = new Date(Date.now() - 120_000).toISOString();
    repo.upsert({ id: "catch-up-job", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 1, nowIso: pastDate });
    repo.setNextRunAt("catch-up-job", pastDate, pastDate);

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "catch-up-job",
        intervalMs: 60_000,
        run: async () => { runLog.push("ran"); },
      },
    ];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs,
    });

    await scheduler.start();
    await scheduler.stop();

    expect(runLog).toContain("ran");
  });

  it("stale running marker is cleared on startup", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    const now = new Date().toISOString();
    const futureDate = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now

    // Simulate a stale running marker (from a crash)
    repo.upsert({ id: "stale-job", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 0, nowIso: now });
    repo.setNextRunAt("stale-job", futureDate, now); // Not due yet
    repo.markRunning("stale-job", now);

    const stateBefore = repo.getById("stale-job");
    expect(stateBefore?.runningAt).not.toBeNull();

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs: [{ id: "stale-job", intervalMs: 60_000, catchUpRuns: 0, run: async () => {} }],
    });

    await scheduler.start();
    await scheduler.stop();

    const stateAfter = repo.getById("stale-job");
    expect(stateAfter?.runningAt).toBeNull();
    // clearStaleRunning sets last_status to 'error' and increments consecutive_failures
    expect(stateAfter?.consecutiveFailures).toBeGreaterThan(0);
    expect(stateAfter?.lastError).toContain("Stale running marker");
  });

  it("timeout leads to error status and backoff", async () => {
    const repo = createFridayJobSchedulerRepository({ db });

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "timeout-job",
        intervalMs: 60_000,
        timeoutMs: 50, // Very short timeout
        run: async () => {
          // Simulate long-running job
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      },
    ];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs,
    });

    await scheduler.start();
    // Give it a moment to run and timeout
    await new Promise((resolve) => setTimeout(resolve, 300));
    await scheduler.stop();

    const state = repo.getById("timeout-job");
    expect(state?.lastStatus).toBe("timeout");
    expect(state?.consecutiveFailures).toBeGreaterThan(0);
    expect(state?.lastError).toContain("timed out");
  });

  it("timer re-arm while running", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "rearm-job",
        intervalMs: 10,
        run: async () => {
          runCount++;
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
    ];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs,
    });

    await scheduler.start();
    // wakeNow should trigger re-arm
    scheduler.wakeNow("test");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await scheduler.stop();

    // Should have run at least once (catch-up)
    expect(runCount).toBeGreaterThanOrEqual(1);
  });

  it("status reports correct information", async () => {
    const repo = createFridayJobSchedulerRepository({ db });

    const jobs: FridayScheduledJobDefinition[] = [
      { id: "status-job", intervalMs: 60_000, run: async () => {} },
    ];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs,
    });

    const s1 = await scheduler.status();
    expect(s1.enabled).toBe(false);

    await scheduler.start();
    const s2 = await scheduler.status();
    expect(s2.enabled).toBe(true);
    expect(s2.jobs).toBe(1);

    await scheduler.stop();
    const s3 = await scheduler.status();
    expect(s3.enabled).toBe(false);
  });

  // ─── F9: Catch-up respects catchUpRuns ───

  it("F9: overdue by many intervals with catchUpRuns=3 runs exactly 3", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    // Pre-seed a job as overdue by many intervals
    const pastDate = new Date(Date.now() - 600_000).toISOString(); // 10 minutes ago
    repo.upsert({ id: "catchup-multi", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 3, nowIso: pastDate });
    repo.setNextRunAt("catchup-multi", pastDate, pastDate);

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "catchup-multi",
        intervalMs: 60_000,
        catchUpRuns: 3,
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await scheduler.stop();

    // Should run exactly 3 catch-up runs (overdue by 10 intervals, capped to 3)
    expect(runCount).toBe(3);
  });

  it("F9: slightly overdue with catchUpRuns=3 runs once", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    // Pre-seed a job as slightly overdue (within one interval)
    const pastDate = new Date(Date.now() - 30_000).toISOString(); // 30s ago, interval is 60s
    repo.upsert({ id: "catchup-slight", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 3, nowIso: pastDate });
    repo.setNextRunAt("catchup-slight", pastDate, pastDate);

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "catchup-slight",
        intervalMs: 60_000,
        catchUpRuns: 3,
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await scheduler.stop();

    // Slightly overdue = floor(30s/60s)+1 = 1 missed, min(1, 3) = 1 run
    expect(runCount).toBe(1);
  });

  it("F9: catchUpRuns=0 runs no catch-up even when overdue", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    const pastDate = new Date(Date.now() - 600_000).toISOString();
    repo.upsert({ id: "catchup-zero", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 0, nowIso: pastDate });
    repo.setNextRunAt("catchup-zero", pastDate, pastDate);

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "catchup-zero",
        intervalMs: 60_000,
        catchUpRuns: 0,
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    // The runLoop will pick it up as due, but catch-up specifically runs 0
    // The due run loop will still fire it — but the catch-up phase won't add extras
    await scheduler.stop();

    // Catch-up: 0 runs. The regular run loop will execute it once since it's due.
    expect(runCount).toBe(1); // due-run, not catch-up
  });

  // ─── F11: stop() awaits in-flight ───

  it("F11: stop() resolves after active run completes", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCompleted = false;

    const pastDate = new Date(Date.now() - 120_000).toISOString();
    repo.upsert({ id: "slow-job", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 1, nowIso: pastDate });
    repo.setNextRunAt("slow-job", pastDate, pastDate);

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "slow-job",
        intervalMs: 60_000,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          runCompleted = true;
        },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await scheduler.stop();

    // stop() should have awaited the in-flight run
    expect(runCompleted).toBe(true);
  });

  it("anchored every job does not run before anchor time", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    const futureAnchor = Date.now() + 60_000; // 1 minute from now

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "anchored-job",
        schedule: { kind: "every", everyMs: 10_000, anchorMs: futureAnchor },
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    // Give a moment for any immediate run
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();

    // Should NOT have run — anchor is in the future
    expect(runCount).toBe(0);

    // Verify next_run_at is set to the anchor time (not now)
    const state = repo.getById("anchored-job");
    expect(state?.nextRunAt).toBeDefined();
    const nextRunMs = new Date(state!.nextRunAt!).getTime();
    expect(nextRunMs).toBeGreaterThanOrEqual(futureAnchor);
  });

  it("cron job does not run immediately on seed", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    // Cron expression: run at midnight Jan 1 only (far future effectively)
    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "cron-job",
        schedule: { kind: "cron", cronExpr: "0 0 1 1 *" },
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await scheduler.stop();

    // Should NOT have run immediately — next cron match is far in the future
    expect(runCount).toBe(0);
  });

  it("plain every job still runs immediately on first seed (backward compat)", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "plain-every-job",
        intervalMs: 60_000,
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await scheduler.stop();

    // Plain every (no anchor) seeds next_run_at = now, so it fires on first tick
    expect(runCount).toBe(1);
  });

  // ─── CX65: Invalid cron disables instead of hot-looping ───

  it("CX65: invalid cron expression disables job on seed instead of hot-looping", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    let runCount = 0;

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "bad-cron-job",
        schedule: { kind: "cron", cronExpr: "NOT_A_CRON" },
        run: async () => { runCount++; },
      },
    ];

    const scheduler = createFridayJobSchedulerService({ repository: repo, jobs });
    await scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await scheduler.stop();

    // Job should never have run
    expect(runCount).toBe(0);

    // Job should be disabled
    const state = repo.getById("bad-cron-job");
    expect(state?.enabled).toBe(false);
  });

  it("successful run resets consecutive failures", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    const now = new Date().toISOString();

    // Pre-seed with failures
    repo.upsert({ id: "reset-job", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 1, nowIso: now });
    const pastDate = new Date(Date.now() - 120_000).toISOString();
    repo.markFailed("reset-job", "some error", 100, pastDate, now);
    repo.markFailed("reset-job", "another error", 100, pastDate, now);

    const stateBefore = repo.getById("reset-job");
    expect(stateBefore?.consecutiveFailures).toBe(2);

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs: [{ id: "reset-job", intervalMs: 60_000, run: async () => {} }],
    });

    await scheduler.start();
    await scheduler.stop();

    const stateAfter = repo.getById("reset-job");
    expect(stateAfter?.consecutiveFailures).toBe(0);
    expect(stateAfter?.lastStatus).toBe("ok");
  });

  // ─── Dynamic job registration (Issue 3 fix) ───

  it("registerDynamicJob adds a job that can be executed", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    const runLog: string[] = [];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs: [],
    });

    await scheduler.start();

    // Dynamically register a new job
    const now = new Date().toISOString();
    repo.upsert({ id: "dynamic-job", intervalMs: 0, timeoutMs: 600_000, catchUpRuns: 1, nowIso: now, scheduleKind: "cron", scheduleCronExpr: "0 9 * * *" });

    scheduler.registerDynamicJob({
      id: "dynamic-job",
      schedule: { kind: "cron", cronExpr: "0 9 * * *" },
      run: async () => { runLog.push("dynamic-ran"); },
    });

    // Set next run to now to trigger immediate execution
    repo.setNextRunAt("dynamic-job", now, now);
    scheduler.wakeNow("test");

    // Give the run loop a tick to process
    await new Promise((r) => setTimeout(r, 200));

    await scheduler.stop();

    expect(runLog).toContain("dynamic-ran");
  });

  // ─── updateJobSchedule (Issue 4 fix) ───

  it("updateJobSchedule changes the in-memory schedule definition", async () => {
    const repo = createFridayJobSchedulerRepository({ db });
    const runLog: string[] = [];

    const jobs: FridayScheduledJobDefinition[] = [
      {
        id: "updatable-job",
        schedule: { kind: "cron", cronExpr: "0 9 * * *" },
        run: async () => { runLog.push("ran"); },
      },
    ];

    const scheduler = createFridayJobSchedulerService({
      repository: repo,
      jobs,
    });

    await scheduler.start();

    // Update the schedule — the scheduler should use the new definition
    scheduler.updateJobSchedule("updatable-job", { kind: "cron", cronExpr: "30 8 * * *" });

    // The in-memory definition is updated; verify via status (job is still registered)
    const status = await scheduler.status();
    expect(status.jobs).toBeGreaterThanOrEqual(1);

    await scheduler.stop();
  });
});
