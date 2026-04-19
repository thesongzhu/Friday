import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAgentRunRepository } from "#agent";

describe("FridayAgentRunRepository", () => {
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
    return createFridayAgentRunRepository();
  }

  // ─── create ───

  describe("create", () => {
    it("creates a new run with pending status", () => {
      const repo = createRepo();
      const run = db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id: idGenerator(),
          task: "Build a hello world script",
          sessionKey: "agent:run:test-1",
          providerId: "anthropic",
          model: "claude-3",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      expect(run.id).toBe("test-id-0001");
      expect(run.task).toBe("Build a hello world script");
      expect(run.status).toBe("pending");
      expect(run.sessionKey).toBe("agent:run:test-1");
      expect(run.providerId).toBe("anthropic");
      expect(run.model).toBe("claude-3");
      expect(run.attempt).toBe(0);
      expect(run.maxAttempts).toBe(3);
      expect(run.createdAt).toBe(NOW);
    });

    it("creates run without optional fields", () => {
      const repo = createRepo();
      const run = db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id: idGenerator(),
          task: "Simple task",
          sessionKey: "agent:run:test-2",
          maxAttempts: 1,
          nowIso: NOW,
        }),
      );

      expect(run.providerId).toBeUndefined();
      expect(run.model).toBeUndefined();
    });
  });

  // ─── getById ───

  describe("getById", () => {
    it("returns run by id", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Find me",
          sessionKey: "agent:run:find",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const found = db.withReadConnection((reader) => repo.getById(reader, id));

      expect(found).not.toBeNull();
      expect(found?.task).toBe("Find me");
    });

    it("returns null for non-existent id", () => {
      const repo = createRepo();
      const found = db.withReadConnection((reader) =>
        repo.getById(reader, "nonexistent"),
      );
      expect(found).toBeNull();
    });

    it("finds the latest run by API idempotency metadata", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Find me by idempotency",
          sessionKey: "agent:run:idem",
          maxAttempts: 3,
          nowIso: NOW,
          metadata: {
            apiRequest: {
              operationId: "agent.runs.start",
              principalId: "user-1",
              idempotencyKey: "idem-1",
              payloadHash: "hash-1",
              receivedAt: NOW,
            },
          },
        }),
      );

      const found = db.withReadConnection((reader) =>
        repo.findLatestByApiRequestIdempotencyKey(reader, {
          principalId: "user-1",
          idempotencyKey: "idem-1",
        }),
      );

      expect(found?.id).toBe(id);
      expect(found?.metadata?.apiRequest?.payloadHash).toBe("hash-1");
    });
  });

  // ─── update ───

  describe("update", () => {
    it("updates run status", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Update me",
          sessionKey: "agent:run:update",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id, status: "executing", startedAt: NOW }),
      );

      expect(updated?.status).toBe("executing");
      expect(updated?.startedAt).toBe(NOW);
    });

    it("updates multiple fields at once", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Multi update",
          sessionKey: "agent:run:multi",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id,
          status: "completed",
          completedAt: NOW,
          durationMs: 5000,
          usageInput: 100,
          usageOutput: 50,
          costUsd: 0.01,
        }),
      );

      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBe(NOW);
      expect(updated?.durationMs).toBe(5000);
      expect(updated?.usageInput).toBe(100);
      expect(updated?.usageOutput).toBe(50);
      expect(updated?.costUsd).toBe(0.01);
    });

    it("updates error fields", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Error update",
          sessionKey: "agent:run:error",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id,
          status: "failed",
          errorCode: "AGENT_LLM_ERROR",
          errorMessage: "Something went wrong",
        }),
      );

      expect(updated?.status).toBe("failed");
      expect(updated?.errorCode).toBe("AGENT_LLM_ERROR");
      expect(updated?.errorMessage).toBe("Something went wrong");
    });

    it("updates artifacts as JSON", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Artifacts update",
          sessionKey: "agent:run:artifacts",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const artifacts = [{ type: "file", path: "/tmp/hello.ts" }];
      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id, artifacts }),
      );

      expect(updated?.artifacts).toEqual(artifacts);
    });

    it("returns null for non-existent id", () => {
      const repo = createRepo();
      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id: "nonexistent", status: "completed" }),
      );
      expect(updated).toBeNull();
    });

    it("round-trips plan_review_json", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Plan review test",
          sessionKey: "agent:run:plan",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const planReview = {
        plan: { task: "Plan review test", stepCount: 3, description: "Test plan" },
        decision: { approved: true, mode: "auto-approve", reason: "Auto", reviewedAt: NOW },
      };

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id, planReview }),
      );

      expect(updated?.planReview).toEqual(planReview);
    });

    it("round-trips actual_execution_json", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Actual exec test",
          sessionKey: "agent:run:actual",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const actualExecution = {
        actualProviderId: "anthropic-1",
        actualModel: "claude-3-haiku",
        totalCostUsd: 0.01,
        turns: [{ providerId: "anthropic-1", model: "claude-3-haiku", inputTokens: 100, outputTokens: 50, costUsd: 0.01 }],
      };

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, { id, actualExecution }),
      );

      expect(updated?.actualExecution).toEqual(actualExecution);
    });

    it("round-trips constraints_json", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Constraints test",
          sessionKey: "agent:run:constraints",
          maxAttempts: 3,
          nowIso: NOW,
          constraints: { readOnly: true },
        }),
      );

      const run = db.withReadConnection((reader) => repo.getById(reader, id));
      expect(run?.constraints).toEqual({ readOnly: true });
    });

    it("round-trips response_text and summary", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Response text test",
          sessionKey: "agent:run:resp",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id,
          responseText: "Here is the result.",
          summary: "Here is the result.",
        }),
      );

      expect(updated?.responseText).toBe("Here is the result.");
      expect(updated?.summary).toBe("Here is the result.");
    });

    it("round-trips artifact_dir", () => {
      const repo = createRepo();
      const id = idGenerator();
      db.withWriteTransaction((writer) =>
        repo.create(writer, {
          id,
          task: "Artifact dir test",
          sessionKey: "agent:run:artifactdir",
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const updated = db.withWriteTransaction((writer) =>
        repo.update(writer, {
          id,
          artifactDir: "/tmp/.friday/agent-runs/run-123",
        }),
      );

      expect(updated?.artifactDir).toBe("/tmp/.friday/agent-runs/run-123");
    });
  });

  // ─── list ───

  describe("list", () => {
    it("lists runs ordered by created_at desc", () => {
      const repo = createRepo();

      for (let i = 0; i < 3; i++) {
        db.withWriteTransaction((writer) =>
          repo.create(writer, {
            id: idGenerator(),
            task: `Task ${String(i)}`,
            sessionKey: `agent:run:list-${String(i)}`,
            maxAttempts: 3,
            nowIso: `2026-02-19T10:0${String(i)}:00.000Z`,
          }),
        );
      }

      const runs = db.withReadConnection((reader) => repo.list(reader));

      expect(runs).toHaveLength(3);
      // Newest first
      expect(runs[0].task).toBe("Task 2");
      expect(runs[2].task).toBe("Task 0");
    });

    it("filters by status", () => {
      const repo = createRepo();

      db.withWriteTransaction((writer) => {
        repo.create(writer, {
          id: idGenerator(),
          task: "Completed task",
          sessionKey: "agent:run:c",
          maxAttempts: 3,
          nowIso: NOW,
        });
        repo.create(writer, {
          id: idGenerator(),
          task: "Pending task",
          sessionKey: "agent:run:p",
          maxAttempts: 3,
          nowIso: NOW,
        });
        repo.update(writer, { id: "test-id-0001", status: "completed" });
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
          repo.create(writer, {
            id: idGenerator(),
            task: `Task ${String(i)}`,
            sessionKey: `agent:run:limit-${String(i)}`,
            maxAttempts: 3,
            nowIso: NOW,
          }),
        );
      }

      const runs = db.withReadConnection((reader) =>
        repo.list(reader, { limit: 2 }),
      );

      expect(runs).toHaveLength(2);
    });

    it("supports cursor-based pagination", () => {
      const repo = createRepo();

      for (let i = 0; i < 3; i++) {
        db.withWriteTransaction((writer) =>
          repo.create(writer, {
            id: idGenerator(),
            task: `Task ${String(i)}`,
            sessionKey: `agent:run:cursor-${String(i)}`,
            maxAttempts: 3,
            nowIso: `2026-02-19T10:0${String(i)}:00.000Z`,
          }),
        );
      }

      const page1 = db.withReadConnection((reader) =>
        repo.list(reader, { limit: 2 }),
      );
      expect(page1).toHaveLength(2);

      const cursor = page1[page1.length - 1].createdAt;
      const page2 = db.withReadConnection((reader) =>
        repo.list(reader, { limit: 2, cursor }),
      );
      expect(page2).toHaveLength(1);
    });
  });

  // ─── listActive ───

  describe("listActive", () => {
    it("returns runs in active statuses only", () => {
      const repo = createRepo();
      const ids: string[] = [];

      // Create runs in various statuses
      db.withWriteTransaction((writer) => {
        const r1 = repo.create(writer, { id: idGenerator(), task: "Pending", sessionKey: "s:1", maxAttempts: 3, nowIso: NOW });
        ids.push(r1.id);
        const r2 = repo.create(writer, { id: idGenerator(), task: "Executing", sessionKey: "s:2", maxAttempts: 3, nowIso: NOW });
        repo.update(writer, { id: r2.id, status: "executing" });
        ids.push(r2.id);
        const r3 = repo.create(writer, { id: idGenerator(), task: "Completed", sessionKey: "s:3", maxAttempts: 3, nowIso: NOW });
        repo.update(writer, { id: r3.id, status: "completed" });
        ids.push(r3.id);
        const r4 = repo.create(writer, { id: idGenerator(), task: "Failed", sessionKey: "s:4", maxAttempts: 3, nowIso: NOW });
        repo.update(writer, { id: r4.id, status: "failed" });
        ids.push(r4.id);
        const r5 = repo.create(writer, { id: idGenerator(), task: "Planning", sessionKey: "s:5", maxAttempts: 3, nowIso: NOW });
        repo.update(writer, { id: r5.id, status: "planning" });
        ids.push(r5.id);
      });

      const active = db.withReadConnection((reader) => repo.listActive(reader));

      // Should include pending, executing, planning but NOT completed or failed
      expect(active).toHaveLength(3);
      const statuses = active.map((r) => r.status);
      expect(statuses).toContain("pending");
      expect(statuses).toContain("executing");
      expect(statuses).toContain("planning");
      expect(statuses).not.toContain("completed");
      expect(statuses).not.toContain("failed");
    });

    it("returns empty array when no active runs", () => {
      const repo = createRepo();

      db.withWriteTransaction((writer) => {
        const r = repo.create(writer, { id: idGenerator(), task: "Done", sessionKey: "s:1", maxAttempts: 3, nowIso: NOW });
        repo.update(writer, { id: r.id, status: "completed" });
      });

      const active = db.withReadConnection((reader) => repo.listActive(reader));
      expect(active).toHaveLength(0);
    });
  });
});
