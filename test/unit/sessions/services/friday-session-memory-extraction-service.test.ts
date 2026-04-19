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
});
