import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionMemoryExtractionRepository } from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import { createFridaySessionMemoryExtractionWorkerJob } from "#jobs";

describe("FridaySessionMemoryExtractionWorkerJob", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  let mockExtractionService: FridaySessionMemoryExtractionService;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    mockExtractionService = {
      extractFromSession: vi.fn().mockResolvedValue({
        sessionKey: "sk1",
        trigger: "auto",
        mode: "inline",
        queued: false,
        processedMessageCount: 5,
        extractedMessageCount: 3,
        skippedMessageCount: 2,
        failedMessageCount: 0,
        memoryItemsCreated: 2,
      }),
      extractSpecificMessages: vi.fn().mockResolvedValue({
        sessionKey: "sk1",
        trigger: "manual",
        mode: "inline",
        queued: false,
        processedMessageCount: 1,
        extractedMessageCount: 1,
        skippedMessageCount: 0,
        failedMessageCount: 0,
        memoryItemsCreated: 1,
      }),
      getExtractionStatus: vi.fn(),
      retryFailedExtractions: vi.fn(),
    };
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("processes no jobs when queue is empty", async () => {
    const worker = createFridaySessionMemoryExtractionWorkerJob({
      db,
      extractionService: mockExtractionService,
      nowIso: () => NOW,
    });

    const result = await worker.run();
    expect(result.processedJobs).toBe(0);
    expect(result.completedJobs).toBe(0);
    expect(result.failedJobs).toBe(0);
  });

  it("processes a queued auto job", async () => {
    const repo = createFridaySessionMemoryExtractionRepository();
    db.withWriteTransaction((d) =>
      repo.insert(d, {
        id: "job-1",
        sessionKey: "discord:default:user1",
        trigger: "auto",
        batchSize: 24,
        maxBatches: 8,
        maxAttempts: 3,
        nowIso: NOW,
      }),
    );

    const worker = createFridaySessionMemoryExtractionWorkerJob({
      db,
      extractionService: mockExtractionService,
      nowIso: () => NOW,
    });

    const result = await worker.run();

    expect(result.processedJobs).toBe(1);
    expect(result.completedJobs).toBe(1);
    expect(result.failedJobs).toBe(0);
    expect(mockExtractionService.extractFromSession).toHaveBeenCalledWith(
      "discord:default:user1",
      expect.objectContaining({ trigger: "auto", mode: "inline" }),
    );

    // Verify job is marked completed
    const job = db.withReadConnection((d) => repo.getById(d, "job-1"));
    expect(job?.status).toBe("completed");
  });

  it("processes a queued manual job with requested message IDs", async () => {
    const repo = createFridaySessionMemoryExtractionRepository();
    db.withWriteTransaction((d) =>
      repo.insert(d, {
        id: "job-2",
        sessionKey: "discord:default:user1",
        trigger: "manual",
        requestedMessageIds: ["msg-1", "msg-2"],
        batchSize: 2,
        maxBatches: 1,
        maxAttempts: 3,
        nowIso: NOW,
      }),
    );

    const worker = createFridaySessionMemoryExtractionWorkerJob({
      db,
      extractionService: mockExtractionService,
      nowIso: () => NOW,
    });

    const result = await worker.run();

    expect(result.processedJobs).toBe(1);
    expect(result.completedJobs).toBe(1);
    expect(mockExtractionService.extractSpecificMessages).toHaveBeenCalledWith(
      "discord:default:user1",
      ["msg-1", "msg-2"],
      { mode: "inline" },
    );
  });

  it("marks job as failed on extraction error", async () => {
    vi.mocked(mockExtractionService.extractFromSession).mockRejectedValue(
      new Error("LLM unavailable"),
    );

    const repo = createFridaySessionMemoryExtractionRepository();
    db.withWriteTransaction((d) =>
      repo.insert(d, {
        id: "job-3",
        sessionKey: "discord:default:user1",
        trigger: "auto",
        batchSize: 24,
        maxBatches: 8,
        maxAttempts: 3,
        nowIso: NOW,
      }),
    );

    const worker = createFridaySessionMemoryExtractionWorkerJob({
      db,
      extractionService: mockExtractionService,
      nowIso: () => NOW,
    });

    const result = await worker.run();

    expect(result.processedJobs).toBe(1);
    expect(result.completedJobs).toBe(0);
    expect(result.failedJobs).toBe(1);
  });
});
