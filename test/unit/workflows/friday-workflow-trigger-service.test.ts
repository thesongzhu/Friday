import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowTriggerRepository,
  createFridayWorkflowRepository,
  createFridayWorkflowTriggerService,
} from "#workflows";
import type { FridayWorkflowExecutionService } from "#workflows";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.helper.js";

// ─── Helpers ───

function createMockExecutionService(): FridayWorkflowExecutionService {
  let runCounter = 0;
  return {
    startRun: vi.fn(async (input) => ({
      id: `run-${String(++runCounter).padStart(4, "0")}`,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId ?? "wv-mock",
      status: "running" as const,
      triggerType: input.triggerType,
      triggerPayload: input.triggerPayload,
      startedByUserId: input.startedByUserId,
      startedAt: "2025-01-15T10:00:00.000Z",
    })),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    getRun: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    getRunNodes: vi.fn(() => []),
    getRunArtifacts: vi.fn(() => []),
    getRunCheckpoints: vi.fn(() => []),
    timeoutStaleRuns: vi.fn(async () => 0),
  } as unknown as FridayWorkflowExecutionService;
}

describe("FridayWorkflowTriggerService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── F7: tickCron DB path ───

  describe("tickCron — DB path", () => {
    it("F6: tickCron uses listDueCron(nowIso, 100) with trigger repo", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const triggerRepo = createFridayWorkflowTriggerRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      // Seed workflow + version
      db.withWriteTransaction((conn) => {
        wfRepo.insertWorkflow(conn, "wf-cron-1", { slug: "cron-wf", name: "Cron WF" }, "etag-1", NOW);
        wfRepo.insertVersion(conn, "wv-cron-1", "wf-cron-1", 1, "cs1", "{}", undefined, undefined, NOW);
      });

      // Insert a cron registration that is "due" (next_fire_at <= now)
      triggerRepo.upsertManyForVersion([{
        id: "tr-cron-1",
        workflowId: "wf-cron-1",
        workflowVersionId: "wv-cron-1",
        triggerNodeId: "node-t-1",
        triggerType: "cron",
        enabled: true,
        cronExpression: "0 * * * *",
        cronTimezone: "UTC",
        dedupeWindowSec: 0,
        nextFireAt: "2025-01-15T09:00:00.000Z", // In the past = due
        createdAt: NOW,
        updatedAt: NOW,
      }]);

      // Spy on listDueCron
      const listDueCronSpy = vi.spyOn(triggerRepo, "listDueCron");

      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        triggerRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      const started = await service.tickCron(NOW);
      expect(started).toBe(1);
      expect(listDueCronSpy.mock.calls[0]).toEqual([NOW, 100]);
      expect(executionService.startRun).toHaveBeenCalledTimes(1);
    });

    it("F6: tickCron honors limit even if repo returns multiple due regs", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const triggerRepo = createFridayWorkflowTriggerRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      // Seed two different workflows so dedup doesn't interfere
      db.withWriteTransaction((conn) => {
        wfRepo.insertWorkflow(conn, "wf-lim-1", { slug: "lim-wf-1", name: "Lim WF 1" }, "e1", NOW);
        wfRepo.insertVersion(conn, "wv-lim-1", "wf-lim-1", 1, "cs1", "{}", undefined, undefined, NOW);
        wfRepo.insertWorkflow(conn, "wf-lim-2", { slug: "lim-wf-2", name: "Lim WF 2" }, "e2", NOW);
        wfRepo.insertVersion(conn, "wv-lim-2", "wf-lim-2", 1, "cs2", "{}", undefined, undefined, NOW);
      });

      triggerRepo.upsertManyForVersion([
        {
          id: "tr-lim-1",
          workflowId: "wf-lim-1",
          workflowVersionId: "wv-lim-1",
          triggerNodeId: "node-1",
          triggerType: "cron",
          enabled: true,
          cronExpression: "0 * * * *",
          dedupeWindowSec: 0,
          nextFireAt: "2025-01-15T09:00:00.000Z",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "tr-lim-2",
          workflowId: "wf-lim-2",
          workflowVersionId: "wv-lim-2",
          triggerNodeId: "node-2",
          triggerType: "cron",
          enabled: true,
          cronExpression: "0 * * * *",
          dedupeWindowSec: 0,
          nextFireAt: "2025-01-15T09:00:00.000Z",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        triggerRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      // Limit to 1 — even though 2 are due
      const started = await service.tickCron(NOW, 1);
      expect(started).toBe(1);
      expect(executionService.startRun).toHaveBeenCalledTimes(1);
    });

    it("F6: tickCron without repo uses in-memory schedule registrations", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      // No triggerRepo — in-memory fallback
      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        // triggerRepo omitted
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      // Register a schedule trigger in-memory at minute=0 (NOW is 10:00)
      service.register("wf-mem-1", "wv-mem-1", {
        type: "schedule",
        cron: "0 10 * * *", // minute=0, hour=10 — matches 10:00 UTC
        timezone: "UTC",
      });

      const started = await service.tickCron(NOW);
      expect(started).toBe(1);
      expect(executionService.startRun).toHaveBeenCalledTimes(1);
    });
  });

  // ─── F7: next_fire_at sync/republish/non-cron null ───

  describe("next_fire_at initialization and republish", () => {
    it("F7: sync published schedule trigger computes nextFireAt", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const triggerRepo = createFridayWorkflowTriggerRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      // Seed workflow + published version with a cron trigger
      db.withWriteTransaction((conn) => {
        wfRepo.insertWorkflow(conn, "wf-nf-1", { slug: "nf-wf", name: "NF WF" }, "etag-1", NOW);
        wfRepo.insertVersion(conn, "wv-nf-1", "wf-nf-1", 1, "cs1",
          JSON.stringify({
            version: 2,
            graph: {
              nodes: [
                { id: "trigger-1", type: "trigger", config: { triggerType: "schedule", cron: "30 10 * * *", timezone: "UTC" } },
              ],
              edges: [],
            },
          }),
          undefined, undefined, NOW,
        );
        wfRepo.publishVersion(conn, "wf-nf-1", "wv-nf-1", NOW);
        wfRepo.setPublishedVersion(conn, "wf-nf-1", 1, NOW);
      });

      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        triggerRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await service.syncPublishedVersionTriggers("wf-nf-1");

      const regs = triggerRepo.listByWorkflow("wf-nf-1");
      expect(regs).toHaveLength(1);
      expect(regs[0]!.triggerType).toBe("cron");
      expect(regs[0]!.cronExpression).toBe("30 10 * * *");
      // nextFireAt should be computed — 10:30 on 2025-01-15
      expect(regs[0]!.nextFireAt).toBe("2025-01-15T10:30:00.000Z");
    });

    it("F7: republish with changed cron updates nextFireAt", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const triggerRepo = createFridayWorkflowTriggerRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      db.withWriteTransaction((conn) => {
        wfRepo.insertWorkflow(conn, "wf-rp-1", { slug: "rp-wf", name: "RP WF" }, "etag-1", NOW);
        wfRepo.insertVersion(conn, "wv-rp-1", "wf-rp-1", 1, "cs1",
          JSON.stringify({
            version: 2,
            graph: {
              nodes: [
                { id: "trigger-1", type: "trigger", config: { triggerType: "schedule", cron: "30 10 * * *", timezone: "UTC" } },
              ],
              edges: [],
            },
          }),
          undefined, undefined, NOW,
        );
        wfRepo.publishVersion(conn, "wf-rp-1", "wv-rp-1", NOW);
        wfRepo.setPublishedVersion(conn, "wf-rp-1", 1, NOW);
      });

      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        triggerRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await service.syncPublishedVersionTriggers("wf-rp-1");

      const regs1 = triggerRepo.listByWorkflow("wf-rp-1");
      expect(regs1[0]!.nextFireAt).toBe("2025-01-15T10:30:00.000Z");

      // Republish with changed cron — new version
      db.withWriteTransaction((conn) => {
        wfRepo.insertVersion(conn, "wv-rp-2", "wf-rp-1", 2, "cs2",
          JSON.stringify({
            version: 2,
            graph: {
              nodes: [
                { id: "trigger-1", type: "trigger", config: { triggerType: "schedule", cron: "45 11 * * *", timezone: "UTC" } },
              ],
              edges: [],
            },
          }),
          undefined, undefined, NOW,
        );
        wfRepo.publishVersion(conn, "wf-rp-1", "wv-rp-2", NOW);
        wfRepo.setPublishedVersion(conn, "wf-rp-1", 2, NOW);
      });

      await service.syncPublishedVersionTriggers("wf-rp-1");

      const regs2 = triggerRepo.listByWorkflow("wf-rp-1");
      expect(regs2).toHaveLength(1);
      expect(regs2[0]!.cronExpression).toBe("45 11 * * *");
      // New nextFireAt should be 11:45
      expect(regs2[0]!.nextFireAt).toBe("2025-01-15T11:45:00.000Z");
    });

    it("F7: event/webhook triggers store next_fire_at as NULL in DB", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const triggerRepo = createFridayWorkflowTriggerRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      db.withWriteTransaction((conn) => {
        wfRepo.insertWorkflow(conn, "wf-ev-1", { slug: "ev-wf", name: "EV WF" }, "etag-1", NOW);
        wfRepo.insertVersion(conn, "wv-ev-1", "wf-ev-1", 1, "cs1",
          JSON.stringify({
            version: 2,
            graph: {
              nodes: [
                { id: "trigger-1", type: "trigger", config: { triggerType: "event", source: "github", event: "push" } },
                { id: "trigger-2", type: "trigger", config: { triggerType: "webhook", pathToken: "my-hook" } },
              ],
              edges: [],
            },
          }),
          undefined, undefined, NOW,
        );
        wfRepo.publishVersion(conn, "wf-ev-1", "wv-ev-1", NOW);
        wfRepo.setPublishedVersion(conn, "wf-ev-1", 1, NOW);
      });

      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        triggerRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      await service.syncPublishedVersionTriggers("wf-ev-1");

      // Raw query to check NULL directly
      const rows = db.withReadConnection((conn) =>
        conn.prepare(
          "SELECT trigger_type, next_fire_at FROM workflow_trigger_registrations WHERE workflow_id = ? ORDER BY trigger_type",
        ).all("wf-ev-1") as Array<{ trigger_type: string; next_fire_at: string | null }>,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.next_fire_at).toBeNull();
      }
    });
  });

  // ─── F8/F12: Advanced cron fallback regression ───

  describe("cron fallback — advanced expressions through shared utils", () => {
    it("F12: in-memory cron fallback fires advanced expressions correctly", async () => {
      const wfRepo = createFridayWorkflowRepository({ db });
      const executionService = createMockExecutionService();
      const idGen = createTestIdGenerator();

      // No triggerRepo — in-memory fallback path
      const service = createFridayWorkflowTriggerService({
        db,
        executionService,
        workflowRepo: wfRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      });

      // Register advanced cron: minutes 1,4,7,10 (1-10/3) every hour
      service.register("wf-adv-1", "wv-adv-1", {
        type: "schedule",
        cron: "1-10/3 * * * *", // matches minutes 1, 4, 7, 10
        timezone: "UTC",
      });

      // Tick at matching minute (07) — 2025-01-15T10:07:00.000Z
      const matchTime = "2025-01-15T10:07:00.000Z";
      const started1 = await service.tickCron(matchTime);
      expect(started1).toBe(1);
      expect(executionService.startRun).toHaveBeenCalledTimes(1);

      // Tick at non-matching minute (08) — 2025-01-15T10:08:00.000Z
      const nonMatchTime = "2025-01-15T10:08:00.000Z";
      const started2 = await service.tickCron(nonMatchTime);
      expect(started2).toBe(0);
      // startRun should not be called again
      expect(executionService.startRun).toHaveBeenCalledTimes(1);
    });
  });
});
