/**
 * Integration tests for session memory extraction — service layer.
 *
 * Uses real DB + real session/extraction services, but mocks the LLM
 * client (external I/O) and the memory service's store method to avoid
 * needing a running embedding provider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import { createFridaySessionService } from "#sessions";
import type { FridaySessionService } from "#sessions";
import { createFridaySessionMemoryExtractionService } from "#sessions";
import type { FridaySessionMemoryExtractionService } from "#sessions";
import type { FridayMemoryService } from "#memory";
import type { FridayProviderService } from "#providers";

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = "2025-06-15T10:00:00.000Z";

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `tid-${String(++counter).padStart(6, "0")}`;
}

// ─── Mock factories ─────────────────────────────────────────────────────────

/**
 * Creates a mock FridayMemoryService that captures stored items.
 */
function createMockMemoryService(): FridayMemoryService & {
  storedItems: Array<{
    namespace: string;
    content: string;
    tags: string[];
    metadata: Record<string, unknown>;
  }>;
} {
  const storedItems: Array<{
    namespace: string;
    content: string;
    tags: string[];
    metadata: Record<string, unknown>;
  }> = [];

  return {
    storedItems,

    async store(namespace, content, metadata) {
      const tags = metadata?.tags ?? [];
      const meta = metadata?.metadata ?? {};
      const item = {
        id: `mem-${storedItems.length + 1}`,
        namespace,
        content,
        key: metadata?.key ?? `mem-${storedItems.length + 1}`,
        source: metadata?.source ?? "test",
        tags,
        metadata: meta,
        createdAt: NOW,
        updatedAt: NOW,
      };
      storedItems.push({ namespace, content, tags, metadata: meta });
      return item;
    },

    async search() {
      return [];
    },

    async get() {
      return null;
    },

    async list() {
      return [];
    },

    async delete() {
      return false;
    },

    async prune() {
      return { deletedCount: 0 };
    },
  };
}

/**
 * Creates a minimal mock FridayProviderService.
 *
 * `runWithFallback` delegates to the caller-supplied `run` callback,
 * passing a mock route whose API type is `"openai-completions"` so the
 * real LLM client can build the correct URL / parse the response via the
 * globally stubbed `fetch`.
 */
function createMockProviderService(): FridayProviderService {
  const mockRoute = {
    provider: {
      id: "mock-provider",
      kind: "openai" as const,
      name: "Mock",
      baseUrl: "http://mock-llm",
      enabled: true,
      config: {
        api: "openai-completions" as const,
        authMode: "bearer" as const,
        keySource: { kind: "none" as const },
        supportedModels: ["gpt-4"],
        validation: { status: "never" as const },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    model: "gpt-4",
    api: "openai-completions" as const,
    priority: 0,
  };

  return {
    async listProviders() { return []; },
    async getProvider() { return null; },
    async createProvider() { throw new Error("not implemented"); },
    async updateProvider() { throw new Error("not implemented"); },
    async deleteProvider() { throw new Error("not implemented"); },
    async validateProvider() { return { status: "never" as const }; },
    async getRoutingConfig() {
      return { defaultProviderId: "mock-provider", fallbackProviderIds: [] };
    },
    async setRoutingConfig(input) { return input; },
    async resolveRoute() { return mockRoute; },
    async runWithFallback(params) {
      const result = await params.run(mockRoute, "fake-key");
      return {
        result,
        route: mockRoute,
        attempts: [],
        routingDecision: {
          strategy: "default" as const,
          orderedCandidates: [mockRoute],
          reasoning: "test",
        },
      };
    },
    async recordUsage() {},
    async getUsageSummary() {
      return {
        totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
        totalCostUsd: 0, records: [],
      };
    },
    async getBudgetStatus() {
      return {
        budgetEnabled: false, monthlyLimitUsd: 0, currentMonthUsageUsd: 0,
        remainingUsd: 0, percentUsed: 0, warningThresholdPercent: 80,
        isWarning: false, isExceeded: false,
      };
    },
    async setBudgetConfig(input) { return input; },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Session memory extraction — integration", () => {
  let db: FridaySqliteLayer;
  let sessionService: FridaySessionService;
  let extractionService: FridaySessionMemoryExtractionService;
  let mockMemory: ReturnType<typeof createMockMemoryService>;

  beforeEach(() => {
    db = createTestDb();
    const idGenerator = createIdGenerator();

    sessionService = createFridaySessionService({
      db,
      idGenerator,
      nowIso: () => NOW,
    });

    mockMemory = createMockMemoryService();

    extractionService = createFridaySessionMemoryExtractionService({
      db,
      sessionService,
      memoryService: mockMemory,
      providerService: createMockProviderService(),
      idGenerator,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // ── inline_extraction_creates_memory_items ─────────────────────────────

  it("inline_extraction_creates_memory_items", async () => {
    // 1. Create session + add messages
    const session = await sessionService.createSession({
      channel: "discord",
      chatId: "extract-chat-001",
    });

    await sessionService.addMessage(session.key, {
      role: "user",
      content: "My favorite color is blue",
    });
    await sessionService.addMessage(session.key, {
      role: "assistant",
      content: "Got it! I'll remember that your favorite color is blue.",
    });

    // 2. Get the real message IDs so we can reference them in the mock LLM output
    const messages = await sessionService.getMessages(session.key);
    const msgIds = messages.map((m) => m.id);

    // 3. Stub fetch BEFORE calling extraction — the LLM client does fetch()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: "preference",
                      content: "User's favorite color is blue",
                      sourceMessageIds: msgIds,
                      tags: ["color.preference"],
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      }),
    );

    // 4. Run inline extraction
    const result = await extractionService.extractFromSession(session.key, {
      trigger: "manual",
      mode: "inline",
    });

    expect(result.sessionKey).toBe(session.key);
    expect(result.mode).toBe("inline");
    // Exactly 2 messages were processed
    expect(result.processedMessageCount).toBe(2);
    // Exactly 1 memory item was created
    expect(result.memoryItemsCreated).toBe(1);
    expect(mockMemory.storedItems.length).toBe(1);
    expect(mockMemory.storedItems[0]!.content).toContain("blue");
    // Check tags were passed through from the LLM response
    expect(mockMemory.storedItems[0]!.tags).toContain("color.preference");
  });

  // ── extraction_status_reflects_state ───────────────────────────────────

  it("extraction_status_reflects_state", async () => {
    // 1. Create session + messages
    const session = await sessionService.createSession({
      channel: "discord",
      chatId: "status-chat-001",
    });

    await sessionService.addMessage(session.key, {
      role: "user",
      content: "Something to extract",
    });

    // 2. Check status BEFORE extraction — should have pending messages
    const statusBefore = await extractionService.getExtractionStatus(session.key);
    expect(statusBefore.sessionKey).toBe(session.key);
    // Exactly 1 pending message
    expect(statusBefore.pendingMessages).toBe(1);
    expect(statusBefore.extractedMessages).toBe(0);

    // 3. Run extraction (mock fetch for LLM)
    const messages = await sessionService.getMessages(session.key);
    const msgIds = messages.map((m) => m.id);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      kind: "fact",
                      content: "Something to extract",
                      sourceMessageIds: msgIds,
                      tags: [],
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      }),
    );

    await extractionService.extractFromSession(session.key, {
      trigger: "manual",
      mode: "inline",
    });

    // 4. Check status AFTER extraction — pending should decrease, extracted increase
    const statusAfter = await extractionService.getExtractionStatus(session.key);
    // Pending should now be 0 (was 1 before)
    expect(statusAfter.pendingMessages).toBe(0);
    // Extracted should now be 1
    expect(statusAfter.extractedMessages).toBe(1);
  });

  // ── retry_failed_extraction ────────────────────────────────────────────

  it("retry_failed_extraction", async () => {
    // 1. Create session + messages
    const session = await sessionService.createSession({
      channel: "discord",
      chatId: "retry-chat-001",
    });

    await sessionService.addMessage(session.key, {
      role: "user",
      content: "Important decision: we will use TypeScript",
    });

    // 2. First extraction attempt: simulate failure (fetch throws)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );

    try {
      await extractionService.extractFromSession(session.key, {
        trigger: "manual",
        mode: "inline",
      });
    } catch {
      // Expected — provider error
    }

    // Messages should be marked as 'failed'
    const statusAfterFail = await extractionService.getExtractionStatus(session.key);
    // Exactly 1 failed message
    expect(statusAfterFail.failedMessages).toBe(1);

    // 3. Retry: queue a retry job
    const retryResult = await extractionService.retryFailedExtractions(session.key);
    // Exactly 1 message should be reset
    expect(retryResult.resetMessageCount).toBe(1);
    expect(retryResult.sessionsQueued).toContain(session.key);
  });
});
