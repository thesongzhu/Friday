import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentAutomationService,
  createFridayAgentAutomationRepository,
} from "#agent";
import type {
  FridayAgentAutomationSchedulerBridge,
  FridayAgentAutomationService,
  FridayAgentRuntimeResult,
} from "#agent";
import { FridayDomainError } from "#errors";

describe("FridayAgentAutomationService", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  let service: FridayAgentAutomationService;
  let mockStartRun: ReturnType<typeof vi.fn<(input: {
    task: string;
    providerId?: string;
    model?: string;
    timeoutMs?: number;
  }) => Promise<FridayAgentRuntimeResult>>>;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
    mockStartRun = vi.fn<(input: {
      task: string;
      providerId?: string;
      model?: string;
      timeoutMs?: number;
    }) => Promise<FridayAgentRuntimeResult>>().mockResolvedValue({
      runId: "run-result-001",
      status: "completed",
      response: "Done",
      toolCallCount: 0,
      durationMs: 1000,
      usageInput: 100,
      usageOutput: 50,
    });

    service = createFridayAgentAutomationService({
      db,
      repository: createFridayAgentAutomationRepository(),
      startRun: mockStartRun,
      idGenerator,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── save ───

  describe("save", () => {
    it("creates a new automation", () => {
      const automation = service.save({
        name: "My Automation",
        taskTemplate: "Do something useful",
      });

      expect(automation.id).toBe("test-id-0001");
      expect(automation.name).toBe("My Automation");
      expect(automation.taskTemplate).toBe("Do something useful");
      expect(automation.enabled).toBe(true);
      expect(automation.runCount).toBe(0);
      expect(automation.createdAt).toBe(NOW);
      expect(automation.updatedAt).toBe(NOW);
    });

    it("creates with optional fields", () => {
      const automation = service.save({
        name: "Full Automation",
        description: "Does everything",
        taskTemplate: "Build the thing",
        schedule: { type: "cron", cron: "0 9 * * *", timezone: "America/New_York" },
        variables: { lang: "ts" },
        skillIds: ["skill-1"],
        workflowIds: ["wf-1"],
        triggerId: "trigger-1",
        enabled: false,
      });

      expect(automation.description).toBe("Does everything");
      expect(automation.variables).toEqual({ lang: "ts" });
      expect(automation.skillIds).toEqual(["skill-1"]);
      expect(automation.workflowIds).toEqual(["wf-1"]);
      expect(automation.triggerId).toBe("trigger-1");
      expect(automation.schedule).toEqual({
        type: "cron",
        cron: "0 9 * * *",
        timezone: "America/New_York",
      });
      expect(automation.enabled).toBe(false);
    });
  });

  describe("scheduler bridge", () => {
    it("syncs on save/update/remove when a bridge is attached", () => {
      const sync = vi.fn();
      const remove = vi.fn();
      const bridge: FridayAgentAutomationSchedulerBridge = {
        sync,
        remove,
      };

      service.attachSchedulerBridge(bridge);

      const created = service.save({
        name: "Scheduled",
        taskTemplate: "task",
        schedule: { type: "cron", cron: "0 * * * *" },
      });
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }));

      const updated = service.update(created.id, {
        enabled: false,
      });
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: updated.id, enabled: false }));

      service.remove(created.id);
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }));
    });

    it("syncScheduledAutomations replays all persisted automations", () => {
      const sync = vi.fn();
      const bridge: FridayAgentAutomationSchedulerBridge = {
        sync,
        remove: vi.fn(),
      };

      service.save({ name: "A", taskTemplate: "task A" });
      service.save({ name: "B", taskTemplate: "task B" });

      service.attachSchedulerBridge(bridge);
      service.syncScheduledAutomations();

      expect(sync).toHaveBeenCalledTimes(2);
    });
  });

  // ─── get ───

  describe("get", () => {
    it("returns automation by id", () => {
      const created = service.save({
        name: "Find Me",
        taskTemplate: "task",
      });

      const found = service.get(created.id);

      expect(found).not.toBeNull();
      expect(found?.name).toBe("Find Me");
    });

    it("returns null for non-existent id", () => {
      const found = service.get("nonexistent");
      expect(found).toBeNull();
    });
  });

  // ─── list ───

  describe("list", () => {
    it("lists all automations", () => {
      service.save({ name: "Auto 1", taskTemplate: "task 1" });
      service.save({ name: "Auto 2", taskTemplate: "task 2" });

      const items = service.list();

      expect(items).toHaveLength(2);
    });

    it("filters by enabled", () => {
      service.save({ name: "Enabled", taskTemplate: "task", enabled: true });
      service.save({ name: "Disabled", taskTemplate: "task", enabled: false });

      const enabled = service.list({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe("Enabled");
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        service.save({ name: `Auto ${String(i)}`, taskTemplate: "task" });
      }

      const items = service.list({ limit: 2 });
      expect(items).toHaveLength(2);
    });
  });

  // ─── update ───

  describe("update", () => {
    it("updates automation fields", () => {
      const created = service.save({
        name: "Original",
        taskTemplate: "original task",
      });

      const updated = service.update(created.id, {
        name: "Updated",
        description: "New description",
      });

      expect(updated.name).toBe("Updated");
      expect(updated.description).toBe("New description");
      expect(updated.updatedAt).toBe(NOW);
    });

    it("updates enabled flag", () => {
      const created = service.save({
        name: "Toggle Me",
        taskTemplate: "task",
        enabled: true,
      });

      const updated = service.update(created.id, { enabled: false });

      expect(updated.enabled).toBe(false);
    });

    it("throws AGENT_AUTOMATION_NOT_FOUND for non-existent id", () => {
      expect(() => service.update("nonexistent", { name: "Nope" }))
        .toThrow(FridayDomainError);

      try {
        service.update("nonexistent", { name: "Nope" });
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("AGENT_AUTOMATION_NOT_FOUND");
        expect((error as FridayDomainError).httpStatus).toBe(404);
      }
    });
  });

  // ─── remove ───

  describe("remove", () => {
    it("removes an existing automation", () => {
      const created = service.save({
        name: "Delete Me",
        taskTemplate: "task",
      });

      service.remove(created.id);

      const found = service.get(created.id);
      expect(found).toBeNull();
    });

    it("throws AGENT_AUTOMATION_NOT_FOUND for non-existent id", () => {
      expect(() => service.remove("nonexistent"))
        .toThrow(FridayDomainError);

      try {
        service.remove("nonexistent");
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("AGENT_AUTOMATION_NOT_FOUND");
      }
    });
  });

  // ─── run ───

  describe("run", () => {
    it("executes the automation task via startRun", async () => {
      const created = service.save({
        name: "Run Me",
        taskTemplate: "Build a widget",
      });

      const result = await service.run(created.id);

      expect(mockStartRun).toHaveBeenCalledWith({
        task: "Build a widget",
        providerId: undefined,
        model: undefined,
        timeoutMs: undefined,
      });
      expect(result.runId).toBe("run-result-001");
      expect(result.status).toBe("completed");
    });

    it("allows taskOverride", async () => {
      const created = service.save({
        name: "Override Me",
        taskTemplate: "Original task",
      });

      await service.run(created.id, { taskOverride: "Custom task" });

      expect(mockStartRun).toHaveBeenCalledWith(
        expect.objectContaining({ task: "Custom task" }),
      );
    });

    it("passes providerId, model, and timeoutMs", async () => {
      const created = service.save({
        name: "Full Run",
        taskTemplate: "task",
      });

      await service.run(created.id, {
        providerId: "openai",
        model: "gpt-4",
        timeoutMs: 60000,
      });

      expect(mockStartRun).toHaveBeenCalledWith({
        task: "task",
        providerId: "openai",
        model: "gpt-4",
        timeoutMs: 60000,
      });
    });

    it("updates last run info after execution", async () => {
      const created = service.save({
        name: "Track Runs",
        taskTemplate: "task",
      });

      await service.run(created.id);

      const automation = service.get(created.id);
      expect(automation?.lastRunId).toBe("run-result-001");
      expect(automation?.lastRunAt).toBe(NOW);
      expect(automation?.runCount).toBe(1);
    });

    it("increments runCount on each execution", async () => {
      const created = service.save({
        name: "Multi Run",
        taskTemplate: "task",
      });

      await service.run(created.id);
      await service.run(created.id);

      const automation = service.get(created.id);
      expect(automation?.runCount).toBe(2);
    });

    it("throws AGENT_AUTOMATION_NOT_FOUND for non-existent id", async () => {
      await expect(service.run("nonexistent"))
        .rejects.toThrow(FridayDomainError);
    });

    it("throws AGENT_AUTOMATION_DISABLED for disabled automation", async () => {
      const created = service.save({
        name: "Disabled",
        taskTemplate: "task",
        enabled: false,
      });

      await expect(service.run(created.id))
        .rejects.toThrow(FridayDomainError);

      try {
        await service.run(created.id);
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("AGENT_AUTOMATION_DISABLED");
        expect((error as FridayDomainError).httpStatus).toBe(409);
      }
    });
  });
});
