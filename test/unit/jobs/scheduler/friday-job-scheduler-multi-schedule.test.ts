import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFridaySqliteLayer } from "#state";
import {
  createFridayJobSchedulerRepository,
  createFridayJobSchedulerService,
  computeNextRunAtMs,
  isValidCronExpression,
  resolveJobSchedule,
  scheduleToIntervalMs,
  scheduleFromState,
} from "#jobs";
import type { FridayScheduledJobDefinition, FridayJobSchedule } from "#jobs";

describe("FridayJobScheduler — Multi-Schedule", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createFridaySqliteLayer>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-sched-multi-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    db = createFridaySqliteLayer({ dbPath, readPoolSize: 1, pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" } });
  });

  afterEach(async () => {
    try { db.close(); } catch { /* ok */ }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Schedule utilities ───

  describe("computeNextRunAtMs", () => {
    it("at: returns the absolute timestamp", () => {
      const target = "2026-03-15T10:00:00Z";
      const result = computeNextRunAtMs({ kind: "at", at: target }, Date.now());
      expect(result).toBe(new Date(target).getTime());
    });

    it("at: returns null for invalid date", () => {
      const result = computeNextRunAtMs({ kind: "at", at: "not-a-date" }, Date.now());
      expect(result).toBeNull();
    });

    it("every: returns nowMs + everyMs when no anchor", () => {
      const now = 1000000;
      const result = computeNextRunAtMs({ kind: "every", everyMs: 60000 }, now);
      expect(result).toBe(1060000);
    });

    it("every: aligns to anchor", () => {
      // anchor at 0, everyMs = 100, now = 250 → next = 300
      const result = computeNextRunAtMs({ kind: "every", everyMs: 100, anchorMs: 0 }, 250);
      expect(result).toBe(300);
    });

    it("every: anchor with exact alignment", () => {
      // anchor at 0, everyMs = 100, now = 200 → next = 200 (ceil of 0 elapsed = 2 intervals)
      const result = computeNextRunAtMs({ kind: "every", everyMs: 100, anchorMs: 0 }, 200);
      expect(result).toBe(200);
    });

    it("every: clamps to anchor when now < anchorMs", () => {
      // anchor at 1000, everyMs = 100, now = 500 → should clamp to 1000 (the anchor)
      const result = computeNextRunAtMs({ kind: "every", everyMs: 100, anchorMs: 1000 }, 500);
      expect(result).toBe(1000);
    });

    it("every: clamps to anchor when now is well before anchor", () => {
      // anchor at 10000, everyMs = 50, now = 0 → should clamp to 10000
      const result = computeNextRunAtMs({ kind: "every", everyMs: 50, anchorMs: 10000 }, 0);
      expect(result).toBe(10000);
    });

    it("every: now just before anchor returns anchor", () => {
      // anchor at 1000, everyMs = 100, now = 999 → should return 1000
      const result = computeNextRunAtMs({ kind: "every", everyMs: 100, anchorMs: 1000 }, 999);
      expect(result).toBe(1000);
    });

    it("cron: computes next occurrence", () => {
      const now = new Date("2026-01-15T10:03:00Z").getTime();
      const result = computeNextRunAtMs({ kind: "cron", cronExpr: "*/5 * * * *" }, now);
      expect(result).not.toBeNull();
      // Next */5 after 10:03 is 10:05
      expect(result).toBe(new Date("2026-01-15T10:05:00Z").getTime());
    });

    it("cron: respects timezone", () => {
      const now = new Date("2026-01-15T10:03:00Z").getTime();
      const result = computeNextRunAtMs(
        { kind: "cron", cronExpr: "*/5 * * * *", tz: "America/Los_Angeles" },
        now,
      );
      expect(result).not.toBeNull();
      // Should still get next */5 minute boundary
      expect(result).toBeGreaterThan(now);
    });

    it("cron: returns null for invalid expression", () => {
      const result = computeNextRunAtMs({ kind: "cron", cronExpr: "invalid" }, Date.now());
      expect(result).toBeNull();
    });

    it("interval: returns nowMs + intervalMs", () => {
      const now = 5000;
      const result = computeNextRunAtMs({ kind: "interval", intervalMs: 30000 }, now);
      expect(result).toBe(35000);
    });
  });

  describe("isValidCronExpression", () => {
    it("accepts valid expressions", () => {
      expect(isValidCronExpression("* * * * *")).toBe(true);
      expect(isValidCronExpression("0 */6 * * *")).toBe(true);
      expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
      expect(isValidCronExpression("*/15 * * * *")).toBe(true);
    });

    it("rejects invalid expressions", () => {
      expect(isValidCronExpression("not a cron")).toBe(false);
      expect(isValidCronExpression("70 * * * *")).toBe(false);
      expect(isValidCronExpression("* * * * * * * *")).toBe(false);
    });
  });

  describe("resolveJobSchedule", () => {
    it("prefers explicit schedule over intervalMs", () => {
      const schedule = resolveJobSchedule({
        schedule: { kind: "cron", cronExpr: "0 * * * *" },
        intervalMs: 60000,
      });
      expect(schedule.kind).toBe("cron");
    });

    it("falls back to intervalMs as every", () => {
      const schedule = resolveJobSchedule({ intervalMs: 30000 });
      expect(schedule).toEqual({ kind: "every", everyMs: 30000 });
    });

    it("throws when neither schedule nor intervalMs provided", () => {
      expect(() => resolveJobSchedule({})).toThrow();
    });
  });

  describe("scheduleToIntervalMs", () => {
    it("returns everyMs for every", () => {
      expect(scheduleToIntervalMs({ kind: "every", everyMs: 5000 })).toBe(5000);
    });

    it("returns intervalMs for interval", () => {
      expect(scheduleToIntervalMs({ kind: "interval", intervalMs: 3000 })).toBe(3000);
    });

    it("returns 0 for at", () => {
      expect(scheduleToIntervalMs({ kind: "at", at: "2026-01-01T00:00:00Z" })).toBe(0);
    });

    it("returns 0 for cron", () => {
      expect(scheduleToIntervalMs({ kind: "cron", cronExpr: "* * * * *" })).toBe(0);
    });
  });

  describe("scheduleFromState", () => {
    it("reconstructs 'at' schedule from state", () => {
      const schedule = scheduleFromState({
        scheduleKind: "at",
        scheduleAt: "2026-03-15T10:00:00Z",
        scheduleEveryMs: null,
        scheduleAnchorMs: null,
        scheduleCronExpr: null,
        scheduleTz: null,
        intervalMs: 0,
      });
      expect(schedule).toEqual({ kind: "at", at: "2026-03-15T10:00:00Z" });
    });

    it("reconstructs 'every' with anchor from state", () => {
      const schedule = scheduleFromState({
        scheduleKind: "every",
        scheduleAt: null,
        scheduleEveryMs: 60000,
        scheduleAnchorMs: 1000,
        scheduleCronExpr: null,
        scheduleTz: null,
        intervalMs: 60000,
      });
      expect(schedule).toEqual({ kind: "every", everyMs: 60000, anchorMs: 1000 });
    });

    it("reconstructs 'cron' with timezone from state", () => {
      const schedule = scheduleFromState({
        scheduleKind: "cron",
        scheduleAt: null,
        scheduleEveryMs: null,
        scheduleAnchorMs: null,
        scheduleCronExpr: "0 9 * * 1-5",
        scheduleTz: "America/New_York",
        intervalMs: 0,
      });
      expect(schedule).toEqual({ kind: "cron", cronExpr: "0 9 * * 1-5", tz: "America/New_York" });
    });
  });

  // ─── Service integration: "at" schedule ───

  describe("at schedule", () => {
    it("one-shot 'at' job runs once and is disabled", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      const pastTime = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "at-job",
          schedule: { kind: "at", at: pastTime },
          run: async () => { runCount++; },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await scheduler.stop();

      expect(runCount).toBe(1);

      // Job should be disabled after execution
      const state = repo.getById("at-job");
      expect(state?.enabled).toBe(false);
      expect(state?.nextRunAt).toBeNull();
    });

    it("failed 'at' job uses exponential backoff instead of hot-looping", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;
      const startMs = Date.now();

      const pastTime = new Date(startMs - 60_000).toISOString();

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "at-fail-job",
          schedule: { kind: "at", at: pastTime },
          run: async () => {
            runCount++;
            throw new Error("intentional failure");
          },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      // Give time for catch-up to fire once
      await new Promise((r) => setTimeout(r, 200));
      await scheduler.stop();

      // Should have run once (catch-up), but next_run_at should be in the future (backoff)
      expect(runCount).toBeGreaterThanOrEqual(1);

      const state = repo.getById("at-fail-job");
      expect(state?.consecutiveFailures).toBeGreaterThanOrEqual(1);
      // next_run_at should be set to a future time (backoff), not null and not in the past
      if (state?.enabled) {
        expect(state.nextRunAt).not.toBeNull();
        const nextRunMs = new Date(state!.nextRunAt!).getTime();
        // Backoff should push next run at least 30s into the future from when the failure occurred
        expect(nextRunMs).toBeGreaterThan(startMs);
      }
    });

    it("'at' job is disabled after max retries (3)", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      // Use a controllable clock to avoid real delays
      let fakeNowMs = Date.now();
      const pastTime = new Date(fakeNowMs - 60_000).toISOString();

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "at-max-retry-job",
          schedule: { kind: "at", at: pastTime },
          run: async () => {
            runCount++;
            throw new Error("always fails");
          },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
        nowMs: () => fakeNowMs,
        nowIso: () => new Date(fakeNowMs).toISOString(),
      });

      await scheduler.start();

      // Simulate time passing and wake the scheduler for each retry
      for (let i = 0; i < 5; i++) {
        fakeNowMs += 3_700_000; // jump well past any backoff
        // Update next_run_at to be in the past so the scheduler picks it up
        const state = repo.getById("at-max-retry-job");
        if (state?.enabled && state.nextRunAt) {
          repo.setNextRunAt("at-max-retry-job", new Date(fakeNowMs - 1000).toISOString(), new Date(fakeNowMs).toISOString());
        }
        scheduler.wakeNow("retry");
        await new Promise((r) => setTimeout(r, 100));
      }

      await scheduler.stop();

      // Should have been disabled after 3 failures
      const state = repo.getById("at-max-retry-job");
      expect(state?.enabled).toBe(false);
      expect(runCount).toBeGreaterThanOrEqual(3);
    });

    it("future 'at' job does not run before its time", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      const futureTime = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "at-future-job",
          schedule: { kind: "at", at: futureTime },
          run: async () => { runCount++; },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 100));
      await scheduler.stop();

      expect(runCount).toBe(0);

      // Job should still be enabled
      const state = repo.getById("at-future-job");
      expect(state?.enabled).toBe(true);
    });
  });

  // ─── Service integration: "every" with anchor ───

  describe("every schedule with anchor", () => {
    it("anchored job respects anchor alignment for next run", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      const now = Date.now();
      // anchor 150ms ago, interval 100ms → should be overdue
      const anchorMs = now - 150;

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "anchor-job",
          schedule: { kind: "every", everyMs: 100, anchorMs },
          run: async () => { runCount++; },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await new Promise((r) => setTimeout(r, 300));
      await scheduler.stop();

      expect(runCount).toBeGreaterThanOrEqual(1);

      // Verify schedule fields are persisted
      const state = repo.getById("anchor-job");
      expect(state?.scheduleKind).toBe("every");
      expect(state?.scheduleAnchorMs).toBe(anchorMs);
    });
  });

  // ─── Service integration: "cron" schedule ───

  describe("cron schedule", () => {
    it("cron job is persisted with cron fields", async () => {
      const repo = createFridayJobSchedulerRepository({ db });

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "cron-job",
          schedule: { kind: "cron", cronExpr: "*/5 * * * *", tz: "UTC" },
          run: async () => {},
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await scheduler.stop();

      const state = repo.getById("cron-job");
      expect(state?.scheduleKind).toBe("cron");
      expect(state?.scheduleCronExpr).toBe("*/5 * * * *");
      expect(state?.scheduleTz).toBe("UTC");
    });

    it("overdue cron job runs catch-up once", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      // Pre-seed a cron job as overdue
      const pastDate = new Date(Date.now() - 120_000).toISOString();
      repo.upsert({
        id: "cron-catchup",
        intervalMs: 0,
        timeoutMs: 600_000,
        catchUpRuns: 3,
        nowIso: pastDate,
        scheduleKind: "cron",
        scheduleCronExpr: "* * * * *",
      });
      repo.setNextRunAt("cron-catchup", pastDate, pastDate);

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "cron-catchup",
          schedule: { kind: "cron", cronExpr: "* * * * *" },
          catchUpRuns: 3,
          run: async () => { runCount++; },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await scheduler.stop();

      // Cron catch-up runs exactly 1 (cron intervals aren't fixed-size)
      expect(runCount).toBe(1);
    });
  });

  // ─── Backward compatibility ───

  describe("backward compatibility", () => {
    it("intervalMs without schedule works as 'every'", async () => {
      const repo = createFridayJobSchedulerRepository({ db });
      let runCount = 0;

      const pastDate = new Date(Date.now() - 120_000).toISOString();
      repo.upsert({ id: "legacy-job", intervalMs: 60_000, timeoutMs: 600_000, catchUpRuns: 1, nowIso: pastDate });
      repo.setNextRunAt("legacy-job", pastDate, pastDate);

      const jobs: FridayScheduledJobDefinition[] = [
        {
          id: "legacy-job",
          intervalMs: 60_000,
          run: async () => { runCount++; },
        },
      ];

      const scheduler = createFridayJobSchedulerService({
        repository: repo,
        jobs,
      });

      await scheduler.start();
      await scheduler.stop();

      expect(runCount).toBeGreaterThanOrEqual(1);

      const state = repo.getById("legacy-job");
      expect(state?.scheduleKind).toBe("every");
      expect(state?.intervalMs).toBe(60_000);
    });
  });

  // ─── Repository: schedule fields ───

  describe("repository schedule fields", () => {
    it("upsert persists schedule fields", () => {
      const repo = createFridayJobSchedulerRepository({ db });
      const now = new Date().toISOString();

      repo.upsert({
        id: "sched-test",
        intervalMs: 0,
        timeoutMs: 600_000,
        catchUpRuns: 1,
        nowIso: now,
        scheduleKind: "cron",
        scheduleCronExpr: "0 9 * * 1-5",
        scheduleTz: "America/New_York",
      });

      const state = repo.getById("sched-test");
      expect(state).not.toBeNull();
      expect(state!.scheduleKind).toBe("cron");
      expect(state!.scheduleCronExpr).toBe("0 9 * * 1-5");
      expect(state!.scheduleTz).toBe("America/New_York");
      expect(state!.scheduleAt).toBeNull();
      expect(state!.scheduleEveryMs).toBeNull();
      expect(state!.scheduleAnchorMs).toBeNull();
    });

    it("upsert persists 'at' schedule fields", () => {
      const repo = createFridayJobSchedulerRepository({ db });
      const now = new Date().toISOString();

      repo.upsert({
        id: "at-field-test",
        intervalMs: 0,
        timeoutMs: 600_000,
        catchUpRuns: 1,
        nowIso: now,
        scheduleKind: "at",
        scheduleAt: "2026-03-15T10:00:00Z",
      });

      const state = repo.getById("at-field-test");
      expect(state!.scheduleKind).toBe("at");
      expect(state!.scheduleAt).toBe("2026-03-15T10:00:00Z");
    });

    it("disableJob disables and clears next_run_at", () => {
      const repo = createFridayJobSchedulerRepository({ db });
      const now = new Date().toISOString();

      repo.upsert({
        id: "disable-test",
        intervalMs: 60_000,
        timeoutMs: 600_000,
        catchUpRuns: 1,
        nowIso: now,
      });
      repo.setNextRunAt("disable-test", now, now);

      const before = repo.getById("disable-test");
      expect(before!.enabled).toBe(true);
      expect(before!.nextRunAt).not.toBeNull();

      repo.disableJob("disable-test", now);

      const after = repo.getById("disable-test");
      expect(after!.enabled).toBe(false);
      expect(after!.nextRunAt).toBeNull();
    });
  });
});
