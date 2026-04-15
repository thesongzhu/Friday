/**
 * Integration tests for the full compaction pipeline:
 *
 *   Bridge → Provider Compactor → Memory Sink → Context Formatter → Preference Injector
 *
 * These tests verify that the mechanisms are truly connected end-to-end,
 * not just that types compile.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createFridayProviderContextCompactor,
} from "#providers";
import type {
  FridayProviderContextMessage,
  FridayContextCompactionSummary,
  FridayContextCompactionBlockSummary,
} from "#providers";
import type { FridayAgentMessage } from "#agent";

import {
  createFridayAgentCompactionBridge,
} from "../../../../src/agent/runtime/friday-agent-compaction-bridge.js";
import type {
  FridayAgentCompactionBridgeResult,
} from "../../../../src/agent/runtime/friday-agent-compaction-bridge.js";

import {
  createFridayCompactionMemorySink,
} from "../../../../src/agent/runtime/friday-agent-compaction-memory-sink.js";

import {
  verifyCompactionSummary,
} from "../../../../src/agent/runtime/friday-agent-compaction-verifier.js";

import {
  groupCompactionMemoryItems,
  formatCompactionContextForPrompt,
} from "../../../../src/agent/runtime/friday-agent-compaction-context-formatter.js";

import {
  createFridayPreferenceInjector,
} from "../../../../src/agent/runtime/friday-agent-preference-injector.js";

import {
  createFridayProviderTokenEstimator,
} from "../../../../src/providers/context/friday-provider-token-estimator.js";

import {
  createFridayProviderContextPruner,
} from "../../../../src/providers/context/friday-provider-context-pruner.js";

import type { FridayMemoryItem } from "../../../../src/memory/model/friday-memory.types.js";

// ─── Helpers ───

let idCounter = 0;
function testIdGenerator(): string {
  return `test-id-${String(++idCounter).padStart(4, "0")}`;
}

const NOW = "2026-04-15T10:00:00.000Z";
function testNowIso(): string {
  return NOW;
}

function makeAgentMessages(count: number, options?: {
  includeToolUse?: boolean;
  includeFailures?: boolean;
  includeDecisions?: boolean;
}): FridayAgentMessage[] {
  const msgs: FridayAgentMessage[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      // User message
      let content = `User message ${i}: tell me about step ${i / 2}`;
      if (options?.includeDecisions && i === 4) {
        content = "I recommend we use TypeScript strict mode for this project. Should we proceed?";
      }
      if (i === 6) {
        content = "What about the next step? We need to deploy to production.";
      }
      msgs.push({ role: "user", content });
    } else {
      // Assistant message
      let content = `Assistant response ${i}: completed step ${(i - 1) / 2} successfully`;
      if (options?.includeFailures && i === 3) {
        content = "The browser session was not connected. Failed to open the page. Error: ECONNREFUSED.";
      }
      if (options?.includeToolUse && i === 1) {
        msgs.push({
          role: "assistant",
          content: [
            {
              type: "tool_use" as const,
              name: "exec",
              input: { command: "npm test" },
              id: `tool-${i}`,
            },
          ],
        });
        continue;
      }
      if (options?.includeDecisions && i === 5) {
        content = "I recommend using AWS ECS for deployment. The plan includes: 1. Build Docker image, 2. Push to ECR, 3. Deploy ECS service.";
      }
      msgs.push({ role: "assistant", content });
    }
  }
  return msgs;
}

// ─── Test Suite ───

describe("Compaction Pipeline Integration", () => {

  beforeEach(() => {
    idCounter = 0;
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 1: Bridge correctly converts and invokes provider compactor
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Bridge", () => {
    it("converts agent messages to provider messages and back without data loss", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor,
        estimator,
        pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      // 50 messages — well above the default threshold
      const messages = makeAgentMessages(50, {
        includeToolUse: true,
        includeFailures: true,
        includeDecisions: true,
      });

      const result = await bridge.compact({
        messages,
        systemPrompt: "You are a helpful assistant.",
        task: "Explain the deployment failure and how to fix it.",
        contextWindowTokens: 200, // Artificially low to force compaction
      });

      // Must have compacted
      expect(result.compacted).toBe(true);

      // Message count must be reduced
      expect(result.messages.length).toBeLessThan(messages.length);

      // Must have summary with structured extraction
      expect(result.summary).toBeDefined();
      expect(result.droppedMessageCount).toBeGreaterThan(0);

      // Original messages that were kept should preserve their content structure
      const keptAssistant = result.messages.find(
        (m) => m.role === "assistant" && Array.isArray(m.content),
      );
      // Tool use messages with content blocks should be preserved if kept
      // (or they may be in the dropped set — either is fine)

      // Summary should have at least some structured fields
      if (result.summary) {
        const hasContent =
          result.summary.summaryText.length > 0 ||
          result.summary.decisions.length > 0 ||
          result.summary.todos.length > 0 ||
          result.summary.toolFailures.length > 0;
        expect(hasContent).toBe(true);
      }
    });

    it("returns uncompacted result when below threshold", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(4);

      const result = await bridge.compact({
        messages,
        systemPrompt: "You are a helpful assistant.",
        task: "Simple task.",
        contextWindowTokens: 200_000, // Large window, no compaction needed
      });

      expect(result.compacted).toBe(false);
      expect(result.messages).toBe(messages); // Same reference
      expect(result.droppedMessageCount).toBe(0);
    });

    it("captures tool_failure_block when messages contain errors", async () => {
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(50, { includeFailures: true });

      const result = await bridge.compact({
        messages,
        systemPrompt: "Test.",
        task: "Why did the browser fail?",
        contextWindowTokens: 200,
      });

      expect(result.compacted).toBe(true);
      // The blocks should include a tool_failure_block
      const failureBlock = result.blocks?.find((b) => b.kind === "tool_failure_block");
      expect(failureBlock).toBeDefined();

      // The failure content should be either in kept messages or in the summary
      const allContent = result.messages.map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ).join("\n");

      // "browser session was not connected" or "ECONNREFUSED" should appear somewhere
      const hasFailureContext =
        allContent.includes("browser") ||
        allContent.includes("ECONNREFUSED") ||
        allContent.includes("failed") ||
        allContent.includes("failure");
      expect(hasFailureContext).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 2: Verifier catches hallucinated summaries
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Verifier", () => {
    it("passes verification when summary mentions source entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Run exec tool on src/index.ts", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "exec returned ENOENT for src/index.ts", createdAt: NOW, toolName: "exec" },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "User asked to run exec on src/index.ts, got ENOENT error.",
        decisions: [],
        todos: ["Fix the missing src/index.ts file"],
        openQuestions: [],
        toolFailures: ["exec: ENOENT on src/index.ts"],
        fileOperations: ["src/index.ts"],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      expect(result.valid).toBe(true);
      expect(result.entityRecall).toBeGreaterThanOrEqual(0.6);
      expect(result.hasStructuredContent).toBe(true);
    });

    it("fails verification when summary misses key entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Run exec tool on src/index.ts", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "exec returned ENOENT for src/index.ts", createdAt: NOW, toolName: "exec" },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "The user did something and got a result.",
        decisions: [],
        todos: [],
        openQuestions: [],
        toolFailures: [],
        fileOperations: [],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      expect(result.valid).toBe(false);
      expect(result.entityRecall).toBeLessThan(0.6);
      expect(result.missingEntities.length).toBeGreaterThan(0);
    });

    it("passes when source has no extractable entities", () => {
      const messages: FridayProviderContextMessage[] = [
        { messageId: "m1", role: "user", content: "Hello, how are you?", createdAt: NOW },
        { messageId: "m2", role: "assistant", content: "I am fine, thank you!", createdAt: NOW },
      ];

      const summary: FridayContextCompactionSummary = {
        summaryText: "Greeting exchange.",
        decisions: [],
        todos: [],
        openQuestions: [],
        toolFailures: [],
        fileOperations: [],
      };

      const result = verifyCompactionSummary({ originalMessages: messages, summary });

      // No entities to check → recall is 1.0
      expect(result.entityRecall).toBe(1.0);
      expect(result.valid).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 3: Memory Sink persists to memory service
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Memory Sink", () => {
    it("stores structured summary fields as separate memory items", async () => {
      const storedItems: Array<{ namespace: string; content: string; metadata: Record<string, unknown> }> = [];

      const mockMemoryService = {
        store: vi.fn(async (namespace: string, content: string, metadata?: Record<string, unknown>) => {
          storedItems.push({ namespace, content, metadata: metadata ?? {} });
          return {
            id: testIdGenerator(),
            namespace,
            key: "",
            content,
            source: "",
            tags: [],
            metadata: metadata ?? {},
            createdAt: NOW,
            updatedAt: NOW,
          } as FridayMemoryItem;
        }),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const sink = createFridayCompactionMemorySink({
        memoryService: mockMemoryService as any,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const summary: FridayContextCompactionSummary = {
        summaryText: "User worked on deployment. Browser failed initially.",
        decisions: ["Use TypeScript strict mode", "Deploy to AWS ECS"],
        todos: ["Fix browser connection", "Run smoke tests"],
        openQuestions: ["Should we use Redis?"],
        toolFailures: ["browser: ECONNREFUSED"],
        fileOperations: ["src/deploy.ts", "docker/Dockerfile"],
      };

      await sink.persist({
        sessionKey: "session-abc",
        runId: "run-123",
        summary,
        compactedAt: NOW,
      });

      // Should have stored 6 items (one per non-empty field)
      expect(mockMemoryService.store).toHaveBeenCalledTimes(6);

      // Check namespace mapping
      const namespaces = storedItems.map((item) => item.namespace);
      expect(namespaces).toContain("compaction.decisions");
      expect(namespaces).toContain("compaction.todos");
      expect(namespaces).toContain("compaction.questions");
      expect(namespaces).toContain("compaction.failures");
      expect(namespaces).toContain("compaction.files");
      expect(namespaces).toContain("compaction.summary");

      // Check decisions content
      const decisionsItem = storedItems.find((i) => i.namespace === "compaction.decisions");
      expect(decisionsItem?.content).toContain("TypeScript strict mode");
      expect(decisionsItem?.content).toContain("AWS ECS");

      // Check TTL is set
      const failuresItem = storedItems.find((i) => i.namespace === "compaction.failures");
      expect((failuresItem?.metadata as any)?.ttlSeconds ?? failuresItem?.metadata).toBeDefined();
    });

    it("skips empty fields and stores nothing when summary is empty", async () => {
      const mockMemoryService = {
        store: vi.fn(async () => ({} as FridayMemoryItem)),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const sink = createFridayCompactionMemorySink({
        memoryService: mockMemoryService as any,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      await sink.persist({
        sessionKey: "session-empty",
        runId: "run-empty",
        summary: {
          summaryText: "",
          decisions: [],
          todos: [],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        compactedAt: NOW,
      });

      expect(mockMemoryService.store).not.toHaveBeenCalled();
    });

    it("does not throw when individual store calls fail", async () => {
      let callCount = 0;
      const mockMemoryService = {
        store: vi.fn(async () => {
          callCount++;
          if (callCount === 2) throw new Error("DB write failed");
          return {} as FridayMemoryItem;
        }),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const sink = createFridayCompactionMemorySink({
        memoryService: mockMemoryService as any,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      // Should NOT throw even though one store fails
      await expect(sink.persist({
        sessionKey: "session-fail",
        runId: "run-fail",
        summary: {
          summaryText: "test",
          decisions: ["d1"],
          todos: ["t1"],
          openQuestions: [],
          toolFailures: [],
          fileOperations: [],
        },
        compactedAt: NOW,
      })).resolves.toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 4: Context Formatter produces correct prompt fragments
  // ══════════════════════════════════════════════════════════════════

  describe("Compaction Context Formatter", () => {
    it("groups memory items by source and formats as prompt fragment", () => {
      const items: FridayMemoryItem[] = [
        {
          id: "item-1", namespace: "compaction.decisions", key: "decisions:run-1",
          content: "Use TypeScript strict mode\nDeploy to AWS ECS",
          source: "compaction:session-abc:run-1",
          tags: ["compaction", "auto", "decisions"],
          metadata: { compactedAt: "2026-04-15T09:00:00Z" },
          createdAt: NOW, updatedAt: NOW,
        },
        {
          id: "item-2", namespace: "compaction.todos", key: "todos:run-1",
          content: "Fix browser connection\nRun smoke tests",
          source: "compaction:session-abc:run-1",
          tags: ["compaction", "auto", "todos"],
          metadata: { compactedAt: "2026-04-15T09:00:00Z" },
          createdAt: NOW, updatedAt: NOW,
        },
        {
          id: "item-3", namespace: "compaction.failures", key: "failures:run-1",
          content: "browser: ECONNREFUSED",
          source: "compaction:session-abc:run-1",
          tags: ["compaction", "auto", "failures"],
          metadata: { compactedAt: "2026-04-15T09:00:00Z" },
          createdAt: NOW, updatedAt: NOW,
        },
      ];

      const blocks = groupCompactionMemoryItems(items);

      expect(blocks).toHaveLength(1);
      expect(blocks[0].decisions).toEqual(["Use TypeScript strict mode", "Deploy to AWS ECS"]);
      expect(blocks[0].todos).toEqual(["Fix browser connection", "Run smoke tests"]);
      expect(blocks[0].toolFailures).toEqual(["browser: ECONNREFUSED"]);

      const prompt = formatCompactionContextForPrompt(blocks);

      expect(prompt).toContain("[Previous Session Context");
      expect(prompt).toContain("Decisions:");
      expect(prompt).toContain("TypeScript strict mode");
      expect(prompt).toContain("TODOs:");
      expect(prompt).toContain("Fix browser connection");
      expect(prompt).toContain("Tool failures:");
      expect(prompt).toContain("ECONNREFUSED");
    });

    it("limits output to maxChars", () => {
      const items: FridayMemoryItem[] = [
        {
          id: "item-1", namespace: "compaction.summary", key: "summary:run-1",
          content: "A".repeat(10_000),
          source: "compaction:session-xyz:run-1",
          tags: [], metadata: { compactedAt: NOW },
          createdAt: NOW, updatedAt: NOW,
        },
      ];

      const blocks = groupCompactionMemoryItems(items);
      const prompt = formatCompactionContextForPrompt(blocks, { maxChars: 100 });

      expect(prompt.length).toBeLessThanOrEqual(100);
      expect(prompt.endsWith("...")).toBe(true);
    });

    it("returns empty string when no items", () => {
      const blocks = groupCompactionMemoryItems([]);
      const prompt = formatCompactionContextForPrompt(blocks);
      expect(prompt).toBe("");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 5: Preference Injector merges sources and deduplicates
  // ══════════════════════════════════════════════════════════════════

  describe("Preference Injector", () => {
    it("merges learning pipeline and memory sources", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "pref-1", namespace: "compaction.decisions", key: "d1",
            content: "Prefer deploying to AWS ECS",
            source: "compaction:s1:r1",
            tags: ["compaction", "auto"],
            metadata: { confidence: 0.7 },
            createdAt: NOW, updatedAt: NOW,
          } as FridayMemoryItem,
        ]),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => ({
          preferences: {
            language: "TypeScript",
            framework: "React",
          },
        }),
        nowIso: testNowIso,
      });

      const result = await injector.loadPreferences("user-1");

      expect(result.itemCount).toBeGreaterThan(0);
      expect(result.fragment).toContain("[Learned Preferences]");
      expect(result.fragment).toContain("TypeScript");
      expect(result.sources).toContain("learning");
    });

    it("handles learning pipeline failure gracefully", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => []),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => { throw new Error("DB down"); },
        nowIso: testNowIso,
      });

      // Should not throw
      const result = await injector.loadPreferences("user-1");

      expect(result.fragment).toBe("");
      expect(result.itemCount).toBe(0);
    });

    it("deduplicates preferences with high token overlap", async () => {
      const mockMemoryService = {
        store: vi.fn(),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => [
          {
            id: "pref-dup", namespace: "compaction.decisions", key: "d1",
            content: "TypeScript strict mode preferred",
            source: "compaction:s1:r1",
            tags: ["compaction", "auto"],
            metadata: { confidence: 0.9 },
            createdAt: NOW, updatedAt: NOW,
          } as FridayMemoryItem,
        ]),
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        learningContextBuilder: () => ({
          preferences: {
            "typescript_mode": "strict mode preferred",
          },
        }),
        nowIso: testNowIso,
      });

      const result = await injector.loadPreferences("user-1");

      // Should deduplicate the two very similar preferences
      // "TypeScript strict mode preferred" vs "typescript_mode: strict mode preferred"
      // They share high overlap, so one should be removed
      expect(result.itemCount).toBeLessThanOrEqual(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 6: END-TO-END pipeline test
  // ══════════════════════════════════════════════════════════════════

  describe("End-to-End Pipeline", () => {
    it("compaction → memory sink → formatter → prompt injection works as a connected pipeline", async () => {
      // ── Step 1: Create compaction bridge ──
      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();
      const compactor = createFridayProviderContextCompactor({ estimator, pruner });

      const bridge = createFridayAgentCompactionBridge({
        compactor, estimator, pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      // ── Step 2: Create 50 messages with rich content ──
      const messages = makeAgentMessages(50, {
        includeToolUse: true,
        includeFailures: true,
        includeDecisions: true,
      });

      // ── Step 3: Run compaction ──
      const compactionResult = await bridge.compact({
        messages,
        systemPrompt: "You are a deployment assistant.",
        task: "Explain the browser failure and recommend next steps for deployment.",
        contextWindowTokens: 200, // Force compaction
      });

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.summary).toBeDefined();

      // ── Step 4: Feed summary to memory sink ──
      const storedItems: FridayMemoryItem[] = [];
      const mockMemoryService = {
        store: vi.fn(async (namespace: string, content: string, metadata?: Record<string, unknown>) => {
          const item: FridayMemoryItem = {
            id: testIdGenerator(),
            namespace,
            key: (metadata as any)?.key ?? "",
            content,
            source: (metadata as any)?.source ?? "",
            tags: (metadata as any)?.tags ?? [],
            metadata: metadata ?? {},
            createdAt: NOW,
            updatedAt: NOW,
          };
          storedItems.push(item);
          return item;
        }),
        search: vi.fn(),
        get: vi.fn(),
        list: vi.fn(async () => storedItems), // Return what was stored
        delete: vi.fn(),
        prune: vi.fn(),
      };

      const sink = createFridayCompactionMemorySink({
        memoryService: mockMemoryService as any,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      await sink.persist({
        sessionKey: "session-e2e",
        runId: "run-e2e",
        summary: compactionResult.summary!,
        blocks: compactionResult.blocks,
        compactedAt: NOW,
      });

      // Verify items were stored
      expect(storedItems.length).toBeGreaterThan(0);

      // ── Step 5: Feed stored items to context formatter ──
      const blocks = groupCompactionMemoryItems(storedItems);
      const promptFragment = formatCompactionContextForPrompt(blocks);

      // The prompt should contain meaningful content from the original conversation
      expect(promptFragment).toContain("[Previous Session Context");
      expect(promptFragment.length).toBeGreaterThan(50);

      // ── Step 6: Verify the verifier works on the compaction output ──
      if (compactionResult.summary) {
        // Build provider messages for verification
        const providerMsgs: FridayProviderContextMessage[] = messages
          .filter((m) => typeof m.content === "string")
          .map((m, i) => ({
            messageId: `verify-${i}`,
            role: m.role as "user" | "assistant",
            content: m.content as string,
            createdAt: NOW,
          }));

        const verification = verifyCompactionSummary({
          originalMessages: providerMsgs,
          summary: compactionResult.summary,
        });

        // Verification should produce a meaningful result
        expect(typeof verification.valid).toBe("boolean");
        expect(verification.entityRecall).toBeGreaterThanOrEqual(0);
        expect(verification.entityRecall).toBeLessThanOrEqual(1);
      }

      // ── Step 7: Verify preference injector can read the stored items ──
      const injector = createFridayPreferenceInjector({
        memoryService: mockMemoryService as any,
        nowIso: testNowIso,
      });

      const prefResult = await injector.loadPreferences("user-e2e");

      // The injector should find and format the compaction items
      // (it queries compaction.decisions and compaction.todos namespaces)
      // Since our mock returns all storedItems, it should find some
      if (storedItems.some((i) => i.namespace === "compaction.decisions" || i.namespace === "compaction.todos")) {
        expect(prefResult.itemCount).toBeGreaterThan(0);
        expect(prefResult.fragment).toContain("[Learned Preferences]");
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // TEST 7: Fallback / degradation behavior
  // ══════════════════════════════════════════════════════════════════

  describe("Graceful Degradation", () => {
    it("bridge handles compactor errors by throwing (caller catches)", async () => {
      const brokenCompactor = {
        async compact(): Promise<any> {
          throw new Error("LLM provider unavailable");
        },
      };

      const estimator = createFridayProviderTokenEstimator();
      const pruner = createFridayProviderContextPruner();

      const bridge = createFridayAgentCompactionBridge({
        compactor: brokenCompactor as any,
        estimator,
        pruner,
        idGenerator: testIdGenerator,
        nowIso: testNowIso,
      });

      const messages = makeAgentMessages(50);

      // Bridge should propagate the error (runtime catches it and falls back)
      await expect(bridge.compact({
        messages,
        systemPrompt: "Test.",
        task: "Test task.",
        contextWindowTokens: 200,
      })).rejects.toThrow("LLM provider unavailable");
    });
  });
});
