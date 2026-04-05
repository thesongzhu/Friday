import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySubagentRunRepository } from "#agent";
import type { FridaySubagentOutcome } from "#agent";

describe("FridaySubagentRunRepository", () => {
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
    return createFridaySubagentRunRepository();
  }

  /** Seed a parent agent run so FK constraints are satisfied. */
  function seedParentRun(runId: string) {
    db.writer.prepare(
      `INSERT OR IGNORE INTO friday_agent_runs (id, task, status, session_key, attempt, max_attempts, created_at)
       VALUES (?, 'seed', 'pending', ?, 0, 1, ?)`,
    ).run(runId, `agent:run:${runId}`, NOW);
  }

  function createRecord(overrides?: Record<string, unknown>) {
    const id = idGenerator();
    const parentRunId = (overrides?.parentRunId as string) ?? "parent-run-1";
    seedParentRun(parentRunId);
    return {
      id,
      parentRunId,
      parentSessionKey: "agent:run:parent-run-1",
      childRunId: "",
      childSessionKey: `agent:run:parent-run-1:sub:${id}`,
      task: "Test task",
      depth: 1,
      nowIso: NOW,
      ...overrides,
    };
  }

  // ─── create ───

  describe("create", () => {
    it("creates a new subagent run with pending status", () => {
      const repo = createRepo();
      const input = createRecord({ label: "Test Label", model: "claude-3" });

      const record = db.withWriteTransaction((writer) =>
        repo.create(writer, input),
      );

      expect(record.id).toBe(input.id);
      expect(record.parentRunId).toBe("parent-run-1");
      expect(record.parentSessionKey).toBe("agent:run:parent-run-1");
      expect(record.childRunId).toBe("");
      expect(record.task).toBe("Test task");
      expect(record.mode).toBe("fresh");
      expect(record.label).toBe("Test Label");
      expect(record.model).toBe("claude-3");
      expect(record.depth).toBe(1);
      expect(record.status).toBe("pending");
      expect(record.createdAt).toBe(NOW);
      expect(record.outcome).toBeUndefined();
    });
  });

  // ─── getById ───

  describe("getById", () => {
    it("returns record by id", () => {
      const repo = createRepo();
      const input = createRecord();
      db.withWriteTransaction((writer) => repo.create(writer, input));

      const found = db.withReadConnection((reader) =>
        repo.getById(reader, input.id),
      );

      expect(found).not.toBeNull();
      expect(found?.task).toBe("Test task");
    });

    it("returns null for missing id", () => {
      const repo = createRepo();
      const found = db.withReadConnection((reader) =>
        repo.getById(reader, "nonexistent"),
      );
      expect(found).toBeNull();
    });
  });

  // ─── update ───

  describe("update", () => {
    it("updates status", () => {
      const repo = createRepo();
      const input = createRecord();
      db.withWriteTransaction((writer) => repo.create(writer, input));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id: input.id, status: "running", startedAt: NOW }),
      );

      expect(updated?.status).toBe("running");
      expect(updated?.startedAt).toBe(NOW);
    });

    it("stores outcome as JSON", () => {
      const repo = createRepo();
      const input = createRecord();
      db.withWriteTransaction((writer) => repo.create(writer, input));

      const outcome: FridaySubagentOutcome = {
        status: "completed",
        response: "Task done",
        toolCallCount: 3,
        durationMs: 1500,
        usageInput: 100,
        usageOutput: 50,
      };

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id: input.id, status: "completed", outcome }),
      );

      expect(updated?.outcome).toEqual(outcome);
      expect(updated?.status).toBe("completed");
    });

    it("persists explicit fork metadata", () => {
      const repo = createRepo();
      const input = createRecord({
        mode: "fork",
        forkedFromMessageId: "msg-42",
        inheritedMessageCount: 6,
      });

      const record = db.withWriteTransaction((writer) =>
        repo.create(writer, input),
      );

      expect(record.mode).toBe("fork");
      expect(record.forkedFromMessageId).toBe("msg-42");
      expect(record.inheritedMessageCount).toBe(6);
    });

    it("updates childRunId", () => {
      const repo = createRepo();
      const input = createRecord();
      db.withWriteTransaction((writer) => repo.create(writer, input));

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id: input.id, childRunId: "child-run-123" }),
      );

      expect(updated?.childRunId).toBe("child-run-123");
    });
  });

  // ─── listByParentRunId ───

  describe("listByParentRunId", () => {
    it("returns children for the given parent", () => {
      const repo = createRepo();
      for (let i = 0; i < 3; i++) {
        db.withWriteTransaction((writer) =>
          repo.create(writer, createRecord({
            task: `Task ${String(i)}`,
            nowIso: `2026-02-19T10:0${String(i)}:00.000Z`,
          })),
        );
      }

      const records = db.withReadConnection((reader) =>
        repo.listByParentRunId(reader, "parent-run-1"),
      );

      expect(records).toHaveLength(3);
      // Ordered by created_at ASC
      expect(records[0].task).toBe("Task 0");
      expect(records[2].task).toBe("Task 2");
    });

    it("returns empty for wrong parent", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) =>
        repo.create(writer, createRecord()),
      );

      const records = db.withReadConnection((reader) =>
        repo.listByParentRunId(reader, "wrong-parent"),
      );

      expect(records).toHaveLength(0);
    });
  });

  // ─── list ───

  describe("list", () => {
    it("filters by status", () => {
      const repo = createRepo();

      db.withWriteTransaction((writer) => {
        const r1 = createRecord({ task: "Completed task" });
        const r2 = createRecord({ task: "Pending task" });
        repo.create(writer, r1);
        repo.create(writer, r2);
        repo.update(writer, { id: r1.id, status: "completed" });
      });

      const completed = db.withReadConnection((reader) =>
        repo.list(reader, { status: "completed" }),
      );

      expect(completed).toHaveLength(1);
      expect(completed[0].task).toBe("Completed task");
    });

    it("respects limit", () => {
      const repo = createRepo();
      for (let i = 0; i < 5; i++) {
        db.withWriteTransaction((writer) =>
          repo.create(writer, createRecord({ task: `Task ${String(i)}` })),
        );
      }

      const records = db.withReadConnection((reader) =>
        repo.list(reader, { limit: 3 }),
      );

      expect(records).toHaveLength(3);
    });
  });

  // ─── countActiveByParentRunId ───

  describe("countActiveByParentRunId", () => {
    it("counts pending and running records", () => {
      const repo = createRepo();

      db.withWriteTransaction((writer) => {
        const r1 = createRecord({ task: "Pending" });
        const r2 = createRecord({ task: "Running" });
        const r3 = createRecord({ task: "Completed" });
        repo.create(writer, r1);
        repo.create(writer, r2);
        repo.create(writer, r3);
        repo.update(writer, { id: r2.id, status: "running" });
        repo.update(writer, { id: r3.id, status: "completed" });
      });

      const count = db.withReadConnection((reader) =>
        repo.countActiveByParentRunId(reader, "parent-run-1"),
      );

      // r1 is pending, r2 is running, r3 is completed
      expect(count).toBe(2);
    });
  });
});
