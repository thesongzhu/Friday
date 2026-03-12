import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionMemoryExtractionRepository } from "#sessions";

describe("FridaySessionMemoryExtractionRepository", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridaySessionMemoryExtractionRepository();
  }

  describe("insert", () => {
    it("creates a queued job", () => {
      const repo = createRepo();
      const job = db.withWriteTransaction((d) =>
        repo.insert(d, {
          id: idGen(),
          sessionKey: "discord:default:user1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      expect(job.status).toBe("queued");
      expect(job.trigger).toBe("auto");
      expect(job.sessionKey).toBe("discord:default:user1");
      expect(job.batchSize).toBe(24);
      expect(job.maxBatches).toBe(8);
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
    });

    it("stores requested message IDs as JSON", () => {
      const repo = createRepo();
      const job = db.withWriteTransaction((d) =>
        repo.insert(d, {
          id: idGen(),
          sessionKey: "discord:default:user1",
          trigger: "manual",
          requestedMessageIds: ["msg-1", "msg-2"],
          batchSize: 2,
          maxBatches: 1,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      expect(job.requestedMessageIds).toEqual(["msg-1", "msg-2"]);
    });
  });

  describe("getById", () => {
    it("returns job by id", () => {
      const repo = createRepo();
      const id = idGen();
      db.withWriteTransaction((d) =>
        repo.insert(d, {
          id,
          sessionKey: "discord:default:user1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const job = db.withReadConnection((d) => repo.getById(d, id));
      expect(job).not.toBeNull();
      expect(job?.id).toBe(id);
    });

    it("returns null for missing id", () => {
      const repo = createRepo();
      const job = db.withReadConnection((d) => repo.getById(d, "nonexistent"));
      expect(job).toBeNull();
    });
  });

  describe("hasOpenAutoJob", () => {
    it("returns true when open auto job exists", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) =>
        repo.insert(d, {
          id: idGen(),
          sessionKey: "sk1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const hasOpen = db.withReadConnection((d) => repo.hasOpenAutoJob(d, "sk1"));
      expect(hasOpen).toBe(true);
    });

    it("returns false when no auto job", () => {
      const repo = createRepo();
      const hasOpen = db.withReadConnection((d) => repo.hasOpenAutoJob(d, "sk1"));
      expect(hasOpen).toBe(false);
    });

    it("returns false for manual jobs", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) =>
        repo.insert(d, {
          id: idGen(),
          sessionKey: "sk1",
          trigger: "manual",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const hasOpen = db.withReadConnection((d) => repo.hasOpenAutoJob(d, "sk1"));
      expect(hasOpen).toBe(false);
    });
  });

  describe("claimQueuedJobs", () => {
    it("returns queued jobs ordered by created_at", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) => {
        repo.insert(d, {
          id: "j2",
          sessionKey: "sk2",
          trigger: "manual",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: "2026-02-18T10:01:00.000Z",
        });
        repo.insert(d, {
          id: "j1",
          sessionKey: "sk1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: "2026-02-18T10:00:00.000Z",
        });
      });

      const jobs = db.withReadConnection((d) =>
        repo.claimQueuedJobs(d, { limit: 10, nowIso: "2026-02-18T10:02:00.000Z" }),
      );
      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe("j1");
      expect(jobs[1].id).toBe("j2");
    });

    it("respects next_attempt_at", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) => {
        repo.insert(d, {
          id: "j1",
          sessionKey: "sk1",
          trigger: "retry",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        });
        // Set next_attempt_at to the future
        d.prepare(
          "UPDATE session_memory_extraction_jobs SET next_attempt_at = '2026-12-01T00:00:00.000Z' WHERE id = 'j1'",
        ).run();
      });

      const jobs = db.withReadConnection((d) =>
        repo.claimQueuedJobs(d, { limit: 10, nowIso: NOW }),
      );
      expect(jobs).toHaveLength(0);
    });
  });

  describe("markRunning / markCompleted / markFailed", () => {
    it("transitions queued → running → completed", () => {
      const repo = createRepo();
      const id = idGen();
      db.withWriteTransaction((d) =>
        repo.insert(d, {
          id,
          sessionKey: "sk1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      const running = db.withWriteTransaction((d) =>
        repo.markRunning(d, { id, nowIso: NOW }),
      );
      expect(running?.status).toBe("running");
      expect(running?.attempts).toBe(1);
      expect(running?.startedAt).toBe(NOW);

      const completed = db.withWriteTransaction((d) =>
        repo.markCompleted(d, { id, resultJson: '{"ok":true}', nowIso: NOW }),
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.completedAt).toBe(NOW);
    });

    it("transitions queued → running → failed", () => {
      const repo = createRepo();
      const id = idGen();
      db.withWriteTransaction((d) =>
        repo.insert(d, {
          id,
          sessionKey: "sk1",
          trigger: "auto",
          batchSize: 24,
          maxBatches: 8,
          maxAttempts: 3,
          nowIso: NOW,
        }),
      );

      db.withWriteTransaction((d) => repo.markRunning(d, { id, nowIso: NOW }));

      const failed = db.withWriteTransaction((d) =>
        repo.markFailed(d, {
          id,
          errorCode: "PROVIDER_ERROR",
          errorMessage: "LLM unavailable",
          nowIso: NOW,
        }),
      );
      expect(failed?.status).toBe("failed");
      expect(failed?.lastErrorCode).toBe("PROVIDER_ERROR");
      expect(failed?.lastErrorMessage).toBe("LLM unavailable");
    });
  });

  describe("countBySessionAndStatus", () => {
    it("counts jobs by session and status", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) => {
        repo.insert(d, { id: "j1", sessionKey: "sk1", trigger: "auto", batchSize: 24, maxBatches: 8, maxAttempts: 3, nowIso: NOW });
        repo.insert(d, { id: "j2", sessionKey: "sk1", trigger: "manual", batchSize: 24, maxBatches: 8, maxAttempts: 3, nowIso: NOW });
        repo.insert(d, { id: "j3", sessionKey: "sk2", trigger: "auto", batchSize: 24, maxBatches: 8, maxAttempts: 3, nowIso: NOW });
      });

      const count = db.withReadConnection((d) =>
        repo.countBySessionAndStatus(d, "sk1", ["queued"]),
      );
      expect(count).toBe(2);
    });
  });

  describe("listFailedSessionKeys", () => {
    it("returns distinct session keys with failed jobs", () => {
      const repo = createRepo();
      db.withWriteTransaction((d) => {
        repo.insert(d, { id: "j1", sessionKey: "sk1", trigger: "auto", batchSize: 24, maxBatches: 8, maxAttempts: 3, nowIso: NOW });
        repo.markRunning(d, { id: "j1", nowIso: NOW });
        repo.markFailed(d, { id: "j1", errorCode: "ERR", errorMessage: "fail", nowIso: NOW });

        repo.insert(d, { id: "j2", sessionKey: "sk2", trigger: "manual", batchSize: 24, maxBatches: 8, maxAttempts: 3, nowIso: NOW });
      });

      const keys = db.withReadConnection((d) => repo.listFailedSessionKeys(d));
      expect(keys).toEqual(["sk1"]);
    });
  });
});
