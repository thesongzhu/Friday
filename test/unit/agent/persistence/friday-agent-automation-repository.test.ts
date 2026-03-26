import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAgentAutomationRepository } from "#agent";
import type { FridayAgentAutomationRecord } from "#agent";

describe("FridayAgentAutomationRepository", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-02-19T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayAgentAutomationRepository();
  }

  function makeRecord(overrides?: Partial<FridayAgentAutomationRecord>): FridayAgentAutomationRecord {
    return {
      id: idGenerator(),
      name: "Test Automation",
      taskTemplate: "Build a hello world script",
      enabled: true,
      runCount: 0,
      estimatedTimeSavedMinutes: 15,
      reuseCount: 0,
      promotionState: "private",
      lastOutcomeScore: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  // ─── insert ───

  describe("insert", () => {
    it("inserts a new automation and returns the record", () => {
      const repo = createRepo();
      const record = makeRecord();

      const inserted = db.withWriteTransaction((writer) => repo.insert(writer, record));

      expect(inserted.id).toBe(record.id);
      expect(inserted.name).toBe("Test Automation");
      expect(inserted.taskTemplate).toBe("Build a hello world script");
      expect(inserted.enabled).toBe(true);
      expect(inserted.runCount).toBe(0);
      expect(inserted.estimatedTimeSavedMinutes).toBe(15);
      expect(inserted.reuseCount).toBe(0);
      expect(inserted.promotionState).toBe("private");
      expect(inserted.lastOutcomeScore).toBe(0);
      expect(inserted.createdAt).toBe(NOW);
      expect(inserted.updatedAt).toBe(NOW);
    });

    it("inserts with all optional fields", () => {
      const repo = createRepo();
      const record = makeRecord({
        description: "A test automation",
        sourceRunId: "run-123",
        variables: { lang: "typescript" },
        skillIds: ["skill-1", "skill-2"],
        workflowIds: ["wf-1"],
        triggerId: "trigger-abc",
        schedule: { type: "cron", cron: "0 9 * * *", timezone: "America/New_York" },
      });

      // Need to first insert a run for the FK constraint
      db.withWriteTransaction((writer) => {
        writer.prepare(
          `INSERT INTO friday_agent_runs (id, task, status, session_key, attempt, max_attempts, created_at)
           VALUES ('run-123', 'test', 'completed', 'key', 0, 3, ?)`,
        ).run(NOW);
      });

      const inserted = db.withWriteTransaction((writer) => repo.insert(writer, record));

      expect(inserted.description).toBe("A test automation");
      expect(inserted.sourceRunId).toBe("run-123");
      expect(inserted.variables).toEqual({ lang: "typescript" });
      expect(inserted.skillIds).toEqual(["skill-1", "skill-2"]);
      expect(inserted.workflowIds).toEqual(["wf-1"]);
      expect(inserted.triggerId).toBe("trigger-abc");
      expect(inserted.schedule).toEqual({
        type: "cron",
        cron: "0 9 * * *",
        timezone: "America/New_York",
      });
      expect(inserted.sessionTarget).toEqual({ type: "isolated" });
    });

    it("inserts with no optional fields", () => {
      const repo = createRepo();
      const record = makeRecord();

      const inserted = db.withWriteTransaction((writer) => repo.insert(writer, record));

      expect(inserted.description).toBeUndefined();
      expect(inserted.sourceRunId).toBeUndefined();
      expect(inserted.variables).toBeUndefined();
      expect(inserted.skillIds).toBeUndefined();
      expect(inserted.workflowIds).toBeUndefined();
      expect(inserted.triggerId).toBeUndefined();
      expect(inserted.schedule).toBeUndefined();
      expect(inserted.sessionTarget).toEqual({ type: "isolated" });
      expect(inserted.lastRunId).toBeUndefined();
      expect(inserted.lastRunAt).toBeUndefined();
    });

    it("persists named session targets", () => {
      const repo = createRepo();
      const record = makeRecord({
        sessionTarget: { type: "named", sessionKey: "named-session-1" },
      });

      const inserted = db.withWriteTransaction((writer) => repo.insert(writer, record));

      expect(inserted.sessionTarget).toEqual({
        type: "named",
        sessionKey: "named-session-1",
      });
    });
  });

  // ─── findById ───

  describe("findById", () => {
    it("returns automation by id", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const found = db.withReadConnection((reader) => repo.findById(reader, record.id));

      expect(found).not.toBeNull();
      expect(found?.name).toBe("Test Automation");
    });

    it("returns null for non-existent id", () => {
      const repo = createRepo();
      const found = db.withReadConnection((reader) => repo.findById(reader, "nonexistent"));
      expect(found).toBeNull();
    });
  });

  // ─── findMany ───

  describe("findMany", () => {
    it("lists automations ordered by created_at desc", () => {
      const repo = createRepo();

      for (let i = 0; i < 3; i++) {
        const record = makeRecord({
          id: idGenerator(),
          name: `Automation ${String(i)}`,
          createdAt: `2026-02-19T10:0${String(i)}:00.000Z`,
          updatedAt: `2026-02-19T10:0${String(i)}:00.000Z`,
        });
        // idGenerator already called in makeRecord, but we override id
        db.withWriteTransaction((writer) => repo.insert(writer, record));
      }

      const automations = db.withReadConnection((reader) => repo.findMany(reader));

      expect(automations).toHaveLength(3);
      expect(automations[0].name).toBe("Automation 2");
      expect(automations[2].name).toBe("Automation 0");
    });

    it("filters by enabled", () => {
      const repo = createRepo();

      db.withWriteTransaction((writer) => {
        repo.insert(writer, makeRecord({ name: "Enabled", enabled: true }));
        repo.insert(writer, makeRecord({ name: "Disabled", enabled: false }));
      });

      const enabledOnly = db.withReadConnection((reader) =>
        repo.findMany(reader, { enabled: true }),
      );

      expect(enabledOnly).toHaveLength(1);
      expect(enabledOnly[0].name).toBe("Enabled");
    });

    it("respects limit", () => {
      const repo = createRepo();

      for (let i = 0; i < 5; i++) {
        db.withWriteTransaction((writer) =>
          repo.insert(writer, makeRecord({ name: `Auto ${String(i)}` })),
        );
      }

      const automations = db.withReadConnection((reader) =>
        repo.findMany(reader, { limit: 2 }),
      );

      expect(automations).toHaveLength(2);
    });

    it("supports cursor-based pagination", () => {
      const repo = createRepo();

      for (let i = 0; i < 3; i++) {
        db.withWriteTransaction((writer) =>
          repo.insert(writer, makeRecord({
            name: `Auto ${String(i)}`,
            createdAt: `2026-02-19T10:0${String(i)}:00.000Z`,
            updatedAt: `2026-02-19T10:0${String(i)}:00.000Z`,
          })),
        );
      }

      const page1 = db.withReadConnection((reader) =>
        repo.findMany(reader, { limit: 2 }),
      );
      expect(page1).toHaveLength(2);

      const cursor = page1[page1.length - 1].createdAt;
      const page2 = db.withReadConnection((reader) =>
        repo.findMany(reader, { limit: 2, cursor }),
      );
      expect(page2).toHaveLength(1);
    });
  });

  // ─── update ───

  describe("update", () => {
    it("updates name and description", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          name: "Updated Name",
          description: "Updated desc",
          updatedAt: "2026-02-19T11:00:00.000Z",
        }),
      );

      expect(updated?.name).toBe("Updated Name");
      expect(updated?.description).toBe("Updated desc");
      expect(updated?.updatedAt).toBe("2026-02-19T11:00:00.000Z");
    });

    it("updates enabled flag", () => {
      const repo = createRepo();
      const record = makeRecord({ enabled: true });
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, { enabled: false, updatedAt: NOW }),
      );

      expect(updated?.enabled).toBe(false);
    });

    it("updates last run info", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          lastRunId: "run-456",
          lastRunAt: "2026-02-19T12:00:00.000Z",
          runCount: 1,
          estimatedTimeSavedMinutes: 24,
          reuseCount: 1,
          promotionState: "team",
          lastOutcomeScore: 84,
          updatedAt: NOW,
        }),
      );

      expect(updated?.lastRunId).toBe("run-456");
      expect(updated?.lastRunAt).toBe("2026-02-19T12:00:00.000Z");
      expect(updated?.runCount).toBe(1);
      expect(updated?.estimatedTimeSavedMinutes).toBe(24);
      expect(updated?.reuseCount).toBe(1);
      expect(updated?.promotionState).toBe("team");
      expect(updated?.lastOutcomeScore).toBe(84);
    });

    it("updates JSON fields", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          variables: { env: "production" },
          skillIds: ["skill-a"],
          workflowIds: ["wf-b"],
          updatedAt: NOW,
        }),
      );

      expect(updated?.variables).toEqual({ env: "production" });
      expect(updated?.skillIds).toEqual(["skill-a"]);
      expect(updated?.workflowIds).toEqual(["wf-b"]);
    });

    it("updates and clears schedule fields", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const withSchedule = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          schedule: { type: "cron", cron: "*/15 * * * *", timezone: "UTC" },
          updatedAt: NOW,
        }),
      );
      expect(withSchedule?.schedule).toEqual({
        type: "cron",
        cron: "*/15 * * * *",
        timezone: "UTC",
      });

      const clearedSchedule = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          schedule: null,
          updatedAt: NOW,
        }),
      );
      expect(clearedSchedule?.schedule).toBeUndefined();
    });

    it("returns null for non-existent id", () => {
      const repo = createRepo();
      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, "nonexistent", { name: "No one" }),
      );
      expect(updated).toBeNull();
    });

    it("returns existing record when no fields to update", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {}),
      );

      expect(updated?.id).toBe(record.id);
      expect(updated?.name).toBe("Test Automation");
    });

    it("updates sessionTarget fields", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, record.id, {
          sessionTarget: { type: "current", sessionKey: "session-current-1" },
        }),
      );

      expect(updated?.sessionTarget).toEqual({
        type: "current",
        sessionKey: "session-current-1",
      });
    });
  });

  // ─── remove ───

  describe("remove", () => {
    it("removes an existing automation", () => {
      const repo = createRepo();
      const record = makeRecord();
      db.withWriteTransaction((writer) => repo.insert(writer, record));

      const removed = db.withWriteTransaction((writer) => repo.remove(writer, record.id));
      expect(removed).toBe(true);

      const found = db.withReadConnection((reader) => repo.findById(reader, record.id));
      expect(found).toBeNull();
    });

    it("returns false for non-existent id", () => {
      const repo = createRepo();
      const removed = db.withWriteTransaction((writer) => repo.remove(writer, "nonexistent"));
      expect(removed).toBe(false);
    });
  });
});
