import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridaySessionService,
  createFridaySessionMemoryExtractionService,
  FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES,
} from "#sessions";
import type {
  FridaySessionService,
  FridaySessionMemoryExtractionService,
} from "#sessions";
import { createFridayAgentMemoryExtractTool } from "#agent";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

// ─── Mock helpers ───

function createMockMemoryService(): FridayMemoryService {
  return {
    store: vi.fn().mockResolvedValue({
      id: "mem-1",
      namespace: "test",
      key: "mem-1",
      content: "test",
      source: "session:test",
      tags: [],
      metadata: {},
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    }),
    search: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedIds: [], dryRun: false }),
  };
}

function createMockProviderService(): FridayProviderService {
  const mockService = {
    listProviders: vi.fn().mockResolvedValue([]),
    getProvider: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn().mockResolvedValue({
      result: JSON.stringify({
        items: [
          {
            kind: "fact",
            content: "User prefers dark mode",
            sourceMessageIds: ["placeholder"],
            tags: ["ui"],
          },
        ],
      }),
      route: { model: "test-model", provider: { id: "test", name: "test" } },
      attempts: [],
      routingDecision: { strategy: "configured" },
    }),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
  };
  return mockService as unknown as FridayProviderService;
}

describe("FridaySessionMemoryExtractionService", () => {
  let db: FridaySqliteLayer;
  let sessionService: FridaySessionService;
  let extractionService: FridaySessionMemoryExtractionService;
  let memoryService: FridayMemoryService;
  let providerService: FridayProviderService;
  let idGen: () => string;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(async () => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    sessionService = createFridaySessionService({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    memoryService = createMockMemoryService();
    providerService = createMockProviderService();

    extractionService = createFridaySessionMemoryExtractionService({
      db,
      sessionService,
      memoryService,
      providerService,
      idGenerator: idGen,
      nowIso: () => NOW,
      // TS-runtime retirement: the three mutators are METHOD-level fail-closed
      // unless this explicit test-oracle flag is set. These behavioral tests
      // exercise the live extraction logic, so opt in (Directive 0b) — the
      // default-off fail-closed behavior is covered by the dedicated guard tests
      // below.
      allowTestOnlySessionMemoryExtractionExecution: true,
    });

    // Create a test session with messages
    await sessionService.createSession({
      channel: "discord",
      chatId: "user1",
      userId: "user1",
    });
    await sessionService.addMessage("discord:default:user1", {
      role: "user",
      content: "I prefer dark mode for all my apps",
      contentText: "I prefer dark mode for all my apps",
    });
    await sessionService.addMessage("discord:default:user1", {
      role: "assistant",
      content: "Got it! Dark mode preference noted.",
      contentText: "Got it! Dark mode preference noted.",
    });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe("extractFromSession", () => {
    it("throws when session not found", async () => {
      await expect(
        extractionService.extractFromSession("nonexistent:key:here"),
      ).rejects.toThrow(FridayDomainError);
    });

    it("queues auto extraction job", async () => {
      const result = await extractionService.extractFromSession(
        "discord:default:user1",
        { trigger: "auto", mode: "queue" },
      );

      expect(result.mode).toBe("queued");
      expect(result.queued).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.trigger).toBe("auto");
    });

    it("deduplicates auto jobs", async () => {
      const first = await extractionService.extractFromSession(
        "discord:default:user1",
        { trigger: "auto", mode: "queue" },
      );
      expect(first.queued).toBe(true);

      const second = await extractionService.extractFromSession(
        "discord:default:user1",
        { trigger: "auto", mode: "queue" },
      );
      expect(second.queued).toBe(false);
    });

    it("runs inline extraction with manual trigger", async () => {
      // Mock LLM to return items referencing actual message IDs
      const messages = await sessionService.getMessages("discord:default:user1");
      const msgIds = messages.map((m) => m.id);

      vi.mocked(providerService.runWithFallback).mockResolvedValue({
        result: JSON.stringify({
          items: [
            {
              kind: "preference",
              content: "User prefers dark mode for all apps",
              sourceMessageIds: msgIds,
              tags: ["ui.theme"],
            },
          ],
        }),
        route: { model: "test", provider: { id: "test", name: "test", config: { api: "openai-completions" }, baseUrl: "http://test" } },
        attempts: [],
        routingDecision: { strategy: "configured" },
      } as ReturnType<FridayProviderService["runWithFallback"]>);

      const result = await extractionService.extractFromSession(
        "discord:default:user1",
        { trigger: "manual", mode: "inline" },
      );

      expect(result.mode).toBe("inline");
      expect(result.queued).toBe(false);
      expect(result.processedMessageCount).toBeGreaterThan(0);
      expect(result.memoryItemsCreated).toBeGreaterThan(0);
      expect(memoryService.store).toHaveBeenCalled();
    });
  });

  describe("extractSpecificMessages", () => {
    it("throws on empty messageIds", async () => {
      await expect(
        extractionService.extractSpecificMessages("discord:default:user1", []),
      ).rejects.toThrow(FridayDomainError);
    });

    it("throws when session not found", async () => {
      await expect(
        extractionService.extractSpecificMessages("nonexistent:key:here", ["msg-1"]),
      ).rejects.toThrow(FridayDomainError);
    });

    it("throws when messages not found in session", async () => {
      await expect(
        extractionService.extractSpecificMessages("discord:default:user1", ["nonexistent-msg"]),
      ).rejects.toThrow(FridayDomainError);
    });

    it("extracts specific messages inline", async () => {
      const messages = await sessionService.getMessages("discord:default:user1");
      const targetId = messages[0].id;

      vi.mocked(providerService.runWithFallback).mockResolvedValue({
        result: JSON.stringify({
          items: [
            {
              kind: "preference",
              content: "Prefers dark mode",
              sourceMessageIds: [targetId],
            },
          ],
        }),
        route: { model: "test", provider: { id: "test", name: "test", config: { api: "openai-completions" }, baseUrl: "http://test" } },
        attempts: [],
        routingDecision: { strategy: "configured" },
      } as ReturnType<FridayProviderService["runWithFallback"]>);

      const result = await extractionService.extractSpecificMessages(
        "discord:default:user1",
        [targetId],
      );

      expect(result.mode).toBe("inline");
      expect(result.trigger).toBe("manual");
      expect(result.processedMessageCount).toBe(1);
    });

    it("does not re-extract messages that are already marked extracted", async () => {
      const messages = await sessionService.getMessages("discord:default:user1");
      const targetId = messages[0].id;

      db.withWriteTransaction((d) => {
        d.prepare(
          `UPDATE session_messages
           SET memory_extract_status = 'extracted',
               memory_extracted_at = ?,
               updated_at = ?
           WHERE id = ?`,
        ).run(NOW, NOW, targetId);
      });

      const result = await extractionService.extractSpecificMessages(
        "discord:default:user1",
        [targetId],
      );

      expect(result.mode).toBe("inline");
      expect(result.trigger).toBe("manual");
      expect(result.processedMessageCount).toBe(0);
      expect(result.skippedMessageCount).toBe(1);
      expect(result.memoryItemsCreated).toBe(0);
      expect(memoryService.store).not.toHaveBeenCalled();
      expect(providerService.runWithFallback).not.toHaveBeenCalled();
    });
  });

  describe("getExtractionStatus", () => {
    it("throws when session not found", async () => {
      await expect(
        extractionService.getExtractionStatus("nonexistent:key:here"),
      ).rejects.toThrow(FridayDomainError);
    });

    it("returns status with message counts", async () => {
      const status = await extractionService.getExtractionStatus("discord:default:user1");

      expect(status.sessionKey).toBe("discord:default:user1");
      expect(status.pendingMessages).toBe(2);
      expect(status.extractedMessages).toBe(0);
      expect(status.skippedMessages).toBe(0);
      expect(status.failedMessages).toBe(0);
      expect(status.queuedJobs).toBe(0);
      expect(status.runningJobs).toBe(0);
    });

    it("includes queued job count", async () => {
      await extractionService.extractFromSession("discord:default:user1", {
        trigger: "auto",
        mode: "queue",
      });

      const status = await extractionService.getExtractionStatus("discord:default:user1");
      expect(status.queuedJobs).toBe(1);
    });
  });

  describe("retryFailedExtractions", () => {
    it("returns empty result when no failures", async () => {
      const result = await extractionService.retryFailedExtractions("discord:default:user1");
      expect(result.sessionsQueued).toEqual([]);
      expect(result.resetMessageCount).toBe(0);
    });

    it("counts failed messages and queues retry job without resetting status", async () => {
      // Mark messages as failed
      db.withWriteTransaction((d) => {
        d.prepare(
          "UPDATE session_messages SET memory_extract_status = 'failed' WHERE session_key = 'discord:default:user1'",
        ).run();
      });

      const result = await extractionService.retryFailedExtractions("discord:default:user1");
      expect(result.resetMessageCount).toBe(2);
      expect(result.sessionsQueued).toContain("discord:default:user1");

      // Messages remain 'failed' — the retry job reads them directly
      const rows = db.withReadConnection((d) =>
        d.prepare(
          "SELECT memory_extract_status FROM session_messages WHERE session_key = 'discord:default:user1'",
        ).all(),
      ) as Array<{ memory_extract_status: string }>;
      expect(rows.every((r) => r.memory_extract_status === "failed")).toBe(true);
    });

    it("retry trigger reads failed messages and processes them (end-to-end)", async () => {
      const messages = await sessionService.getMessages("discord:default:user1");
      const msgIds = messages.map((m) => m.id);

      // Mark messages as failed
      db.withWriteTransaction((d) => {
        d.prepare(
          "UPDATE session_messages SET memory_extract_status = 'failed' WHERE session_key = 'discord:default:user1'",
        ).run();
      });

      // Mock LLM to return items referencing actual message IDs
      vi.mocked(providerService.runWithFallback).mockResolvedValue({
        result: JSON.stringify({
          items: [
            {
              kind: "fact",
              content: "Retried extraction",
              sourceMessageIds: msgIds,
              tags: [],
            },
          ],
        }),
        route: { model: "test", provider: { id: "test", name: "test", config: { api: "openai-completions" }, baseUrl: "http://test" } },
        attempts: [],
        routingDecision: { strategy: "configured" },
      } as ReturnType<FridayProviderService["runWithFallback"]>);

      // Run inline retry — this directly reads 'failed' messages
      const result = await extractionService.extractFromSession("discord:default:user1", {
        trigger: "retry",
        mode: "inline",
      });

      expect(result.processedMessageCount).toBe(2);
      expect(result.extractedMessageCount).toBe(2);
      expect(result.memoryItemsCreated).toBeGreaterThan(0);

      // Verify messages are now 'extracted'
      const rows = db.withReadConnection((d) =>
        d.prepare(
          "SELECT memory_extract_status FROM session_messages WHERE session_key = 'discord:default:user1'",
        ).all(),
      ) as Array<{ memory_extract_status: string }>;
      expect(rows.every((r) => r.memory_extract_status === "extracted")).toBe(true);
    });
  });

  describe("batch options passthrough", () => {
    it("honours batchSize and maxBatches in inline mode", async () => {
      // Add more messages to see batching effects
      for (let i = 0; i < 5; i++) {
        await sessionService.addMessage("discord:default:user1", {
          role: "user",
          content: `Message ${i}`,
          contentText: `Message ${i}`,
        });
      }

      const allMessages = await sessionService.getMessages("discord:default:user1");
      const allIds = allMessages.map((m) => m.id);

      // Mock LLM — always returns items referencing all batch message ids
      vi.mocked(providerService.runWithFallback).mockImplementation(async ({ run }) => {
        // The run function is not called directly; mock return
        return {
          result: JSON.stringify({
            items: [
              {
                kind: "fact",
                content: "Some fact",
                sourceMessageIds: allIds.slice(0, 2),
              },
            ],
          }),
          route: { model: "test", provider: { id: "test", name: "test", config: { api: "openai-completions" }, baseUrl: "http://test" } },
          attempts: [],
          routingDecision: { strategy: "configured" },
        } as ReturnType<FridayProviderService["runWithFallback"]>;
      });

      // batchSize=3, maxBatches=1 → only first 3 messages processed
      const result = await extractionService.extractFromSession("discord:default:user1", {
        trigger: "manual",
        mode: "inline",
        batchSize: 3,
        maxBatches: 1,
      });

      // Should process exactly 3 messages (1 batch × 3)
      expect(result.processedMessageCount).toBe(3);
    });
  });

  describe("TS-runtime retirement: METHOD-level fail-closed guard", () => {
    // Construct a SEPARATE service WITHOUT the test-oracle flag (mirrors the
    // production/runtime hub + the three non-route callers: lifecycle job,
    // memory-extraction job, agent memory-extract tool). The mutators must fail
    // closed BEFORE any read/persist/LLM-call.
    function createUnflaggedService(): FridaySessionMemoryExtractionService {
      return createFridaySessionMemoryExtractionService({
        db,
        sessionService,
        memoryService,
        providerService,
        idGenerator: idGen,
        nowIso: () => NOW,
        // allowTestOnlySessionMemoryExtractionExecution intentionally unset → fail-closed
      });
    }

    function countJobRows(): number {
      return db.withReadConnection((d) => {
        const row = d.prepare(
          "SELECT COUNT(*) AS cnt FROM session_memory_extraction_jobs WHERE session_key = ?",
        ).get("discord:default:user1") as { cnt: number };
        return row.cnt;
      });
    }

    function pendingMessageCount(): number {
      return db.withReadConnection((d) => {
        const row = d.prepare(
          "SELECT COUNT(*) AS cnt FROM session_messages WHERE session_key = ? AND memory_extract_status = 'pending'",
        ).get("discord:default:user1") as { cnt: number };
        return row.cnt;
      });
    }

    it("extractFromSession fails closed (503) when the flag is unset and persists NO job rows", async () => {
      const unflagged = createUnflaggedService();
      const jobsBefore = countJobRows();
      const pendingBefore = pendingMessageCount();

      let thrown: unknown;
      try {
        await unflagged.extractFromSession("discord:default:user1", { trigger: "auto", mode: "queue" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FridayDomainError);
      expect(thrown).toMatchObject({
        code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
        httpStatus: 503,
      });
      // No partial side-effect: no job queued, no memory items, no status mutation.
      expect(countJobRows()).toBe(jobsBefore);
      expect(pendingMessageCount()).toBe(pendingBefore);
      expect(memoryService.store).not.toHaveBeenCalled();
      expect(providerService.runWithFallback).not.toHaveBeenCalled();
    });

    it("extractFromSession (inline) fails closed (503) and persists NO memory items / NO status mutation", async () => {
      const unflagged = createUnflaggedService();
      const pendingBefore = pendingMessageCount();

      await expect(
        unflagged.extractFromSession("discord:default:user1", { trigger: "manual", mode: "inline" }),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
        httpStatus: 503,
      });

      expect(pendingMessageCount()).toBe(pendingBefore);
      expect(memoryService.store).not.toHaveBeenCalled();
      expect(providerService.runWithFallback).not.toHaveBeenCalled();
    });

    it("extractSpecificMessages fails closed (503) BEFORE the empty-input check and persists NO side-effect", async () => {
      const unflagged = createUnflaggedService();
      const messages = await sessionService.getMessages("discord:default:user1");
      const targetId = messages[0].id;
      const pendingBefore = pendingMessageCount();

      await expect(
        unflagged.extractSpecificMessages("discord:default:user1", [targetId]),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
        httpStatus: 503,
      });

      // Guard runs before the empty-input check too (fail-closed, not a 400).
      await expect(
        unflagged.extractSpecificMessages("discord:default:user1", []),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
        httpStatus: 503,
      });

      expect(pendingMessageCount()).toBe(pendingBefore);
      expect(memoryService.store).not.toHaveBeenCalled();
      expect(providerService.runWithFallback).not.toHaveBeenCalled();
    });

    it("retryFailedExtractions fails closed (503) when the flag is unset and persists NO job rows", async () => {
      const unflagged = createUnflaggedService();
      // Mark messages failed so a flagged retry would otherwise queue a job.
      db.withWriteTransaction((d) => {
        d.prepare(
          "UPDATE session_messages SET memory_extract_status = 'failed' WHERE session_key = 'discord:default:user1'",
        ).run();
      });
      const jobsBefore = countJobRows();

      await expect(
        unflagged.retryFailedExtractions("discord:default:user1"),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_SESSION_MEMORY_EXTRACTION_RETIRED",
        httpStatus: 503,
      });

      expect(countJobRows()).toBe(jobsBefore);
    });

    it("the agent memory-extract tool path fails closed when the flag is unset", async () => {
      const unflagged = createUnflaggedService();
      const tool = createFridayAgentMemoryExtractTool({ extractionService: unflagged });

      // Default tool mode is "inline" → reaches extractFromSession → guard fires.
      // The tool catches the FridayDomainError and surfaces it as a failed tool
      // result (content carries the retirement fail-closed message).
      const output = await tool.execute(
        { sessionKey: "discord:default:user1" },
        new AbortController().signal,
      );

      expect(output.isError).toBe(true);
      expect(output.content).toContain("fail-closed");
      expect(output.content).toContain("session_memory_extraction");
      // No partial side-effect: no LLM call, no memory persisted.
      expect(memoryService.store).not.toHaveBeenCalled();
      expect(providerService.runWithFallback).not.toHaveBeenCalled();
    });

    it("getExtractionStatus (read-only) stays LIVE even when the flag is unset", async () => {
      const unflagged = createUnflaggedService();
      const status = await unflagged.getExtractionStatus("discord:default:user1");
      expect(status.sessionKey).toBe("discord:default:user1");
      expect(status.pendingMessages).toBe(2);
    });
  });
});
