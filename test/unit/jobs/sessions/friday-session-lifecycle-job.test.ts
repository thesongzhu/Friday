import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionService, FRIDAY_SESSION_IDLE_TIMEOUT_MS } from "#sessions";
import type { FridaySessionService, FridaySessionMemoryExtractionService } from "#sessions";
import { createFridaySessionLifecycleJob } from "#jobs";

describe("FridaySessionLifecycleJob", () => {
  let db: FridaySqliteLayer;
  let sessionService: FridaySessionService;
  let mockExtractionService: FridaySessionMemoryExtractionService;
  let idGen: () => string;

  const BASE_TIME = new Date("2026-02-18T10:00:00.000Z").getTime();

  beforeEach(async () => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    sessionService = createFridaySessionService({
      db,
      idGenerator: idGen,
      nowIso: () => new Date(BASE_TIME).toISOString(),
    });

    mockExtractionService = {
      extractFromSession: vi.fn().mockResolvedValue({
        sessionKey: "",
        trigger: "auto",
        mode: "queued",
        queued: true,
        processedMessageCount: 0,
        extractedMessageCount: 0,
        skippedMessageCount: 0,
        failedMessageCount: 0,
        memoryItemsCreated: 0,
      }),
      extractSpecificMessages: vi.fn(),
      getExtractionStatus: vi.fn(),
      retryFailedExtractions: vi.fn(),
    };

    // Create a session with activity in the past
    await sessionService.createSession({
      channel: "discord",
      chatId: "user1",
      userId: "user1",
    });
    await sessionService.addMessage("discord:default:user1", {
      role: "user",
      content: "Hello",
    });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("sweeps idle sessions and enqueues extraction", async () => {
    // Advance time past idle timeout
    const futureTime = BASE_TIME + FRIDAY_SESSION_IDLE_TIMEOUT_MS + 60_000;
    const futureIso = () => new Date(futureTime).toISOString();

    // Need a new session service with advanced time for sweep
    const futureSessionService = createFridaySessionService({
      db,
      idGenerator: idGen,
      nowIso: futureIso,
    });

    const job = createFridaySessionLifecycleJob({
      db,
      sessionService: futureSessionService,
      extractionService: mockExtractionService,
      nowIso: futureIso,
    });

    const result = await job.run();

    expect(result.sweep.idledCount).toBe(1);
    expect(result.idledSessionKeys).toContain("discord:default:user1");
    expect(result.extractionsQueued).toBe(1);
    expect(mockExtractionService.extractFromSession).toHaveBeenCalledWith(
      "discord:default:user1",
      { trigger: "auto", mode: "queue" },
    );
  });

  it("handles extraction failure gracefully", async () => {
    const futureTime = BASE_TIME + FRIDAY_SESSION_IDLE_TIMEOUT_MS + 60_000;
    const futureIso = () => new Date(futureTime).toISOString();

    const futureSessionService = createFridaySessionService({
      db,
      idGenerator: idGen,
      nowIso: futureIso,
    });

    vi.mocked(mockExtractionService.extractFromSession).mockRejectedValue(
      new Error("Provider unavailable"),
    );

    const job = createFridaySessionLifecycleJob({
      db,
      sessionService: futureSessionService,
      extractionService: mockExtractionService,
      nowIso: futureIso,
    });

    const result = await job.run();

    // Sweep should still succeed
    expect(result.sweep.idledCount).toBe(1);
    // Extraction should fail gracefully
    expect(result.extractionsQueued).toBe(0);
  });

  it("returns zero counts when no sessions are idle", async () => {
    // Session was just created, so not idle yet
    const job = createFridaySessionLifecycleJob({
      db,
      sessionService,
      extractionService: mockExtractionService,
      nowIso: () => new Date(BASE_TIME).toISOString(),
    });

    const result = await job.run();

    expect(result.sweep.idledCount).toBe(0);
    expect(result.extractionsQueued).toBe(0);
    expect(result.idledSessionKeys).toEqual([]);
  });
});
